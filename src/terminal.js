'use strict';

const { Terminal } = require('@xterm/headless');

const DECTCEM = 25;
// Mouse report encodings an app can switch on; without one, the legacy
// X10 byte encoding applies.
const MOUSE_ENCODINGS = { 1006: 'sgr', 1015: 'urxvt', 1005: 'utf8' };

function hex(n) {
  return n.toString(16).padStart(2, '0');
}

// xterm stores a color as a mode plus a value; normalize to null (the
// terminal's default color), { palette: 0-255 }, or { rgb: '#rrggbb' }.
function readColor(cell, which) {
  if (which === 'fg' ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (which === 'fg' ? cell.isFgRGB() : cell.isBgRGB()) {
    return { rgb: `#${hex((value >> 16) & 0xff)}${hex((value >> 8) & 0xff)}${hex(value & 0xff)}` };
  }
  return { palette: value };
}

function readCell(cell) {
  const width = cell.getWidth();
  return {
    // '' for a cell nothing was ever written to (width 1) and for the
    // second half of a wide character (width 0). Keeping never-written cells
    // distinct from written spaces is what lets text derived from the grid
    // trim exactly what getScreenText() trims.
    ch: cell.getChars(),
    width,
    fg: readColor(cell, 'fg'),
    bg: readColor(cell, 'bg'),
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    inverse: Boolean(cell.isInverse()),
    strike: Boolean(cell.isStrikethrough()),
    invisible: Boolean(cell.isInvisible()),
  };
}

function flattenParams(params) {
  return params.flatMap((p) => (Array.isArray(p) ? p : [p]));
}

/**
 * Wraps @xterm/headless so the rest of RPGWright never has to reason about
 * raw ANSI/VT100 bytes directly. Re-derives "current screen" from live
 * buffer state on every read rather than accumulating raw output, since many
 * TUI frameworks redraw a full frame per update instead of appending to a
 * scrolling log.
 */
// `convertEol` treats a bare "\n" as "\r\n". A PTY's line discipline does
// that translation for a real terminal; plain pipes don't, so output read
// from pipes needs it to avoid every line starting where the last one ended.
function createVirtualTerminal({ cols = 120, rows = 40, scrollback = 1000, convertEol = false } = {}) {
  const terminal = new Terminal({ cols, rows, scrollback, convertEol, allowProposedApi: true });

  // The styled cell grid is comparatively expensive to build, and layout
  // and style assertions read it on every screen update, often several
  // times. Cache it until the buffer changes: every change arrives through
  // write() (or resize()), so invalidate synchronously there. xterm's own
  // onWriteParsed event is throttled to once per frame, so it can fire after
  // a reader has already seen the stale grid.
  let cellCache = null;
  const invalidate = () => {
    cellCache = null;
  };

  // xterm's public API exposes neither cursor visibility nor the mouse
  // report encoding, so track those private modes (CSI ? n h / l) ourselves.
  // Every handler returns false so xterm's own handling still runs.
  let cursorVisible = true;
  let mouseEncoding = 'x10';
  const trackPrivateModes = (enabled) => (params) => {
    for (const param of flattenParams(params)) {
      if (param === DECTCEM) cursorVisible = enabled;
      if (MOUSE_ENCODINGS[param]) mouseEncoding = enabled ? MOUSE_ENCODINGS[param] : 'x10';
    }
    return false;
  };
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackPrivateModes(true));
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackPrivateModes(false));
  // Full reset (RIS) and soft reset (DECSTR) restore the defaults.
  const reset = () => {
    cursorVisible = true;
    mouseEncoding = 'x10';
    return false;
  };
  terminal.parser.registerEscHandler({ final: 'c' }, reset);
  terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, reset);

  // Out-of-band signals an app sends through the terminal: the window
  // title, the bell, hyperlinks (OSC 8) and clipboard writes (OSC 52).
  let title = '';
  let bellCount = 0;
  const hyperlinks = [];
  const clipboardWrites = [];
  let openLink = null;
  terminal.onTitleChange((value) => {
    title = value;
  });
  terminal.onBell(() => {
    bellCount += 1;
  });
  // OSC 8 ; params ; uri ST opens a link at the cursor; an empty uri closes
  // it. The handler runs at that point in the stream, so the cursor marks
  // where the link text starts and ends. Read the line directly: the cached
  // cell grid may predate the chunk being parsed.
  terminal.parser.registerOscHandler(8, (data) => {
    const uri = data.slice(data.indexOf(';') + 1);
    const buffer = terminal.buffer.active;
    if (uri) {
      openLink = { uri, x: buffer.cursorX, y: buffer.cursorY };
    } else if (openLink) {
      const line = buffer.getLine(buffer.viewportY + openLink.y);
      const endX = buffer.cursorY === openLink.y ? buffer.cursorX : terminal.cols;
      hyperlinks.push({ uri: openLink.uri, text: line ? line.translateToString(false, openLink.x, endX) : '' });
      openLink = null;
    }
    return false;
  });
  // OSC 52 ; selection ; base64 ST. "?" is a read request, not a write.
  terminal.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    if (payload !== '?') clipboardWrites.push(Buffer.from(payload, 'base64').toString('utf8'));
    return false;
  });

  // `onParsed`, if given, runs synchronously the moment xterm has applied
  // this chunk, before the promise resolves. xterm can parse several queued
  // chunks in one tick, so by the time a promise continuation runs the
  // buffer may already show a later chunk; anything that must see each
  // chunk's own result (frame history) has to use onParsed.
  function write(data, onParsed) {
    return new Promise((resolve) => {
      terminal.write(data, () => {
        invalidate();
        if (onParsed) onParsed();
        resolve();
      });
    });
  }

  function resize(cols, rows) {
    terminal.resize(cols, rows);
    invalidate();
  }

  function getScreenLines() {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function getScreenText() {
    return getScreenLines().join('\n');
  }

  /**
   * The visible screen as rows of styled cells, one entry per column, so
   * `cells[y][x]` is the cell at that position. Treat the result as
   * read-only: it is shared until the next buffer change.
   */
  function getScreenCells() {
    if (cellCache) return cellCache;
    const buffer = terminal.buffer.active;
    const scratch = buffer.getNullCell();
    const grid = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      const cells = [];
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line && line.getCell(x, scratch);
        cells.push(cell ? readCell(cell) : readCell(buffer.getNullCell()));
      }
      grid.push(cells);
    }
    cellCache = grid;
    return grid;
  }

  // true for a row that is the continuation of the row above it, because
  // the text overflowed the terminal width and the terminal wrapped it.
  function getWrappedRows() {
    const buffer = terminal.buffer.active;
    const wrapped = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      wrapped.push(Boolean(line && line.isWrapped));
    }
    return wrapped;
  }

  // Lines that have scrolled off the top of the normal screen, oldest first,
  // right-trimmed like getScreenLines(). The alternate screen has none.
  function getScrollbackLines() {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.viewportY; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  // The terminal modes an app can switch on, as an app (or a user) would see
  // their effect.
  function getModes() {
    const { modes } = terminal;
    return {
      altScreen: terminal.buffer.active.type === 'alternate',
      cursorVisible,
      applicationCursorKeys: modes.applicationCursorKeysMode,
      bracketedPaste: modes.bracketedPasteMode,
      mouseTracking: modes.mouseTrackingMode,
      mouseEncoding,
      focusReporting: modes.sendFocusMode,
    };
  }

  // Copies, so callers can't change the terminal's own record.
  function getSignals() {
    return { title, bellCount, hyperlinks: hyperlinks.slice(), clipboardWrites: clipboardWrites.slice() };
  }

  function getCursor() {
    const buffer = terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY, visible: cursorVisible };
  }

  function getBufferType() {
    return terminal.buffer.active.type;
  }

  function getSize() {
    return { cols: terminal.cols, rows: terminal.rows };
  }

  // Bytes the emulator itself answers with, as a real terminal would: replies
  // to cursor-position (DSR) and device-attribute (DA) queries. The caller
  // must forward these to the process's stdin, or an app that queries the
  // terminal waits forever for an answer.
  function onReply(listener) {
    return terminal.onData(listener);
  }

  function dispose() {
    terminal.dispose();
  }

  return {
    write,
    resize,
    getScreenText,
    getScreenLines,
    getScreenCells,
    getWrappedRows,
    getScrollbackLines,
    getModes,
    getSignals,
    getCursor,
    getBufferType,
    getSize,
    onReply,
    dispose,
  };
}

module.exports = { createVirtualTerminal };
