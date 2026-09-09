import React, { useState, useEffect } from 'react';
import { render, Text, Box, useInput, useApp, useStdout } from 'ink';
import fs from 'node:fs';

const MENU_OPTIONS = ['Play', 'Settings', 'Quit'];
const SIDEBAR_MIN_COLS = 60;
const STATE_FILE = process.env.STATE_FILE;

function writeState(state) {
  if (!STATE_FILE) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState('menu');
  const [cursor, setCursor] = useState(0);
  const [typedBuffer, setTypedBuffer] = useState('');
  const [score, setScore] = useState(0);
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  useEffect(() => {
    writeState({ screen, score, soundOn });
  }, [screen, score, soundOn]);

  function selectMenuOption(index) {
    const option = MENU_OPTIONS[index];
    if (option === 'Play') {
      setScreen('play');
    } else if (option === 'Settings') {
      setScreen('settings');
    } else if (option === 'Quit') {
      exit();
    }
  }

  useInput((input, key) => {
    if (screen === 'menu') {
      if (key.upArrow) {
        setCursor((c) => (c - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % MENU_OPTIONS.length);
        return;
      }
      // input.length === 1 guards against a multi-character "paste" chunk
      // (e.g. a digit and Enter arriving in the same PTY read when sent in
      // quick succession) -- Ink hands a paste to the handler as one raw
      // string with none of the key.* flags set, and a bare regex .test()
      // would match a digit anywhere in it, silently absorbing the rest
      // (including a swallowed Enter) into the typed buffer.
      if (input.length === 1 && /[0-9]/.test(input)) {
        setTypedBuffer((b) => b + input);
        return;
      }
      if (key.return) {
        if (typedBuffer.length > 0) {
          const index = Number(typedBuffer) - 1;
          setTypedBuffer('');
          if (index >= 0 && index < MENU_OPTIONS.length) {
            selectMenuOption(index);
          }
        } else {
          selectMenuOption(cursor);
        }
      }
      return;
    }

    if (screen === 'play') {
      if (input === ' ') {
        setScore((s) => s + 1);
        return;
      }
      if (key.escape) {
        setScreen('menu');
        setCursor(0);
      }
      return;
    }

    if (screen === 'settings') {
      if (key.return || input === ' ') {
        setSoundOn((v) => !v);
        return;
      }
      if (key.escape) {
        setScreen('menu');
        setCursor(0);
      }
    }
  });

  // See fixtures/minimal-ink-app/cli.js for why this effect must be declared
  // after useInput(): it guarantees raw mode + the stdin listener are wired
  // up before any interactive screen becomes visible.
  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return React.createElement(Text, null, 'Loading...');
  }

  if (screen === 'play') {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'PLAYING'),
      React.createElement(Text, null, `Score: ${score}`),
      React.createElement(Text, null, 'Press SPACE to score, ESCAPE to return to menu'),
    );
  }

  if (screen === 'settings') {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'SETTINGS'),
      React.createElement(Text, null, `Sound: ${soundOn ? 'ON' : 'OFF'}`),
      React.createElement(Text, null, 'Press ENTER to toggle, ESCAPE to return to menu'),
    );
  }

  const wide = size.columns >= SIDEBAR_MIN_COLS;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, 'MENU NAV APP'),
    ...MENU_OPTIONS.map((label, index) =>
      React.createElement(Text, { key: label }, `${index === cursor ? '> ' : '  '}${label}`),
    ),
    React.createElement(
      Text,
      null,
      `Type a number and press ENTER, or use arrow keys${typedBuffer ? ` (typed: ${typedBuffer})` : ''}`,
    ),
    React.createElement(Text, null, wide ? 'Wide layout enabled' : 'Narrow layout'),
  );
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

render(React.createElement(App));
