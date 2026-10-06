'use strict';

// A dependency-free raw-mode probe for terminal-level behavior that an Ink
// app can't conveniently produce on demand. One mode per run, chosen by the
// first argument. Every mode attaches its stdin listener (raw mode) before
// printing anything: a keystroke sent while the tty is still in cooked mode
// is echoed by the line discipline and then delivered again once raw mode
// starts, so the first output must only appear once input truly works.

const mode = process.argv[2];
const out = (text) => process.stdout.write(text);

function onInput(handler) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handler);
}

const MODES = {
  // Asks the terminal for the cursor position and prints the reply. Without
  // a terminal that answers, this hangs on "waiting" forever.
  query() {
    onInput((data) => {
      const match = /\x1b\[(\d+);(\d+)R/.exec(data);
      if (match) out(`\r\nCPR row=${match[1]} col=${match[2]}\r\n`);
    });
    out('READY waiting');
    out('\x1b[6n');
  },

  env() {
    for (const name of ['TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'HOME']) {
      out(`${name}=${process.env[name] ?? '(unset)'}\r\n`);
    }
    out(`isTTY=${Boolean(process.stdout.isTTY)}\r\n`);
    onInput(() => {});
    out('READY\r\n');
  },

  // Redraws a spinner frame every 30ms, `argv[3]` times ("forever" never
  // stops), then prints DONE.
  spinner() {
    const frames = process.argv[3] === 'forever' ? Infinity : Number(process.argv[3] || 10);
    const glyphs = '|/-\\';
    let drawn = 0;
    onInput(() => {});
    out('READY\r\n');
    const timer = setInterval(() => {
      if (drawn >= frames) {
        clearInterval(timer);
        out('\rDONE   \r\n');
        return;
      }
      out(`\rworking ${glyphs[drawn % glyphs.length]}`);
      drawn += 1;
    }, 30);
  },

  // A one-line text input with a visible cursor. Enter submits, prints a
  // greeting and hides the cursor.
  prompt() {
    let name = '';
    onInput((data) => {
      for (const ch of data) {
        if (ch === '\r') {
          out(`\r\nHello, ${name}!\x1b[?25l`);
        } else if (ch === '\x7f') {
          if (name) {
            name = name.slice(0, -1);
            out('\b \b');
          }
        } else if (ch >= ' ') {
          name += ch;
          out(ch);
        }
      }
    });
    out('READY\r\nName: \x1b[?25h');
  },

  // Any key shows "Saved!" for ~20ms, then clears it: a toast too brief for
  // a check that only looks at the current screen to rely on catching.
  toast() {
    onInput(() => {
      out('\x1b[3;1HSaved!');
      setTimeout(() => out('\x1b[3;1H\x1b[2K'), 20);
    });
    out('READY\r\n');
  },

  // Any key redraws the screen. `argv[3]` "flicker" clears it in one write
  // and draws the new content ~30ms later in another; "clean" does both in
  // a single write.
  redraw() {
    const draw = (n) => `\x1b[H\x1b[2JREADY\r\nframe ${n}\r\n`;
    let n = 0;
    onInput(() => {
      n += 1;
      if (process.argv[3] === 'flicker') {
        out('\x1b[H\x1b[2J');
        setTimeout(() => out(draw(n)), 30);
      } else {
        out(draw(n));
      }
    });
    out(draw(n));
  },

  // Turns on mouse reporting (private mode `argv[3]`, default 1000, plus
  // `argv[4]` if given, e.g. 1006 for SGR encoding), then echoes input.
  mouse() {
    onInput((data) => out(`GOT ${JSON.stringify(data)}\r\n`));
    const modes = [process.argv[3] || '1000', process.argv[4]].filter(Boolean);
    out(`${modes.map((m) => `\x1b[?${m}h`).join('')}READY\r\n`);
  },

  // Turns on bracketed paste, then echoes input.
  paste() {
    onInput((data) => out(`GOT ${JSON.stringify(data)}\r\n`));
    out('\x1b[?2004hREADY\r\n');
  },

  // Sets the window title and prints a hyperlink at start. Keys: b rings the
  // bell, c copies "copied text" (OSC 52), a/n enter/leave the alternate
  // screen.
  signals() {
    onInput((data) => {
      if (data === 'b') out('\x07');
      if (data === 'c') out(`\x1b]52;c;${Buffer.from('copied text').toString('base64')}\x07`);
      if (data === 'a') out('\x1b[?1049h\x1b[HALT SCREEN');
      if (data === 'n') out('\x1b[?1049l');
    });
    out('\x1b]0;Probe Title\x07READY\r\nsee \x1b]8;;https://example.com/docs\x07the docs\x1b]8;;\x07\r\n');
  },

  // Exits with code `argv[3]` on any key; Ctrl+C (raw mode delivers it as
  // a byte) exits 130 like an interrupted shell command.
  exit() {
    onInput((data) => {
      if (data === '\x03') {
        out('interrupted\r\n');
        process.exit(130);
      }
      process.exit(Number(process.argv[3] || 0));
    });
    process.removeAllListeners('SIGTERM');
    out('READY\r\n');
  },

  // Prints `argv[3]` numbered lines, scrolling the earlier ones off screen.
  log() {
    onInput(() => {});
    const count = Number(process.argv[3] || 50);
    for (let i = 1; i <= count; i += 1) out(`line ${i}\r\n`);
    out('READY');
  },

  // Echoes each stdin chunk as its JSON-escaped bytes, one chunk per line.
  echo() {
    onInput((data) => out(`GOT ${JSON.stringify(data)}\r\n`));
    out('READY\r\n');
  },
};

const run = MODES[mode];
if (!run) {
  out(`Unknown mode "${mode}". Modes: ${Object.keys(MODES).join(', ')}\r\n`);
  process.exit(2);
}

process.on('SIGTERM', () => process.exit(0));
run();
