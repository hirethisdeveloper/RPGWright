# Key sequences

`press(key)` writes the raw bytes a real terminal would send for `key`. `key` is a named key (`'ENTER'`, `'ArrowDown'`), a single character (`'q'`), or a modifier chord (`'Control+ArrowLeft'`, `'Shift+Tab'`).

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

Built-in names are case-insensitive, so `'Enter'`, `'ArrowDown'` and `'PageUp'` work as well as `'ENTER'`, `'ARROWDOWN'` and `'PAGEUP'`. A name you add with `keys` matches exactly as you wrote it, or in any case if you define it in upper case. A single character such as `'q'` or `'+'` is sent as-is.

## Chords: modifier keys

Join modifiers and a key with `+`:

```js
await game.press('Control+c');          // \x03
await game.press('Shift+Tab');          // \x1b[Z (back-tab)
await game.press('Alt+x');              // \x1bx
await game.press('Control+ArrowLeft');  // \x1b[1;5D
await game.press('Control+Shift+End'); // \x1b[1;6F
```

Modifier names: `Shift`, `Control` (or `Ctrl`), and `Alt` (or `Option`, `Meta`). They're encoded the way xterm encodes them:

| Chord | Encoding |
|---|---|
| Any modifier + an arrow, `Home`, `End`, `F1`–`F4` | `\x1b[1;<m><letter>`, where `<m>` is 1 + 1 (Shift) + 2 (Alt) + 4 (Control) |
| Any modifier + `Delete`, `PageUp`, `PageDown`, `F5`–`F12` | `\x1b[<n>;<m>~` |
| `Control` + a letter | the control byte (`Control+a` → `\x01`, `Control+c` → `\x03`) |
| `Control` + `[`, `\`, `]`, `^`, `_`, `@`, `Space` | the matching control byte |
| `Control+Backspace` | `\x08` |
| `Shift` + a letter | the uppercase letter |
| `Shift+Tab` | `\x1b[Z` |
| `Alt` + anything else | `\x1b` followed by the unmodified key |

Some chords have no standard encoding: a terminal sends the same bytes for `Control+Enter` as for `Enter`, for example. `press()` throws for those, rather than silently sending the unmodified key. If your app expects a specific sequence (some apps enable an extended keyboard protocol), send it with `press.raw`.

The legacy names `CTRL_C` and `CTRL_D` keep working.

## Extending the table

Chords cover modifier keys, so the `keys` option is for naming keys after what they do in your app, or for sequences no chord produces. It's merged into, not replacing, the built-in table (see [Configuration](./configuration.md#keys)), and an exact name in it always wins over chord parsing:

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  keys: {
    CONFIRM: '\r',
    KITTY_CTRL_ENTER: '\x1b[13;5u', // an extended-keyboard-protocol sequence
  },
};
```

## Anything not in the table: `press.raw`

For a one-off sequence you don't want to name in config, `press.raw(bytes)` sends it directly, bypassing the table entirely:

```js
await game.press.raw('\x1b[13;5u');
```

`press(key)` deliberately throws on an unknown name rather than writing the string literally — this catches a typo (`press('ENTR')`) at the call site instead of it silently becoming a no-op that only surfaces later as a confusing `expectText` timeout. `press.raw` is the explicit way to say "yes, I mean these literal bytes."

## Pasting and the mouse

To send text as a paste rather than as typing, use `game.paste(text)`. For mouse clicks, scrolling and dragging, use `game.mouse` or `locator.click()`. Both are covered in [Writing tests](./writing-tests.md#pasting).

