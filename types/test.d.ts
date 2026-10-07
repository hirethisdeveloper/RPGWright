// Type declarations for the test runner API (`require('rpgwright/test')`).

import type {
  ExitInfo,
  FocusIndicators,
  GameDriver,
  LaunchOptions,
  Locator,
  Rect,
  SnapshotOptions,
  StyleSpec,
  TextMatcher,
  TimeoutOptions,
  MouseTrackingMode,
} from './index';

export interface Viewport {
  name: string;
  cols: number;
  rows: number;
}

export interface TestInfo {
  title: string;
  titlePath: string[];
  file: string;
  line: number | null;
  /** 0 on the first attempt, then 1, 2... when retries are on. */
  retry: number;
  repeatEachIndex: number;
  workerIndex: number;
  viewport?: Viewport;
  outputDir: string;
  readonly timeout: number;
  setTimeout(ms: number): void;
  slow(): void;
}

/** The fixtures every test can request by destructuring them. */
export interface BuiltinFixtures {
  game: GameDriver;
  viewport: Viewport;
  /** A fresh directory used as HOME for the app, removed afterwards. */
  tmpHome: string;
  /** Starts another process with the config's options plus these; stopped after the test. */
  launch: (options?: Partial<LaunchOptions>) => Promise<GameDriver>;
  testInfo: TestInfo;
}

/** A fixture definition for test.extend(): a value, or a setup/use/cleanup function. */
export type FixtureDefinition<V, F> =
  | V
  | ((fixtures: F, use: (value: V) => Promise<void>, testInfo: TestInfo) => Promise<void>);

/** Options for test.use() and the config: any launch option, plus homeFiles. */
export type UseOptions = Partial<LaunchOptions> & {
  /** Files to create in an isolated HOME before the app starts. */
  homeFiles?: Record<string, string>;
};

export type TestFunction<F> = (fixtures: F) => void | Promise<void>;
export type HookFunction<F> = (fixtures: F) => void | Promise<void>;

export interface TestApi<F> {
  (name: string, fn: TestFunction<F>): void;
  skip(name: string, fn: TestFunction<F>): void;
  fixme(name: string, fn: TestFunction<F>): void;
  only(name: string, fn: TestFunction<F>): void;
  fail(name: string, fn: TestFunction<F>): void;
  /** One test per viewport (the config's, or the list given). */
  eachViewport(name: string, fn: TestFunction<F>): void;
  eachViewport(viewports: Array<{ name?: string; cols: number; rows: number }>, name: string, fn: TestFunction<F>): void;
  extend<E extends Record<string, unknown>>(defs: { [K in keyof E]: FixtureDefinition<E[K], F & E> }): TestApi<F & E>;

  use(options: UseOptions): void;
  beforeEach(fn: HookFunction<F>): void;
  afterEach(fn: HookFunction<F>): void;
  beforeAll(fn: () => void | Promise<void>): void;
  afterAll(fn: () => void | Promise<void>): void;
  setTimeout(ms: number): void;
  slow(): void;
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  info(): TestInfo;
  describe: Describe;
}

export interface Describe {
  (name: string, fn: () => void): void;
  skip(name: string, fn: () => void): void;
  only(name: string, fn: () => void): void;
}

export interface LocatorAssertions {
  toBeVisible(options?: TimeoutOptions): Promise<void>;
  toHaveBox(box: Partial<Record<keyof Rect, number | [number, number]>>, options?: TimeoutOptions & { tolerance?: number }): Promise<void>;
  toBeAt(x: number, y: number, options?: TimeoutOptions): Promise<void>;
  toBeWithinScreen(options?: TimeoutOptions): Promise<void>;
  toBeWithin(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toOverlap(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toBeLeftOf(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toBeRightOf(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toBeAbove(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toBeBelow(other: Locator | Rect, options?: TimeoutOptions): Promise<void>;
  toHaveGap(other: Locator | Rect, options?: TimeoutOptions & { min?: number; max?: number; axis?: 'x' | 'y' }): Promise<void>;
  toBeAligned(
    edge: 'left' | 'right' | 'top' | 'bottom' | 'center' | 'middle',
    options?: TimeoutOptions & { with?: Locator | Rect | 'screen'; tolerance?: number },
  ): Promise<void>;
  toFitWithoutClipping(options?: TimeoutOptions): Promise<void>;
  toHaveText(needle: TextMatcher, options?: TimeoutOptions): Promise<void>;
  toHaveStyle(style: StyleSpec, options?: TimeoutOptions): Promise<void>;
  toBeFocused(options?: TimeoutOptions & FocusIndicators): Promise<void>;
}

export interface LocatorMatchers extends LocatorAssertions {
  toHaveCount(count: number, options?: TimeoutOptions): Promise<void>;
  toHaveExactlyOneFocused(options?: TimeoutOptions & FocusIndicators): Promise<void>;
  not: LocatorAssertions;
}

export interface TerminalAssertions {
  toBeInAltScreen(options?: TimeoutOptions): Promise<void>;
  toHaveTitle(title: TextMatcher, options?: TimeoutOptions): Promise<void>;
  toHaveBell(options?: TimeoutOptions): Promise<void>;
  toHaveMouseTracking(mode?: MouseTrackingMode, options?: TimeoutOptions): Promise<void>;
  toHaveBracketedPaste(options?: TimeoutOptions): Promise<void>;
  toHaveHyperlink(url: TextMatcher, options?: TimeoutOptions & { text?: TextMatcher }): Promise<void>;
  toHaveCopied(text: TextMatcher, options?: TimeoutOptions): Promise<void>;
  toHaveScrollbackText(text: TextMatcher, options?: TimeoutOptions): Promise<void>;
}

export interface GameMatchers extends TerminalAssertions {
  toHaveText(needle: TextMatcher, options?: TimeoutOptions): Promise<void>;
  toMatchScreen(matcher: string | RegExp, options?: SnapshotOptions): Promise<void>;
  toMatchScreenSnapshot(name: string, options?: SnapshotOptions): Promise<void>;
  toHaveState<S>(getState: () => S | Promise<S>, matcher: (state: S) => boolean, options?: TimeoutOptions & { pollInterval?: number }): Promise<void>;
  toHaveCursorAt(x: number, y: number, options?: TimeoutOptions): Promise<void>;
  toHaveCursorAt(region: Locator, options?: TimeoutOptions): Promise<void>;
  toHaveCursorVisible(options?: TimeoutOptions): Promise<void>;
  toHaveExited(expected?: { code?: number; signal?: string | number }, options?: TimeoutOptions): Promise<void>;
  not: TerminalAssertions & {
    toHaveText(needle: TextMatcher, options?: TimeoutOptions & { holdFor?: number }): Promise<void>;
    toHaveCursorVisible(options?: TimeoutOptions): Promise<void>;
  };
}

export function expect(locator: Locator): LocatorMatchers;
export function expect(game: GameDriver): GameMatchers;

export const test: TestApi<BuiltinFixtures>;
export const describe: Describe;

/** The shape of rpgwright.config.js. */
export interface Config extends UseOptions {
  command: string;
  testDir?: string;
  testMatch?: string | string[];
  timeout?: number;
  reporter?: ReporterName | Array<ReporterName | [ReporterName, { outputFile?: string }]>;
  viewports?: Array<{ name?: string; cols: number; rows: number }>;
  trace?: 'off' | 'on' | 'retain-on-failure';
  /** Write a `.run.json` per test (for `rpgwright play`), like `--save-run`. */
  saveRun?: boolean;
  outputDir?: string;
  retries?: number;
  workers?: number;
  services?: Array<{
    command: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    name?: string;
    readyText?: TextMatcher;
    readyPort?: number;
    timeout?: number;
  }>;
  globalSetup?: string;
  globalTeardown?: string;
  watchPaths?: string[];
}

export type ReporterName = 'list' | 'dot' | 'json' | 'junit' | 'github';

export type { ExitInfo };
