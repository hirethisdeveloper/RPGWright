# Key sequences

`press(key)` looks up `key` in a built-in table of named keys and writes the corresponding raw byte sequence to the target process.

## The built-in table

| Name | Bytes |
|---|---|
| `ENTER` | `\r` |
| `ESCAPE` | `\x1b` |
| `TAB` | `\t` |
| `BACKSPACE` | `\x7f` |
| `DELETE` | `\x1b[3~` |
| `ARROWUP` | `\x1b[A` |
| `ARROWDOWN` | `\x1b[B` |
| `ARROWLEFT` | `\x1b[D` |
| `ARROWRIGHT` | `\x1b[C` |
| `SPACE` | ` ` |
| `CTRL_C` | `\x03` |
| `CTRL_D` | `\x04` |
| `HOME` | `\x1b[H` |
| `END` | `\x1b[F` |
| `PAGEUP` | `\x1b[5~` |
| `PAGEDOWN` | `\x1b[6~` |
| `F1`–`F4` | `\x1bOP`–`\x1bOS` |
| `F5`–`F12` | `\x1b[15~`, `\x1b[17~`–`\x1b[21~`, `\x1b[23~`, `\x1b[24~` |

These are the standard xterm/VT100 sequences a real terminal sends for each key, in the terminal's normal (non-application) cursor-key mode.

## Extending the table

For key combinations your app supports that aren't in the default table, add them via `rpgwright.config.js`'s `keys` option (merged into, not replacing, the built-in table — see [Configuration](./configuration.md#keys)):

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  keys: {
    CTRL_RIGHT: '\x1b[1;5C',
    SHIFT_TAB: '\x1b[Z',
  },
};
```

## Anything not in the table: `press.raw`

For a one-off sequence you don't want to name in config, `press.raw(bytes)` sends it directly, bypassing the table entirely:

```js
await game.press.raw('\x1b[1;5C');
```

`press(key)` deliberately throws on an unknown name rather than writing the string literally — this catches a typo (`press('ENTR')`) at the call site instead of it silently becoming a no-op that only surfaces later as a confusing `expectText` timeout. `press.raw` is the explicit way to say "yes, I mean these literal bytes."
