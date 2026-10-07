// Type declarations for the core package (`require('rpgwright')`).

/** A text needle: a substring, or a RegExp tested against the text. */
export type TextMatcher = string | RegExp;

/** A region of the screen in cells, 0-based; `x + width` is exclusive. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A cell color: the terminal default (null), a palette index, or truecolor. */
export type CellColor = null | { palette: number } | { rgb: string };

export interface Cell {
  /** '' for a never-written cell (width 1) and for a wide character's second half (width 0). */
  ch: string;
  width: 0 | 1 | 2;
  fg: CellColor;
  bg: CellColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  invisible: boolean;
}

export type ColorName =
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'gray' | 'grey' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite';

/** A color in a style assertion: null or 'default', a palette index, a name, or '#rrggbb'. */
export type ColorSpec = null | 'default' | number | ColorName | `#${string}`;

export interface StyleSpec {
  fg?: ColorSpec;
  bg?: ColorSpec;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

/** How an app shows focus; `toBeFocused()` passes if any of these marks the region. */
export interface FocusIndicators {
  /** Text immediately left of the region ends with this string, or matches this RegExp. */
  marker?: TextMatcher;
  /** Every visible character in the region has this style. */
  style?: StyleSpec;
  /** The visible cursor is in the region, or just after it on the same row. */
  cursor?: boolean;
}

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export interface TerminalModes {
  altScreen: boolean;
  cursorVisible: boolean;
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  mouseTracking: MouseTrackingMode;
  mouseEncoding: 'x10' | 'sgr' | 'urxvt' | 'utf8';
  focusReporting: boolean;
}

export interface ExitInfo {
  exitCode: number;
  /** The signal number that ended the process, if one did. */
  signal: number | null;
}

/** What locates a region: text, a RegExp, a rect, a whole row, or a bordered box. */
export type LocatorTarget =
  | string
  | RegExp
  | Rect
  | { row: number }
  | { box: true | { containing?: TextMatcher } };

export interface LocatorOptions {
  /** Pick one match: 0 is the first, -1 the last. */
  nth?: number;
  /** Keep only matches inside this locator's region. */
  within?: Locator;
}

export interface MouseOptions {
  button?: 'left' | 'middle' | 'right';
  modifiers?: Array<'shift' | 'alt' | 'ctrl'>;
  /** Wait for the screen to settle after each event (true: 150ms quiet). */
  settle?: boolean | number;
}

/** A lazy, strict description of a screen region, resolved afresh on every read. */
export interface Locator {
  readonly _isLocator: true;
  nth(index: number): Locator;
  first(): Locator;
  last(): Locator;
  /** A locator for matches of `target` inside this one. */
  locator(target: LocatorTarget, options?: Omit<LocatorOptions, 'within'>): Locator;
  /** How many regions match right now. */
  count(): number;
  /** The single matching region, or null; throws if several match. */
  boundingBox(): Rect | null;
  textContent(): string | null;
  cells(): Cell[][] | null;
  click(options?: MouseOptions & { clickCount?: number }): Promise<void>;
  hover(options?: MouseOptions): Promise<void>;
  describe(): string;
}

export interface ActionOptions {
  /** Wait until the screen has been quiet this long after writing (true: 150ms). */
  settle?: boolean | number;
}

export interface TimeoutOptions {
  timeout?: number;
}

export interface SnapshotOptions extends TimeoutOptions {
  updateSnapshot?: boolean;
  /** Also record and compare styles, in <name>.styles.snap. */
  styles?: boolean;
  /** Regions blanked with '*' before recording or comparing. */
  mask?: Array<TextMatcher | Rect | Locator>;
  normalize?: (text: string) => string;
  /** How many cells may differ and still pass. */
  maxDiffCells?: number;
  /** Set false to record without first waiting for the screen to settle. */
  stable?: boolean;
}

export type ScreenMatcher = string | RegExp | { snapshot: string };

export type LayoutCheck =
  | 'toHaveBox' | 'toBeWithinScreen' | 'toBeWithin' | 'toOverlap' | 'toBeLeftOf' | 'toBeRightOf'
  | 'toBeAbove' | 'toBeBelow' | 'toHaveGap' | 'toBeAligned' | 'toFitWithoutClipping'
  | 'toHaveText' | 'toHaveStyle' | 'toBeFocused';

export type TerminalCheck =
  | 'toBeInAltScreen' | 'toHaveTitle' | 'toHaveBell' | 'toHaveMouseTracking'
  | 'toHaveBracketedPaste' | 'toHaveHyperlink' | 'toHaveCopied' | 'toHaveScrollbackText';

export interface ActionRecord {
  type: string;
  detail: string;
  ok: boolean | null;
  depth: number;
  t: number;
  /** The screen the action finished on; only with `record: true`. */
  screen?: Cell[][];
  cursor?: Cursor;
}

export interface Trace {
  command: string;
  args: string[];
  actions: ActionRecord[];
  frames: Array<{ seq: number; t: number; text: string }>;
  final: { grid: Cell[][]; cursor: Cursor };
  exitInfo: ExitInfo | null;
  recording: null | { cols: number; rows: number; startedAt: number; events: Array<[number, 'o' | 'i' | 'r', string]> };
}

export interface GameDriver {
  /** A named key or chord; `press.raw(bytes)` sends bytes exactly as given. */
  readonly press: ((key: string, options?: ActionOptions) => Promise<void>) & {
    raw(bytes: string, options?: ActionOptions): Promise<void>;
  };
  type(text: string, options?: ActionOptions): Promise<void>;
  paste(text: string, options?: ActionOptions): Promise<void>;
  readonly mouse: {
    click(x: number, y: number, options?: MouseOptions & { clickCount?: number }): Promise<void>;
    down(x: number, y: number, options?: MouseOptions): Promise<void>;
    up(x: number, y: number, options?: MouseOptions): Promise<void>;
    move(x: number, y: number, options?: MouseOptions): Promise<void>;
    wheel(x: number, y: number, options?: MouseOptions & { deltaY?: number }): Promise<void>;
    drag(from: { x: number; y: number }, to: { x: number; y: number }, options?: MouseOptions): Promise<void>;
  };

  expectText(needle: TextMatcher, options?: TimeoutOptions): Promise<void>;
  expectNotText(needle: TextMatcher, options?: TimeoutOptions & { holdFor?: number }): Promise<void>;
  expectSeen(needle: TextMatcher, options?: TimeoutOptions & { since?: 'start' }): Promise<void>;
  expectScreen(matcher: ScreenMatcher, options?: SnapshotOptions): Promise<void>;
  expectState<S>(getState: () => S | Promise<S>, matcher: (state: S) => boolean, options?: TimeoutOptions & { pollInterval?: number }): Promise<void>;
  expectNoFlicker(options?: TimeoutOptions & { quiet?: number }): Promise<void>;
  expectLayout(locator: Locator, check: LayoutCheck, args?: unknown[], options?: TimeoutOptions & { not?: boolean }): Promise<void>;
  expectCount(locator: Locator, count: number, options?: TimeoutOptions): Promise<void>;
  expectFocusGroup(locator: Locator, indicators?: FocusIndicators, options?: TimeoutOptions): Promise<void>;
  expectCursorAt(target: { x: number; y: number } | Locator, options?: TimeoutOptions): Promise<void>;
  expectCursorVisible(visible?: boolean, options?: TimeoutOptions): Promise<void>;
  expectTerminal(check: TerminalCheck, args?: unknown[], options?: TimeoutOptions & { not?: boolean }): Promise<void>;
  expectExit(expected?: { code?: number; signal?: string | number }, options?: TimeoutOptions): Promise<void>;
  waitForStable(options?: TimeoutOptions & { quiet?: number }): Promise<void>;
  waitForExit(options?: TimeoutOptions): Promise<ExitInfo>;

  locator(target?: LocatorTarget, options?: LocatorOptions): Locator;
  getFocused(locator: Locator, indicators?: FocusIndicators): Rect[];
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  resize(cols: number, rows: number): Promise<void>;
  kill(signal?: string): void;
  stop(options?: TimeoutOptions): Promise<ExitInfo>;

  getScreenText(): string;
  getScrollbackText(): string;
  getCursor(): Cursor;
  getSize(): TerminalSize;
  getModes(): TerminalModes;
  renderHtml(options?: { title?: string }): string;
  getTrace(): Trace;
  getScreenCells(): Cell[][];
  observe(listener: (event: GameObserverEvent) => void): { dispose(): void };
  readonly actions: ActionRecord[];
}

export type GameObserverEvent =
  | { type: 'screen' }
  | { type: 'action'; action: ActionRecord }
  | { type: 'exit'; exitInfo: ExitInfo };

export interface LaunchOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  expectTimeout?: number;
  killSignal?: string;
  killTimeout?: number;
  getDiagnostics?: (() => string | Promise<string>) | null;
  scenarioName?: string | null;
  keys?: Record<string, string>;
  snapshotsDir?: string;
  updateSnapshots?: boolean;
  term?: string;
  colorDepth?: 'none' | 16 | 256 | 'truecolor';
  locale?: string;
  focus?: FocusIndicators;
  historySize?: number;
  scrollback?: number;
  /** Keep an asciinema-style recording of the session and each action's screen (for traces). */
  record?: boolean;
  /** false: run with plain pipes instead of a terminal (isTTY is false in the app). */
  tty?: boolean;
}

export function launchGame(options: LaunchOptions): Promise<GameDriver>;

export const KEY_SEQUENCES: Readonly<Record<string, string>>;
export function resolveKey(key: string, table?: Record<string, string>): string;
export function encodeMouse(
  event: { x: number; y: number; button?: 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | null; action?: 'press' | 'release' | 'move'; modifiers?: Array<'shift' | 'alt' | 'ctrl'> },
  encoding?: TerminalModes['mouseEncoding'],
): string;
export function renderScreenHtml(grid: Cell[][], options?: { cursor?: Cursor | null; title?: string }): string;
export function renderScreenAnsi(grid: Cell[][], cursor?: Cursor | null): string[];

export interface ProcessHandle {
  onData(callback: (chunk: string) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  waitForExit(): Promise<ExitInfo>;
  getExitInfo(): ExitInfo | null;
  kill(signal?: string): void;
  pid: number;
}

export function spawnPty(options: { command: string; args?: string[]; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv; term?: string }): ProcessHandle;
export function spawnPipe(options: { command: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }): ProcessHandle;

export interface VirtualTerminal {
  write(data: string, onParsed?: () => void): Promise<void>;
  resize(cols: number, rows: number): void;
  getScreenText(): string;
  getScreenLines(): string[];
  getScreenCells(): Cell[][];
  getWrappedRows(): boolean[];
  getScrollbackLines(): string[];
  getModes(): TerminalModes;
  getSignals(): { title: string; bellCount: number; hyperlinks: Array<{ uri: string; text: string }>; clipboardWrites: string[] };
  getCursor(): Cursor;
  getBufferType(): 'normal' | 'alternate';
  getSize(): TerminalSize;
  onReply(listener: (data: string) => void): { dispose(): void };
  dispose(): void;
}

export function createVirtualTerminal(options?: { cols?: number; rows?: number; scrollback?: number; convertEol?: boolean }): VirtualTerminal;
