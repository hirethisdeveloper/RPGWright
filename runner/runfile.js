'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stripAnsi } = require('../src/render');
const { artifactPath } = require('./trace');
const { version: RPGWRIGHT_VERSION } = require('../package.json');

const RUN_FILE_FORMAT = 'rpgwright-run';
const RUN_FILE_VERSION = 1;
const RUN_STATUSES = ['passed', 'failed', 'aborted'];

// A failure as the run file keeps it: a one-line message, and the whole
// failure block (a GameDriver failure's message is the full report).
function errorRecord(error) {
  if (!error) return null;
  const report = stripAnsi(String(error.message ?? error));
  return { message: report.split('\n')[0], report };
}

// One launched process: its recorded event stream as is, and its action
// timeline with `t` moved from milliseconds to seconds, so both count from
// the same launch instant in the same unit. The screens a recorded action
// carries stay out: playback rebuilds every screen from the events.
function sessionRecord(trace) {
  const { recording, final } = trace;
  return {
    command: trace.command,
    args: trace.args,
    // launch()'s options can turn recording off; the final screen still
    // says what size the session started at, and it plays back as empty.
    cols: recording ? recording.cols : final.grid[0].length,
    rows: recording ? recording.rows : final.grid.length,
    events: recording ? recording.events : [],
    actions: trace.actions.map(({ type, detail, ok, depth, t }) => ({ type, detail, ok, depth: depth || 0, t: t / 1000 })),
  };
}

/**
 * A run file's contents, from one test's final outcome and the getTrace()
 * of each driver it launched (in launch order). Pure: `recordedAt` (an ISO
 * timestamp) comes in with the details. `file` is shown relative to
 * `testDir` when one is given.
 */
function buildRunFile({ title, file, line, testDir, status, durationMs, error, traces, recordedAt }) {
  return {
    format: RUN_FILE_FORMAT,
    version: RUN_FILE_VERSION,
    rpgwright: RPGWRIGHT_VERSION,
    recordedAt,
    test: { title, file: testDir ? path.relative(testDir, file) : path.basename(file), line },
    result: { status, durationMs, error: errorRecord(error) },
    sessions: traces.map(sessionRecord),
  };
}

// Writes the run file next to the test's trace (same naming, `.run.json`)
// and returns its path.
function writeRunFile(outputDir, details, naming = {}) {
  const target = artifactPath(outputDir, details.file, details.title, naming, '.run.json');
  const contents = buildRunFile({ testDir: naming.testDir, recordedAt: new Date().toISOString(), ...details });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(contents)}\n`, 'utf8');
  return target;
}

const isString = (v) => typeof v === 'string';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v > 0;
const isArray = Array.isArray;
const isObject = (v) => v !== null && typeof v === 'object' && !isArray(v);

// [field path, check, what it should be] for every field playback relies
// on; the first one that fails is the one reported.
const REQUIRED_FIELDS = [
  ['rpgwright', isString, 'a string'],
  ['recordedAt', isString, 'a string'],
  ['test', isObject, 'an object'],
  ['test.title', isString, 'a string'],
  ['test.file', isString, 'a string'],
  ['test.line', isNumber, 'a number'],
  ['result', isObject, 'an object'],
  ['result.status', (v) => RUN_STATUSES.includes(v), `one of ${RUN_STATUSES.join(', ')}`],
  ['result.durationMs', isNumber, 'a number'],
  ['result.error', (v) => v === null || (isObject(v) && isString(v.message) && isString(v.report)), 'null or { message, report }'],
  ['sessions', isArray, 'an array'],
];
const SESSION_FIELDS = [
  ['command', isString, 'a string'],
  ['args', isArray, 'an array'],
  ['cols', isCount, 'a positive integer'],
  ['rows', isCount, 'a positive integer'],
  ['events', (v) => isArray(v) && v.every((e) => isArray(e) && isNumber(e[0]) && ['o', 'i', 'r'].includes(e[1]) && isString(e[2])), 'an array of [seconds, "o"|"i"|"r", data]'],
  ['actions', (v) => isArray(v) && v.every((a) => isObject(a) && isString(a.type) && isNumber(a.t)), 'an array of { type, detail, ok, depth, t }'],
];

function fieldAt(object, dotted) {
  return dotted.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), object);
}

function checkFields(object, fields, prefix, file) {
  for (const [field, check, expected] of fields) {
    const value = fieldAt(object, field);
    if (value === undefined) throw new Error(`${file}: run file is missing the required field "${prefix}${field}".`);
    if (!check(value)) throw new Error(`${file}: run file field "${prefix}${field}" must be ${expected}.`);
  }
}

/**
 * Reads and validates a run file, returning its parsed contents. Throws an
 * Error naming the file and the problem: unreadable, not JSON, not a run
 * file, a version this RPGWright can't play, or a missing/malformed field.
 */
function readRunFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Can't read run file ${file}: ${err.message}`);
  }
  let run;
  try {
    run = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so it isn't a run file (${err.message}).`);
  }
  if (!isObject(run) || run.format !== RUN_FILE_FORMAT) {
    const got = isObject(run) ? JSON.stringify(run.format) : 'no format';
    throw new Error(`${file} is not an RPGWright run file (expected "format": "${RUN_FILE_FORMAT}", got ${got}). Run files are written by "rpgwright test --save-run".`);
  }
  if (run.version !== RUN_FILE_VERSION) {
    throw new Error(
      `${file} is run file version ${JSON.stringify(run.version)}, but this RPGWright (${RPGWRIGHT_VERSION}) only supports version ${RUN_FILE_VERSION}. Re-record it with "rpgwright test --save-run".`,
    );
  }
  checkFields(run, REQUIRED_FIELDS, '', file);
  run.sessions.forEach((session, index) => {
    if (!isObject(session)) throw new Error(`${file}: run file field "sessions[${index}]" must be an object.`);
    checkFields(session, SESSION_FIELDS, `sessions[${index}].`, file);
  });
  return run;
}

module.exports = { buildRunFile, writeRunFile, readRunFile, RUN_FILE_VERSION };
