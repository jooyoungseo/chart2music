import { OscillatorAudioEngine } from "./audio/index";
import type { AudioEngine } from "./audio/index";
import { HERTZ, NOTE_LENGTH, SPEEDS } from "./constants";
import { KeyboardEventManager } from "./keyboardManager";
import { ScreenReaderBridge } from "./ScreenReaderBridge";
import type {
    AxisData,
    groupedMetadata,
    SonifyTypes,
    c2mOptions,
    c2mGolangReturn,
    dataSet
} from "./types";
import {
    calcPan,
    generateSummary,
    interpolateBin,
    sentenceCase,
    generatePointDescription,
    usesAxis,
    calculateMetadataByGroup,
    initializeAxis,
    detectDataPointType,
    calculateAxisMinimum,
    calculateAxisMaximum
} from "./utils";
import { validateInput } from "./validate";
import {
    isAlternateAxisDataPoint,
    isHighLowDataPoint,
    isOHLCDataPoint,
    isSimpleDataPoint
} from "./dataPoint";
import type { SupportedDataPointType } from "./dataPoint";
import { english } from "./language";

let context: null | AudioContext = null;

const convertDataRow = (row: (SupportedDataPointType | number)[]) => {
    return row.map((point: number | SupportedDataPointType, index: number) => {
        if (typeof point === "number") {
            return {
                x: index,
                y: point
            } as SupportedDataPointType;
        }
        return point;
    });
};

/**
 * Validates and initializes a single chart that should be sonified
 *
 * @param {SonifyTypes} input - data, config, and options for the chart
 * @returns c2mGolangReturn - A value of "err" (null if no error, or string if error) and "data" (the chart, if there was no error)
 */
export const c2mChart = (input: SonifyTypes): c2mGolangReturn => {
    const validationErrorString = validateInput(input);
    if (validationErrorString !== "") {
        return { err: validationErrorString };
    }

    return {
        err: null,
        data: new c2m(input)
    };
};

const checkForNumberInput = (
    metadataByGroup: groupedMetadata[],
    data: SonifyTypes["data"]
) => {
    if (Array.isArray(data) && typeof data[0] === "number") {
        metadataByGroup[0].inputType = "number";
    } else {
        let index = 0;
        for (const group in data) {
            if (detectDataPointType((data as dataSet)[group][0]) === "number") {
                metadataByGroup[index].inputType = "number";
            }
            index++;
        }
    }

    return metadataByGroup;
};

/**
 * Represents a single chart that should be sonified.
 */
export class c2m {
    private _chartElement: HTMLElement;
    private _ccElement: HTMLElement;
    private _summary: string;
    private _groups: string[];
    private _data: SupportedDataPointType[][];
    private _groupIndex = 0;
    private _pointIndex = 0;
    private _sr: ScreenReaderBridge;
    private _xAxis: AxisData;
    private _yAxis: AxisData;
    private _y2Axis: AxisData;
    private _title: string;
    private _playListInterval: NodeJS.Timeout | null = null;
    private _speedRateIndex = 1;
    private _flagNewGroup = false;
    private _flagNewStat = false;
    private _keyEventManager: KeyboardEventManager;
    private _audioEngine: AudioEngine | null = null;
    private _metadataByGroup: groupedMetadata[];
    private _options: c2mOptions = {
        enableSound: true,
        enableSpeech: true,
        live: false
    };
    private _providedAudioEngine?: AudioEngine;
    private _pauseFlag = false;
    private _monitorMode = false;
    private _type: SonifyTypes["type"];
    private _explicitAxes: {
        x?: AxisData;
        y?: AxisData;
        y2?: AxisData;
    } = {};

    /**
     * Constructor
     *
     * @param input - data/config provided by the invocation
     */
    constructor(input: SonifyTypes) {
        this._type = input.type;
        this._providedAudioEngine = input.audioEngine;
        this._title = input.title ?? "";
        this._chartElement = input.element;

        if (
            !this._chartElement.hasAttribute("alt") &&
            !this._chartElement.hasAttribute("aria-label")
        ) {
            this._chartElement.setAttribute(
                "aria-label",
                `${this._title}, Sonified chart`
            );
        }

        this._ccElement = input.cc ?? this._chartElement;

        this.setData(input.data, input.axes);

        if (input?.options) {
            this._options = {
                ...this._options,
                ...input?.options
            };
        }

        // Generate summary
        this._generateSummary();

        // Initialize SRB
        ScreenReaderBridge.addAriaAttributes(this._ccElement);
        this._sr = new ScreenReaderBridge(this._ccElement);

        this._initializeKeyActionMap();
        this._startListening();
    }

    /**
     * Generate (or regenerate) chart summary
     */
    public _generateSummary() {
        this._summary = generateSummary({
            type: this._type,
            title: this._title,
            x: this._xAxis,
            y: this._yAxis,
            dataRows: this._groups.length,
            y2: this._y2Axis,
            live: this._options.live
        });
    }

    /**
     * Assign or re-assign data values
     *
     * @param data
     * @param axes
     */
    setData(data: SonifyTypes["data"], axes?: SonifyTypes["axes"]) {
        // Update axes
        this._explicitAxes = {
            x: {
                ...(this._explicitAxes.x ?? {}),
                ...(axes?.x ?? {})
            },
            y: {
                ...(this._explicitAxes.y ?? {}),
                ...(axes?.y ?? {})
            },
            y2: {
                ...(this._explicitAxes.y2 ?? {}),
                ...(axes?.y2 ?? {})
            }
        };

        this._initializeData(data);

        this._metadataByGroup = calculateMetadataByGroup(this._data);
        this._metadataByGroup = checkForNumberInput(
            this._metadataByGroup,
            data
        );

        this._xAxis = initializeAxis(this._data, "x", this._explicitAxes.x);
        this._yAxis = initializeAxis(this._data, "y", this._explicitAxes.y);
        if (usesAxis(this._data, "y2")) {
            this._y2Axis = initializeAxis(
                this._data,
                "y2",
                this._explicitAxes.y2
            );
        }

        // Generate summary
        this._generateSummary();
    }

    /**
     * Set options for the interaction model of the chart
     *
     * @param option - key/value pairs for options and their possible values
     * @param [option.enableSound] - enables sound. Set to FALSE to mute.
     * @param [option.enableSpeech] - enables speech. Set to FALSE to gag.
     */
    setOptions(option: c2mOptions) {
        this._options = {
            ...this._options,
            ...option
        };
    }

    /**
     * Get the data point that the user is currently focused on
     *
     * @returns - the current group name and data point
     */
    getCurrent() {
        const { statIndex, availableStats } =
            this._metadataByGroup[this._groupIndex];
        return {
            group: this._groups[this._groupIndex],
            point: this._data[this._groupIndex][this._pointIndex],
            stat: availableStats[statIndex] ?? ""
        };
    }

    /**
     * If there's a max width, shift off any data points that go over size
     */
    private _shrinkToMaxWidth() {
        if (typeof this._options.maxWidth === "undefined") {
            return;
        }
        for (let i = 0; i < this._data.length; i++) {
            if (this._data[i].length <= this._options.maxWidth) {
                continue;
            }

            const tmp = this._data[i].shift();
            if (
                this._xAxis.minimum === tmp.x ||
                this._xAxis.maximum === tmp.x
            ) {
                this._xAxis.minimum = calculateAxisMinimum(this._data, "x");
                this._xAxis.maximum = calculateAxisMaximum(this._data, "x");
            }
            this._yAxis.minimum = calculateAxisMinimum(this._data, "y");
            this._yAxis.maximum = calculateAxisMaximum(this._data, "y");

            if (isAlternateAxisDataPoint(tmp)) {
                this._y2Axis.minimum = calculateAxisMinimum(this._data, "y2");
                this._y2Axis.maximum = calculateAxisMaximum(this._data, "y2");
            }

            const targetType = this._metadataByGroup[i].inputType;

            if (targetType === "number") {
                this._data[i].forEach((item, index) => {
                    this._data[i][index].x = index;
                });
            }
        }
    }

    /**
     * Append data in a live chart
     *
     * @param dataPoint - the data point
     * @param group - which group to apply to, if there are multiple groups
     */
    appendData(
        dataPoint: SupportedDataPointType | number,
        group?: string
    ): { err: string | null; data?: SupportedDataPointType } {
        const groupIndex = group ? this._groups.indexOf(group) : 0;
        if (groupIndex === -1) {
            return { err: english.error_unknown_group(group, this._groups) };
        }

        const addedType = detectDataPointType(dataPoint);
        const targetType = this._metadataByGroup[groupIndex].inputType;

        if (addedType !== targetType) {
            return {
                err: english.error_mismatched_type(addedType, targetType)
            };
        }

        const newDataPoint =
            typeof dataPoint === "number"
                ? {
                      x: this._data[groupIndex].length,
                      y: dataPoint
                  }
                : dataPoint;

        this._data[groupIndex].push(newDataPoint);

        this._xAxis.maximum = Math.max(this._xAxis.maximum, newDataPoint.x);
        if (isSimpleDataPoint(newDataPoint)) {
            this._yAxis.maximum = Math.max(this._yAxis.maximum, newDataPoint.y);
            this._yAxis.minimum = Math.min(this._yAxis.minimum, newDataPoint.y);
        } else if (isOHLCDataPoint(newDataPoint)) {
            this._yAxis.maximum = Math.max(
                this._yAxis.maximum,
                newDataPoint.open,
                newDataPoint.high,
                newDataPoint.low,
                newDataPoint.close
            );
            this._yAxis.minimum = Math.min(
                this._yAxis.minimum,
                newDataPoint.open,
                newDataPoint.high,
                newDataPoint.low,
                newDataPoint.close
            );
        } else if (isHighLowDataPoint(newDataPoint)) {
            this._yAxis.maximum = Math.max(
                this._yAxis.maximum,
                newDataPoint.high,
                newDataPoint.low
            );
            this._yAxis.minimum = Math.min(
                this._yAxis.minimum,
                newDataPoint.high,
                newDataPoint.low
            );
        }

        if (this._monitorMode) {
            const { statIndex, availableStats } =
                this._metadataByGroup[groupIndex];
            this._playDataPoint(newDataPoint, statIndex, availableStats);
        }

        this._shrinkToMaxWidth();
        return {
            err: null,
            data: newDataPoint
        };
    }

    /**
     * Initialize which keys map to which actions
     */
    private _initializeKeyActionMap() {
        this._keyEventManager = new KeyboardEventManager(this._chartElement);
        this._keyEventManager.registerKeyEvents([
            {
                title: english.hotkey_right(),
                key: "ArrowRight",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._moveRight()) {
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_left(),
                key: "ArrowLeft",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._moveLeft()) {
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_play_right(),
                key: "Shift+ArrowRight",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._playRight();
                }
            },
            {
                title: english.hotkey_play_left(),
                key: "Shift+ArrowLeft",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._playLeft();
                }
            },
            {
                title: english.hotkey_cancel_play(),
                key: "Ctrl+Control",
                keyDescription: "Control",
                callback: () => {
                    clearInterval(this._playListInterval);
                }
            },
            {
                title: english.hotkey_previous_stat(),
                key: "ArrowUp",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._movePrevStat()) {
                        this._flagNewStat = true;
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_next_stat(),
                key: "ArrowDown",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._moveNextStat()) {
                        this._flagNewStat = true;
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_previous_category(),
                key: "PageUp",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._groupIndex === 0) {
                        return;
                    }
                    this._groupIndex--;
                    this._flagNewGroup = true;
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_next_category(),
                key: "PageDown",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._groupIndex === this._data.length - 1) {
                        return;
                    }
                    this._groupIndex++;
                    this._flagNewGroup = true;
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_first(),
                key: "Home",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._pointIndex = 0;
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_end(),
                key: "End",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._pointIndex = this._data[this._groupIndex].length - 1;
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_play_all_left(),
                key: "Shift+Home",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._playAllLeft();
                }
            },
            {
                title: english.hotkey_play_all_right(),
                key: "Shift+End",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._playAllRight();
                }
            },
            {
                title: english.hotkey_replay(),
                key: " ",
                keyDescription: "Spacebar",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._flagNewGroup = true;
                    this._flagNewStat = true;
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_backward_tenth(),
                key: "Ctrl+ArrowLeft",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._moveLeftTenths();
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_forward_tenth(),
                key: "Ctrl+ArrowRight",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._moveRightTenths();
                    this._playAndSpeak();
                }
            },
            {
                title: english.hotkey_jump_minimum(),
                key: "[",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._moveToMinimum()) {
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_jump_minimum(),
                key: "]",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._moveToMaximum()) {
                        this._playAndSpeak();
                    }
                }
            },
            {
                title: english.hotkey_speed_incr(),
                key: "q",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._speedRateIndex < SPEEDS.length - 1) {
                        this._speedRateIndex++;
                    }
                    this._sr.render(
                        english.speed(SPEEDS[this._speedRateIndex])
                    );
                }
            },
            {
                title: english.hotkey_speed_decr(),
                key: "e",
                callback: () => {
                    clearInterval(this._playListInterval);
                    if (this._speedRateIndex > 0) {
                        this._speedRateIndex--;
                    }
                    this._sr.render(
                        english.speed(SPEEDS[this._speedRateIndex])
                    );
                }
            },
            {
                title: english.hotkey_toggle_monitor(),
                key: "m",
                callback: () => {
                    this._monitorMode = !this._monitorMode;
                    this._sr.render(english.monitoring(this._monitorMode));
                }
            },
            {
                title: english.hotkey_help(),
                key: "h",
                callback: () => {
                    clearInterval(this._playListInterval);
                    this._keyEventManager.launchHelpDialog();
                }
            }
        ]);
    }

    /**
     * Initialize internal data structure. The user can provide data is several different types of formats,
     * so those formats will need to be unified here.
     *
     * @param userData - data provided by the invocation
     */
    private _initializeData(userData: SonifyTypes["data"]) {
        if (!Array.isArray(userData)) {
            // Data is presumably of type dataSet. No other effort necessary.
            this._groups = Object.keys(userData);
            this._data = Object.values(userData).map((row) =>
                convertDataRow(row)
            );
            return;
        }

        this._groups = [""];
        this._data = [convertDataRow(userData)];
    }

    /**
     * Listen to various events, and drive interactions
     */
    private _startListening() {
        this._chartElement.addEventListener("focus", () => {
            if (this._options.live) {
                this._generateSummary();
            }
            if (this._options.enableSpeech) {
                this._sr.render(this._summary);
            }
        });
        this._chartElement.addEventListener("blur", () => {
            this._monitorMode = false;
        });
    }

    /**
     * Play an individual data point, and then speak its details
     */
    private _playAndSpeak() {
        this._playCurrent();
        setTimeout(() => {
            this._speakCurrent();
        }, NOTE_LENGTH * 1000);
    }

    /**
     * Move focus to the next data point to the right, if there is one
     */
    private _moveRight() {
        const max = this._data[this._groupIndex].length - 1;
        if (this._pointIndex >= max) {
            this._pointIndex = max;
            return false;
        }
        this._pointIndex++;
        return true;
    }

    /**
     * Move focus to the next data point to the left, if there is one
     */
    private _moveLeft() {
        if (this._pointIndex <= 0) {
            this._pointIndex = 0;
            return false;
        }
        this._pointIndex--;
        return true;
    }

    /**
     * Move focus to the lowest value data point
     *
     * @returns - if move was completed
     */
    private _moveToMinimum() {
        const index = this._metadataByGroup[this._groupIndex].minimumPointIndex;
        if (index === -1) {
            return false;
        }
        this._pointIndex = index;
        return true;
    }

    /**
     * Move focus to the lowest value data point
     *
     * @returns - if move was completed
     */
    private _moveToMaximum() {
        const index = this._metadataByGroup[this._groupIndex].maximumPointIndex;
        if (index === -1) {
            return false;
        }
        this._pointIndex = index;
        return true;
    }

    /**
     * Move by a tenth to the left
     */
    private _moveLeftTenths() {
        if (this._pointIndex === 0) {
            return false;
        }
        this._pointIndex = Math.max(
            this._pointIndex - this._metadataByGroup[this._groupIndex].tenths,
            0
        );
        return true;
    }

    /**
     * Move by a tenth to the right
     */
    private _moveRightTenths() {
        if (this._pointIndex === this._data[this._groupIndex].length - 1) {
            return false;
        }
        this._pointIndex = Math.min(
            this._pointIndex + this._metadataByGroup[this._groupIndex].tenths,
            this._data[this._groupIndex].length - 1
        );
        return true;
    }

    /**
     * Move to the next stat
     *
     * @returns if possible
     */
    private _movePrevStat() {
        const { statIndex } = this._metadataByGroup[this._groupIndex];
        if (statIndex < 0) {
            return false;
        }
        this._metadataByGroup[this._groupIndex].statIndex = statIndex - 1;
        return true;
    }

    /**
     * Move to the next stat
     *
     * @returns if possible
     */
    private _moveNextStat() {
        const { statIndex, availableStats } =
            this._metadataByGroup[this._groupIndex];
        if (statIndex >= availableStats.length - 1) {
            return false;
        }
        this._metadataByGroup[this._groupIndex].statIndex = statIndex + 1;
        return true;
    }

    /**
     * Play all data points to the left, if there are any
     */
    private _playLeft() {
        const min = 0;
        this._playListInterval = setInterval(() => {
            if (this._pointIndex <= min) {
                this._pointIndex = min;
                clearInterval(this._playListInterval);
            } else {
                this._pointIndex--;
                this._playCurrent();
            }
        }, SPEEDS[this._speedRateIndex]) as NodeJS.Timeout;
        this._playCurrent();
    }

    /**
     * Play all data points to the right, if there are any
     */
    private _playRight() {
        const max = this._data[this._groupIndex].length - 1;
        this._playListInterval = setInterval(() => {
            if (this._pointIndex >= max) {
                this._pointIndex = max;
                clearInterval(this._playListInterval);
            } else {
                this._pointIndex++;
                this._playCurrent();
            }
        }, SPEEDS[this._speedRateIndex]);
        this._playCurrent();
    }

    /**
     * Play all categories to the right
     */
    private _playAllRight() {
        const maxPoints = this._data[this._groupIndex].length - 1;
        const maxGroups = this._data.length - 1;
        this._playListInterval = setInterval(() => {
            if (
                this._pointIndex >= maxPoints &&
                this._groupIndex >= maxGroups
            ) {
                this._pointIndex = maxPoints;
                clearInterval(this._playListInterval);
            } else if (this._groupIndex === maxGroups) {
                if (!this._pauseFlag) {
                    this._pauseFlag = true;
                    return;
                }
                this._pauseFlag = false;
                this._groupIndex = 0;
                this._pointIndex++;
                this._playCurrent();
            } else {
                this._groupIndex++;
                this._playCurrent();
            }
        }, SPEEDS[this._speedRateIndex]);
        this._playCurrent();
    }

    /**
     * Play all categories to the left
     */
    private _playAllLeft() {
        const min = 0;
        const maxGroups = this._data.length - 1;
        this._playListInterval = setInterval(() => {
            if (this._pointIndex <= min && this._groupIndex <= min) {
                this._pointIndex = min;
                clearInterval(this._playListInterval);
            } else if (this._groupIndex === min) {
                if (!this._pauseFlag) {
                    this._pauseFlag = true;
                    return;
                }
                this._pauseFlag = false;
                this._groupIndex = maxGroups;
                this._pointIndex--;
                this._playCurrent();
            } else {
                this._groupIndex--;
                this._playCurrent();
            }
        }, SPEEDS[this._speedRateIndex]);
        this._playCurrent();
    }

    /**
     * Play the current data point
     */
    private _playCurrent() {
        if (!this._options.enableSound) {
            this._onFocus();
            return;
        }

        const { statIndex, availableStats } =
            this._metadataByGroup[this._groupIndex];

        const current = this._data[this._groupIndex][this._pointIndex];

        this._playDataPoint(current, statIndex, availableStats);
        this._onFocus();
    }

    /**
     * Play a given data point
     *
     * @param current - the data point to play
     * @param statIndex - which stat is present, if available
     * @param availableStats - which stats are available
     */
    private _playDataPoint(
        current: SupportedDataPointType,
        statIndex: groupedMetadata["statIndex"],
        availableStats: groupedMetadata["availableStats"]
    ) {
        if (!context) {
            context = new AudioContext();
        }
        if (!this._audioEngine && context) {
            this._audioEngine =
                this._providedAudioEngine ?? new OscillatorAudioEngine(context);
        }
        if (!this._audioEngine) {
            return;
        }

        const xPan = calcPan(
            (current.x - this._xAxis.minimum) /
                (this._xAxis.maximum - this._xAxis.minimum)
        );

        if (isSimpleDataPoint(current)) {
            const yBin = interpolateBin(
                current.y,
                this._yAxis.minimum,
                this._yAxis.maximum,
                HERTZ.length - 1
            );

            this._audioEngine.playDataPoint(HERTZ[yBin], xPan, NOTE_LENGTH);

            return;
        }

        if (isAlternateAxisDataPoint(current)) {
            const yBin = interpolateBin(
                current.y2,
                this._y2Axis.minimum,
                this._y2Axis.maximum,
                HERTZ.length - 1
            );

            this._audioEngine.playDataPoint(HERTZ[yBin], xPan, NOTE_LENGTH);
            return;
        }

        if (isOHLCDataPoint(current) || isHighLowDataPoint(current)) {
            // Only play a single note, because we've drilled into stats
            if (statIndex >= 0) {
                const stat = availableStats[statIndex];
                const yBin = interpolateBin(
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    current[stat],
                    this._yAxis.minimum,
                    this._yAxis.maximum,
                    HERTZ.length - 1
                );

                this._audioEngine.playDataPoint(HERTZ[yBin], xPan, NOTE_LENGTH);
                return;
            }

            const interval = 1 / (availableStats.length + 1);
            availableStats.forEach((stat, index) => {
                const yBin = interpolateBin(
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    current[stat],
                    this._yAxis.minimum,
                    this._yAxis.maximum,
                    HERTZ.length - 1
                );
                setTimeout(() => {
                    this._audioEngine.playDataPoint(
                        HERTZ[yBin],
                        xPan,
                        NOTE_LENGTH
                    );
                }, SPEEDS[this._speedRateIndex] * interval * index);
            });
        }
    }

    /**
     * Perform actions when a new data point receives focus
     */
    private _onFocus() {
        this._options?.onFocusCallback?.({
            slice: this._groups[this._groupIndex],
            index: this._pointIndex
        });
    }

    /**
     * Update the screen reader on the current data point
     */
    private _speakCurrent() {
        if (!this._options.enableSpeech) {
            return;
        }

        // If we're glagged to announce a new group, but the group name is empty, ignore the flag
        if (this._flagNewGroup && this._groups[this._groupIndex] === "") {
            this._flagNewGroup = false;
        }

        const { statIndex, availableStats } =
            this._metadataByGroup[this._groupIndex];
        if (this._flagNewStat && availableStats.length === 0) {
            this._flagNewStat = false;
        }

        const current = this._data[this._groupIndex][this._pointIndex];
        const point = generatePointDescription(
            current,
            this._xAxis,
            isAlternateAxisDataPoint(current) ? this._y2Axis : this._yAxis,
            availableStats[statIndex]
        );
        const text =
            (this._flagNewGroup ? `${this._groups[this._groupIndex]}, ` : "") +
            (this._flagNewStat
                ? `${sentenceCase(availableStats[statIndex] ?? "all")}, `
                : "") +
            point;

        this._sr.render(text);

        this._flagNewGroup = false;
        this._flagNewStat = false;
    }
}

export default c2mChart;
