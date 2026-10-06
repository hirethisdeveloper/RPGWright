'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderScreenFragment, escapeHtml, SCREEN_CSS } = require('../src/render');

function shouldWriteTrace(mode, failed) {
  return mode === 'on' || (mode === 'retain-on-failure' && failed);
}

// "menu > opens settings [80x24]" -> "menu-opens-settings-80x24"
function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'test'
  );
}

// The file part is the test file's path under testDir (so same-named files
// in different directories differ). Slugs are lossy and capped, so two
// tests can still map to one name (a retry's "(retry n)" cut off a long
// title, say); `taken`, one per run, numbers the later ones instead of
// letting them overwrite each other.
function tracePath(outputDir, file, testName, { testDir, taken } = {}) {
  const relative = testDir ? path.relative(testDir, file) : path.basename(file);
  const base = `${slugify(relative.replace(/\.[jt]s$/, ''))}--${slugify(testName)}`;
  let name = base;
  for (let n = 2; taken && taken.has(name); n += 1) name = `${base}-${n}`;
  if (taken) taken.add(name);
  return path.join(outputDir, `${name}.trace.html`);
}

function actionLabel(action) {
  return `${action.type}(${action.detail})`;
}

function statusOf(action) {
  if (action.ok === true) return ['ok', '✓'];
  if (action.ok === false) return ['failed', '✖'];
  return ['pending', '…'];
}

/**
 * A self-contained HTML page for one test run: outcome, the failure report
 * if any, then every action in order with the screen as it was when that
 * action finished (expandable; the failed one open), and the final screen.
 * Works offline, with no script: <details> does the expanding.
 */
function buildTraceHtml({ testName, file, passed, durationMs, error, trace }) {
  const steps = trace.actions
    .map((action, index) => {
      const [cls, mark] = statusOf(action);
      const indent = (action.depth || 0) * 20;
      const screen = action.screen ? renderScreenFragment(action.screen, action.cursor) : '<p class="muted">(no screen captured)</p>';
      return `<details class="step ${cls}" style="margin-left:${indent}px"${action.ok === false ? ' open' : ''}>
<summary><span class="mark">${mark}</span> <span class="n">${index + 1}.</span> <code>${escapeHtml(actionLabel(action))}</code> <span class="t">+${action.t}ms</span></summary>
${screen}
</details>`;
    })
    .join('\n');

  const status = passed ? 'passed' : 'failed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(testName)} (${status})</title>
<style>
:root{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--panel:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--panel:#161b22}}
body{margin:0 auto;max-width:1100px;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.meta{color:var(--muted);margin-bottom:16px}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-weight:600}.badge.passed{background:var(--ok)}.badge.failed{background:var(--bad)}
pre.report{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;font-size:12px}
.step{border-left:3px solid var(--line);padding:2px 8px;margin:4px 0}.step.ok{border-color:var(--ok)}.step.failed{border-color:var(--bad)}
.step summary{cursor:pointer}.step .mark{font-weight:700}.step.ok .mark{color:var(--ok)}.step.failed .mark{color:var(--bad)}
.n,.t,.muted{color:var(--muted)}.step .rpgw-screen{margin:8px 0}
h2{font-size:15px;margin:20px 0 8px}
${SCREEN_CSS}
</style></head><body>
<h1>${escapeHtml(testName)}</h1>
<div class="meta"><span class="badge ${status}">${status}</span> ${escapeHtml(path.basename(file))} · ${durationMs}ms · <code>${escapeHtml([trace.command, ...trace.args].join(' '))}</code></div>
${error ? `<h2>Failure</h2>\n<pre class="report">${escapeHtml(error.message)}</pre>` : ''}
<h2>Actions</h2>
${steps || '<p class="muted">No actions were recorded.</p>'}
<h2>Final screen</h2>
${renderScreenFragment(trace.final.grid, trace.final.cursor)}
<p class="muted">${trace.frames.length} screen update${trace.frames.length === 1 ? '' : 's'} retained.</p>
</body></html>
`;
}

/**
 * An asciinema v2 recording (https://docs.asciinema.org/manual/asciicast/v2/)
 * of the session: a JSON header line, then one [seconds, type, data] line
 * per event: "o" output, "i" input, "r" resize ("COLSxROWS").
 */
function buildCast(recording, { title }) {
  const header = {
    version: 2,
    width: recording.cols,
    height: recording.rows,
    timestamp: Math.floor(recording.startedAt / 1000),
    title,
  };
  return [header, ...recording.events.map(([t, type, data]) => [Number(t.toFixed(6)), type, data])]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

// Writes the trace page, and the .cast recording next to it when the run
// recorded one. Returns both paths (cast is null without a recording).
function writeTrace(outputDir, details, naming) {
  const target = tracePath(outputDir, details.file, details.testName, naming);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildTraceHtml(details), 'utf8');
  let cast = null;
  if (details.trace.recording) {
    cast = target.replace(/\.trace\.html$/, '.cast');
    fs.writeFileSync(cast, buildCast(details.trace.recording, { title: details.testName }), 'utf8');
  }
  return { trace: target, cast };
}

module.exports = { shouldWriteTrace, slugify, tracePath, buildTraceHtml, buildCast, writeTrace };
