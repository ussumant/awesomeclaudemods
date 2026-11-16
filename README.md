# awesomeclaudemods

Mods for Claude Code. A mod changes how Claude Code looks or behaves.

## fat-context

Your session gets fat as its context window fills up. A full context is slow and expensive, and this makes you feel it before you check a number.

![fat-context at 92% full](pictures/fat-context-92.png)

What changes as the context fills:

| Context | Name | What you see |
| --- | --- | --- |
| under 30% | lean | a tiny creature above the prompt, messages untouched |
| 30 to 49% | filling out | a solid bar beside each message |
| 50 to 69% | chubby | a solid ring around each message, a rounder creature |
| 70 to 84% | stuffed | thick walls, your own plain-prose messages in double-width letters, the percent in giant digits |
| 85% and up | about to pop | walls up to half the width, every plain-prose message in double-width letters, a creature up to 14 rows tall |

After `/compact` or `/clear` it slims back down. A `/fat` preview is separate: it stays on until you type `/fat real`.

### What gets wide letters

Wide letters are only drawn on messages that are plain prose.

If a message has a backtick, `~~~`, a tab, four spaces in a row, a `|` or a `<` anywhere in it, the whole message is drawn exactly as written. That keeps code blocks, inline code, indented code, tables and HTML out of it. It also means a plain sentence like "a < b" stays normal width.

In a plain-prose message, only whole words made of letters and digits go wide. One trailing `, . ! ? ; :` stays as it is. Any word with another character in it stays as written: a slash, backslash, underscore, @, hyphen, apostrophe, markdown marks, or a dot or colon inside the word. So file paths and web addresses keep their spelling. A line that starts with `/` and a list number at the start of a line are left alone too.

`/fat look frames` or `/fat look belly` shows the mod without wide letters.

The mod changes only what is drawn. What the model reads and what is saved stay the same.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install fat-context --marketplace ussumant/awesomeclaudemods
```

Answer `y` to add the marketplace, then pick a scope with Enter.

From a shell:

```
claude plugin install fat-context --marketplace ussumant/awesomeclaudemods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ussumant/awesomeclaudemods`, then Add plugin. The fat look is built for the terminal. Outside the terminal the messages are left alone, and the rest is untested there.

### Commands

| Command | What it does |
| --- | --- |
| `/fat` | shows the percent, the name and the look |
| `/fat 92` | previews any percent from 0 to 100 |
| `/fat real` | goes back to the real reading |
| `/fat look frames` | walls only (also `belly`, `letters`, `all`) |
| `/fat off` and `/fat on` | hides or shows everything |

### Not checked yet

- Light terminal themes. The mod uses the theme's own colors, but it has only been looked at on a dark one.
- In a window shorter than about 45 rows the biggest creature loses a couple of rows.

## License

MIT
