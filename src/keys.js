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

module.exports = { KEY_SEQUENCES };
