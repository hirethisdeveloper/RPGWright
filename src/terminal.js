'use strict';

const { Terminal } = require('@xterm/headless');

/**
 * Wraps @xterm/headless so the rest of RPGWright never has to reason about
 * raw ANSI/VT100 bytes directly. Re-derives "current screen" from live
 * buffer state on every read rather than accumulating raw output, since many
 * TUI frameworks redraw a full frame per update instead of appending to a
 * scrolling log.
 */
function createVirtualTerminal({ cols = 120, rows = 40 } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });

  function write(data) {
    return new Promise((resolve) => {
      terminal.write(data, resolve);
    });
  }

  function resize(cols, rows) {
    terminal.resize(cols, rows);
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

  function getCursor() {
    const buffer = terminal.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  function dispose() {
    terminal.dispose();
  }

  return { write, resize, getScreenText, getScreenLines, getCursor, dispose };
}

module.exports = { createVirtualTerminal };
