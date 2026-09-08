import React, { useState, useEffect } from 'react';
import { render, Text, Box, useInput, useApp, useStdout } from 'ink';

function App() {
  const [screen, setScreen] = useState('welcome');
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  useInput((input, key) => {
    if (screen === 'welcome' && key.return) {
      setScreen('pressed');
      return;
    }
    if (screen === 'pressed' && input === 'q') {
      exit();
    }
  });

  // useInput's own effect (registered above, during this render) is what
  // enables raw mode and wires up the stdin listener. React flushes a
  // component's effects in the order the hooks were called, so declaring
  // this effect after useInput guarantees raw mode is already active by the
  // time it fires — which is what lets the prompt below only ever appear
  // once the app can actually receive it. Without this gate, the first
  // frame can paint before Ink's stdin listener is attached, and a
  // keystroke sent that instant is silently lost.
  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return React.createElement(Text, null, 'Loading...');
  }

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, 'MINIMAL APP'),
    React.createElement(Text, null, `Size: ${size.columns}x${size.rows}`),
    screen === 'welcome'
      ? React.createElement(Text, null, 'Press ENTER to continue')
      : React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(Text, null, 'You pressed ENTER'),
          React.createElement(Text, null, 'Press q to quit'),
        ),
  );
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

render(React.createElement(App));
