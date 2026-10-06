'use strict';

/**
 * Renders a styled cell grid (terminal.getScreenCells()) as self-contained
 * HTML, so a person can see a screen the way a terminal would draw it:
 * colors, inverse, bold, underline, wide characters, the cursor. Used for
 * game.renderHtml() and the runner's trace files. No external resources;
 * pure functions of the grid.
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
      const isCursor = Boolean(cursor && cursor.visible && cursor.x === x && cursor.y === y);
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

module.exports = { renderScreenFragment, renderScreenHtml, paletteColor, escapeHtml, SCREEN_CSS, THEME };
