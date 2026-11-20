import type { Elements } from 'claude-code'

import type { Side } from './shape'

// Tapbacks, threaded replies and the Read receipt (chat-bubbles 0.5).
//
// - Hold any bubble (hold.tsx): the tapback bar opens above it, the actions
//   (Reply, Copy) under it. Slide onto a tapback and let go, or click one.
//   Picking the same one again takes it off. A click on any bubble, a new
//   prompt, or BAR_OPEN_MS with nothing picked closes the bar.
// - A tapback on one of Claude's replies is told to Claude beside the person's
//   next message (prompt.submit `context`); it never starts a turn.
// - Claude tapbacks the person's newest message with its `react` tool.
// - Reply puts a "Replying to" row above the prompt; the next message carries
//   the quoted message to Claude as context, and draws the quote above its
//   bubble, with "1 Reply" under the original.

export type Tapback = { key: string; glyph: string; word: string; color?: string }

// iMessage's six, drawn as its monochrome glyphs where a terminal can: a heart,
// the two thumbs, "HA", "!!" and "?". Text glyphs are one cell wide on every
// terminal; the thumbs are emoji, two wide everywhere.
export const TAPBACKS: readonly Tapback[] = [
  { key: 'love', glyph: '♥', word: 'loved', color: '#FF2D55' },
  { key: 'like', glyph: '👍', word: 'liked' },
  { key: 'dislike', glyph: '👎', word: 'disliked' },
  { key: 'laugh', glyph: 'HA', word: 'laughed at' },
  { key: 'emphasize', glyph: '!!', word: 'emphasized' },
  { key: 'question', glyph: '?', word: 'questioned' },
]

export const BAR_OPEN_MS = 15_000
// The bar: one cell of padding, then four cells per tapback, then one cell.
export const ITEM_CELLS = 4
export const BAR_CELLS = 2 + TAPBACKS.length * ITEM_CELLS

// A message's reactions: the person's (a tapback key) and Claude's (any emoji),
// each with when it landed (a badge pops only when it is new).
export type Reactions = { you?: string; youAt?: number; claude?: string; claudeAt?: number; status?: string }
// The bar open over one message; `picked` once a tapback was chosen on it.
export type OpenBar = { id: string; at: number; picked?: string }
export type Quoted = { id: string; who: string; snippet: string }
export type ToClaude = { id: string; word: string; snippet: string }
export type ReadMark = { uuid: string; at: number }

// Messages kept in the reaction map, newest last; older ones are dropped.
export const KEPT = 500

export function tapbackOf(key: string | undefined): Tapback | undefined {
  return TAPBACKS.find(t => t.key === key)
}

// A record capped at KEPT entries, the oldest (first inserted) dropped.
export function capped<T>(record: Record<string, T>): Record<string, T> {
  const keys = Object.keys(record)
  if (keys.length <= KEPT) return record

  return Object.fromEntries(keys.slice(-KEPT).map(k => [k, record[k] as T]))
}

// A message's words for a quote or for Claude: markdown marks dropped, lines
// joined, at most `max` characters (an ellipsis when cut).
export function snippetOf(text: string, max: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

// The emoji presentation selector, by code point (no invisible character in
// this file).
const VS16 = new RegExp(String.fromCodePoint(0xfe0f), 'g')

// Claude's emoji as a badge draws it. A red heart becomes the bar's heart: the
// emoji form (U+2764 U+FE0F) is one cell on some terminals and two on others,
// which shifts the row. Anything else is kept as sent.
export function badgeGlyph(emoji: string): string {
  const bare = emoji.replace(VS16, '')
  if (bare === '❤' || bare === '♥') return '♥'

  return emoji
}

// The few words Claude says it is doing, as drawn: one line, no control or
// invisible characters, at most STATUS_MAX characters (an ellipsis when cut);
// undefined when there is nothing left.
export const STATUS_MAX = 48
export function statusOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = [...(value.split(/\r?\n/)[0] ?? '')]
    .filter(ch => {
      const c = ch.codePointAt(0) ?? 0

      return c >= 0x20 && !(c >= 0x7f && c <= 0x9f) && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x2028 && c <= 0x202e)
    })
    .join('')
    .trim()
  if (line === '') return undefined

  return line.length > STATUS_MAX ? `${line.slice(0, STATUS_MAX - 1).trimEnd()}…` : line
}

// What Claude may send as a reaction: one short emoji or tapback word, no
// spaces or line breaks, at most 8 UTF-16 units (a family emoji fits; a word
// does not, other than the tapback glyphs).
export function isReaction(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v === '' || v.length > 8 || /\s/.test(v)) return false
  if (TAPBACKS.some(t => t.glyph === v)) return true

  return !/[A-Za-z0-9]/.test(v)
}

// Where a bubble's hold region sits, so a release can be mapped to a tapback.
// All in cells, relative to the bubble's outer box (its tail column included):
// `x0` the region's left edge; `barY` the bar's row above the region's top
// (negative); `barLeft` the bar's left edge (negative when a narrow sent bubble
// has the bar stick out to its left).
export type BarPlace = { x0: number; barY: number; barLeft: number }

export function barPlace(o: { side: Side; width: number }): BarPlace {
  // hold.tsx draws the whole bubble (round and block), so its region starts at
  // the bubble's left edge and the bar sits on the row right above it.
  return { x0: 0, barY: -1, barLeft: o.side === 'received' ? 0 : o.width - BAR_CELLS }
}

// The tapback under a release at (x, y) of the hold region, if any.
export function barHit(place: BarPlace, x: number, y: number): Tapback | undefined {
  if (y !== place.barY) return undefined
  const bx = x + place.x0 - place.barLeft - 1
  if (bx < 0 || bx >= TAPBACKS.length * ITEM_CELLS) return undefined

  return TAPBACKS[Math.floor(bx / ITEM_CELLS)]
}

type Drawn = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type BarColors = { bar: string; ink: string; chosen: string }

export function barColors(theme: 'dark' | 'light' | 'other'): BarColors {
  return theme === 'light'
    ? { bar: '#D1D1D6', ink: '#000000', chosen: '#0073EB' }
    : { bar: '#3A3A3C', ink: '#FFFFFF', chosen: '#0073EB' }
}

// The tapback bar over a bubble: aligned with its left edge (Claude's) or its
// body's right edge (the person's), the current pick on blue.
export function tapbackBar(
  { Box, Text, Button }: Drawn,
  o: { id: string; side: Side; tailCols: number; current?: string; colors: BarColors; pick: (t: Tapback) => void },
) {
  return (
    <Box
      key={`bar-row:${o.id}`}
      width="100%"
      justifyContent={o.side === 'received' ? 'flex-start' : 'flex-end'}
      paddingRight={o.side === 'sent' ? o.tailCols : 0}
    >
      <Box key={`bar:${o.id}`} flexDirection="row" width={BAR_CELLS} paddingX={1} backgroundColor={o.colors.bar}>
        {TAPBACKS.map(t => {
          const isChosen = t.key === o.current
          const ink = t.color !== undefined && !isChosen ? t.color : o.colors.ink

          return (
            <Box key={`slot-${t.key}`} width={ITEM_CELLS} justifyContent="center">
              <Button key={`tap-${t.key}:${o.id}`} plain onPress={() => o.pick(t)}>
                <Text color={isChosen ? '#FFFFFF' : ink} backgroundColor={isChosen ? o.colors.chosen : o.colors.bar} bold>
                  {t.glyph}
                </Text>
              </Button>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

// The actions under a held bubble.
export function actionRow(
  { Box, Text, Button }: Drawn,
  o: { id: string; side: Side; tailCols: number; colors: BarColors; reply: () => void; copy: () => void },
) {
  return (
    <Box
      key={`actions-row:${o.id}`}
      width="100%"
      justifyContent={o.side === 'received' ? 'flex-start' : 'flex-end'}
      paddingRight={o.side === 'sent' ? o.tailCols : 0}
    >
      <Box key={`actions:${o.id}`} flexDirection="row" paddingX={1} backgroundColor={o.colors.bar}>
        <Button key={`reply:${o.id}`} plain onPress={o.reply}>
          <Text color={o.colors.ink} backgroundColor={o.colors.bar}>↩ Reply</Text>
        </Button>
        <Text backgroundColor={o.colors.bar}>{'   '}</Text>
        <Button key={`copy:${o.id}`} plain onPress={o.copy}>
          <Text color={o.colors.ink} backgroundColor={o.colors.bar}>⧉ Copy</Text>
        </Button>
      </Box>
    </Box>
  )
}

// "1 Reply" / "3 Replies" under a message that was replied to.
export function repliesRow(
  { Box, Text }: Pick<Drawn, 'Box' | 'Text'>,
  o: { id: string; side: Side; tailCols: number; count: number; small: string },
) {
  return (
    <Box
      key={`replies:${o.id}`}
      width="100%"
      justifyContent={o.side === 'received' ? 'flex-start' : 'flex-end'}
      paddingRight={o.side === 'sent' ? o.tailCols + 1 : 0}
      paddingLeft={o.side === 'received' ? 1 : 0}
    >
      <Text color={o.small}>{o.count === 1 ? '1 Reply' : `${o.count} Replies`}</Text>
    </Box>
  )
}

// The band row above the prompt while a reply is being written.
export function replyingRow(
  { Box, Text, Button }: Drawn,
  o: { quoted: Quoted; small: string; cancel: () => void },
) {
  return (
    <Box key="replying" flexDirection="row">
      <Text color={o.small}>{`↩ Replying to ${o.quoted.who}: `}</Text>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{snippetOf(o.quoted.snippet, 70)}</Text>
      </Box>
      <Text>{'  '}</Text>
      <Button key="reply-cancel" plain dimColor onPress={o.cancel}>✕</Button>
    </Box>
  )
}

// What Claude reads beside the person's next message: each tapback they put on
// one of its replies since, and the message they are replying to.
export function contextLines(sent: readonly ToClaude[], quoted: Quoted | null): string[] {
  const lines = sent.map(
    s => `The user ${s.word} one of your earlier messages with an iMessage-style tapback. The message: "${s.snippet}"`,
  )
  if (quoted !== null) {
    lines.push(
      `The user's message below is a threaded reply (iMessage-style) to this earlier message from ${
        quoted.who === 'Claude' ? 'you' : 'them'
      }: "${quoted.snippet}". Answer it in that thread's context.`,
    )
  }

  return lines
}

export const REACT_TOOL = 'react'
export const REACT_TOOL_NAME = 'mcp__chat-bubbles__react'

export const REACT_DESCRIPTION = [
  "Tapback the user's newest message with one emoji, the way a friend reacts in iMessage. It shows at once as a badge on their bubble and costs nothing. Your reaction is a live sign of what you are doing for that message.",
  'Whenever your answer is not instant, react first, before any other tool call and before thinking at length: the typing dots hide what is happening, and on a long think the user is left wondering.',
  'The emoji answers their message: it names the action you are taking on what they just said, not your next job elsewhere. A decision, a go-ahead, "later", "yes", a correction you accept: ✅. A question you are thinking through: 🤔. A request for work: the specific thing that work is about, picked from the whole emoji set so a glance says what is going on, e.g. 🧵 threads or replies, 📸 pictures, 🎨 colours, ⏳ animation timing, 🔤 fonts, 📐 layout, 🐛 a bug, 💥 a crash, 🧪 tests, 🚀 a deploy, 🔀 git merges, 🔒 auth or keys, 💾 a database, 💸 billing, 📊 data, 📜 logs, 📚 docs, 🧠 memory, 🤖 agents, 🧹 cleanup, ⚡ speed, 📱 mobile, 📧 email, 📅 dates.',
  'Only when nothing more specific fits, fall back to 🔎 (reading) or 🔧 (building). Prefer emoji that are pictures on their own, not symbols that need a variation selector.',
  'Always pass `status` too: exactly what you are doing, in a few plain words naming the thing (the file, the command, the question): "reading register.tsx", "running the 140 tests", "checking how Read is stored". Not a category ("working", "coding"). They show when the user rests the pointer on the badge, and stay after your turn so they can see what you did.',
  'React again when the thing you are on changes (📜 "reading the logs", then 🐛 "found it: a stale cache", then 🧪 "running the tests"): the new one replaces the old. Not on every tool call, only when the focus changes.',
  'Some messages need no words back: a reaction is the whole answer (thanks, "nice", "cool", a small confirmation, a go-ahead you simply act on). Then react and say nothing, or only what the work itself needs.',
  'When the work will take a while, you may also send one short line of text first saying what you are about to do, after the reaction.',
  'For a quick answer, react only when the message invites it: thanks (♥), a win (🎉), a joke (😂), a go-ahead (👍), a surprise (!!).',
].join('\n')
