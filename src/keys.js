'use strict';

/**
 * Named key -> raw byte sequence, covering the standard xterm/VT100 set.
 * F1-F4 use the SS3 (\x1bO) prefix per xterm convention; F5 and up use CSI
 * sequences that skip codes 16 and 22 (historically reserved/ambiguous).
 * Overridable/extendable per launchGame() via its `keys` option.
 */
const KEY_SEQUENCES = {
  ENTER: '\r',
  ESCAPE: '\x1b',
  TAB: '\t',
  BACKSPACE: '\x7f',
  DELETE: '\x1b[3~',
  ARROWUP: '\x1b[A',
  ARROWDOWN: '\x1b[B',
  ARROWLEFT: '\x1b[D',
  ARROWRIGHT: '\x1b[C',
  SPACE: ' ',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGEUP: '\x1b[5~',
  PAGEDOWN: '\x1b[6~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

const MODIFIER_ALIASES = {
  SHIFT: 'shift',
  CONTROL: 'ctrl',
  CTRL: 'ctrl',
  ALT: 'alt',
  OPTION: 'alt',
  META: 'alt',
};

// Single-character control bytes reachable with Ctrl, beyond the letters.
const CTRL_PUNCTUATION = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f' };

/**
 * Re-encodes a CSI/SS3 key sequence with an xterm modifier parameter
 * (1 + shift + 2*alt + 4*ctrl): `ESC[A` -> `ESC[1;5A`, `ESC[3~` ->
 * `ESC[3;5~`, `ESC OP` -> `ESC[1;5P`. Returns null for anything that isn't
 * one of those shapes (Enter, Tab, printable characters, ...).
 */
function withCsiModifier(sequence, param) {
  const ss3 = /^\x1bO([PQRS])$/.exec(sequence);
  if (ss3) return `\x1b[1;${param}${ss3[1]}`;
  const letter = /^\x1b\[([A-Z])$/.exec(sequence);
  if (letter) return `\x1b[1;${param}${letter[1]}`;
  const tilde = /^\x1b\[(\d+)~$/.exec(sequence);
  if (tilde) return `\x1b[${tilde[1]};${param}~`;
  return null;
}

function splitChord(key) {
  // "+" alone, or a trailing "++" ("Alt++"), names the plus key itself.
  if (key === '+') return { modifierNames: [], base: '+' };
  const parts = key.endsWith('++') ? [...key.slice(0, -2).split('+'), '+'] : key.split('+');
  return { modifierNames: parts.slice(0, -1), base: parts[parts.length - 1] };
}

function unknownKeyError(key) {
  return new Error(
    `Unknown key "${key}". Use press.raw(bytes) to send a literal byte sequence, or pass it via launchGame's "keys" option to extend the table.`,
  );
}

function unrepresentableError(key) {
  return new Error(
    `Key chord "${key}" has no standard terminal encoding (terminals can't distinguish it from the unmodified key). Use press.raw(bytes) if the target app expects a specific sequence.`,
  );
}

/**
 * Resolves a key name or a Playwright-style chord ("Control+ArrowLeft",
 * "Shift+Tab", "Alt+x", "Control+c") to the bytes a real xterm would send.
 * Exact entries in `table` always win, so the `keys` override and the legacy
 * names (CTRL_C, ARROWUP, ...) keep working unchanged. Key and modifier names
 * are case-insensitive except for single printable characters.
 */
function resolveKey(key, table = KEY_SEQUENCES) {
  if (typeof key !== 'string' || key.length === 0) throw unknownKeyError(key);
  if (table[key] !== undefined) return table[key];

  const { modifierNames, base } = splitChord(key);
  const mods = { shift: false, ctrl: false, alt: false };
  for (const name of modifierNames) {
    const mod = MODIFIER_ALIASES[name.toUpperCase()];
    if (!mod) throw unknownKeyError(key);
    mods[mod] = true;
  }

  const named = base.length > 1 ? table[base.toUpperCase()] : undefined;
  if (base.length > 1 && named === undefined) throw unknownKeyError(key);
  if (base.length === 0) throw unknownKeyError(key);

  if (named !== undefined) {
    if (!mods.shift && !mods.ctrl && !mods.alt) return named;
    const param = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
    const csi = withCsiModifier(named, param);
    if (csi) return csi;

    const upper = base.toUpperCase();
    if (upper === 'TAB' && mods.shift && !mods.ctrl) return `${mods.alt ? '\x1b' : ''}\x1b[Z`;
    if (mods.shift) throw unrepresentableError(key);
    let bytes = named;
    if (mods.ctrl) {
      if (upper === 'SPACE') bytes = '\x00';
      else if (upper === 'BACKSPACE') bytes = '\x08';
      else throw unrepresentableError(key);
    }
    return mods.alt ? `\x1b${bytes}` : bytes;
  }

  // A single printable character.
  let bytes = base;
  if (mods.shift) {
    if (base.toUpperCase() === base.toLowerCase()) throw unrepresentableError(key);
    bytes = base.toUpperCase();
  }
  if (mods.ctrl) {
    const lower = bytes.toLowerCase();
    if (lower >= 'a' && lower <= 'z') bytes = String.fromCharCode(lower.charCodeAt(0) - 96);
    else if (CTRL_PUNCTUATION[bytes] !== undefined) bytes = CTRL_PUNCTUATION[bytes];
    else throw unrepresentableError(key);
  }
  return mods.alt ? `\x1b${bytes}` : bytes;
}

const MOUSE_BUTTONS = { left: 0, middle: 1, right: 2, wheelUp: 64, wheelDown: 65 };
const MOUSE_MODIFIERS = { shift: 4, alt: 8, ctrl: 16 };

/**
 * The bytes a real xterm sends for one mouse event, in the report encoding
 * the app switched on (terminal.getModes().mouseEncoding):
 * - 'sgr' (?1006): ESC [ < code ; x ; y M, or a final "m" on release
 * - 'urxvt' (?1015): ESC [ code+32 ; x ; y M
 * - 'x10' (the default) and 'utf8' (?1005): ESC [ M then code+32, x+32, y+32
 *   as characters; plain X10 can't express a coordinate past 222, and its
 *   characters are single bytes (the caller writes them as latin1, since a
 *   string would send anything past 127 UTF-8 encoded)
 * `x`/`y` are 0-based cells; reports are 1-based. `action` is 'press',
 * 'release' or 'move'; a move with no button held reports button 3.
 */
function encodeMouse({ x, y, button = 'left', action = 'press', modifiers = [] }, encoding = 'x10') {
  let code = action === 'move' && button === null ? 3 : MOUSE_BUTTONS[button];
  if (code === undefined) throw new Error(`Unknown mouse button ${JSON.stringify(button)}. Use one of: ${Object.keys(MOUSE_BUTTONS).join(', ')}.`);
  for (const mod of modifiers) {
    if (!MOUSE_MODIFIERS[mod]) throw new Error(`Unknown mouse modifier ${JSON.stringify(mod)}. Use: shift, alt, ctrl.`);
    code += MOUSE_MODIFIERS[mod];
  }
  if (action === 'move') code += 32;
  const col = x + 1;
  const row = y + 1;

  if (encoding === 'sgr') return `\x1b[<${code};${col};${row}${action === 'release' ? 'm' : 'M'}`;
  // The legacy encodings can't say which button was released.
  if (action === 'release') code = (code & ~3) | 3;
  if (encoding === 'urxvt') return `\x1b[${code + 32};${col};${row}M`;
  if (encoding === 'x10' && (col > 222 || row > 222)) {
    throw new Error(`Mouse position (${x}, ${y}) is past what the legacy X10 mouse encoding can report (222); the app would need SGR mouse mode (?1006).`);
  }
  return `\x1b[M${String.fromCharCode(code + 32, col + 32, row + 32)}`;
}

module.exports = { KEY_SEQUENCES, resolveKey, encodeMouse };
