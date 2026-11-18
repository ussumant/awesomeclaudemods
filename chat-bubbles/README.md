# chat-bubbles

A Claude Code mod that draws the terminal transcript as a text-message thread:
your messages in blue bubbles on the right, Claude's replies in gray bubbles on
the left, an animated typing bubble while Claude works, and a quiet header
(Claude, iMessage, the time) above the first message.

Only the conversation shows: clean tool rows, their progress pill, the turn's
closing line and the notice under the logo are hidden. A tool call that failed
or was stopped becomes one short red line; its error text shows with
`/bubbles detail on` or ctrl+o (the full transcript).

Colours follow Claude Code's own `theme` setting (light or dark). Messages you
send from the terminal, from Remote Control (a phone or the web) or as a Slack
ping get a blue bubble. Messages from other agents, tasks, sessions and
plugins draw as one small gray line saying who sent them; a message that came
through a channel (Slack, Telegram) is a gray bubble with "<sender> via
<channel>" above it.

A batch of teammate updates that holds an idle notice draws as one small gray
line ("builder sent an update", "builder and researcher sent updates",
"Teammates sent updates"). Limit: a teammate message with no idle notice and
no teammate frame stays Claude Code's own row.

While the band above the prompt is collapsed, its one-line reminder is
hidden; a survey there still shows.

A reply with a table gets a bubble as wide as the table, past the usual width
if it has to be, up to the whole terminal. A reply whose table is too wide for
any bubble is shown as Claude Code's own row, so the table stays readable.
Tables in a list item or a quote, and tables with emoji or other wide
characters, are measured too. Limit: a table with a line of plain text right
under it (no blank line between) keeps the usual 85% bubble and may wrap.

## Install

```
/plugin install chat-bubbles --marketplace ussumant/awesomeclaudemods
```

## Commands

- `/bubbles` shows the current settings.
- `/bubbles on` and `/bubbles off` turn the mod on and off.
- `/bubbles detail on` brings back the hidden tool rows and status lines;
  `/bubbles detail off` hides them again.
- `/bubbles style block|pill|tail|round` picks the bubble shape. `block` is the
  default.
- `/bubbles tail on|off` turns the tails of the `round` style on or off.

Settings are kept between sessions.

## The `round` style needs a font

`round` draws true rounded bubbles with tails using a small font, Bubble Caps,
in `assets/BubbleCaps-Regular.ttf` (its glyphs are listed in
`assets/glyph-map.json`). Without the font installed those characters draw as
empty boxes, which is why `round` is never the default.

1. Install `assets/BubbleCaps-Regular.ttf` (double-click it on macOS, then
   Install Font).
2. Add `Bubble Caps` to your terminal's font family after your main font, for
   example `'SF Mono', 'Bubble Caps', Menlo, monospace`.
3. Run `/bubbles style round`.

`round` is proven in full-screen chats (the `tui: fullscreen` setting), not yet
on the normal scrolling screen; off full screen a saved `round` draws `block`.
In `round` the thread opens with Claude's avatar, a disc drawn with the same
font, above the Claude and iMessage lines. Limit: in `round`, a one-line
message with non-Latin text or emoji draws two rows tall.
