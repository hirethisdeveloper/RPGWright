'use strict';

/**
 * Renders a styled cell grid (terminal.getScreenCells()) as self-contained
 * HTML, so a person can see a screen the way a terminal would draw it:
 * colors, inverse, bold, underline, wide characters, the cursor. Used for
 * game.renderHtml() and the runner's trace files. No external resources;
 * pure functions of the grid.
 *
 * renderScreenAnsi draws the same grid as SGR-styled text rows for a real
 * terminal, passing palette indices through untouched.
 *
 * Palette indices are drawn with xterm's default colors. That's one
 * plausible theme, not the truth: what "red" looks like is up to the
 * user's terminal, which is why assertions compare indices, never these.
 */

const THEME = { fg: '#e5e5e5', bg: '#1e1e1e', cursor: '#f5c542' };

const PALETTE_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function hex(n) {
  return n.toString(16).padStart(2, '0');
}

function paletteColor(index) {
  if (index < 16) return PALETTE_16[index];
  if (index < 232) {
    const i = index - 16;
    return `#${hex(CUBE_LEVELS[Math.floor(i / 36)])}${hex(CUBE_LEVELS[Math.floor(i / 6) % 6])}${hex(CUBE_LEVELS[i % 6])}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

function cssColor(color, fallback) {
  if (color === null) return fallback;
  return color.rgb || paletteColor(color.palette);
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function isCursorCell(cursor, x, y) {
  return Boolean(cursor && cursor.visible && cursor.x === x && cursor.y === y);
}

function cellCss(cell, isCursor) {
  let fg = cssColor(cell.fg, THEME.fg);
  let bg = cssColor(cell.bg, THEME.bg);
  if (cell.inverse) [fg, bg] = [bg, fg];
  const css = [];
  if (fg !== THEME.fg) css.push(`color:${fg}`);
  if (bg !== THEME.bg) css.push(`background:${bg}`);
  if (cell.bold) css.push('font-weight:bold');
  if (cell.dim) css.push('opacity:.6');
  if (cell.italic) css.push('font-style:italic');
  const lines = [cell.underline && 'underline', cell.strike && 'line-through'].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(' ')}`);
  if (cell.invisible) css.push('color:transparent');
  if (isCursor) css.push(`outline:1px solid ${THEME.cursor};outline-offset:-1px`);
  return css.join(';');
}

/**
 * One screen as a <pre> fragment: consecutive cells with the same style
 * share a <span>; a wide character gets a fixed two-column box so the rest
 * of its row stays aligned whatever the font.
 */
function renderScreenFragment(grid, cursor = null) {
  const rows = grid.map((row, y) => {
    let html = '';
    let runCss = null;
    let runText = '';
    const flush = () => {
      if (runText) html += runCss ? `<span style="${runCss}">${escapeHtml(runText)}</span>` : escapeHtml(runText);
      runText = '';
    };
    row.forEach((cell, x) => {
      if (cell.width === 0) return;
      const isCursor = isCursorCell(cursor, x, y);
      const css = cellCss(cell, isCursor);
      const ch = cell.ch === '' ? ' ' : cell.ch;
      if (cell.width === 2) {
        flush();
        html += `<span class="w2"${css ? ` style="${css}"` : ''}>${escapeHtml(ch)}</span>`;
        runCss = null;
        return;
      }
      if (css !== runCss) {
        flush();
        runCss = css;
      }
      runText += ch;
    });
    flush();
    return html;
  });
  return `<pre class="rpgw-screen">${rows.join('\n')}</pre>`;
}

const SCREEN_CSS = `.rpgw-screen{display:inline-block;margin:0;padding:8px;background:${THEME.bg};color:${THEME.fg};font:13px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-radius:4px;white-space:pre;overflow-x:auto;max-width:100%}.rpgw-screen .w2{display:inline-block;width:2ch;text-align:center}`;

/**
 * A standalone HTML page showing one screen.
 */
function renderScreenHtml(grid, { cursor = null, title = 'Terminal screen' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:16px;background:#f4f4f4;font:14px system-ui,sans-serif}${SCREEN_CSS}</style>
</head><body>
${renderScreenFragment(grid, cursor)}
</body></html>
`;
}

function sgrColor(color, base) {
  if (color.rgb) {
    const n = parseInt(color.rgb.slice(1), 16);
    return `${base + 8};2;${n >> 16};${(n >> 8) & 255};${n & 255}`;
  }
  const i = color.palette;
  if (i < 8) return `${base + i}`;
  if (i < 16) return `${base + 60 + i - 8}`;
  return `${base + 8};5;${i}`;
}

function cellSgr(cell, inverse) {
  const codes = [];
  if (cell.fg) codes.push(sgrColor(cell.fg, 30));
  if (cell.bg) codes.push(sgrColor(cell.bg, 40));
  if (cell.bold) codes.push(1);
  if (cell.dim) codes.push(2);
  if (cell.italic) codes.push(3);
  if (cell.underline) codes.push(4);
  if (inverse) codes.push(7);
  if (cell.invisible) codes.push(8);
  if (cell.strike) codes.push(9);
  return codes.join(';');
}

/**
 * One SGR-styled string per grid row, each starting from and ending in the
 * reset state, with no cursor movement: the caller positions the rows. A
 * visible cursor is drawn as an inverse-toggled cell.
 */
function renderScreenAnsi(grid, cursor = null) {
  return grid.map((row, y) => {
    let out = '';
    let current = '';
    row.forEach((cell, x) => {
      if (cell.width === 0) return;
      const inverse = Boolean(cell.inverse) !== isCursorCell(cursor, x, y);
      const sgr = cellSgr(cell, inverse);
      if (sgr !== current) {
        out += sgr ? `\x1b[0;${sgr}m` : '\x1b[0m';
        current = sgr;
      }
      out += cell.ch === '' ? ' ' : cell.ch;
    });
    return `${out}\x1b[0m`;
  });
}

// CSI and OSC escape sequences, as text carrying them (a colored error
// message, ANSI rows like renderScreenAnsi's) would contain.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// `text` with its escape sequences removed: what it reads as, unstyled.
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

module.exports = { renderScreenFragment, renderScreenHtml, renderScreenAnsi, stripAnsi, paletteColor, escapeHtml, SCREEN_CSS };
