'use strict';

/**
 * Screen geometry over a styled cell grid (`cells[y][x]`, as
 * terminal.getScreenCells() returns): finding text and bordered boxes,
 * resolving locators to rectangles, and the pure layout checks that
 * GameDriver's locator assertions wait on. No PTY, no waiting, no I/O, so
 * all of it is unit-testable against a synthetic grid.
 *
 * Coordinates are 0-based cells. A rect is { x, y, width, height }; its
 * right edge is x + width (exclusive) and its bottom edge is y + height.
 */

const { formatNeedle, matchesNeedle } = require('./assertions');

// ---------------------------------------------------------------- rects --

function right(r) {
  return r.x + r.width;
}

function bottom(r) {
  return r.y + r.height;
}

function formatRect(r) {
  return `(x=${r.x}, y=${r.y}, ${r.width}×${r.height})`;
}

function isRect(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isInteger(value[k]))
  );
}

function overlaps(a, b) {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
}

// Blank cells between a and b along one axis; negative when their spans
// overlap on that axis (by that many cells).
function gapX(a, b) {
  return Math.max(a.x, b.x) - Math.min(right(a), right(b));
}

function gapY(a, b) {
  return Math.max(a.y, b.y) - Math.min(bottom(a), bottom(b));
}

// ----------------------------------------------------------------- text --

// What a cell shows: a never-written cell (ch '', width 1) shows a space;
// a wide character's continuation cell (width 0) shows nothing.
function cellText(cell) {
  return cell.ch === '' && cell.width !== 0 ? ' ' : cell.ch;
}

/**
 * The screen as one string (rows right-trimmed and joined with \n, the same
 * text getScreenText() returns) plus, for every UTF-16 code unit in it, the
 * cell it came from. Wide characters and multi-code-unit characters are why
 * a string index can't be used as a column directly.
 */
function screenIndex(grid) {
  let text = '';
  const positions = [];
  grid.forEach((row, y) => {
    if (y > 0) {
      text += '\n';
      positions.push(null);
    }
    // Trim only never-written cells (and wide-character continuations
    // among them), as xterm's translateToString(true) does: spaces the app
    // actually wrote are part of the text.
    let end = row.length;
    while (end > 0 && row[end - 1].ch === '') end -= 1;
    for (let x = 0; x < end; x += 1) {
      const { width } = row[x];
      const ch = cellText(row[x]);
      for (let i = 0; i < ch.length; i += 1) positions.push({ x, y, width: Math.max(width, 1) });
      text += ch;
    }
  });
  return { text, positions };
}

function spanRect(positions, start, end) {
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = -Infinity;
  let maxY = -Infinity;
  for (let i = start; i < end; i += 1) {
    const p = positions[i];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxRight = Math.max(maxRight, p.x + p.width);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxRight - minX, height: maxY - minY + 1 };
}

/**
 * Every occurrence of `needle` (string, or RegExp tested against the full
 * screen text) as a bounding rect, in reading order. A match spanning
 * several rows yields the rect covering all of it.
 */
function findText(grid, needle) {
  const { text, positions } = screenIndex(grid);
  const rects = [];
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes('g') ? needle.flags : `${needle.flags}g`;
    for (const match of text.matchAll(new RegExp(needle.source, flags))) {
      if (match[0].length === 0) continue;
      const rect = spanRect(positions, match.index, match.index + match[0].length);
      if (rect) rects.push(rect);
    }
    return rects;
  }
  if (typeof needle !== 'string' || needle.length === 0) return rects;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    const rect = spanRect(positions, i, i + needle.length);
    if (rect) rects.push(rect);
  }
  return rects;
}

// The text inside a rect: each covered row's slice, right-trimmed.
function textIn(grid, r) {
  const lines = [];
  for (let y = r.y; y < bottom(r) && y < grid.length; y += 1) {
    lines.push(
      grid[y]
        .slice(r.x, right(r))
        .map(cellText)
        .join('')
        .replace(/\s+$/, ''),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- boxes --

// Box-drawing characters as Ink's borderStyle values (and most TUI
// libraries) draw them: single, round, double, bold/heavy, the mixed
// single/double styles, and classic ASCII. Junctions (├ ┬ ┼ ...) count as
// corners where geometry allows, so panels split by dividers and table
// cells are found as boxes too.
const TOP_LEFT = new Set('┌╭╔┏╓╒┍┎+├┬┼╠╦╬┣┳╋╟╤╞┝┠');
const TOP_RIGHT = new Set('┐╮╗┓╖╕┑┒+┤┬┼╣╦╬┫┳╋╢╤╡┥┨');
const BOTTOM_LEFT = new Set('└╰╚┗╙╘┕┖+├┴┼╠╩╬┣┻╋╟╧╞┝┠');
const BOTTOM_RIGHT = new Set('┘╯╝┛╜╛┙┚+┤┴┼╣╩╬┫┻╋╢╧╡┥┨');
const VERTICAL = new Set('│┃║|╎╏┆┇┊┋├┤┼╟╢╠╣┝┥┿╞╡╪┠┨╂┣┫╋');
// Pure corners can't sit in the middle of a box's top or bottom edge: one
// there means the scan has run from one box into the next.
const PURE_CORNERS = new Set('┌┐└┘╭╮╰╯╔╗╚╝┏┓┗┛╓╖╙╜╒╕╘╛┍┑┕┙┎┒┖┚');
const BORDER_CHARS = new Set([...TOP_LEFT, ...TOP_RIGHT, ...BOTTOM_LEFT, ...BOTTOM_RIGHT, ...VERTICAL, ...'─━═-╌╍┄┅┈┉']);

function edgeIsOpen(grid, y, x1, x2) {
  for (let x = x1 + 1; x < x2; x += 1) {
    if (PURE_CORNERS.has(grid[y][x].ch)) return false;
  }
  return true;
}

// A corner is only a corner if the edge leaving it is drawn: the cells next
// to it along the edge are border characters. Without this, ASCII '+' in
// ordinary text ("a+b" on two lines) made boxes.
function edgeStarts(grid, y, x1, x2) {
  return BORDER_CHARS.has(grid[y][x1 + 1].ch) && BORDER_CHARS.has(grid[y][x2 - 1].ch);
}

function boxTitle(grid, y, x1, x2) {
  return grid[y]
    .slice(x1 + 1, x2)
    .map((c) => (BORDER_CHARS.has(c.ch) ? ' ' : cellText(c)))
    .join('')
    .trim()
    .replace(/\s+/g, ' ');
}

// Grids are immutable snapshots (terminal.js replaces, never mutates, its
// cached grid), so each one's boxes are found once however many locators
// and checks ask for them on the same screen update.
const boxCache = new WeakMap();

/**
 * Every rectangle drawn with box-drawing characters, innermost (smallest
 * area) first. Each box is a rect (border included) plus `inner` (the rect
 * inside the border) and `title` (any text drawn into the top edge, read
 * on first access). The returned array is shared: copy it before sorting.
 */
function findBoxes(grid) {
  if (boxCache.has(grid)) return boxCache.get(grid);
  const boxes = [];
  const rows = grid.length;
  for (let y = 0; y + 1 < rows; y += 1) {
    const cols = grid[y].length;
    for (let x = 0; x < cols; x += 1) {
      if (!TOP_LEFT.has(grid[y][x].ch)) continue;
      const below = grid[y + 1][x].ch;
      if (!VERTICAL.has(below) && !BOTTOM_LEFT.has(below)) continue;
      for (let x2 = x + 1; x2 < cols; x2 += 1) {
        const ch = grid[y][x2].ch;
        if (TOP_RIGHT.has(ch) && edgeStarts(grid, y, x, x2)) {
          for (let y2 = y + 1; y2 < rows; y2 += 1) {
            const leftCh = grid[y2][x].ch;
            const rightCh = grid[y2][x2].ch;
            if (BOTTOM_LEFT.has(leftCh) && BOTTOM_RIGHT.has(rightCh) && edgeStarts(grid, y2, x, x2) && edgeIsOpen(grid, y2, x, x2)) {
              boxes.push(makeBox(grid, x, y, x2, y2));
            }
            if (!VERTICAL.has(leftCh) || !VERTICAL.has(rightCh)) break;
          }
        }
        // A pure corner ends this top edge: past it, the scan would be in
        // the next box.
        if (PURE_CORNERS.has(ch)) break;
      }
    }
  }
  boxes.sort((a, b) => a.width * a.height - b.width * b.height || a.y - b.y || a.x - b.x);
  boxCache.set(grid, boxes);
  return boxes;
}

function makeBox(grid, x, y, x2, y2) {
  const box = { x, y, width: x2 - x + 1, height: y2 - y + 1 };
  box.inner = { x: x + 1, y: y + 1, width: Math.max(0, box.width - 2), height: Math.max(0, box.height - 2) };
  let title;
  Object.defineProperty(box, 'title', {
    enumerable: true,
    get: () => (title ??= boxTitle(grid, y, x, x2)),
  });
  return box;
}

// ------------------------------------------------------------- locators --

function formatTarget(target) {
  if (target === undefined) return 'screen';
  if (target instanceof RegExp) return target.toString();
  if (typeof target === 'string') return JSON.stringify(target);
  if (isRect(target)) return formatRect(target);
  if (target && target.box !== undefined) {
    const { containing } = target.box === true ? {} : target.box;
    return containing === undefined ? 'box' : `box containing ${formatTarget(containing)}`;
  }
  if (target && Number.isInteger(target.row)) return `row ${target.row}`;
  return JSON.stringify(target);
}

function sortReadingOrder(rects) {
  return rects.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * All rects a locator target matches on `grid`:
 * - undefined: the whole screen
 * - string / RegExp: each text match
 * - { x, y, width, height }: that rect, as given
 * - { row: n }: the whole of row n
 * - { box: true } / { box: { containing } }: bordered boxes (optionally only
 *   those whose title or interior contains a text match), innermost first
 */
function resolveTarget(grid, target) {
  const cols = grid.length ? grid[0].length : 0;
  if (target === undefined) return [{ x: 0, y: 0, width: cols, height: grid.length }];
  if (typeof target === 'string' || target instanceof RegExp) return findText(grid, target);
  if (isRect(target)) return [target];
  if (target && Number.isInteger(target.row)) {
    return target.row >= 0 && target.row < grid.length ? [{ x: 0, y: target.row, width: cols, height: 1 }] : [];
  }
  if (target && target.box !== undefined) {
    const boxes = findBoxes(grid);
    const containing = target.box === true ? undefined : target.box.containing;
    if (containing === undefined) return boxes.slice();
    const hits = findText(grid, containing);
    return boxes.filter((box) => hits.some((hit) => contains(box, hit)));
  }
  throw new Error(`Unsupported locator target ${JSON.stringify(target)}.`);
}

/**
 * A lazy description of a region of the screen. It holds no rect of its
 * own: every read resolves it against the screen as it is right then, which
 * is what lets assertions on it wait for redraws.
 *
 * `source` supplies the grid (`getScreenCells`) and is carried through so
 * runner/expect.js can reach the owning GameDriver.
 */
function createLocator(source, target, { nth = null, within = null } = {}) {
  function resolveAll(grid = source.getScreenCells()) {
    let rects = resolveTarget(grid, target);
    if (within) {
      const containers = within.resolveAll(grid);
      rects = rects.filter((r) => containers.some((c) => contains(c, r)));
    }
    if (!(target && target.box !== undefined)) rects = sortReadingOrder(rects);
    if (nth === null) return rects;
    const picked = rects[nth < 0 ? rects.length + nth : nth];
    return picked ? [picked] : [];
  }

  // The single rect this locator matches, or an explanation of why it
  // doesn't match exactly one (locators are strict, like Playwright's).
  function resolveOne(grid) {
    const rects = resolveAll(grid);
    if (rects.length === 1) return { rect: rects[0] };
    if (rects.length === 0) return { error: `${describe()} matched nothing` };
    return {
      error: `${describe()} matched ${rects.length} regions (${rects.map(formatRect).join(', ')}); use .first(), .last() or .nth(i) to pick one`,
    };
  }

  function describe() {
    let text = `locator(${formatTarget(target)})`;
    if (within) text = `${within.describe()}.locator(${formatTarget(target)})`;
    if (nth !== null) text += nth === 0 ? '.first()' : nth === -1 ? '.last()' : `.nth(${nth})`;
    return text;
  }

  function strictRect() {
    const { rect, error } = resolveOne();
    if (error && !error.endsWith('matched nothing')) throw new Error(error);
    return rect || null;
  }

  // The cell a click or hover aims at: the region's center (left of center
  // for an even width, as a user aiming at the middle would land).
  function center() {
    const rect = strictRect();
    if (!rect) throw new Error(`${describe()} matched nothing, so there is nowhere to point the mouse.`);
    return { x: rect.x + Math.floor((rect.width - 1) / 2), y: rect.y + Math.floor((rect.height - 1) / 2) };
  }

  const locator = {
    _isLocator: true,
    source,
    target,
    resolveAll,
    resolveOne,
    describe,
    nth: (i) => createLocator(source, target, { nth: i, within }),
    first: () => createLocator(source, target, { nth: 0, within }),
    last: () => createLocator(source, target, { nth: -1, within }),
    locator: (inner, opts) => createLocator(source, inner, { ...opts, within: locator }),
    count: () => resolveAll().length,
    boundingBox: strictRect,
    textContent() {
      const rect = strictRect();
      return rect ? textIn(source.getScreenCells(), rect) : null;
    },
    click(opts) {
      const { x, y } = center();
      return source.driver.mouse.click(x, y, opts);
    },
    hover(opts) {
      const { x, y } = center();
      return source.driver.mouse.move(x, y, opts);
    },
    cells() {
      const rect = strictRect();
      if (!rect) return null;
      return source
        .getScreenCells()
        .slice(rect.y, bottom(rect))
        .map((row) => row.slice(rect.x, right(rect)));
    },
  };
  return locator;
}

// ---------------------------------------------------------------- style --

const NAMED_COLORS = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, grey: 8, brightBlack: 8, brightRed: 9, brightGreen: 10, brightYellow: 11,
  brightBlue: 12, brightMagenta: 13, brightCyan: 14, brightWhite: 15,
};
const STYLE_FLAGS = ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'];

// A color in a style spec: null or 'default' (the terminal's default), a
// palette index, a name from NAMED_COLORS, or '#rrggbb'. Returns the same
// shape terminal.js uses for cells.
function normalizeColor(color) {
  if (color === null || color === 'default') return null;
  if (Number.isInteger(color) && color >= 0 && color <= 255) return { palette: color };
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return { rgb: color.toLowerCase() };
  if (typeof color === 'string' && NAMED_COLORS[color] !== undefined) return { palette: NAMED_COLORS[color] };
  throw new Error(`Unknown color ${JSON.stringify(color)}. Use null, a palette index 0-255, '#rrggbb', or one of: ${Object.keys(NAMED_COLORS).join(', ')}.`);
}

function sameColor(a, b) {
  if (a === null || b === null) return a === b;
  return a.palette === b.palette && a.rgb === b.rgb;
}

function formatColor(color) {
  if (color === null) return 'default';
  return color.rgb || `palette ${color.palette}`;
}

function formatCellStyle(cell) {
  const flags = STYLE_FLAGS.filter((f) => cell[f]);
  return [`fg=${formatColor(cell.fg)}`, `bg=${formatColor(cell.bg)}`, ...flags].join(', ');
}

function formatStyleSpec(spec) {
  return Object.entries(spec)
    .map(([k, v]) => `${k}=${k === 'fg' || k === 'bg' ? formatColor(normalizeColor(v)) : v}`)
    .join(', ');
}

// The first cell (non-blank cells only) that differs from `spec`, or null
// when every one matches. Fields absent from `spec` aren't compared.
function firstStyleMismatch(grid, rect, spec) {
  const fg = spec.fg === undefined ? undefined : normalizeColor(spec.fg);
  const bg = spec.bg === undefined ? undefined : normalizeColor(spec.bg);
  let visible = 0;
  for (let y = rect.y; y < bottom(rect) && y < grid.length; y += 1) {
    for (let x = rect.x; x < right(rect) && x < grid[y].length; x += 1) {
      const cell = grid[y][x];
      if (cell.ch === ' ' || cell.ch === '') continue;
      visible += 1;
      const differs =
        (fg !== undefined && !sameColor(cell.fg, fg)) ||
        (bg !== undefined && !sameColor(cell.bg, bg)) ||
        STYLE_FLAGS.some((f) => spec[f] !== undefined && cell[f] !== spec[f]);
      if (differs) return { x, y, cell };
    }
  }
  return visible === 0 ? { empty: true } : null;
}

// ------------------------------------------------------------ snapshots --

const BLANK_CELL = Object.freeze({
  ch: ' ', width: 1, fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false, invisible: false,
});

// A copy of `grid` with every cell inside `rects` replaced by `ch` in the
// default style, so volatile content (clocks, IDs) can't fail a snapshot.
function maskGrid(grid, rects, ch = '*') {
  if (rects.length === 0) return grid;
  return grid.map((row, y) =>
    row.map((cell, x) => (rects.some((r) => x >= r.x && x < right(r) && y >= r.y && y < bottom(r)) ? { ...BLANK_CELL, ch } : cell)),
  );
}

// The same text getScreenText() would return for this grid.
function gridText(grid) {
  return screenIndex(grid).text;
}

// The style of a cell as it actually looks. On a blank cell only the
// background, inverse and underline are visible, so the rest is dropped:
// otherwise a renderer's choice to color the padding around text would
// change the snapshot without changing anything on screen.
function visibleStyleKey(cell) {
  const blank = cell.ch === ' ' || cell.ch === '';
  const parts = [];
  if (!blank && cell.fg) parts.push(`fg=${cell.fg.rgb || cell.fg.palette}`);
  if (cell.bg) parts.push(`bg=${cell.bg.rgb || cell.bg.palette}`);
  for (const flag of STYLE_FLAGS) {
    if (blank && flag !== 'inverse' && flag !== 'underline') continue;
    if (cell[flag]) parts.push(flag);
  }
  return parts.join(' ');
}

/**
 * The screen's styling as text, for a styled snapshot: one line per run of
 * identically styled cells, as "y:x+width style", skipping unstyled cells.
 * Diff-friendly and readable in a pull request.
 */
function styleSpans(grid) {
  const lines = [];
  grid.forEach((row, y) => {
    let start = 0;
    for (let x = 1; x <= row.length; x += 1) {
      const key = visibleStyleKey(row[start]);
      if (x < row.length && visibleStyleKey(row[x]) === key) continue;
      if (key) lines.push(`${y}:${start}+${x - start} ${key}`);
      start = x;
    }
  });
  return lines.join('\n');
}

// Expands styleSpans() output back to a map of "x,y" -> style key.
function parseStyleSpans(text) {
  const cells = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\d+):(\d+)\+(\d+) (.+)$/.exec(line);
    if (!match) continue;
    const [, y, x, width, key] = match;
    for (let i = 0; i < Number(width); i += 1) cells.set(`${Number(x) + i},${y}`, key);
  }
  return cells;
}

/**
 * How many cells differ between two captures ({ text, styles? }): a
 * character that differs, or (when both have styles) a style that differs.
 */
function countCellDiffs(expected, actual) {
  let diffs = 0;
  const expectedRows = expected.text.split('\n');
  const actualRows = actual.text.split('\n');
  for (let y = 0; y < Math.max(expectedRows.length, actualRows.length); y += 1) {
    const a = [...(expectedRows[y] || '')];
    const b = [...(actualRows[y] || '')];
    for (let x = 0; x < Math.max(a.length, b.length); x += 1) if (a[x] !== b[x]) diffs += 1;
  }
  if (expected.styles !== undefined && actual.styles !== undefined) {
    const a = parseStyleSpans(expected.styles);
    const b = parseStyleSpans(actual.styles);
    for (const key of new Set([...a.keys(), ...b.keys()])) if (a.get(key) !== b.get(key)) diffs += 1;
  }
  return diffs;
}

// ---------------------------------------------------------------- focus --

// Used when neither launchGame's `focus` option nor the assertion gives
// any indicator: the hardware cursor, or inverse video, the two most
// common ways a terminal UI marks focus.
const DEFAULT_FOCUS = { cursor: true, style: { inverse: true } };

/**
 * Which of the configured focus indicators mark `rect`:
 * - marker: the text immediately left of the region on its first row ends
 *   with this string (e.g. '> '), or matches this RegExp
 * - style: every visible cell in the region has this style
 * - cursor: the visible hardware cursor is inside the region or just
 *   after it on the same row (where a text input's cursor sits)
 */
function focusIndicators(grid, rect, cursor, focus = DEFAULT_FOCUS) {
  const found = [];
  if (focus.marker !== undefined) {
    const prefix = grid[rect.y].slice(0, rect.x).map(cellText).join('');
    const hit = focus.marker instanceof RegExp ? matchesNeedle(prefix, focus.marker) : prefix.endsWith(focus.marker);
    if (hit) found.push('marker');
  }
  if (focus.style !== undefined && firstStyleMismatch(grid, rect, focus.style) === null) found.push('style');
  if (focus.cursor && cursor && cursor.visible) {
    const inRow = cursor.y >= rect.y && cursor.y < bottom(rect);
    if (inRow && cursor.x >= rect.x && cursor.x <= right(rect)) found.push('cursor');
  }
  return found;
}

function describeFocus(focus) {
  const parts = [];
  if (focus.marker !== undefined) parts.push(`marker ${focus.marker instanceof RegExp ? focus.marker : JSON.stringify(focus.marker)}`);
  if (focus.style !== undefined) parts.push(`style {${formatStyleSpec(focus.style)}}`);
  if (focus.cursor) parts.push('cursor');
  return parts.join(' or ');
}

// --------------------------------------------------------------- checks --

// A layout check's other operands may be a locator or a plain rect.
function resolveOperand(operand, grid) {
  if (operand && operand._isLocator) return operand.resolveOne(grid);
  if (isRect(operand)) return { rect: operand };
  return { error: `expected a locator or a { x, y, width, height } rect, got ${JSON.stringify(operand)}` };
}

function describeOperand(operand) {
  return operand && operand._isLocator ? operand.describe() : formatRect(operand);
}

function inRange(actual, wanted, tolerance) {
  if (Array.isArray(wanted)) return actual >= wanted[0] && actual <= wanted[1];
  return Math.abs(actual - wanted) <= tolerance;
}

function describeRange(wanted, tolerance) {
  if (Array.isArray(wanted)) return `${wanted[0]}..${wanted[1]}`;
  return tolerance ? `${wanted}±${tolerance}` : String(wanted);
}

const EDGES = {
  left: (r) => r.x,
  right: (r) => right(r),
  top: (r) => r.y,
  bottom: (r) => bottom(r),
  // Centers are doubled to stay in integers; a 1-cell difference in doubled
  // units is the unavoidable half-cell off-center of odd/even widths.
  center: (r) => r.x * 2 + r.width,
  middle: (r) => r.y * 2 + r.height,
};

/**
 * Each check takes (rect, ctx, ...args) and returns { pass, expected,
 * observed }. `rect` is the subject locator's single resolved rect; `ctx`
 * gives { grid, wrapped, size, other(operand) -> { rect } | { error } }.
 * `expected` is phrased to follow the subject's description; `observed`
 * reports the actual geometry for the failure report.
 */
const CHECKS = {
  toHaveBox(rect, ctx, wanted, { tolerance = 0 } = {}) {
    const keys = ['x', 'y', 'width', 'height'].filter((k) => wanted[k] !== undefined);
    return {
      pass: keys.every((k) => inRange(rect[k], wanted[k], tolerance)),
      expected: `to have ${keys.map((k) => `${k}=${describeRange(wanted[k], tolerance)}`).join(', ')}`,
      observed: `at ${formatRect(rect)}`,
    };
  },

  toBeWithinScreen(rect, ctx) {
    const { cols, rows } = ctx.size;
    return {
      pass: rect.x >= 0 && rect.y >= 0 && right(rect) <= cols && bottom(rect) <= rows,
      expected: `to be within the ${cols}×${rows} screen`,
      observed: `at ${formatRect(rect)}`,
    };
  },

  toBeWithin(rect, ctx, other) {
    return relation(ctx, other, `to be within`, (o) => contains(o, rect), rect);
  },

  toOverlap(rect, ctx, other) {
    return relation(ctx, other, `to overlap`, (o) => overlaps(rect, o), rect);
  },

  toBeLeftOf(rect, ctx, other) {
    return relation(ctx, other, 'to be left of', (o) => right(rect) <= o.x, rect);
  },

  toBeRightOf(rect, ctx, other) {
    return relation(ctx, other, 'to be right of', (o) => rect.x >= right(o), rect);
  },

  toBeAbove(rect, ctx, other) {
    return relation(ctx, other, 'to be above', (o) => bottom(rect) <= o.y, rect);
  },

  toBeBelow(rect, ctx, other) {
    return relation(ctx, other, 'to be below', (o) => rect.y >= bottom(o), rect);
  },

  // The blank cells separating the subject from `other` along the axis on
  // which they're apart. `axis` forces one ('x' or 'y') when they're
  // diagonal from each other.
  toHaveGap(rect, ctx, other, { min = 0, max = Infinity, axis } = {}) {
    const range = max === Infinity ? `at least ${min}` : min === max ? `exactly ${min}` : `${min}..${max}`;
    return relation(
      ctx,
      other,
      `to have a gap of ${range} cell${min === 1 && max === 1 ? '' : 's'} from`,
      (o) => {
        const gx = gapX(rect, o);
        const gy = gapY(rect, o);
        let gap;
        if (axis === 'x') gap = gx;
        else if (axis === 'y') gap = gy;
        else if (gx >= 0 && gy < 0) gap = gx;
        else if (gy >= 0 && gx < 0) gap = gy;
        else if (gx < 0) return { pass: false, note: 'they overlap' };
        else return { pass: false, unresolved: true, note: 'they are diagonal from each other; pass { axis: "x" } or { axis: "y" }' };
        return { pass: gap >= min && gap <= max, note: `gap is ${gap}` };
      },
      rect,
    );
  },

  toBeAligned(rect, ctx, edge, { with: other, tolerance } = {}) {
    // A typo is a mistake in the test, not a layout that differs: thrown,
    // so `not.toBeAligned('centre')` can't quietly pass.
    if (!EDGES[edge]) throw new Error(`toBeAligned: unknown edge ${JSON.stringify(edge)}; use ${Object.keys(EDGES).join(', ')}.`);
    const allowance = tolerance ?? (edge === 'center' || edge === 'middle' ? 1 : 0);
    const scale = edge === 'center' || edge === 'middle' ? 2 : 1;
    const compare = (o) => {
      const diff = EDGES[edge](rect) - EDGES[edge](o);
      return { pass: Math.abs(diff) <= allowance, note: `${edge} edges differ by ${diff / scale}` };
    };
    if (other === undefined || other === 'screen') {
      const screen = { x: 0, y: 0, width: ctx.size.cols, height: ctx.size.rows };
      const { pass, note } = compare(screen);
      return { pass, expected: `to be aligned ${edge} with the screen`, observed: `at ${formatRect(rect)}; ${note}` };
    }
    return relation(ctx, other, `to be aligned ${edge} with`, compare, rect);
  },

  // Two signals that text didn't fit: the terminal had to auto-wrap a row
  // inside (or just below) the region, or the region's text ends in a
  // truncation ellipsis (Ink's wrap="truncate" and most TUI libraries).
  // Merely touching the last column is not one: flush-right text does that.
  toFitWithoutClipping(rect, ctx) {
    let wrappedRow = -1;
    for (let y = rect.y + 1; y <= bottom(rect) && y < ctx.wrapped.length; y += 1) {
      if (ctx.wrapped[y]) {
        wrappedRow = y;
        break;
      }
    }
    const truncated = /(…|\.\.\.)$/m.test(textIn(ctx.grid, rect));
    const problems = [];
    if (wrappedRow !== -1) problems.push(`row ${wrappedRow} is a wrapped continuation`);
    if (truncated) problems.push('its text ends in a truncation ellipsis');
    return {
      pass: problems.length === 0,
      expected: 'to fit without clipping or wrapping',
      observed: `at ${formatRect(rect)}${problems.length ? `; ${problems.join(', ')}` : ''}`,
    };
  },

  toHaveStyle(rect, ctx, spec) {
    const mismatch = firstStyleMismatch(ctx.grid, rect, spec);
    let observed = `at ${formatRect(rect)}`;
    if (mismatch && mismatch.empty) observed += '; the region has no visible characters';
    else if (mismatch) observed += `; cell (${mismatch.x}, ${mismatch.y}) ${JSON.stringify(mismatch.cell.ch)} has ${formatCellStyle(mismatch.cell)}`;
    return { pass: mismatch === null, expected: `to have style {${formatStyleSpec(spec)}}`, observed };
  },

  toBeFocused(rect, ctx, focus) {
    const indicators = focus || ctx.focus || DEFAULT_FOCUS;
    const found = focusIndicators(ctx.grid, rect, ctx.cursor, indicators);
    return {
      pass: found.length > 0,
      expected: `to be focused (by ${describeFocus(indicators)})`,
      observed: `at ${formatRect(rect)}; ${found.length ? `marked by ${found.join(', ')}` : 'no focus indicator present'}${
        ctx.cursor ? `; cursor at (${ctx.cursor.x}, ${ctx.cursor.y})${ctx.cursor.visible ? '' : ' hidden'}` : ''
      }`,
    };
  },

  toHaveText(rect, ctx, needle) {
    const text = textIn(ctx.grid, rect);
    return {
      pass: matchesNeedle(text, needle),
      expected: `to contain text ${formatNeedle(needle)}`,
      observed: `at ${formatRect(rect)} containing ${JSON.stringify(text)}`,
    };
  },
};

function relation(ctx, other, phrase, compare, rect) {
  const resolved = ctx.other(other);
  const expected = `${phrase} ${describeOperand(other)}`;
  if (resolved.error) return { pass: false, unresolved: true, expected, observed: resolved.error };
  const result = compare(resolved.rect);
  const verdict = typeof result === 'boolean' ? { pass: result } : result;
  return {
    pass: verdict.pass,
    // A comparison that can't be made (no defined gap between diagonal
    // regions) fails negated or not, like an operand that isn't there.
    unresolved: verdict.unresolved,
    expected,
    observed: `at ${formatRect(rect)}; other at ${formatRect(resolved.rect)}${verdict.note ? `; ${verdict.note}` : ''}`,
  };
}

/**
 * For a locator matching a group of items (a menu's options, a list's
 * rows): passes when exactly one of them is focused. Unlike the CHECKS,
 * this one wants several matches.
 */
function evaluateFocusGroup(locator, focus, { grid, cursor }) {
  const indicators = focus || DEFAULT_FOCUS;
  const rects = locator.resolveAll(grid);
  const focused = rects.filter((r) => focusIndicators(grid, r, cursor, indicators).length > 0);
  return {
    pass: focused.length === 1,
    expected: `${locator.describe()} to have exactly one focused match (by ${describeFocus(indicators)})`,
    observed: `${rects.length} match${rects.length === 1 ? '' : 'es'}, ${focused.length} focused${
      focused.length ? `: ${focused.map((r) => `${JSON.stringify(textIn(grid, r))} ${formatRect(r)}`).join(', ')}` : ''
    }`,
    focused,
  };
}

/**
 * Runs one named check for `locator` against the current screen state.
 * Returns { pass, expected, observed }, where pass is already negated when
 * `negate` is set. A locator (or operand) that doesn't resolve to exactly
 * one region fails either way: "not left of" can't be confirmed for a
 * region that isn't there.
 */
function evaluateCheck(name, locator, args, { negate = false, grid, wrapped, size, cursor, focus }) {
  const check = CHECKS[name];
  if (!check) throw new Error(`Unknown layout check "${name}".`);
  const subject = locator.resolveOne(grid);
  const ctx = { grid, wrapped, size, cursor, focus, other: (operand) => resolveOperand(operand, grid) };
  if (subject.error) {
    // Run the check against a placeholder only to phrase `expected`; with
    // operands also unresolved, no geometry is compared.
    const placeholder = { x: 0, y: 0, width: 0, height: 0 };
    const { expected } = check(placeholder, { ...ctx, other: () => ({ error: subject.error }) }, ...args);
    return { pass: false, expected: `${negate ? 'not ' : ''}${expected}`, observed: subject.error };
  }
  const result = check(subject.rect, ctx, ...args);
  if (result.unresolved) return { pass: false, expected: `${negate ? 'not ' : ''}${result.expected}`, observed: result.observed };
  return {
    pass: negate ? !result.pass : result.pass,
    expected: `${negate ? 'not ' : ''}${result.expected}`,
    observed: result.observed,
  };
}

module.exports = {
  right,
  formatRect,
  isRect,
  overlaps,
  contains,
  gapX,
  gapY,
  findText,
  textIn,
  findBoxes,
  resolveTarget,
  createLocator,
  evaluateCheck,
  evaluateFocusGroup,
  normalizeColor,
  focusIndicators,
  DEFAULT_FOCUS,
  maskGrid,
  gridText,
  styleSpans,
  parseStyleSpans,
  countCellDiffs,
  CHECKS,
};
