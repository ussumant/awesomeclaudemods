import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import { capRows } from './cap'
import type { CapProps } from './cap'
import { SHAPES, bubbleEdges, isShape } from './shape'
import type { Shape, Side } from './shape'

// Sent text on either fill.
const WHITE = '#FFFFFF'

// Bubble fills and typing dots, picked by Claude Code's own `theme` setting:
// the default text in a received bubble follows that theme, so its fill does
// too. iMessage's colours for a `dark…` or `light…` theme; for any other value,
// or none, `userMessageBackground`, a key the engine's theme holds, which the
// ThemeKey doc says resolves like a typed one.
type Palette = {
  sent: string
  received: string
  dotDim: string
  dotBright: string
  // Delivered fades in through these, then ends on the small gray.
  deliveredSteps: readonly string[]
  // The one small line a failed or stopped tool call draws.
  failed: string
}
// The grays are iMessage's #262629 and #E9E9EB with the blue channel levelled
// (a change of 3, not visible). A level gray lands on the right step of a
// 256-colour terminal's gray ramp; #262629 rounded to a much lighter 59 there.
// The sent blue is #0073EB in both themes and every style, a shade darker than
// iMessage's: white text on it clears a 4.5 contrast ratio, so terminals that
// re-tint low-contrast text (Cursor's minimum contrast rule) leave it white.
// On #0A84FF or #007AFF that rule turned the white text black.
const SENT_BLUE = '#0073EB'
const DARK: Palette = {
  sent: SENT_BLUE,
  received: '#262626',
  dotDim: '#636366',
  dotBright: '#AEAEB2',
  deliveredSteps: ['#2C2C2E', '#48484A', '#636366'],
  failed: '#FF453A',
}
const LIGHT: Palette = {
  sent: SENT_BLUE,
  received: '#E9E9E9',
  dotDim: '#C7C7CC',
  dotBright: '#8E8E93',
  deliveredSteps: ['#E5E5EA', '#D1D1D6', '#C7C7CC'],
  failed: '#D70015',
}
const FALLBACK: Palette = { ...DARK, received: 'userMessageBackground' }

function paletteOf(theme: unknown): Palette {
  if (typeof theme !== 'string') return FALLBACK
  if (theme.startsWith('dark')) return DARK
  if (theme.startsWith('light')) return LIGHT
  return FALLBACK
}

// Small gray text: the header, time lines, Delivered.
const SMALL = '#8E8E93'
// The thread's first lines: Claude's mark, then its name.
const CLAUDE_ORANGE = '#D97757'

const SENT_SHARE = 0.75
const RECEIVED_SHARE = 0.75
const MAX_TEXT = 68 // columns of text in a bubble at most, before its padding
const RECEIVED_WIDE_SHARE = 0.85
const PAD_X = 2 // columns inside a bubble, left and right
const SPARE = 2 // columns a table or fence estimate keeps in hand
const TIME_GAP_MS = 15 * 60_000
const FALLBACK_COLUMNS = 80

// Switches kept across sessions in this mod's store.
const OFF_KEY = 'isOff' // the whole mod
const DETAIL_KEY = 'detail' // show what "only the conversation" hides
const STYLE_KEY = 'style' // the bubble shape
const TAIL_KEY = 'tail' // the `round` style's tails
// `block` by default: some terminals (Cursor's) draw the half-block edge rows
// of `pill` and `tail` with a seam; full filled lines join everywhere. `round`
// needs the Bubble Caps font installed (without it its glyphs draw as boxes),
// so it is never the default.
const DEFAULT_SHAPE: Shape = 'block'

type Prefs = { isOff: boolean; detail: boolean; shape: Shape; tail: boolean }

// The switches as last read from the store, kept in memory: read once per
// session (at session.start, or by the first draw that comes earlier), and
// changed by `/bubbles` once the store has the change. Draws never read the
// store after a good read. A hot reload starts with none and reads again.
let prefsCache: Promise<Prefs> | undefined

const DEFAULT_PREFS: Prefs = { isOff: false, detail: false, shape: DEFAULT_SHAPE, tail: true }

type StoreReader = { store: { get: (key: string) => Promise<unknown> } }

// Unset means on, detail off, block, tail on. A read that fails rejects.
async function readPrefs($: StoreReader): Promise<Prefs> {
  const [off, detail, style, tail] = await Promise.all([
    $.store.get(OFF_KEY),
    $.store.get(DETAIL_KEY),
    $.store.get(STYLE_KEY),
    $.store.get(TAIL_KEY),
  ])

  return {
    isOff: off === true,
    detail: detail === true,
    shape: isShape(style) ? style : DEFAULT_SHAPE,
    tail: tail !== false,
  }
}

// Starts a read and keeps it only if it succeeds: a failed read is dropped, so
// the next draw (or command) reads again.
function startRead($: StoreReader): Promise<Prefs> {
  const reading = readPrefs($)
  prefsCache = reading
  reading.catch(() => {
    if (prefsCache === reading) prefsCache = undefined
  })

  return reading
}

// The switches for a draw: the kept copy, else a fresh read; the defaults for
// this draw alone when the read fails.
async function prefsOf($: StoreReader): Promise<Prefs> {
  try {
    return await (prefsCache ?? startRead($))
  } catch {
    return DEFAULT_PREFS
  }
}

// Writes one switch to the store, then (only once that write succeeded) to
// the in-memory copy. It starts from a fresh read of the store, never from
// defaults a failed read left for a draw: a read or a write that fails
// rejects, and nothing changes.
async function setPref($: EngineInterface, change: Partial<Prefs>) {
  const current = await readPrefs($)
  if (change.isOff !== undefined) await $.store.set(OFF_KEY, change.isOff)
  if (change.detail !== undefined) await $.store.set(DETAIL_KEY, change.detail)
  if (change.shape !== undefined) await $.store.set(STYLE_KEY, change.shape)
  if (change.tail !== undefined) await $.store.set(TAIL_KEY, change.tail)
  prefsCache = Promise.resolve({ ...current, ...change })
}

// Typed prompts of this session in order, stamped when the session stored
// them: the API gives a row no time of its own, so this is the stable one.
const prompts = atom({ plugin: 'chat-bubbles', key: 'prompts' } as const, [], {
  shape: 'prompts-1',
})

// The thread's first typed prompt, by id, kept on its own: `prompts` keeps the
// last 500 only, so its first entry is not the thread's first after that.
const first = atom({ plugin: 'chat-bubbles', key: 'first' } as const, '')

// Claude Code's `theme` row as last read: at session start, after a /config
// change, and before each prompt (the /theme picker raises no config event).
const theme = atom({ plugin: 'chat-bubbles', key: 'theme' } as const, '')

type Table = Pick<Elements['terminal'], 'Box' | 'Text'>

// Reads the `theme` row; '' when there is none or the read fails. Written only
// when it changed, so rows redraw only then.
async function refreshTheme($: EngineInterface) {
  let value = ''
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    value = typeof row?.value === 'string' ? row.value : ''
  } catch {
    value = ''
  }
  if ((await read($, theme)) !== value) {
    await update($, theme, () => value)
  }
  themeKnown = true
  if (themeNow !== value) {
    themeNow = value
    await redraw($) // draws read `themeNow`, not the state, so ask for a redraw
  }
}

// The theme as last read, in memory: every draw reads it without a `$` call
// (a worker hop per row). Kept in step with the `theme` state above.
let themeNow = ''
let themeKnown = false

// The theme for a draw. After a hot reload no session start or theme change
// comes, so the first draw reads the saved `theme` state once; every draw
// after that reads memory.
// Rows drawn at the same moment share the one read in flight, so every one of
// them waits for it and gets the saved theme.
let themeLoading: Promise<void> | undefined
async function themeOf($: EngineInterface): Promise<string> {
  if (!themeKnown) {
    themeLoading ??= (async () => {
      try {
        const saved = await read($, theme)
        if (!themeKnown && typeof saved === 'string' && saved !== '') themeNow = saved
      } catch {
        // keep the fallback colours
      }
      themeKnown = true
    })()
    await themeLoading
  }

  return themeNow
}

// Cells one character takes in the terminal: 2 for CJK, Hangul, full-width
// forms and emoji, 0 for combining marks, zero-width characters and variation
// selectors, 1 for the rest. A small range check (the kit has no helper).
function charCells(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2300 && cp <= 0x23ff) || // ⌚ ⌛ ⏰ … (counted two: over is the safe side)
    (cp >= 0x2600 && cp <= 0x27bf) || // ☕ ✅ ❤ …
    (cp >= 0x2b00 && cp <= 0x2bff) || // ⭐ ⬛ …
    (cp >= 0x1f000 && cp <= 0x1f02f) || // 🀄 …
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) || // 🫠 …
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

// Cells a line takes, wide characters counted 2.
function lineCells(line: string): number {
  let cells = 0
  for (const ch of line) cells += charCells(ch.codePointAt(0) ?? 0)

  return cells
}

// Columns a block of text needs on its longest line, counted in cells.
function longestLine(text: string): number {
  let longest = 0
  for (const line of text.split('\n')) {
    longest = Math.max(longest, lineCells(line))
  }
  return longest
}

// A table's delimiter row: cells of dashes with optional colons, split by
// pipes, with or without the outer ones (`--- | ---`, `|:--|--:|`).
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitCells(line)

  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell.trim()))
}

// A row's cells, split only on pipes no backslash escapes; the outer pipes,
// when there, open and close the row rather than holding an empty cell.
function splitCells(line: string): string[] {
  const cells = line.trim().split(/(?<!\\)\|/)
  if (line.trim().startsWith('|')) cells.shift()
  if (line.trim().endsWith('|') && !line.trim().endsWith('\\|')) cells.pop()

  return cells
}

const FENCE = /^(\s*)(```+|~~~+)/

// Markdown the renderer lays out wider than its source: tables and fences
// (and lines that open with a pipe, which may be either).
function hasWideBlocks(markdown: string): boolean {
  const lines = markdown.split('\n')

  return lines.some(
    line => FENCE.test(line) || /^\s*\|/.test(line) || isDelimiterRow(line) || isQuotedTableLine(line),
  )
}

// A table line inside a `>` blockquote (it is still a table: its quote marks
// are counted as indent).
function isQuotedTableLine(line: string): boolean {
  const quote = /^\s*(>\s*)+/.exec(line)
  if (!quote) return false
  const inner = line.slice(quote[0].length)

  return /^\s*\|/.test(inner) || isDelimiterRow(inner)
}

// Latin text, common punctuation, arrows and box drawing: surely one cell
// each. Any other character (emoji, CJK, other scripts) may take two.
const ONE_CELL = /^[\t\n\r -~ -ɏ -⁯←-⇿─-╿]*$/

// Columns a raw line takes, a tab counted as 8.
function rawColumns(line: string): number {
  return [...line].reduce((sum, ch) => sum + (ch === '\t' ? 8 : charCells(ch.codePointAt(0) ?? 0)), 0)
}

// Columns a table cell's text takes, never under-counted: a character not
// surely one cell (ONE_CELL) and not zero-width counts two.
function tableCells(text: string): number {
  let cells = 0
  for (const ch of text) {
    if (ch === '\t') {
      cells += 8
      continue
    }
    const one = charCells(ch.codePointAt(0) ?? 0)
    cells += one === 1 && !ONE_CELL.test(ch) ? 2 : one
  }

  return cells
}

// A cell's text as drawn, for well-formed inline markup only: a link
// `[text](url)` is its text, paired `**…**` and paired backticks lose their
// marks. Anything else (a lone `*` or `_`) stays as written: when unsure, the
// raw text, so a cell is never under-counted.
function drawnCellText(cell: string): string {
  return cell
    .replace(/\[([^\]\n]*)\]\([^()\s]*\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
}

// The marks before a table row inside a quote or a list item: leading spaces,
// `>` quote marks, and a list marker (`-`, `*`, `+`, `1.`, `1)`).
const ROW_PREFIX = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+)?/

function rowPrefix(line: string): string {
  return ROW_PREFIX.exec(line)?.[0] ?? ''
}

// Estimated columns the renderer draws a reply holding a table or a code fence
// in, never narrower than what is drawn:
// - a table (any block with a delimiter row) is the sum over its columns of
//   the widest cell + 2, plus columns + 1 for the rules, the column count
//   being the most cells any row has; a cell is its drawn text (drawnCellText)
//   in cells (tableCells); a table in a quote or a list item adds its widest
//   row prefix (the quote marks, the marker, the indent);
// - a fence is its longest raw line (a tab as 8) plus its own indent + 2;
// - any other line counts as written, wide characters two cells.
// Undefined (take the 85% width) when a fence never closes, a delimiter row
// has no header row above it, or a table has a lazy row (a non-blank line with
// no pipe right under it).
export function estimateContentWidth(markdown: string): number | undefined {
  return measureContent(markdown)?.widest
}

// The estimate above, with the widest table alone beside it (0 when none):
// a table may widen its bubble past the 85% cap, plain lines may not.
function measureContent(markdown: string): { widest: number; table: number } | undefined {
  const lines = markdown.split('\n')
  const body = (line: string | undefined) => (line ?? '').slice(rowPrefix(line ?? '').length)
  let widest = 0
  let widestTable = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence) {
      const indent = rawColumns(fence[1] ?? '')
      const marker = fence[2] ?? '```'
      let longest = 0
      let closed = false
      i += 1
      while (i < lines.length) {
        const inner = lines[i] ?? ''
        if (inner.trim().startsWith(marker[0]!.repeat(3)) && inner.trim().replace(/[`~]/g, '') === '') {
          closed = true
          break
        }
        longest = Math.max(longest, rawColumns(inner))
        i += 1
      }
      if (!closed) return undefined
      widest = Math.max(widest, indent + longest + 2)
      i += 1
      continue
    }
    if (isDelimiterRow(body(line))) {
      // The header row is the line just above (not counted as plain text).
      const header = lines[i - 1]
      if (header === undefined || body(header).trim() === '' || !body(header).includes('|')) return undefined
      const rows = [header, line]
      i += 1
      while (i < lines.length && body(lines[i]).trim() !== '' && /(?<!\\)\|/.test(body(lines[i]))) {
        rows.push(lines[i] ?? '')
        i += 1
      }
      // A lazy row: GFM may draw it as one more row of the table.
      if (i < lines.length && body(lines[i]).trim() !== '') return undefined
      // In a quote or a list item the rows sit behind their marks and indent.
      const indent = Math.max(...rows.map(row => rawColumns(rowPrefix(row))))
      // The delimiter row adds to the column count, not to any width: its
      // dashes are never drawn.
      const cols: number[] = []
      for (const row of rows) {
        splitCells(body(row)).forEach((cell, c) => {
          const drawn = row === line ? 0 : tableCells(drawnCellText(cell.trim()))
          cols[c] = Math.max(cols[c] ?? 0, drawn)
        })
      }
      const table = indent + cols.reduce((sum, w) => sum + w + 2, 0) + cols.length + 1
      widest = Math.max(widest, table)
      widestTable = Math.max(widestTable, table)
      continue
    }
    // A table's header row is measured with its table (as drawn), not raw.
    const isHeader = body(line).includes('|') && i + 1 < lines.length && isDelimiterRow(body(lines[i + 1]))
    if (!isHeader) widest = Math.max(widest, rawColumns(line))
    i += 1
  }

  return { widest, table: widestTable }
}

// The widest a plain bubble gets: 68 columns of text plus its padding, or its
// share of the row, whichever is smaller.
function narrowCap(columns: number, share: number): number {
  return Math.max(4, Math.min(MAX_TEXT + 2 * PAD_X, Math.floor(columns * share)))
}

// What a reply's width depends on, worked out once per text: a reply is drawn
// again on every redraw (a key press, a resize, the typing dots), and a long
// one is not scanned again each time. The last 64 texts are kept.
type WidthFacts = { wide: boolean; longest: number; content: { widest: number; table: number } | undefined }
const widthFacts = new Map<string, WidthFacts>()
const FACTS_KEPT = 64
let scans = 0

// How many times a reply's text has been scanned for its width (tests).
export function widthScans(): number {
  return scans
}

function factsOf(markdown: string): WidthFacts {
  const kept = widthFacts.get(markdown)
  if (kept !== undefined) return kept
  scans += 1
  const wide = hasWideBlocks(markdown)
  const facts = { wide, longest: wide ? 0 : longestLine(markdown), content: wide ? measureContent(markdown) : undefined }
  if (widthFacts.size >= FACTS_KEPT) widthFacts.delete(widthFacts.keys().next().value as string)
  widthFacts.set(markdown, facts)

  return facts
}

// A reply bubble's width: hugs its text up to the narrow cap; with a table or
// fence, the estimate plus padding and spare, up to 85%; 85% when unsure.
// A table gets past 85% if it needs to. What the engine was measured doing:
// it draws a table at its natural width whatever Box holds it; a table wider
// than the terminal it either squeezes to at most columns - 5 (121 at 127, 75
// at 80, 55 at 60) or lays out as a "Field: value" list wrapped at about
// columns - 4 (about 123 at 127). So a table's bubble is its estimate plus
// padding and spare, up to the whole row less the tail column (inside:
// columns - 5); a table that would need more is the engine's row
// (tableTooWide).
export function replyWidth(markdown: string, columns: number): number {
  const facts = factsOf(markdown)
  const wideCap = Math.max(4, Math.floor(columns * RECEIVED_WIDE_SHARE))
  if (!facts.wide) {
    return Math.min(facts.longest + 2 * PAD_X, narrowCap(columns, RECEIVED_SHARE))
  }
  if (facts.content === undefined) return wideCap
  const base = Math.min(facts.content.widest + 2 * PAD_X + SPARE, wideCap)
  if (facts.content.table === 0) return base
  const table = Math.min(facts.content.table + 2 * PAD_X + SPARE, Math.max(4, columns - 1))

  return Math.max(base, table)
}

// Whether a reply holds a table no bubble can hold: its bubble (the table
// plus padding and spare) would pass the row less the tail column. The engine
// then fits the table to the terminal (see replyWidth: squeezed to at most
// columns - 5, or a "Field: value" list at about columns - 4, which wraps
// inside any bubble), so the reply is better drawn as the engine's own row.
export function tableTooWide(markdown: string, columns: number): boolean {
  const content = factsOf(markdown).content

  return content !== undefined && content.table > 0 && content.table + 2 * PAD_X + SPARE > columns - 1
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// `Today` / `12:21 AM`, or `Mon, Nov 17` / `at 9:05 PM` for an earlier day.
function timeLabel(at: number, now: number): { day: string; time: string } {
  const when = new Date(at)
  const today = new Date(now)
  const hours = when.getHours()
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${String(when.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
  const isToday =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()

  return isToday
    ? { day: 'Today', time: clock }
    : {
        day: `${DAYS[when.getDay()]}, ${MONTHS[when.getMonth()]} ${when.getDate()}`,
        time: `at ${clock}`,
      }
}

// One bubble: its edge rows (per shape) around a filled body. Rows as wide as
// the body sit on the side away from the tail; the tail row is one wider.
function bubble(
  { Box, Text }: Table,
  o: { shape: Shape; side: Side; width: number; fill: string; who: string; children: unknown },
) {
  const edges = bubbleEdges(o.shape, o.width, o.side)
  const hasTail = edges.tailAt !== 'none'
  const align = o.side === 'sent' ? 'flex-start' : 'flex-end'

  return (
    <Box key={`shape-${o.who}`} flexDirection="column" width={hasTail ? o.width + 1 : o.width}>
      {edges.top !== '' && (
        <Box width={o.width} alignSelf={align}>
          <Text color={o.fill} wrap="clip">{edges.top}</Text>
        </Box>
      )}
      <Box
        key={`bubble-${o.who}`}
        width={o.width}
        paddingX={PAD_X}
        paddingY={o.shape === 'block' ? 1 : 0}
        backgroundColor={o.fill}
        alignSelf={align}
      >
        {o.children as never}
      </Box>
      {edges.bottom !== '' && (
        <Box width={hasTail ? o.width + 1 : o.width} alignSelf={align}>
          <Text color={o.fill} wrap="clip">{edges.bottom}</Text>
        </Box>
      )}
    </Box>
  )
}

// ---- Client faults ----------------------------------------------------------
//
// Which of this mod's Client keys have failed: the typing dots
// (`typing:<turn word>`) and Delivered (`delivered`). A faulted key draws its
// fallback (still dots, the plain word). At the person's next
// prompt a key's first fault is forgotten and its Client tried again. A key
// that has faulted before keeps its fallback until the first prompt that comes
// at least 60 seconds after its last fault, then is tried again: never locked
// for the rest of the session.

const REPEAT_WAIT_MS = 60_000
const faultedAt = new Map<string, number>()
const faultCount = new Map<string, number>()

export function noteFault(key: string, at: number) {
  // A fault noted again before its time is known is still the same one.
  const known = faultedAt.get(key)
  if (!(Number.isFinite(at) && known !== undefined && !Number.isFinite(known))) {
    faultCount.set(key, (faultCount.get(key) ?? 0) + 1)
  }
  faultedAt.set(key, at)
}

export function hasFaulted(key: string): boolean {
  return faultedAt.has(key)
}

// At the person's next prompt: forgets each fault that may be tried again (a
// first fault, a repeat whose last fault is at least 60 s old, or one whose
// time could not be read: never kept for good); whether any was forgotten.
export function recoverFaults(now: number): boolean {
  let any = false
  for (const [key, at] of [...faultedAt]) {
    const repeat = (faultCount.get(key) ?? 0) > 1
    const waited = !Number.isFinite(at) || (Number.isFinite(now) && now - at >= REPEAT_WAIT_MS)
    if (!repeat || waited) {
      faultedAt.delete(key)
      any = true
    }
  }

  return any
}

export function forgetAllFaults() {
  faultedAt.clear()
  faultCount.clear()
}

// The typing dots without a Client: still, the middle one bright, each dot its
// own colour run starting with the dot.
function stillDots(
  { Box, Text }: Pick<Elements['terminal'], 'Box' | 'Text'>,
  o: { dot: string; dim: string; bright: string; fill: string },
) {
  return (
    <Box key="still-dots" flexDirection="row">
      <Text color={o.dim} backgroundColor={o.fill}>{`${o.dot} `}</Text>
      <Text color={o.bright} backgroundColor={o.fill}>{`${o.dot} `}</Text>
      <Text color={o.dim} backgroundColor={o.fill}>{o.dot}</Text>
    </Box>
  )
}

// ---- round: the Bubble Caps font -------------------------------------------
//
// Glyphs as listed in assets/glyph-map.json. A cap glyph is drawn in the
// fill colour on the page (no background of its own); body cells are the text
// on the fill. Two rules the terminal imposes: a colour run starts with a glyph
// or real text, never with a space in cap colours (its contrast rule judges a
// run by its first cell, and the font's glyphs are exempt from it only when they
// lead); and indents are uncoloured layout, never coloured spaces.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const PAD_TOP = 0xe0a4
const PAD_BOTTOM = 0xe0a5
const TYPING_DOT = cp(0xe0a6)
const AVATAR_TOP = cp(0xe0ce, 0xe0cf, 0xe0d0, 0xe0d1)
const AVATAR_BOTTOM = cp(0xe0d2, 0xe0d3, 0xe0d4, 0xe0d5)

// The shape a draw uses. `round` relies on rows that redraw (its cap columns
// read their height after layout), which only the full-screen layout does: off
// full screen a saved `round` draws `block`, everywhere.
function shapeFor(saved: Shape, viewport: { isFullscreen?: boolean } | undefined): Shape {
  return saved === 'round' && viewport?.isFullscreen !== true ? 'block' : saved
}

type RoundTable = Pick<Elements['terminal'], 'Box' | 'Text' | 'Client'>

function padRows(side: Side, inner: number, tail: boolean): { top: string; bottom: string } {
  const top = cp(0xe0b0, 0xe0b1) + cp(PAD_TOP).repeat(inner) + cp(0xe0bb, 0xe0ba)
  const fill = cp(PAD_BOTTOM).repeat(inner)
  if (!tail) return { top, bottom: cp(0xe0b8, 0xe0b9) + fill + cp(0xe0c3, 0xe0c2) }

  return side === 'sent'
    ? { top, bottom: cp(0xe0b8, 0xe0b9) + fill + cp(0xe0c5, 0xe0c6, 0xe0c7) }
    : { top, bottom: cp(0xe0cc, 0xe0cb, 0xe0ca) + fill + cp(0xe0c3, 0xe0c2) }
}

// One cap column of a `round` bubble that wraps, in the row's flow: its
// first-row cap, a fill that grows, its last-row cap. Its own height is two
// rows, so the row (stretched to its tallest child) is as tall as the body and
// the column follows the body down as well as up (a wider or narrower
// terminal). Two earlier ways failed: a Client with no height is as tall as
// what it draws, which held the bubble at its old height; and a Box out of the
// flow (absolute) inside a message partly scrolled off the top was drawn from
// the first visible row, so its last cap fell below the bubble. The cost: a
// body on this path is at least two rows tall.
function capColumn(Box: RoundTable['Box'], Text: RoundTable['Text'], name: string, id: string, props: CapProps) {
  const [first, last] = capRows(props, 2)

  return (
    <Box key={`${name}:${id}`} flexDirection="column" width={2} flexShrink={0}>
      <Text color={props.fill} wrap="clip">{first}</Text>
      <Box key={`${name}-fill:${id}`} flexGrow={1} backgroundColor={props.fill} />
      <Text color={props.fill} wrap="clip">{last}</Text>
    </Box>
  )
}

// Whether a body's text is surely one row at this inner width.
function isOneRow(text: string, inner: number): boolean {
  // Every character one cell (ONE_CELL): a wide one may wrap where the count
  // says it fits, and a wrapped body needs the cap columns.
  return !/[\n\t]/.test(text) && ONE_CELL.test(text) && !hasWideBlocks(text) && lineCells(text) <= inner
}

// A `round` bubble `width` wide (text width + 4), plus one column for the tail:
// right of a sent bubble (the bubble moves one column left for it), left of a
// received one. The cap columns (capColumn) stretch to the body's height, so
// wrapped text and Markdown of any height get the right corners.
function roundBubble(
  { Box, Text }: Pick<RoundTable, 'Box' | 'Text'>,
  o: { side: Side; width: number; fill: string; who: string; id: string; tail: boolean; text: string; children: unknown },
) {
  const inner = Math.max(1, o.width - 4)
  const sentTail = o.tail && o.side === 'sent'
  const receivedTail = o.tail && o.side === 'received'
  const { top, bottom } = padRows(o.side, inner, o.tail)
  const left = { side: 'left' as const, fill: o.fill, tail: receivedTail }
  const right = { side: 'right' as const, fill: o.fill, tail: sentTail }
  // A body known to be one row (no line break, no tab, no table or fence, and
  // no wider than the inner width) gets its one-line caps printed here. Only
  // bodies that can wrap get the cap columns, which stretch to their height.
  const oneLine = isOneRow(o.text, inner)

  return (
    <Box key={`shape-${o.who}`} flexDirection="column" width={o.width + (o.tail ? 1 : 0)}>
      <Box flexDirection="row">
        {receivedTail && <Box width={1} />}
        <Text color={o.fill} wrap="clip">{top}</Text>
      </Box>
      <Box flexDirection="row" alignItems="stretch">
        {receivedTail && <Box width={1} />}
        {oneLine ? (
          <Text color={o.fill} wrap="clip">{capRows(left, 1)[0]}</Text>
        ) : (
          capColumn(Box, Text, `cap-left`, o.id, left)
        )}
        <Box key={`bubble-${o.who}`} width={inner} backgroundColor={o.fill}>
          {o.children as never}
        </Box>
        {oneLine ? (
          <Text color={o.fill} wrap="clip">{capRows(right, 1)[0]}</Text>
        ) : (
          capColumn(Box, Text, `cap-right`, o.id, right)
        )}
      </Box>
      <Box flexDirection="row">
        <Text color={o.fill} wrap="clip">{bottom}</Text>
      </Box>
    </Box>
  )
}

// The `round` typing pill: one text row, no tail, 9 wide; the dots are the
// font's dot glyph, animated by typing.tsx under `typingKey`, or still when
// that Client has faulted.
function roundTyping(
  { Box, Text, Client }: RoundTable,
  o: { fill: string; dim: string; bright: string; typingKey: string },
) {
  const { top, bottom } = padRows('received', 5, false)

  return (
    <Box key="shape-typing" flexDirection="column" width={9}>
      <Text color={o.fill} wrap="clip">{top}</Text>
      <Box flexDirection="row">
        <Text color={o.fill}>{cp(0xe0b6, 0xe0b7)}</Text>
        <Box key="bubble-typing" width={5} backgroundColor={o.fill}>
          {hasFaulted(o.typingKey) ? (
            stillDots({ Box, Text }, { dot: TYPING_DOT, dim: o.dim, bright: o.bright, fill: o.fill })
          ) : (
            <Client
              key={o.typingKey}
              module="./typing.tsx"
              props={{ dim: o.dim, bright: o.bright, fill: o.fill, dot: TYPING_DOT }}
            />
          )}
        </Box>
        <Text color={o.fill}>{cp(0xe0c1, 0xe0c0)}</Text>
      </Box>
      <Text color={o.fill} wrap="clip">{bottom}</Text>
    </Box>
  )
}

// What "only the conversation" hides: clean tool rows and their progress pill,
// the turn's closing line ("Baked for 3s"), and the dim notice under the logo.
// Shown again with `/bubbles detail on`, with the mod off, off the terminal,
// and in the ctrl+o / verbose view.
// The turn line is kept when it carries `waitingFor` (it only says what the
// turn waits on). A waiting line whose agent count differs from the one it
// draws carries no `waitingFor` and is hidden: an accepted edge case, since it
// is a status line and the agent list still shows what is running.
// InfoNotice is information only (the model source, an experiment enrollment,
// a settings hint), per its doc.
const HIDDEN = ['ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress', 'TurnDuration', 'InfoNotice'] as const

// Whether a user-role row's origin is, by its doc, the person's own words sent
// to Claude, whatever device it came from:
// - `composer`: Enter at this terminal's prompt, typed or queued;
// - `bridge`: the person's message through Remote Control (a phone, the web);
// - `slack-ping`: the session's owner pinging it from Slack.
// Every other kind is left to the engine: another agent or session (`peer`,
// `peer-send-message`, `projects-relay`, `coordinator`, `observer`,
// `observer-activity`), a task (`task-notification`), a stored or machine
// turn (`scheduled-trigger`, `auto-continuation`, `sdk`), a relayed channel
// (`channel`, whose sender the doc does not name), `unclassified`, and any
// plugin's message, `asUser` included: the engine's row names the plugin, and
// a blue bubble would make an installed plugin's text look typed by the person.
function isOwnWords(origin: { kind: string } | undefined): boolean {
  if (origin === undefined) return false

  return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'slack-ping'
}

// The first quoted label in a task's one-line summary, 1 to 48 characters of
// plain text; undefined when the summary has none, runs past one line, or the
// label is longer or holds markup.
const TASK_LABEL_MAX = 48
function taskLabel(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text.includes('\n')) return undefined
  const quoted = /"([^"\n]{1,200})"/.exec(text)?.[1]?.trim()
  if (!quoted || quoted.length > TASK_LABEL_MAX || /[<>]/.test(quoted)) return undefined

  return quoted
}

// A server, plugin or sender name as a small line prints it: its first line,
// trimmed, at most 32 characters (the 32nd an ellipsis when cut); '' when none.
const NAME_MAX = 32
export function shortName(name: string | undefined): string {
  const first = String(name ?? '').split(/\r?\n/)[0] ?? ''
  const line = [...first].filter(ch => !isHiddenChar(ch.codePointAt(0) ?? 0)).join('').trim()

  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
}

// Characters a name must not carry: control characters, and the bidi
// controls, zero-width, format, filler, line-separator and tag characters that
// could reorder, hide or break part of it. By code point, so no invisible
// character sits in this file.
function isHiddenChar(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  )
}

// The gray line for a teammate drain row as the hook gets it (the frames'
// bodies joined, framing stripped): undefined unless some line (the text's
// start or right after a newline) starts with an idle notice. Names are the
// notices' distinct `from` values through shortName: one, "<a> sent an
// update"; two, "<a> and <b> sent updates"; more, "Teammates sent updates".
const IDLE_NOTICE = /(?:^|\n)\{"type":"idle_notification","from":"((?:[^"\\\n]|\\.)*)"/g
export function drainUpdate(text: string): string | undefined {
  const names: string[] = []
  let seen = false
  for (const match of text.matchAll(IDLE_NOTICE)) {
    seen = true
    let from = match[1] ?? ''
    try {
      from = JSON.parse(`"${from}"`) as string
    } catch {
      // keep the raw value
    }
    const name = shortName(from)
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  if (!seen) return undefined
  if (names.length === 1) return `${names[0]} sent an update`
  if (names.length === 2) return `${names[0]} and ${names[1]} sent updates`

  return 'Teammates sent updates'
}

// The gray line for a row whose text is only teammate frames, each a
// `<teammate-message teammate_id="…">…</teammate-message>`, as the session
// stores them: optional leading whitespace, the harness's leading line
// (TEAMMATE_LEAD) if present, the frames with nothing but whitespace between
// them, and the harness's closing paragraph (from TEAMMATE_CLOSING to the
// end) if present. "<id> sent an update" when every frame names the same
// teammate, "Teammates sent updates" when they differ. undefined for any
// other text (it stays the engine's).
const TEAMMATE_FRAME = /<teammate-message(\s[^<>]*)?>[\s\S]*?<\/teammate-message>/g
const TEAMMATE_LEAD = 'Another Claude session sent a message:'
const TEAMMATE_CLOSING = 'This came from another Claude session'
const FRAME_END = '</teammate-message>'
export function teammateUpdate(text: string): string | undefined {
  let body = text.trimStart()
  if (body.startsWith(TEAMMATE_LEAD)) body = body.slice(TEAMMATE_LEAD.length).trimStart()
  if (!body.startsWith('<teammate-message')) return undefined
  const end = body.lastIndexOf(FRAME_END)
  if (end < 0) return undefined
  const after = body.slice(end + FRAME_END.length).trim()
  if (after !== '' && !after.startsWith(TEAMMATE_CLOSING)) return undefined
  const ids: string[] = []
  const rest = body.slice(0, end + FRAME_END.length).replace(TEAMMATE_FRAME, (_frame, attrs: string | undefined) => {
    ids.push(/(?:^|\s)teammate_id="([^"]*)"/.exec(attrs ?? '')?.[1] ?? '')

    return ''
  })
  if (ids.length === 0 || rest.trim() !== '' || ids.some(id => shortName(id) === '')) return undefined

  return ids.every(id => id === ids[0]) ? `${shortName(ids[0])} sent an update` : 'Teammates sent updates'
}

// A message's own words, not text wrapped in tags or other markup: no tag at
// all (`<channel …>`, `</x>`, `<x/>`).
function isPlainText(text: string): boolean {
  return !/<\/?[A-Za-z][\w:.-]*(\s[^<>]*)?\/?>/.test(text)
}

// The one gray line a user-role row that is not the person's own words draws:
// who sent it, in plain words, from the origin kind, `from` and `task`.
export function fromLine(props: {
  origin?: { kind: string; name?: string; server?: string }
  from?: { name: string }
  task?: { status?: string }
  text?: string
}): string {
  const kind = props.origin?.kind
  if (props.task !== undefined || kind === 'task-notification') {
    const status = props.task?.status
    // The task's own short label, when its one-line summary quotes one
    // (`Background command "build docs" completed`).
    const label = taskLabel(props.text)
    if (label !== undefined) {
      if (status === 'completed') return `${label} finished`
      if (status === 'failed') return `${label} failed`
      if (status === 'killed') return `${label} stopped`
    }
    if (status === 'completed') return 'A background task finished'
    if (status === 'failed') return 'A background task failed'
    if (status === 'killed') return 'A background task was stopped'

    return 'A background task sent an update'
  }
  const name = shortName(props.from?.name)
  if (name) return `${name} sent an update`
  const server = shortName(props.origin?.server)
  const plugin = shortName(props.origin?.name)
  switch (kind) {
    case 'peer':
    case 'peer-send-message':
    case 'projects-relay':
    case 'coordinator':
      return 'Another Claude session sent an update'
    case 'scheduled-trigger':
      return 'A scheduled check-in ran'
    case 'channel':
      return server ? `A message arrived from ${server}` : 'A message arrived from a channel'
    case 'observer':
      return 'An observer agent sent a report'
    case 'observer-activity':
      return 'An activity digest arrived'
    case 'plugin':
      return plugin ? `The ${plugin} plugin sent a message` : 'A plugin sent a message'
    default:
      // sdk, auto-continuation, unclassified, and any kind added later.
      return 'A message arrived from outside this chat'
  }
}

// Whether a stored row joins the thread record (`prompts`, `first`): the
// person's own words (wherever sent from), a user row of the main
// conversation, not meta, with a stored id.
export function isRecorded(
  e: { origin: { kind: string }; agentId?: string; message: { type: string; isMeta?: true } },
  uuid: string | undefined,
): boolean {
  return (
    uuid !== undefined &&
    isOwnWords(e.origin) &&
    e.agentId === undefined &&
    e.message.type === 'user' &&
    e.message.isMeta !== true
  )
}

async function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render') // redraw rows already on screen
  } catch {
    // The switch is stored; new rows follow it even without a redraw.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bubbles',
      description: 'Chat bubbles: on, off, detail on|off, style block|pill|tail|round, tail on|off',
      argumentHint: 'on|off | detail on|off | style block|pill|tail|round | tail on|off',
    })
    // Once per session; a failed read is dropped and retried on first use.
    await startRead($).catch(() => undefined)
    forgetAllFaults() // a new session tries every Client again
    await refreshTheme($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The theme row changed in /config (or by a plugin's $.config.set).
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await refreshTheme($)

    return result
  }).catch(($, e, next) => next(e))

  // /theme's picker raises no config event: read the row again before each
  // prompt, so a change shows from the next reply on.
  on('prompt.submit', async ($, e, next) => {
    await refreshTheme($)
    // The person is back: Client faults (a stall while the Mac was locked,
    // say) are forgotten and every piece tries its Client again.
    const now = await $.clock.now().catch(() => Number.NaN)
    if (recoverFaults(now)) await redraw($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A Client of this mod failed (did not load, failed to draw, or overran its
  // budget). Recorded by its key; the engine then draws the site again, and
  // the draw leaves that Client out (see hasFaulted). Observe only.
  on('ui.fault', async ($, e, next) => {
    noteFault(e.element, Number.NaN) // before any wait: the redraw may come first
    try {
      noteFault(e.element, await $.clock.now())
    } catch {
      // The key stays recorded without a time.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear starts a new thread: the next prompt gets the header again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, prompts, () => [])
      await update($, first, () => '')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Stamp each typed prompt of the main conversation as it is stored.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      const uuid = stored.uuid
      if (uuid !== undefined && isRecorded(e, uuid)) {
        const at = await $.clock.now()
        await update($, prompts, list => [...list, { uuid, at }].slice(-500))
        await update($, first, id => (id === '' ? uuid : id))
      }
    } catch {
      // A missing stamp only costs that row its time line.
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bubbles' }, async ($, e) => {
    // A plugin's `$.command.run` can leave `args` out; read that as bare.
    const words = String(e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [word, second] = words

    if (words.length === 1 && (word === 'on' || word === 'off')) {
      await setPref($, { isOff: word === 'off' })
      await redraw($)

      return { text: `Chat bubbles ${word}.`, isTextDisplayOnly: true }
    }

    if (word === 'detail' && (second === 'on' || second === 'off') && words.length === 2) {
      await setPref($, { detail: second === 'on' })
      await redraw($)

      return { text: `Detail ${second}.`, isTextDisplayOnly: true }
    }

    if (word === 'style') {
      if (words.length === 2 && isShape(second)) {
        await setPref($, { shape: second })
        await redraw($)

        return { text: `Style ${second}.`, isTextDisplayOnly: true }
      }

      return { text: `Styles: ${SHAPES.join(', ')}.`, isTextDisplayOnly: true }
    }

    if (word === 'tail' && (second === 'on' || second === 'off') && words.length === 2) {
      await setPref($, { tail: second === 'on' })
      await redraw($)

      return { text: `Tail ${second}.`, isTextDisplayOnly: true }
    }

    const prefs = await prefsOf($)

    return {
      text: `Chat bubbles ${prefs.isOff ? 'off' : 'on'}. Detail ${prefs.detail ? 'on' : 'off'}. Style ${prefs.shape}. Tail ${prefs.tail ? 'on' : 'off'}.`,
      isTextDisplayOnly: true,
    }
  }).catch(() => ({ text: 'Chat bubbles: that did not take. Try /bubbles again.', isTextDisplayOnly: true as const }))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { text, origin, isExpanded } = e.props

    if (e.surface !== 'terminal' || isExpanded !== false || typeof text !== 'string' || text.trim() === '') {
      return next(e)
    }
    const prefs = await prefsOf($)
    if (prefs.isOff) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    // Not the person's own words typed here. With detail on, the engine's
    // full row. Otherwise:
    if (!isOwnWords(origin) || e.props.from !== undefined || e.props.task !== undefined) {
      if (prefs.detail) return next(e)
      const kind = origin?.kind
      const columns = e.viewport?.columns ?? FALLBACK_COLUMNS
      const palette = paletteOf(await themeOf($))
      const saved = shapeFor(prefs.shape, e.viewport)
      const grayLine = (
        <Box key="from-line" width="100%" justifyContent="center" marginTop={1}>
          <Text color={SMALL}>{fromLine({ ...e.props, text })}</Text>
        </Box>
      )

      // In this order: a task is its task line; a sender (other than a
      // channel's) is "<name> sent an update" (teammates arrive `unclassified`
      // with a `from`); an `unclassified` row with neither is left to the
      // engine (it may be the engine's own notice).
      if (e.props.task !== undefined) return grayLine
      if (e.props.from !== undefined && kind !== 'channel') return grayLine
      // A teammate drain: the frames' bodies joined, the framing stripped and
      // no `from`. One line that starts with an idle notice makes it one gray
      // line naming the notices' senders; nothing of the body is printed.
      // Frames still in the text (the stored form) keep teammateUpdate's
      // wording, below. Both rules hold for `unclassified` rows only (the kind
      // a teammate drain carries): any other kind keeps its own line, so no
      // plugin or other sender can pass as a teammate with a notice line.
      const teammate = kind === 'unclassified'
      const framed = teammate && teammateUpdate(text) !== undefined
      const drain = teammate && !framed ? drainUpdate(text) : undefined
      if (drain !== undefined) {
        return (
          <Box key="from-line" width="100%" justifyContent="center" marginTop={1}>
            <Text color={SMALL}>{drain}</Text>
          </Box>
        )
      }
      if (kind === 'unclassified') {
        // A block made only of teammate frames (no `from`: several frames,
        // or a summary line) is one gray line; anything else, the engine's.
        const update = e.props.from === undefined && e.props.task === undefined ? teammateUpdate(text) : undefined
        if (update === undefined) return next(e)

        return (
          <Box key="from-line" width="100%" justifyContent="center" marginTop={1}>
            <Text color={SMALL}>{update}</Text>
          </Box>
        )
      }

      // A person writing through a channel (Slack, Telegram, a board): their
      // words in a received-style bubble, with who and where above it. Only
      // when the row's text is the message itself: text wrapped in markup is
      // left to the engine.
      if (kind === 'channel') {
        if (!isPlainText(text)) return next(e)
        const shape = saved
        const width = Math.min(longestLine(text) + 2 * PAD_X, narrowCap(columns, RECEIVED_SHARE))
        const sender = e.props.from?.name !== undefined ? shortName(e.props.from.name) : ''
        const server = `via ${shortName(String(origin?.server ?? '')) || 'a channel'}`
        const label = sender ? `${sender} ${server}` : server
        // Lined up with the text: past the tail column and the cap in round.
        const indent = shape === 'round' ? (prefs.tail ? 1 : 0) + 2 : PAD_X
        const body = <Text>{text}</Text>

        return (
          <Box flexDirection="column" width="100%" alignItems="flex-start" marginTop={1}>
            <Box key="via-line" paddingLeft={indent}>
              <Text color={SMALL}>{label}</Text>
            </Box>
            {shape === 'round'
              ? roundBubble({ Box, Text }, {
                  side: 'received', width, fill: palette.received, who: 'elsewhere', id: e.requestId, tail: prefs.tail, text, children: body,
                })
              : bubble({ Box, Text }, { shape, side: 'received', width, fill: palette.received, who: 'elsewhere', children: body })}
          </Box>
        )
      }

      // A plugin's text sent as the person's own words (a button press,
      // dictation): a sent-style bubble, with the plugin named above it. Not
      // recorded in the thread (no time line, no Delivered): the plugin, not
      // the person, typed it.
      const asUser = origin as { kind: string; name?: string; asUser?: true } | undefined
      if (kind === 'plugin' && asUser?.asUser === true && e.props.task === undefined && e.props.from === undefined) {
        const shape = saved
        const width = Math.min(longestLine(text) + 2 * PAD_X, narrowCap(columns, SENT_SHARE))
        const indent = shape === 'round' ? (prefs.tail ? 1 : 0) + 2 : PAD_X
        const body = <Text color={WHITE} backgroundColor={palette.sent}>{text}</Text>

        return (
          <Box flexDirection="column" width="100%" alignItems="flex-end" marginTop={1}>
            <Box key="via-line" paddingRight={indent}>
              <Text color={SMALL}>{`via ${shortName(String(asUser.name ?? '')) || 'a plugin'}`}</Text>
            </Box>
            {shape === 'round'
              ? roundBubble({ Box, Text }, {
                  side: 'sent', width, fill: palette.sent, who: 'plugin-user', id: e.requestId, tail: prefs.tail, text, children: body,
                })
              : bubble({ Box, Text }, { shape, side: 'sent', width, fill: palette.sent, who: 'plugin-user', children: body })}
          </Box>
        )
      }

      // Another agent or session, a schedule, a plugin's own message: one
      // centred gray line naming where it came from, never the raw text.
      return grayLine
    }
    const columns = e.viewport?.columns ?? FALLBACK_COLUMNS
    const width = Math.min(longestLine(text) + 2 * PAD_X, narrowCap(columns, SENT_SHARE))
    const list = await read($, prompts)
    const isFirst = e.requestId !== '' && e.requestId === (await read($, first))
    const index = list.findIndex(p => p.uuid === e.requestId)
    const stamp = index >= 0 ? list[index] : undefined
    const before = index > 0 ? list[index - 1] : undefined
    const showTime =
      stamp !== undefined &&
      (isFirst || (before !== undefined && stamp.at - before.at >= TIME_GAP_MS))
    const label = showTime && stamp ? timeLabel(stamp.at, await $.clock.now()) : undefined
    const isNewest = index >= 0 && index === list.length - 1
    // A printed row (the main screen) never redraws, so Delivered would stay
    // under every old bubble: drawn only where rows redraw.
    const showDelivered = isNewest && e.viewport?.isFullscreen === true
    const palette = paletteOf(await themeOf($))
    const sent = palette.sent
    const shape = shapeFor(prefs.shape, e.viewport)
    const isRound = shape === 'round'
    const bubbleShape = shape
    const roundShape = bubbleShape === 'round'
    const hasTail = roundShape ? prefs.tail : bubbleEdges(bubbleShape, width, 'sent').tailAt === 'right'
    const { Client } = $.ui.resolve(e) // Delivered fades in from its own module
    const body = <Text color={WHITE} backgroundColor={sent}>{text}</Text>

    return (
      <Box flexDirection="column" width="100%" alignItems="flex-end" marginTop={1}>
        {isFirst && !isRound && (
          <Box width="100%" justifyContent="center">
            <Text color={CLAUDE_ORANGE}>✻</Text>
          </Box>
        )}
        {isFirst && isRound && (
          // The avatar disc (Bubble Caps), two rows of four cells, each row
          // one colour run starting with its glyph; centred by uncoloured
          // layout, never by coloured spaces.
          <Box width="100%" flexDirection="column" alignItems="center">
            <Text color={CLAUDE_ORANGE}>{AVATAR_TOP}</Text>
            <Text color={CLAUDE_ORANGE}>{AVATAR_BOTTOM}</Text>
          </Box>
        )}
        {isFirst && (
          <Box width="100%" justifyContent="center">
            <Text bold>Claude</Text>
          </Box>
        )}
        {isFirst && (
          <Box width="100%" justifyContent="center">
            <Text color={SMALL}>iMessage</Text>
          </Box>
        )}
        {label !== undefined && (
          <Box width="100%" justifyContent="center" marginBottom={1}>
            <Text color={SMALL} bold>{label.day}</Text>
            <Text color={SMALL}>{` ${label.time}`}</Text>
          </Box>
        )}
        {roundShape
          ? roundBubble({ Box, Text }, {
              side: 'sent',
              width,
              fill: sent,
              who: 'user',
              id: e.requestId,
              tail: prefs.tail,
              text,
              children: body,
            })
          : bubble({ Box, Text }, {
              shape: bubbleShape,
              side: 'sent',
              width,
              fill: sent,
              who: 'user',
              children: body,
            })}
        {showDelivered && (
          // Lined up with the bubble's right edge, not its tail. The plain
          // word in its final colour once its fade-in Client has faulted.
          <Box paddingRight={hasTail ? 1 : 0}>
            {hasFaulted('delivered') ? (
              <Text color={SMALL}>Delivered</Text>
            ) : (
              <Client
                key="delivered"
                module="./delivered.tsx"
                props={{ ink: SMALL, steps: [...palette.deliveredSteps] }}
              />
            )}
          </Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text, isSummary } = e.props

    if (e.surface !== 'terminal' || typeof text !== 'string' || text.trim() === '') {
      return next(e)
    }
    const prefs = await prefsOf($)
    if (prefs.isOff) return next(e)
    // A summary row stands for the model's text between two tool calls (its
    // full text is in the ctrl+o view). In clean mode it is a reply bubble like
    // any other, without the engine's faint "· summary" mark; with detail on,
    // the engine's row.
    if (isSummary === true && prefs.detail) return next(e)
    // A table no bubble can hold: the engine's own row, readable at full width.
    const columns = e.viewport?.columns ?? FALLBACK_COLUMNS
    if (tableTooWide(text, columns)) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const width = replyWidth(text, columns)
    const { received } = paletteOf(await themeOf($))
    const shape = shapeFor(prefs.shape, e.viewport)

    return (
      <Box flexDirection="column" width="100%" alignItems="flex-start" marginTop={1}>
        {shape === 'round'
          ? roundBubble({ Box, Text }, {
              side: 'received',
              width,
              fill: received,
              who: 'assistant',
              id: e.requestId,
              tail: prefs.tail,
              text,
              children: <Markdown text={text} />,
            })
          : bubble({ Box, Text }, {
              shape,
              side: 'received',
              width,
              fill: received,
              who: 'assistant',
              children: <Markdown text={text} />,
            })}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // While Claude works: the typing bubble alone, its dots animated. With
  // detail on, the engine's spinner row (word, timer, interrupt hint) is kept
  // under it.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const prefs = await prefsOf($)
    if (prefs.isOff) return next(e)

    const engine = prefs.detail ? await next(e) : undefined
    const { Box, Text, Client } = $.ui.resolve(e)
    const palette = paletteOf(await themeOf($))
    const shape = shapeFor(prefs.shape, e.viewport)
    // One key per turn: the Spinner's word is sampled once per turn, so a
    // Client that faulted in one turn is tried afresh in the next.
    const typingKey = `typing:${String(e.props.word ?? '')}`

    return (
      <Box flexDirection="column" marginTop={1}>
        {shape === 'round'
          ? roundTyping({ Box, Text, Client }, {
              fill: palette.received,
              dim: palette.dotDim,
              bright: palette.dotBright,
              typingKey,
            })
          : bubble({ Box, Text }, {
              shape,
              side: 'received',
              width: 5 + 2 * PAD_X,
              fill: palette.received,
              who: 'typing',
              children: hasFaulted(typingKey) ? (
                stillDots({ Box, Text }, {
                  dot: '•',
                  dim: palette.dotDim,
                  bright: palette.dotBright,
                  fill: palette.received,
                })
              ) : (
                <Client
                  key={typingKey}
                  module="./typing.tsx"
                  props={{ dim: palette.dotDim, bright: palette.dotBright, fill: palette.received }}
                />
              ),
            })}
        {engine}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Only the conversation: clean tool rows and their pill draw nothing. A
  // display-none Box takes no row and leaves no blank line (checked in a real
  // draw). The turn line and the notice under the logo go too. Kept: the
  // ctrl+o / verbose view and a turn line carrying `waitingFor`; a call that
  // failed or was stopped becomes one small red line. (One `on` per component:
  // the engine refuses one call site run twice.)
  // A failed or stopped call: one small red line (see failureOf), drawn once.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const failed = await failedLine($, e)
    if (failed !== undefined) return failed

    return (await hides($, e)) ? nothing($, e) : next(e)
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const failed = await failedLine($, e)
    if (failed !== undefined) return failed

    return (await hides($, e)) ? nothing($, e) : next(e)
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const failed = await failedLine($, e)
    if (failed !== undefined) return failed

    return (await hides($, e)) ? nothing($, e) : next(e)
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await hides($, e)) ? nothing($, e) : next(e),
  ).catch(($, e, next) => next(e))
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) =>
    (await hides($, e)) ? nothing($, e) : next(e),
  ).catch(($, e, next) => next(e))
  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) =>
    (await hides($, e)) ? nothing($, e) : next(e),
  ).catch(($, e, next) => next(e))

  // The band above the prompt, while the person has collapsed it: its rows are
  // left out of the list, so the engine has nothing to stack and draws no
  // "plugin panel hidden" hint. Expanding it (ctrl+x ctrl+a) hands every row on
  // again; so do a survey, detail on, the mod off and other surfaces.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isCollapsed !== true || e.props.hasSurvey) return next(e)
    const prefs = await prefsOf($)
    if (prefs.isOff || prefs.detail) return next(e)

    return next({ ...e, props: { ...e.props, rows: [] } })
  }).catch(($, e, next) => next(e))
}

type HiddenRow = {
  surface: string
  component: (typeof HIDDEN)[number]
  props: object
}

// Whether a row "only the conversation" hides is hidden right now.
async function hides($: EngineInterface, e: HiddenRow): Promise<boolean> {
  if (e.surface !== 'terminal') return false
  const props = e.props as {
    isExpanded?: boolean
    isErrored?: boolean
    isInterrupted?: boolean
    isCallsOnly?: boolean
    waitingFor?: unknown
  }
  if (props.isExpanded === true) return false
  // A turn line that only says what the turn waits on stays (see HIDDEN).
  if (e.component === 'TurnDuration' && props.waitingFor !== undefined) return false
  // A call that failed or was stopped stays, so the person sees it.
  if (props.isErrored === true || props.isInterrupted === true) return false
  // A group is hidden only when it holds nothing but clean calls.
  if (e.component === 'ToolGroup' && props.isCallsOnly !== true) return false
  const prefs = await prefsOf($)

  return !prefs.isOff && !prefs.detail
}

// ---- failed and stopped calls ----------------------------------------------
//
// In clean mode a failed or stopped call is one centred small line in red,
// never the error text: `Read failed`, `Bash stopped`, `1 of 3 steps failed`,
// `A step failed` when no name is given. Which row draws it: see carriesLine.

type ToolLike = {
  tool_use_id?: string
  tool?: string
  isErrored?: boolean
  isInterrupted?: boolean
  isExpanded?: boolean
  calls?: ReadonlyArray<{ tool_use_id?: string; tool: string; isErrored: boolean; isInterrupted: boolean }>
}

// The short name the engine shows: an MCP tool by its server.
export function toolName(tool: string | undefined): string {
  const name = (tool ?? '').trim()
  const mcp = /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(name)

  return mcp ? (mcp[1] ?? name) : name
}

export function failureOf(props: ToolLike): { label: string; ids: string[] } | undefined {
  if (props.calls !== undefined) {
    const failed = props.calls.filter(call => call.isErrored)
    const stopped = props.calls.filter(call => call.isInterrupted && !call.isErrored)
    const bad = failed.length > 0 ? failed : stopped
    if (bad.length === 0) return undefined
    const word = failed.length > 0 ? 'failed' : 'stopped'
    const ids = bad.map(call => call.tool_use_id ?? '')
    if (props.calls.length === 1) {
      const name = toolName(props.calls[0]?.tool)

      return { label: name ? `${name} ${word}` : `A step ${word}`, ids }
    }

    return { label: `${bad.length} of ${props.calls.length} steps ${word}`, ids }
  }
  if (props.isErrored !== true && props.isInterrupted !== true) return undefined
  const word = props.isErrored === true ? 'failed' : 'stopped'
  const name = toolName(props.tool)

  return { label: name ? `${name} ${word}` : `A step ${word}`, ids: [props.tool_use_id ?? ''] }
}

// Which row carries a failed or stopped call's line, by a rule with no memory
// (so no redraw, scroll or order changes it): a group with failed or stopped
// calls, a result row that errored, a call row that was stopped. A call row
// that only errored draws nothing: its result row or its group carries the
// line. A call stopped and failed may show two lines; never none.
function carriesLine(component: string, props: ToolLike): 'line' | 'nothing' {
  if (component === 'ToolUse' && props.isInterrupted !== true) return 'nothing'

  return 'line'
}

// The failed line for a tool row, nothing for a call row whose line its result
// row or group carries, or undefined to go on as usual (no failure, detail on,
// mod off, ctrl+o, another surface).
async function failedLine(
  $: EngineInterface,
  e: { surface: string; component: string; requestId: string; props: object } & Parameters<EngineInterface['ui']['resolve']>[0],
) {
  if (e.surface !== 'terminal') return undefined
  const props = e.props as ToolLike
  if (props.isExpanded === true) return undefined
  const failure = failureOf(props)
  if (failure === undefined) return undefined
  const prefs = await prefsOf($)
  if (prefs.isOff || prefs.detail) return undefined
  if (carriesLine(e.component, props) === 'nothing') return nothing($, e)

  const { Box, Text } = $.ui.resolve(e)
  const { failed } = paletteOf(await themeOf($))

  return (
    <Box key="failed-line" width="100%" justifyContent="center" marginTop={1}>
      <Text color={failed}>{failure.label}</Text>
    </Box>
  )
}

// A row that draws nothing and takes no line.
function nothing($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box } = $.ui.resolve(e)

  return <Box display="none" />
}
