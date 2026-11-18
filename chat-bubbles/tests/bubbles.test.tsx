import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capRows as capGlyphs } from '../hooks/cap'
import type { CapProps } from '../hooks/cap'
import {
  drainUpdate,
  estimateContentWidth,
  forgetAllFaults,
  hasFaulted,
  isRecorded,
  noteFault,
  recoverFaults,
  replyWidth,
  widthScans,
} from '../hooks/register'
import { bubbleEdges } from '../hooks/shape'

const VIEWPORT = { columns: 100, rows: 40 }
const FULLSCREEN = { columns: 100, rows: 40, isFullscreen: true }

const PROMPT = {
  plugin: 'chat-bubbles',
  component: 'UserMessage',
  viewport: VIEWPORT,
  props: { text: 'hello there', origin: { kind: 'composer' }, isExpanded: false },
} as const

const FENCED = 'Here is a list:\n\n- **one**\n- `two`\n\n```js\nlet x = 1\n```'
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |'

const REPLY = {
  plugin: 'chat-bubbles',
  component: 'AssistantMessage',
  viewport: VIEWPORT,
  props: { text: FENCED, isFirstOfReply: true },
} as const

const SPINNER = {
  plugin: 'chat-bubbles',
  component: 'Spinner',
  viewport: VIEWPORT,
  props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
} as const

// The rows "only the conversation" hides, each with props it can carry.
const TOOL_USE = {
  plugin: 'chat-bubbles',
  component: 'ToolUse',
  viewport: VIEWPORT,
  props: {
    tool_use_id: 't1',
    tool: 'Bash',
    input: { command: 'echo hi' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const
const TOOL_RESULT = {
  plugin: 'chat-bubbles',
  component: 'ToolResult',
  viewport: VIEWPORT,
  props: { tool_use_id: 't1', tool: 'Bash', output: { stdout: 'hi' }, isErrored: false },
} as const
const TOOL_GROUP = {
  plugin: 'chat-bubbles',
  component: 'ToolGroup',
  viewport: VIEWPORT,
  props: { calls: [], isActive: false, isExpanded: false, isCallsOnly: true },
} as const
const TOOL_PROGRESS = {
  plugin: 'chat-bubbles',
  component: 'ToolProgress',
  viewport: VIEWPORT,
  props: { tool_use_id: 't1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
} as const
const TURN = {
  plugin: 'chat-bubbles',
  component: 'TurnDuration',
  viewport: VIEWPORT,
  props: { word: 'Baked', durationMs: 3000 },
} as const
const INFO = {
  plugin: 'chat-bubbles',
  component: 'InfoNotice',
  viewport: VIEWPORT,
  props: { text: 'Using the model from your settings', command: '/model' },
} as const
const HIDDEN = [TOOL_USE, TOOL_RESULT, TOOL_GROUP, TOOL_PROGRESS, TURN, INFO] as const

const LONG = 'word '.repeat(60)
const MINUTE = 60_000

// Nothing sits beneath the plugin: this hook stands for the engine's own row.
// The store is answered from memory, as the engine keeps a plugin's own.
function engineDraws(on: On, store: Record<string, unknown> = {}) {
  mock.store(on, store)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('ui.invalidate', () => ({ value: undefined }))
}

type Ui = {
  find: (q: { type?: string; key?: string; text?: RegExp; in?: string }) => Promise<
    { text: string; props: Record<string, unknown> } | undefined
  >
}

// A bubble's edge rows, by the glyphs that start them.
async function edgeRows(ui: Ui) {
  const top = await ui.find({ type: 'Text', text: /^▗/ })
  const bottom = await ui.find({ type: 'Text', text: /^▝/ })

  return { top: top?.text, bottom: bottom?.text }
}

// The person typing `/bubbles <args>` at the prompt.
function typed($: Engine, args: string) {
  return $.command.run({
    command: 'bubbles',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

// ---- shapes, as rows of glyphs -------------------------------------------

test('pill: corners cut, both edge rows as wide as the body, no tail', () => {
  for (const width of [15, 75]) {
    for (const side of ['sent', 'received'] as const) {
      const { top, bottom, tailAt } = bubbleEdges('pill', width, side)
      expect(top).toBe(`▗${'▄'.repeat(width - 2)}▖`)
      expect(bottom).toBe(`▝${'▀'.repeat(width - 2)}▘`)
      expect(tailAt).toBe('none')
    }
  }
})

test('tail: the pill with a tail one cell past the body', () => {
  for (const width of [15, 75]) {
    const sent = bubbleEdges('tail', width, 'sent')
    expect(sent.top).toBe(`▗${'▄'.repeat(width - 2)}▖`)
    expect(sent.bottom).toBe(`▝${'▀'.repeat(width - 2)}▀▘`)
    expect(sent.tailAt).toBe('right')

    const received = bubbleEdges('tail', width, 'received')
    expect(received.bottom).toBe(`▝▀${'▀'.repeat(width - 2)}▘`)
    expect(received.tailAt).toBe('left')
  }
})

test('block: no edge rows', () => {
  expect(bubbleEdges('block', 15, 'sent')).toEqual({ top: '', bottom: '', tailAt: 'none' })
})

// ---- the drawn bubbles ---------------------------------------------------

test('by default every bubble is a block: no edge rows, a filled line above and below', async ($, on) => {
  engineDraws(on)
  for (const [target, who] of [
    [PROMPT, 'user'],
    [REPLY, 'assistant'],
    [SPINNER, 'typing'],
  ] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    const body = await ui.find({ key: `bubble-${who}` })
    expect({ who, paddingY: body?.props.paddingY, paddingX: body?.props.paddingX }).toEqual({ who, paddingY: 1, paddingX: 2 })
    expect(await edgeRows(ui)).toEqual({ top: undefined, bottom: undefined })
    await ui.unmount()
  }
})

test('a typed prompt as a blue pill, two columns of padding each side', async ($, on) => {
  engineDraws(on, { style: 'pill' })
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })

  const body = await ui.find({ key: 'bubble-user' })
  expect(body?.props.backgroundColor).toBe('#0073EB')
  expect(body?.props.width).toBe('hello there'.length + 4)
  expect(body?.props.paddingX).toBe(2)
  expect((await ui.find({ type: 'Text', text: /hello there/ }))?.props.color).toBe('#FFFFFF')
  expect(await edgeRows(ui)).toEqual({ top: `▗${'▄'.repeat(13)}▖`, bottom: `▝${'▀'.repeat(13)}▘` })
  expect((await ui.find({ key: 'shape-user' }))?.props.width).toBe(15)
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await ui.unmount()
})

test('a long prompt wraps at 68 columns of text, or 75% of a narrow row', async ($, on) => {
  engineDraws(on, { style: 'pill' })
  const wide = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, text: LONG } })

  // 68 + 4 padding = 72, under 75% of 100.
  expect((await wide.find({ key: 'bubble-user' }))?.props.width).toBe(72)
  const { top, bottom } = await edgeRows(wide)
  expect(top?.length).toBe(72)
  expect(bottom?.length).toBe(72)
  await wide.unmount()

  // At 80 columns, 75% (60) is the smaller.
  const narrow = await $.ui.mount({
    ...PROMPT,
    viewport: { columns: 80, rows: 40 },
    surface: 'terminal',
    props: { ...PROMPT.props, text: LONG },
  })
  expect((await narrow.find({ key: 'bubble-user' }))?.props.width).toBe(60)
  await narrow.unmount()
})

test('a reply as a gray pill holding its markdown', async ($, on) => {
  engineDraws(on, { style: 'pill' })
  const ui = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi there, friend.' } })

  const body = await ui.find({ key: 'bubble-assistant' })
  expect(body?.props.backgroundColor).toBe('userMessageBackground')
  expect(body?.props.width).toBe(21)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Hi there, friend.')
  expect((await edgeRows(ui)).bottom).toBe(`▝${'▀'.repeat(19)}▘`)
  await ui.unmount()
})

// ---- 3d: tables and fences hug what they draw -----------------------------

test('a table or fence is estimated from its source, wide characters counted two cells', () => {
  // Table: columns of 1 and 1 → (1+2)+(1+2) + 3 rules = 9.
  expect(estimateContentWidth(TABLE)).toBe(9)
  // Fence `let x = 1` → 9 + 2 = 11; the widest plain line is 15.
  expect(estimateContentWidth(FENCED)).toBe(15)
  // 🍎 is two cells: (2+2)+(1+2) + 3 = 10. A line with no delimiter row is
  // plain text: `| 東京 | b |` is 12 cells.
  expect(estimateContentWidth('| 🍎 | b |\n|---|---|\n| 1 | 2 |')).toBe(10)
  expect(estimateContentWidth('| 東京 | b |')).toBe(12)

  // Estimate + padding 4 + spare 2, capped at 85% of the row.
  expect(replyWidth(TABLE, 100)).toBe(15)
  expect(replyWidth(FENCED, 100)).toBe(21)
  expect(replyWidth('| 🍎 | b |\n|---|---|\n| 1 | 2 |', 100)).toBe(16)
  // A table wider than 85% widens its bubble up to the row less the tail
  // column, so the engine's drawing (at most columns - 5) fits inside.
  expect(replyWidth(`| ${'x'.repeat(120)} | b |\n|---|---|\n| 1 | 2 |`, 100)).toBe(99)
  // No table or fence: hugs its text, up to 75%.
  expect(replyWidth('Hi.', 100)).toBe(7)
  expect(replyWidth(LONG, 100)).toBe(72)
  expect(replyWidth(LONG, 200)).toBe(72)
  expect(replyWidth(LONG, 80)).toBe(60)
  // The wide case keeps its own 85% cap, not the 68-column one.
  // (120 + 2) + (1 + 2) + 3 rules = 128, + 4 padding + 2 spare = 134.
  expect(replyWidth(`| ${'x'.repeat(120)} | b |`, 200)).toBe(134)
})

// A table wider than the 85% bubble. The engine draws a table at its natural
// width N (widest cell per column + 3 per column + 1) whatever Box it is in;
// one wider than the terminal it squeezes to at most columns - 5 (measured:
// 121 at 127, 75 at 80, 55 at 60) or lays out as a "Field: value" list at
// about columns - 4. So the bubble's inside (width - 4) must reach N, the
// bubble with its tail column must stay in the row, and a table needing more
// is the engine's row.
const DINNERS = [
  '| Day | Dinner | Key ingredients |',
  '|-----|--------|-----------------|',
  '| Mon | Chickpea and spinach curry | Chickpeas, spinach, onion, tomatoes, rice |',
  '| Wed | Lemon garlic salmon with roasted broccoli | Salmon, broccoli, lemon, garlic, potatoes |',
  '| Fri | Turkey and black bean tacos | Ground turkey, black beans, tortillas, salsa, avocado |',
].join('\n')
const WIDE = [
  `| ${['Feature', 'Owner', 'Status', 'Next step', 'Risk', 'Notes'].join(' | ')} |`,
  '|---|---|---|---|---|---|',
  `| ${['Pricing page with three tiers', 'Marketing and design', 'Drafted in plain words', 'Write the final copy', 'Low, needs review', 'Ship by Friday'].join(' | ')} |`,
].join('\n')

test('T2: a table wider than 85% of the row gets a bubble whose inside holds it', () => {
  // The dinners table: 3 + 41 + 53 + 3 columns * 3 + 1 = 107.
  expect(estimateContentWidth(DINNERS)).toBe(107)
  for (const columns of [127, 120]) {
    const width = replyWidth(DINNERS, columns)
    expect({ columns, inside: width - 4 >= 107, inRow: width + 1 <= columns }).toEqual({ columns, inside: true, inRow: true })
  }
  // Wider than any bubble: the whole row less the tail column (inside
  // columns - 5, which holds the engine's fitted drawing).
  for (const columns of [127, 80, 60]) {
    expect({ columns, width: replyWidth(WIDE, columns) }).toEqual({ columns, width: columns - 1 })
  }
  // A narrow table still hugs it; plain text keeps its caps.
  expect(replyWidth(TABLE, 127)).toBe(15)
  expect(replyWidth(LONG, 127)).toBe(72)
})

// A table no bubble can hold (its bubble would pass the row less the tail
// column) may be laid out by the engine as a "Field: value" list about
// columns - 4 wide, which wraps inside any bubble. Readable beats the look:
// that reply is the engine's own row. A table that fits keeps its bubble.
test('T3: a reply whose table no bubble can hold is the engine row; one that fits is a bubble', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const draw = async (text: string, columns: number) => {
    const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', viewport: { ...FULLSCREEN, columns }, surface: 'terminal', props: { ...REPLY.props, text } })
    const engine = await isEngine(ui)
    const shape = (await ui.find({ key: 'shape-assistant' }))?.props.width
    await ui.unmount()

    return engine ? 'engine' : shape
  }

  expect(await draw(WIDE, 127)).toBe('engine')
  expect(await draw(DINNERS, 127)).toBe(107 + 4 + 2 + 1) // inside 109, plus the tail column
  expect(await draw(DINNERS, 100)).toBe('engine')
  expect(await draw(TABLE, 60)).toBe(15 + 1)
  // Plain text: unchanged.
  expect(await draw(LONG, 127)).toBe(72 + 1)
})

test('T5: the width of a reply is worked out once per text, not on every draw', () => {
  const long = `${'A paragraph of plain words. '.repeat(400)}\n\n${DINNERS}`
  const before = widthScans()
  replyWidth(long, 127)
  replyWidth(long, 127)
  replyWidth(long, 80)
  expect(widthScans() - before).toBe(1)
})

// F1: the estimate counts raw source, never less than what is drawn.
test('F1: a table without outer pipes is a table', () => {
  // Columns: max(4 "Name", 5 "alpha") = 5 and max(5 "Value", 1) = 5
  // → (5+2) + (5+2) + 3 rules = 17.
  expect(estimateContentWidth('Name | Value\n--- | ---\nalpha | 1')).toBe(17)
  expect(replyWidth('Name | Value\n--- | ---\nalpha | 1', 120)).toBe(17 + 4 + 2)
})

test('F1: an escaped pipe stays inside its cell', () => {
  const md = [
    '| A | B | C | D |',
    '|---|---|---|---|',
    '| x \\| y | PPPPPPPPPP | q | RRRRRRRRRR |',
  ].join('\n')
  // Raw cells: `x \| y` 6, P×10, q 1, R×10 → 8 + 12 + 3 + 12 + 5 rules = 40.
  expect(estimateContentWidth(md)).toBe(40)
})

test('R4c: well-formed inline markup in a cell counts as its drawn text; anything else raw', () => {
  // Paired backticks: `__init_subclass__` draws 17; "hook" 4 → 19 + 6 + 3 = 28.
  expect(estimateContentWidth('| name | use |\n|---|---|\n| `__init_subclass__` | hook |')).toBe(28)
  // Paired ** and a link: "Name" 4, "docs" 4 → (4+2)+(4+2)+3 = 15.
  expect(estimateContentWidth('| **Name** | link |\n|---|---|\n| a | [docs](https://example.com/a/b) |')).toBe(15)
  // A lone * or _ stays counted: "a * b" 5, "c_d" 3 → 7 + 5 + 3 = 15.
  expect(estimateContentWidth('| a * b | c_d |\n|---|---|\n| 1 | 2 |')).toBe(15)
  // An unpaired ** stays raw: "**open" 6 → 8 + 3 + 3 = 14.
  expect(estimateContentWidth('| **open | x |\n|---|---|\n| 1 | 2 |')).toBe(14)
})

test('R4c: a four-column table with bold headers, natural width 120, fits a bubble at 127', () => {
  // Each header is its column's widest cell, drawn without its ** marks.
  const header = [30, 24, 22, 31].map(n => `**${'H'.repeat(n)}**`)
  const row = [28, 22, 20, 29].map(n => 'x'.repeat(n))
  const md = [`| ${header.join(' | ')} |`, '|---|---|---|---|', `| ${row.join(' | ')} |`].join('\n')
  // 30 + 24 + 22 + 31 = 107, + 3 per column + 1 = 120: 126 with padding and
  // spare. Counted raw (with the marks) it would be 136: the engine's row.
  expect(estimateContentWidth(md)).toBe(120)
  expect(replyWidth(md, 127)).toBe(126)
})

test('R1: common emoji are two cells wide', () => {
  // ✅ ⭐ ❤️ ☕ ⌚ 🫠 🀄: 7 × 2 = 14, + 4 padding.
  expect(replyWidth('✅⭐❤️☕⌚🫠🀄', 100)).toBe(14 + 4)
})

test('R4a: a CJK table is measured in cells', () => {
  // 東京 and 大阪 are 4 cells each: (4+2)+(4+2)+3 = 15.
  expect(estimateContentWidth('| 東京 | 大阪 |\n|---|---|\n| 1 | 2 |')).toBe(15)
})

test('F1: a tab in a fence counts 8 columns', () => {
  const md = '```go\nfunc main() {\n\tfmt.Println("hi")\n}\n```'
  // `\tfmt.Println("hi")`: 8 + 17 = 25, + 2 = 27.
  expect(estimateContentWidth(md)).toBe(27)
})

test('F1: what the rules cannot parse takes the 85% width', () => {
  // A fence that never closes.
  expect(estimateContentWidth('```\nlet x = 1')).toBeUndefined()
  expect(replyWidth('```\nlet x = 1', 120)).toBe(102)
  // A delimiter row with no header row above it.
  expect(estimateContentWidth('--- | ---\na | b')).toBeUndefined()
})

test('G2a: a lazy row under a table takes the 85% width', () => {
  // `lazy line` has no pipe yet sits right under the table: GFM may draw it as
  // a row of the table, so the rules cannot say how wide it draws.
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\nlazy line with no pipe'
  expect(estimateContentWidth(md)).toBeUndefined()
  expect(replyWidth(md, 120)).toBe(102)
})

test('R4b: an indented table, or one under a list marker, is a table with its indent added', () => {
  // The table is 9 wide; the widest prefix of its rows is added.
  for (const [md, est] of [
    ['  | a | b |\n  |---|---|\n  | 1 | 2 |', 11],
    ['- | a | b |\n  |---|---|\n  | 1 | 2 |', 11],
    ['* a | b\n  --- | ---\n  1 | 2', 11],
    ['+ | a | b |\n  |---|---|', 11],
    ['1. | a | b |\n   |---|---|\n   | 1 | 2 |', 12],
  ] as const) {
    expect({ md, est: estimateContentWidth(md) }).toEqual({ md, est })
    expect({ md, width: replyWidth(md, 120) }).toEqual({ md, width: est + 6 })
  }
})

test('R4b: a table inside a blockquote is a table with the quote marks added', () => {
  const md = '> | a | b |\n> |---|---|\n> | 1 | 2 |'
  expect(estimateContentWidth(md)).toBe(11)
  expect(replyWidth(md, 120)).toBe(17)
  const bare = '> a | b\n> --- | ---\n> 1 | 2'
  expect(replyWidth(bare, 120)).toBe(17)
  // A wide one in a quote still goes past 85% instead of spilling.
  const wide = `> | ${'x'.repeat(100)} | b |\n> |---|---|\n> | 1 | 2 |`
  expect(estimateContentWidth(wide)).toBe(2 + 102 + 3 + 3)
  expect(replyWidth(wide, 127)).toBe(116)
})

// G2b: a switch is kept in memory only once the store has it.
test('G2b: a failed store write leaves the old value and says it did not take', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => {
    throw new Error('disk full')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const reply = await typed($, 'style pill')
  expect(reply.text).toMatch(/did not take/)
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  // Still block: a filled line above and below, no edge rows.
  expect((await ui.find({ key: 'bubble-user' }))?.props.paddingY).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^▗/ })).toBeUndefined()
  await ui.unmount()
})

// H3: a change starts from a fresh read of the store, never from defaults a
// failed read left behind.
test('H3: /bubbles while the store cannot be read changes nothing', async ($, on) => {
  let failing = true
  const stored: Record<string, unknown> = { style: 'pill', isOff: false }
  const writes: string[] = []
  on('store.get', (_, e) => {
    if (failing) throw new Error('busy')

    return { value: stored[e.key] }
  })
  on('store.set', (_, e) => {
    writes.push(e.key)
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  expect((await typed($, 'detail on')).text).toMatch(/did not take/)
  expect(writes).toEqual([])

  failing = false
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  // The stored pill and "on" are honoured; detail stayed off.
  expect((await ui.find({ type: 'Text', text: /^▗/ }))?.text).toBe(`▗${'▄'.repeat(13)}▖`)
  await ui.unmount()
  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail off. Style pill. Tail on.')
})

// G2c: a failed store read is not kept for the session.
test('G2c: a failed store read uses the defaults once, then reads again', async ($, on) => {
  let reads = 0
  on('store.get', (_, e) => {
    reads += 1
    if (reads <= 3) throw new Error('busy')

    return { value: e.key === 'style' ? 'pill' : undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const first = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect((await first.find({ key: 'bubble-user' }))?.props.paddingY).toBe(1) // default: block
  await first.unmount()

  const second = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect((await second.find({ type: 'Text', text: /^▗/ }))?.text).toBe(`▗${'▄'.repeat(13)}▖`) // stored pill
  await second.unmount()
})

// F4: the switches are read from the store once, not on every draw.
test('F4: many draws read each stored switch at most once', async ($, on) => {
  const reads: Record<string, number> = {}
  on('store.get', (_, e) => {
    reads[e.key] = (reads[e.key] ?? 0) + 1

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  for (let i = 0; i < 5; i += 1) {
    for (const target of [PROMPT, REPLY, SPINNER, TOOL_USE] as const) {
      const ui = await $.ui.mount({ ...target, surface: 'terminal' })
      await ui.unmount()
    }
  }

  expect(Object.values(reads).every(n => n <= 1)).toBe(true)
  expect(Object.keys(reads).sort()).toEqual(['detail', 'isOff', 'style', 'tail'])
})

test('a drawn reply with a table takes the estimated width', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: TABLE } })

  expect((await ui.find({ key: 'bubble-assistant' }))?.props.width).toBe(15)
  await ui.unmount()
})

// ---- styles --------------------------------------------------------------

test('/bubbles style picks the shape, is stored, and lists the names when unknown', async ($, on) => {
  engineDraws(on)

  expect((await typed($, 'style tail')).text).toBe('Style tail.')
  let ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect((await edgeRows(ui)).bottom).toBe(`▝${'▀'.repeat(13)}▀▘`)
  expect((await ui.find({ key: 'shape-user' }))?.props.width).toBe(16)
  await ui.unmount()

  expect((await typed($, 'style block')).text).toBe('Style block.')
  ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect(await edgeRows(ui)).toEqual({ top: undefined, bottom: undefined })
  expect((await ui.find({ key: 'bubble-user' }))?.props.paddingY).toBe(1)
  await ui.unmount()

  expect((await typed($, 'style oval')).text).toBe('Styles: pill, tail, block, round.')
  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail off. Style block. Tail on.')

  expect((await typed($, 'style pill')).text).toBe('Style pill.')
  ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect((await edgeRows(ui)).bottom).toBe(`▝${'▀'.repeat(13)}▘`)
  await ui.unmount()
})

test('a stored style and detail are read back', async ($, on) => {
  engineDraws(on, { style: 'tail', detail: true })

  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail on. Style tail. Tail on.')
})

// ---- the thread header and time lines ------------------------------------

// The stamps the mod keeps for this session's typed prompts, as the host holds
// them. The kit mints no uuid for a row a test raises, so the stamping hook
// itself is only proven by the real draw.
// Answers the `prompts` read (and `first`, the thread's first prompt, which
// defaults to the list's first); every other read goes on to the kit's state.
function stamped(on: On, list: { uuid: string; at: number }[], first = list[0]?.uuid ?? '') {
  on('state.get', (_, e, next) => {
    if (e.plugin === 'chat-bubbles' && e.key === 'prompts') {
      return { value: { value: { shape: 'prompts-1', value: list }, version: 1 } }
    }
    if (e.plugin === 'chat-bubbles' && e.key === 'first') {
      return { value: { value: first, version: 1 } }
    }

    return next(e)
  })
}

test('F5: the header stays on the thread\'s true first prompt after the list drops old entries', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START + 600 * MINUTE })
  // 501 prompts, a minute apart: the list keeps the last 500 (p2..p501), the
  // first prompt's id is kept on its own.
  const list = Array.from({ length: 500 }, (_, i) => ({ uuid: `p${i + 2}`, at: START + (i + 1) * MINUTE }))
  stamped(on, list, 'p1')

  const first = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  expect((await first.find({ type: 'Text', text: /^Claude$/ }))?.props.bold).toBe(true)
  expect(await first.find({ type: 'Text', text: /^iMessage$/ })).toBeDefined()
  await first.unmount()

  const second = await $.ui.mount({ ...PROMPT, requestId: 'p2', surface: 'terminal' })
  expect(await second.find({ type: 'Text', text: /✻|Claude|iMessage/ })).toBeUndefined()
  await second.unmount()

  const later = await $.ui.mount({ ...PROMPT, requestId: 'p300', surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /✻|Claude|iMessage/ })).toBeUndefined()
  await later.unmount()
})

// Local times, as the mod reads them: 12:21 AM on Nov 18, 2026.
const START = new Date(2026, 10, 18, 0, 21).getTime()

test('the thread opens with ✻, Claude, iMessage and the time; later lines only after 15 minutes', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START + 30 * MINUTE })
  stamped(on, [
    { uuid: 'p1', at: START },
    { uuid: 'p2', at: START + 5 * MINUTE },
    { uuid: 'p3', at: START + 25 * MINUTE },
  ])
  const draw = async (requestId: string) => $.ui.mount({ ...PROMPT, requestId, surface: 'terminal' })

  const one = await draw('p1')
  expect((await one.find({ type: 'Text', text: /^✻$/ }))?.props.color).toBe('#D97757')
  expect((await one.find({ type: 'Text', text: /^Claude$/ }))?.props.bold).toBe(true)
  expect((await one.find({ type: 'Text', text: /^iMessage$/ }))?.props.color).toBe('#8E8E93')
  expect((await one.find({ type: 'Text', text: /^Today$/ }))?.props.bold).toBe(true)
  expect((await one.find({ type: 'Text', text: /^ \d{1,2}:\d{2} (AM|PM)$/ }))?.text).toBe(' 12:21 AM')
  await one.unmount()

  const two = await draw('p2')
  expect(await two.find({ type: 'Text', text: /✻|Claude|iMessage|Today/ })).toBeUndefined()
  await two.unmount()

  const three = await draw('p3')
  expect(await three.find({ type: 'Text', text: /✻|Claude|iMessage/ })).toBeUndefined()
  expect((await three.find({ type: 'Text', text: /^ \d{1,2}:\d{2} (AM|PM)$/ }))?.text).toBe(' 12:46 AM')
  await three.unmount()

  // A row the mod never saw stored (a resumed one) gets no header or time.
  const unknown = await draw('not-stored')
  expect(await unknown.find({ type: 'Text', text: /Today|iMessage|Claude/ })).toBeUndefined()
  await unknown.unmount()
})

test('a prompt from an earlier day reads with its weekday and date', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START })
  stamped(on, [{ uuid: 'old', at: new Date(2026, 10, 17, 21, 5).getTime() }])

  const ui = await $.ui.mount({ ...PROMPT, requestId: 'old', surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nov 17/ }))?.text).toBe('Tue, Nov 17')
  expect((await ui.find({ type: 'Text', text: /PM/ }))?.text).toBe(' at 9:05 PM')
  await ui.unmount()
})

test('Delivered sits under the newest sent bubble, where rows redraw', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START })
  stamped(on, [
    { uuid: 'p1', at: START },
    { uuid: 'p2', at: START + MINUTE },
  ])

  const older = await $.ui.mount({ ...PROMPT, requestId: 'p1', viewport: FULLSCREEN, surface: 'terminal' })
  expect(await older.find({ type: 'Text', text: /^Delivered$/ })).toBeUndefined()
  await older.unmount()

  // A1: the newest prompt's Delivered fades in: nothing for 400 ms, then the
  // word in each step colour for 80 ms, ending on the ink.
  const newest = await $.ui.mount({ ...PROMPT, requestId: 'p2', viewport: FULLSCREEN, surface: 'terminal' })
  const word = async () => newest.find({ type: 'Text', in: 'delivered' })
  expect((await word())?.text.trim()).toBe('')
  await newest.advance(320)
  expect((await word())?.text.trim()).toBe('')
  const seen: unknown[] = []
  for (let i = 0; i < 4; i += 1) {
    await newest.advance(80)
    seen.push((await word())?.props.color)
  }
  expect((await word())?.text).toBe('Delivered')
  // Fallback theme uses the dark steps.
  expect(seen).toEqual(['#2C2C2E', '#48484A', '#636366', '#8E8E93'])
  await newest.advance(1000)
  expect((await word())?.props.color).toBe('#8E8E93')
  await newest.unmount()

  // On the main screen a printed row never redraws: no Delivered at all.
  const printed = await $.ui.mount({ ...PROMPT, requestId: 'p2', surface: 'terminal' })
  expect(await printed.find({ type: 'Text', text: /Delivered/ })).toBeUndefined()
  await printed.unmount()
})

// ---- typing: the bubble alone, its dots alive ----------------------------

test('while Claude works, only the typing bubble shows, its dots in a Client', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })

  expect((await ui.find({ key: 'bubble-typing' }))?.props.backgroundColor).toBe('userMessageBackground')
  const client = await ui.find({ type: 'Client', key: 'typing:Thinking' })
  expect(client?.props.module).toMatch(/typing\.tsx$/)
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await ui.unmount()
})

test('the bright dot moves on every 300 ms tick', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })

  // The first dot: bright at step 0, dim once the bright dot has moved on.
  const first = async () => (await ui.find({ type: 'Text', text: /•/, in: 'typing:Thinking' }))?.props.color
  expect(await first()).toBe('#AEAEB2')
  await ui.advance(300)
  expect(await first()).toBe('#636366')
  await ui.advance(900)
  expect(await first()).toBe('#AEAEB2')
  await ui.unmount()
})

test('with detail on, the engine spinner row sits under the typing bubble', async ($, on) => {
  engineDraws(on, { detail: true })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })

  expect(await ui.find({ type: 'Client', key: 'typing:Thinking' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

// ---- only the conversation -----------------------------------------------

async function isHidden(ui: Ui) {
  const box = await ui.find({ type: 'Box' })

  return box?.props.display === 'none' && (await ui.find({ type: 'Text' })) === undefined
}

async function isEngine(ui: Ui) {
  return (await ui.find({ type: 'Text', text: /engine/ }))?.text === 'engine'
}

test('clean tool rows and their pill draw nothing', async ($, on) => {
  engineDraws(on)
  for (const row of HIDDEN) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    expect({ component: row.component, hidden: await isHidden(ui) }).toEqual({ component: row.component, hidden: true })
    await ui.unmount()
  }
})

test('F2: a tool row that failed or was stopped is never hidden', async ($, on) => {
  engineDraws(on)
  const shown = async (name: string, ui: Ui & { unmount: () => Promise<void> }) => {
    const engine = await isEngine(ui)
    await ui.unmount()

    return { name, engine }
  }

  // (M1 replaced the failed and stopped rows by one red line; see below.)
  expect(
    await shown('ToolGroup not calls-only', await $.ui.mount({ ...TOOL_GROUP, surface: 'terminal', props: { ...TOOL_GROUP.props, isCallsOnly: false } })),
  ).toEqual({ name: 'ToolGroup not calls-only', engine: true })
  expect(
    await shown(
      'ToolGroup calls-only unknown',
      await $.ui.mount({ ...TOOL_GROUP, surface: 'terminal', props: { calls: [], isActive: false, isExpanded: false } }),
    ),
  ).toEqual({ name: 'ToolGroup calls-only unknown', engine: true })
})

// M1: a failed or stopped call is one small red line, never the error text.
async function failLine(ui: Ui) {
  const line = await ui.find({ key: 'failed-line' })
  if (line === undefined) return undefined
  const text = await ui.find({ type: 'Text', text: /./ })

  return { text: text?.text, color: text?.props.color }
}

test('M1: a failed call\'s result row is one red line naming the tool', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...TOOL_RESULT,
    requestId: 'z1',
    surface: 'terminal',
    props: { ...TOOL_RESULT.props, tool_use_id: 'z1', tool: 'mcp__cua-driver__zoom', isErrored: true },
  })
  expect(await failLine(ui)).toEqual({ text: 'cua-driver failed', color: '#FF453A' })
  expect(await isEngine(ui)).toBe(false)
  await ui.unmount()
})

test('M1: a failed or stopped call row names the tool; a group counts its failures', async ($, on) => {
  engineDraws(on)
  const lines: Record<string, unknown> = {}
  const take = async (label: string, ui: Ui & { unmount: () => Promise<void> }) => {
    lines[label] = (await failLine(ui))?.text
    await ui.unmount()
  }
  await take('result errored', await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'a', isErrored: true } }))
  await take('use stopped', await $.ui.mount({ ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool_use_id: 'b', isInterrupted: true } }))
  await take('result no name', await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'c', tool: '', isErrored: true } }))
  const call = (id: string, tool: string, isErrored: boolean, isInterrupted = false) => ({
    tool_use_id: id, tool, input: {}, isRunning: false, isErrored, isInterrupted,
  })
  await take('group one', await $.ui.mount({
    ...TOOL_GROUP, surface: 'terminal',
    props: { calls: [call('g1', 'Read', true)], isActive: false, isExpanded: false, isCallsOnly: false },
  }))
  await take('group three', await $.ui.mount({
    ...TOOL_GROUP, surface: 'terminal',
    props: { calls: [call('g2', 'Read', true), call('g3', 'Grep', false), call('g4', 'Bash', false)], isActive: false, isExpanded: false, isCallsOnly: false },
  }))
  await take('group stopped', await $.ui.mount({
    ...TOOL_GROUP, surface: 'terminal',
    props: { calls: [call('g5', 'Read', false, true), call('g6', 'Grep', false)], isActive: false, isExpanded: false, isCallsOnly: false },
  }))
  expect(lines).toEqual({
    'result errored': 'Bash failed',
    'use stopped': 'Bash stopped',
    'result no name': 'A step failed',
    'group one': 'Read failed',
    'group three': '1 of 3 steps failed',
    'group stopped': '1 of 2 steps stopped',
  })
})

test('Q2: a failed call row draws nothing; its result row carries the one line', async ($, on) => {
  engineDraws(on)
  // The call's row and its result row both carry the failure for id x1.
  const use = await $.ui.mount({ ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool_use_id: 'x1', isErrored: true } })
  const result = await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'x1', isErrored: true } })
  expect(await isHidden(use)).toBe(true)
  expect(await failLine(result)).toEqual({ text: 'Bash failed', color: '#FF453A' })
  await use.unmount()
  await result.unmount()

  // Only the result row is flagged (the call's own row is clean): its line shows.
  const cleanUse = await $.ui.mount({ ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool_use_id: 'x2' } })
  const flagged = await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'x2', isErrored: true } })
  expect(await isHidden(cleanUse)).toBe(true)
  expect((await failLine(flagged))?.text).toBe('Bash failed')
  await cleanUse.unmount()
  await flagged.unmount()
})

test('M1: the red is #D70015 on a light theme', async ($, on) => {
  engineDraws(on)
  themed(on, () => 'light')
  await startSession($)
  const ui = await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'l1', isErrored: true } })
  expect((await failLine(ui))?.color).toBe('#D70015')
  await ui.unmount()
})

test('M1: detail on, the ctrl+o view and mod off keep the engine\'s failed rows', async ($, on) => {
  engineDraws(on)
  const expanded = await $.ui.mount({ ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool_use_id: 'e1', isErrored: true, isExpanded: true } })
  expect(await isEngine(expanded)).toBe(true)
  await expanded.unmount()

  expect((await typed($, 'detail on')).text).toBe('Detail on.')
  const detail = await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'e2', isErrored: true } })
  expect(await isEngine(detail)).toBe(true)
  await detail.unmount()

  expect((await typed($, 'detail off')).text).toBe('Detail off.')
  expect((await typed($, 'off')).text).toBe('Chat bubbles off.')
  const off = await $.ui.mount({ ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool_use_id: 'e3', isErrored: true } })
  expect(await isEngine(off)).toBe(true)
  await off.unmount()
})

test('B1/B2: the turn line and the notice under the logo draw nothing in clean mode', async ($, on) => {
  engineDraws(on)
  const results: Record<string, boolean> = {}
  for (const row of [TURN, INFO] as const) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    results[row.component] = await isHidden(ui)
    await ui.unmount()
  }
  expect(results).toEqual({ TurnDuration: true, InfoNotice: true })
})

test('a turn line that only says what it waits on is kept', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...TURN,
    surface: 'terminal',
    props: { ...TURN.props, waitingFor: { agents: [], workflows: 0 } },
  })

  expect(await isEngine(ui)).toBe(true)
  await ui.unmount()
})

test('the ctrl+o view keeps every hidden row', async ($, on) => {
  engineDraws(on)
  for (const row of [TOOL_USE, TOOL_RESULT, TOOL_GROUP, TURN] as const) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal', props: { ...row.props, isExpanded: true } })
    expect({ component: row.component, engine: await isEngine(ui) }).toEqual({ component: row.component, engine: true })
    await ui.unmount()
  }
})

test('/bubbles detail on brings the hidden rows back; off hides them again', async ($, on) => {
  engineDraws(on)

  expect((await typed($, 'detail on')).text).toBe('Detail on.')
  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail on. Style block. Tail on.')
  for (const row of HIDDEN) {
    const ui = await $.ui.mount({ ...row, surface: 'terminal' })
    expect({ component: row.component, engine: await isEngine(ui) }).toEqual({ component: row.component, engine: true })
    await ui.unmount()
  }

  expect((await typed($, 'detail off')).text).toBe('Detail off.')
  const ui = await $.ui.mount({ ...TOOL_USE, surface: 'terminal' })
  expect(await isHidden(ui)).toBe(true)
  await ui.unmount()
})

test('a surface other than the terminal keeps every row', async ($, on) => {
  engineDraws(on)
  for (const row of [PROMPT, REPLY, SPINNER, TOOL_USE, TOOL_RESULT, TOOL_GROUP, TURN, INFO] as const) {
    const ui = await $.ui.mount({ ...row, surface: 'desktop' })
    expect({ component: row.component, engine: await isEngine(ui) }).toEqual({ component: row.component, engine: true })
    await ui.unmount()
  }
})

// ---- pass-through --------------------------------------------------------

test('G1: the person\'s own words from another device are blue bubbles too', async ($, on) => {
  engineDraws(on)
  const results: Record<string, boolean> = {}
  for (const origin of [{ kind: 'bridge' }, { kind: 'slack-ping' }] as const) {
    const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, origin } })
    results[origin.kind] = (await ui.find({ key: 'bubble-user' }))?.props.backgroundColor === '#0073EB'
    await ui.unmount()
  }
  expect(results).toEqual({ bridge: true, 'slack-ping': true })
})

// L2: a message that is not the person's own words is one centred gray line
// naming where it came from, never its raw text.
async function grayLine(ui: Ui) {
  const line = await ui.find({ key: 'from-line' })
  const text = await ui.find({ type: 'Text', text: /./ })

  return line === undefined ? undefined : { text: text?.text, color: text?.props.color }
}

test('L2: a plugin\'s own message is a gray line naming the plugin', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, origin: { kind: 'plugin', name: 'notes' } } })
  expect(await ui.find({ key: 'bubble-user' })).toBeUndefined()
  expect(await grayLine(ui)).toEqual({ text: 'The notes plugin sent a message', color: '#8E8E93' })
  await ui.unmount()
})

// P1: words a person sent are never reduced to a gray line.
async function viaLine(ui: Ui) {
  const line = await ui.find({ key: 'via-line' })
  if (line === undefined) return undefined
  const text = await ui.find({ type: 'Text', text: /^via |^from outside| via / })

  return { text: text?.text, color: text?.props.color, line: line.props }
}

test('P1a: a channel message is a received bubble with "via <server>" above it', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'can you check the deploy?', origin: { kind: 'channel', server: 'slack' } },
  })
  const body = await ui.find({ key: 'bubble-elsewhere' })
  expect(body?.props.backgroundColor).toBe('userMessageBackground')
  expect((await ui.find({ type: 'Text', text: /^can you check the deploy\?$/ }))).toBeDefined()
  const via = await viaLine(ui)
  expect({ text: via?.text, color: via?.color, paddingLeft: via?.line.paddingLeft }).toEqual({
    text: 'via slack',
    color: '#8E8E93',
    paddingLeft: 2,
  })
  expect(await ui.find({ key: 'from-line' })).toBeUndefined()
  await ui.unmount()
})

test('Q1: an unclassified row with no sender and no task is left to the engine', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'Goal set: make it look like iMessage', origin: { kind: 'unclassified' } },
  })
  expect(await ui.find({ key: 'bubble-elsewhere' })).toBeUndefined()
  expect(await ui.find({ key: 'from-line' })).toBeUndefined()
  expect(await isEngine(ui)).toBe(true)
  await ui.unmount()
})

test('Q1: a teammate (unclassified with a sender) is the gray "<name> sent an update" line', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'status: done', origin: { kind: 'unclassified' }, from: { name: 'builder' } },
  })
  expect(await ui.find({ key: 'bubble-elsewhere' })).toBeUndefined()
  expect((await grayLine(ui))?.text).toBe('builder sent an update')
  await ui.unmount()
})

// V1: an `unclassified` row with no sender and no task whose text is only
// teammate frames is one gray line; anything else such stays the engine's.
const frame = (id: string, body = '{"type":"idle_notification"}') => `<teammate-message teammate_id="${id}" color="blue">\n${body}\n</teammate-message>`
const teammateRow = (text: string, props: Record<string, unknown> = {}) => ({
  ...PROMPT,
  surface: 'terminal' as const,
  props: { ...PROMPT.props, text, origin: { kind: 'unclassified' as const }, ...props },
})

test('V1: teammate frames with no sender: one gray line, by teammate or "Teammates sent updates"', async ($, on) => {
  engineDraws(on)
  const lineOf = async (text: string) => {
    const ui = await $.ui.mount(teammateRow(text))
    const line = await grayLine(ui)
    const engine = await isEngine(ui)
    await ui.unmount()

    return engine ? 'engine' : line?.text
  }

  expect(await lineOf(frame('builder'))).toBe('builder sent an update')
  expect(await lineOf(`${frame('designer')}\n\n${frame('designer', 'done')}\n${frame('designer')}`)).toBe('designer sent an update')
  expect(await lineOf(`${frame('builder')}\n${frame('researcher')}`)).toBe('Teammates sent updates')
  expect(await lineOf(`${frame('builder')}\nand one more thing`)).toBe('engine')
  expect(await lineOf('Compacted the conversation.')).toBe('engine')
  expect(await lineOf(`  ${frame('builder')}  `)).toBe('builder sent an update') // W1: leading whitespace is allowed
  const odd = `a-very-long-teammate-name-that\u0007goes-on-and-on-and-on`
  const text = (await lineOf(frame(odd))) ?? ''
  expect({ name: text.replace(/ sent an update$/, '').length, lines: text.split('\n').length, ctrl: /[\u0000-\u001f]/.test(text) }).toEqual({ name: 32, lines: 1, ctrl: false })
})

// W1: a stored teammate row's shape: a leading line, frames split by a blank
// line, and a closing paragraph to the end of the text. Only the fixed words
// the rule matches are kept; the rest is filler.
const LEAD = 'Another Claude session sent a message:\n'
const CLOSING = '\n\nThis came from another Claude session, followed by a paragraph of filler text for the test.'
const IDLE = (id: string) => `{"type":"idle_notification","from":"${id}","timestamp":"2026-01-01T00:00:00.000Z","idleReason":"available","result":"done"}`

// A: a teammate drain row as the hook gets it: the frames' bodies joined by
// blank lines, the framing stripped, no `from`. A line that starts with an
// idle notice makes the whole row one gray line.
const NOTICE = (id: string) => `{"type":"idle_notification","from":"${id}","timestamp":"2026-01-01T00:00:00.000Z","idleReason":"available","result":"[result truncated]"}`
const REPORT = 'Finished the first draft.\nFiles changed: notes.md.'

test('A: a drain row with idle notices is one gray line naming its senders', async ($, on) => {
  engineDraws(on)
  const lineOf = async (text: string, origin: { kind: 'unclassified' | 'peer' } = { kind: 'unclassified' }) => {
    const ui = await $.ui.mount(teammateRow(text, { origin }))
    const line = await grayLine(ui)
    const engine = await isEngine(ui)
    const texts = await ui.find({ type: 'Text', text: /idle_notification|first draft/ })
    await ui.unmount()

    return engine ? 'engine' : texts !== undefined ? 'body printed' : line?.text
  }

  expect(await lineOf(NOTICE('researcher'))).toBe('researcher sent an update')
  expect(await lineOf(`${REPORT}\n\n${NOTICE('builder')}\n\n${NOTICE('builder')}`)).toBe('builder sent an update')
  expect(await lineOf(`${NOTICE('builder')}\n\n${REPORT}\n\n${NOTICE('researcher')}`)).toBe('builder and researcher sent updates')
  expect(await lineOf(`${NOTICE('a')}\n\n${NOTICE('b')}\n\n${NOTICE('c')}`)).toBe('Teammates sent updates')
  // Only `unclassified` rows (V1): a peer keeps its own line.
  expect(await lineOf(NOTICE('builder'), { kind: 'peer' })).toBe('Another Claude session sent an update')
  // Plain bodies only, or the notice not at a line start: the engine's row.
  expect(await lineOf(`${REPORT}\n\n${REPORT}`)).toBe('engine')
  expect(await lineOf(`see ${NOTICE('builder')}`)).toBe('engine')
  // Names through shortName: one line, 32 characters.
  const long = 'a-very-long-teammate-name-that-goes-on-and-on'
  expect(await lineOf(NOTICE(long))).toBe(`${long.slice(0, 31)}… sent an update`)
})

// V1: the idle-notice and frame rules apply to `unclassified` rows only.
// Every other kind keeps what it drew before them; nobody can borrow a
// teammate's name with a notice line.
async function drawnAs(ui: Ui): Promise<string> {
  if (await ui.find({ key: 'from-line' })) return `gray:${(await ui.find({ type: 'Text', text: /./ }))?.text}`
  for (const key of ['bubble-user', 'bubble-plugin-user', 'bubble-elsewhere']) if (await ui.find({ key })) return key
  if (await isEngine(ui)) return 'engine'

  return 'other'
}

test('V1: a notice line in any row but an unclassified one changes nothing; no spoofing', async ($, on) => {
  engineDraws(on)
  const log = `here is a log I pasted:\n${NOTICE('ops-bot')}\nend`
  const origins: Record<string, unknown> = {
    composer: { kind: 'composer' },
    bridge: { kind: 'bridge' },
    slackPing: { kind: 'slack-ping' },
    channel: { kind: 'channel', server: 'slack' },
    pluginAsUser: { kind: 'plugin', name: 'dictate', asUser: true },
    plugin: { kind: 'plugin', name: 'some-plugin' },
    sdk: { kind: 'sdk' },
    autoCont: { kind: 'auto-continuation' },
    peer: { kind: 'peer' },
    sched: { kind: 'scheduled-trigger' },
    observer: { kind: 'observer' },
    unclassified: { kind: 'unclassified' },
    none: undefined,
  }
  const out: Record<string, string> = {}
  for (const [k, origin] of Object.entries(origins)) {
    const ui = await $.ui.mount({ ...PROMPT, requestId: 'x1', surface: 'terminal', props: { ...PROMPT.props, text: log, origin } } as never)
    out[k] = await drawnAs(ui)
    await ui.unmount()
  }
  expect(out).toEqual({
    composer: 'bubble-user',
    bridge: 'bubble-user',
    slackPing: 'bubble-user',
    channel: 'bubble-elsewhere',
    pluginAsUser: 'bubble-plugin-user',
    plugin: 'gray:The some-plugin plugin sent a message',
    sdk: 'gray:A message arrived from outside this chat',
    autoCont: 'gray:A message arrived from outside this chat',
    peer: 'gray:Another Claude session sent an update',
    sched: 'gray:A scheduled check-in ran',
    observer: 'gray:An observer agent sent a report',
    unclassified: 'gray:ops-bot sent an update',
    none: 'gray:A message arrived from outside this chat',
  })
  const spoof = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, text: NOTICE('planner'), origin: { kind: 'plugin', name: 'some-plugin' } } })
  expect(await drawnAs(spoof)).toBe('gray:The some-plugin plugin sent a message')
  await spoof.unmount()
  const framed = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, text: frame('planner', 'hi'), origin: { kind: 'plugin', name: 'some-plugin' } } })
  expect(await drawnAs(framed)).toBe('gray:The some-plugin plugin sent a message')
  await framed.unmount()
})

// V2: names lose bidi controls and zero-width characters.
test('V2: a name drops bidi controls and zero-width characters', () => {
  const hidden = (...points: number[]) => String.fromCodePoint(...points)
  const odd = `res${hidden(0x202e)}ear${hidden(0x200b)}ch${hidden(0x2066)}er${hidden(0xfeff, 0x200f)}`
  expect(drainUpdate(NOTICE(odd))).toBe('researcher sent an update')
})

// V3: a one-line round bubble only when every character takes one cell.
test('V3: wide characters keep the cap columns in round', async ($, on) => {
  engineDraws(on, { style: 'round' })
  for (const [id, text] of [['w1', '日本語のテキスト'], ['w2', '👍👍👍']] as const) {
    const ui = await $.ui.mount({ ...PROMPT, requestId: id, viewport: FULLSCREEN, surface: 'terminal', props: { ...PROMPT.props, text } })
    expect({ text, column: (await capColumnOf(ui, `cap-left:${id}`))?.type }).toEqual({ text, column: 'Box' })
    await ui.unmount()
  }
})

// V4: widths count cells: a CJK character or an emoji takes two.
test('V4: widths count cells, wide characters two, in every style', async ($, on) => {
  expect(replyWidth('日本語', 100)).toBe(6 + 4)
  expect(replyWidth('👍👍', 100)).toBe(4 + 4)
  expect(replyWidth('abc', 100)).toBe(3 + 4)
  engineDraws(on)
  const block = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, text: '日本語のテキスト' } })
  expect((await block.find({ key: 'bubble-user' }))?.props.width).toBe(16 + 4)
  await block.unmount()
})

// V5: after a hot reload no session.start or theme change comes; the first
// draw reads the saved theme once.
test('V5: the first draw after a reload reads the saved theme', async ($, on) => {
  engineDraws(on)
  on('state.get', (_, e, next) => (e.plugin === 'chat-bubbles' && e.key === 'theme' ? { value: { value: 'light', version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi there.' } })
  expect((await ui.find({ key: 'bubble-assistant' }))?.props.backgroundColor).toBe('#E9E9E9')
  await ui.unmount()
})

// R2: two rows drawn at the same moment after a reload, the saved theme read
// slowly: both get it, and it is read once. (The test runtime has timers; the
// tsconfig loads no runtime types, so it is declared here.)
declare const setTimeout: (run: () => void, ms: number) => unknown
test('R2: rows drawn at once after a reload all get the saved theme', async ($, on) => {
  engineDraws(on)
  let reads = 0
  on('state.get', async (_, e, next) => {
    if (e.plugin !== 'chat-bubbles' || e.key !== 'theme') return next(e)
    reads += 1
    await new Promise<void>(resolve => setTimeout(resolve, 30)) // a slow read

    return { value: { value: 'light', version: 1 } }
  })
  const reply = (id: string) => $.ui.mount({ ...REPLY, requestId: id, surface: 'terminal', props: { ...REPLY.props, text: `Hi ${id}.` } })
  const drawn = await Promise.all([reply('a'), reply('b')])
  const fills = await Promise.all(drawn.map(async ui => (await ui.find({ key: 'bubble-assistant' }))?.props.backgroundColor))
  expect({ fills, reads }).toEqual({ fills: ['#E9E9E9', '#E9E9E9'], reads: 1 })
  for (const ui of drawn) await ui.unmount()
})

// R3: names lose more invisible characters.
test('R3: a name drops format, filler and tag characters too', () => {
  const hidden = (...points: number[]) => String.fromCodePoint(...points)
  const odd = [
    're', hidden(0x061c), 'se', hidden(0x2060, 0x2064), 'ar', hidden(0x180e, 0x00ad), 'ch', hidden(0x034f, 0x3164),
    'e', hidden(0x2028), 'r', hidden(0x2029, 0xe0041, 0xe007f),
  ].join('')
  expect(drainUpdate(NOTICE(odd))).toBe('researcher sent an update')
})

test('A: own words quoting an idle notice stay a blue bubble; detail on keeps the engine row', async ($, on) => {
  engineDraws(on)
  const own = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, text: `why does this show?\n${NOTICE('builder')}` } })
  expect((await own.find({ key: 'bubble-user' }))?.props.backgroundColor).toBe('#0073EB')
  await own.unmount()
})

test('A: a drain row with detail on is the engine row', async ($, on) => {
  engineDraws(on, { detail: true })
  const ui = await $.ui.mount(teammateRow(`${REPORT}\n\n${NOTICE('builder')}`))
  expect(await isEngine(ui)).toBe(true)
  await ui.unmount()
})

test('W1: real stored teammate rows: leading line, closing paragraph; anything else outside frames is the engine row', async ($, on) => {
  engineDraws(on)
  const lineOf = async (text: string) => {
    const ui = await $.ui.mount(teammateRow(text))
    const line = await grayLine(ui)
    const engine = await isEngine(ui)
    await ui.unmount()

    return engine ? 'engine' : line?.text
  }
  const builder = frame('builder', IDLE('builder'))
  const verifier = frame('researcher', IDLE('researcher'))

  expect(await lineOf(`${LEAD}${builder}`)).toBe('builder sent an update')
  expect(await lineOf(`${LEAD}${builder}\n\n${builder}${CLOSING}`)).toBe('builder sent an update')
  expect(await lineOf(`${LEAD}${builder}\n\n${verifier}${CLOSING}`)).toBe('Teammates sent updates')
  expect(await lineOf(`${builder}${CLOSING}`)).toBe('builder sent an update')
  // A different first line, extra text between frames, or after the closing's
  // place: the engine's row.
  // (Frames with plain bodies here: a body that is an idle notice makes any
  // row a gray line by the drain rule, checked just below.)
  const plain = frame('builder', 'Draft done.')
  expect(await lineOf(`Another session wrote:\n${plain}`)).toBe('engine')
  expect(await lineOf(`${LEAD}${plain}\n\nand also this\n\n${frame('researcher', 'ok')}${CLOSING}`)).toBe('engine')
  expect(await lineOf(`${LEAD}${plain}\n\nPS: one more thing`)).toBe('engine')
  expect(await lineOf(`${LEAD}${builder}\n\nPS: one more thing`)).toBe('builder sent an update')
  expect(await lineOf(`${LEAD}${CLOSING}`)).toBe('engine') // no frame at all
})

test('V1: teammate frames keep the engine row with detail on, in the ctrl+o view, and with a task', async ($, on) => {
  engineDraws(on, { detail: true })
  const detail = await $.ui.mount(teammateRow(frame('builder')))
  expect(await isEngine(detail)).toBe(true)
  await detail.unmount()
})

test('V1: teammate frames in the ctrl+o view are the engine row', async ($, on) => {
  engineDraws(on)
  const expanded = await $.ui.mount(teammateRow(frame('builder'), { isExpanded: true }))
  expect(await isEngine(expanded)).toBe(true)
  await expanded.unmount()
})

test('Q1: a channel message with a sender reads "<sender> via <server>"', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'can you check the deploy?', origin: { kind: 'channel', server: 'slack' }, from: { name: 'ana' } },
  })
  expect(await ui.find({ key: 'bubble-elsewhere' })).toBeDefined()
  expect((await viaLine(ui))?.text).toBe('ana via slack')
  await ui.unmount()
})

test('Q3: names in a small line are one line of at most 32 characters', async ($, on) => {
  engineDraws(on)
  const long = 'a-very-long-server-name-that-goes-on-and-on'
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, origin: { kind: 'channel', server: `${long}\nsecond line` }, from: { name: `${long}-person` } },
  })
  const text = (await viaLine(ui))?.text ?? ''
  const [sender, server] = text.split(' via ')
  expect({ sender: sender?.length, server: server?.length, lines: text.split('\n').length }).toEqual({ sender: 32, server: 32, lines: 1 })
  await ui.unmount()

  const peer = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, origin: { kind: 'peer' }, from: { name: `${long}-agent` } } })
  expect((await grayLine(peer))?.text).toBe(`${long.slice(0, 31)}… sent an update`)
  await peer.unmount()

  const plugin = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, origin: { kind: 'plugin', name: `${long}-plugin`, asUser: true } },
  })
  expect((await viaLine(plugin))?.text).toBe(`via ${long.slice(0, 31)}…`)
  await plugin.unmount()
})

test('P1a: text wrapped in markup is left to the engine, never bubbled or hidden', async ($, on) => {
  engineDraws(on)
  for (const origin of [{ kind: 'channel', server: 'slack' }, { kind: 'unclassified' }] as const) {
    const ui = await $.ui.mount({
      ...PROMPT,
      surface: 'terminal',
      props: { ...PROMPT.props, text: '<channel source="slack" user="ana">hi there</channel>', origin },
    })
    expect({ kind: origin.kind, engine: await isEngine(ui) }).toEqual({ kind: origin.kind, engine: true })
    await ui.unmount()
  }
})

test('P1a: in round, full screen, the line sits over the text, past the tail and the cap', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({
    ...PROMPT,
    requestId: 'ch1',
    viewport: FULLSCREEN,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'hello\nthere', origin: { kind: 'channel', server: 'telegram' } },
  })
  expect(await capColumnOf(ui, 'cap-left:ch1')).toMatchObject({ first: g(0xe0b2, 0xe0b3), last: g(0xe0cd, 0xe0b5), fill: 'userMessageBackground' })
  expect((await viaLine(ui))?.line.paddingLeft).toBe(3)
  await ui.unmount()
})

test('P1b: a plugin\'s "as the user" text is a sent bubble with "via <plugin>" above it, not recorded', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, text: 'yes, ship it', origin: { kind: 'plugin', name: 'dictation', asUser: true } },
  })
  expect((await ui.find({ key: 'bubble-plugin-user' }))?.props.backgroundColor).toBe('#0073EB')
  const via = await viaLine(ui)
  expect({ text: via?.text, paddingRight: via?.line.paddingRight }).toEqual({ text: 'via dictation', paddingRight: 2 })
  await ui.unmount()
  // Not part of the thread record: no time line, no Delivered (H2 stands).
  expect(isRecorded({ origin: { kind: 'plugin' }, message: { type: 'user' } }, 'u1')).toBe(false)
})

test('P1c: a task line adds the task\'s own short label when its summary gives one', async ($, on) => {
  engineDraws(on)
  const lines: string[] = []
  for (const [text, status] of [
    ['Background command "build docs" completed (exit code 0)', 'completed'],
    ['Background command "build docs" failed', 'failed'],
    ['Agent "checker" was stopped', 'killed'],
    [`Background command "${'x'.repeat(80)}" completed`, 'completed'],
    ['A summary with no label', 'completed'],
  ] as const) {
    const ui = await $.ui.mount({
      ...PROMPT,
      surface: 'terminal',
      props: { ...PROMPT.props, text, origin: { kind: 'task-notification' }, task: { status } },
    })
    lines.push((await grayLine(ui))?.text ?? '')
    await ui.unmount()
  }
  expect(lines).toEqual([
    'build docs finished',
    'build docs failed',
    'checker stopped',
    'A background task finished',
    'A background task finished',
  ])
})

test('P1: with detail on, a channel message keeps the engine row', async ($, on) => {
  engineDraws(on, { detail: true })
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, origin: { kind: 'channel', server: 'slack' } } })
  expect(await isEngine(ui)).toBe(true)
  await ui.unmount()
})

test('L2: each origin kind gets its own plain line', async ($, on) => {
  engineDraws(on)
  const lines: Record<string, unknown> = {}
  for (const [label, props] of [
    ['peer, named', { origin: { kind: 'peer' }, from: { name: 'builder' } }],
    ['peer', { origin: { kind: 'peer' } }],
    ['peer-send-message, named', { origin: { kind: 'peer-send-message' }, from: { name: 'checker' } }],
    ['projects-relay', { origin: { kind: 'projects-relay' } }],
    ['coordinator', { origin: { kind: 'coordinator' } }],
    ['task finished', { origin: { kind: 'task-notification' }, task: { status: 'completed' } }],
    ['task failed', { origin: { kind: 'task-notification' }, task: { status: 'failed' } }],
    ['task stopped', { origin: { kind: 'task-notification' }, task: { status: 'killed' } }],
    ['task other', { origin: { kind: 'task-notification' } }],
    ['scheduled-trigger', { origin: { kind: 'scheduled-trigger' } }],
    ['observer', { origin: { kind: 'observer' } }],
    ['observer-activity', { origin: { kind: 'observer-activity' } }],
    ['auto-continuation', { origin: { kind: 'auto-continuation' } }],
    ['sdk', { origin: { kind: 'sdk' } }],
    ['bridge with a sender', { origin: { kind: 'bridge' }, from: { name: 'worker' } }],
  ] as const) {
    const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, ...props } })
    lines[label] = (await grayLine(ui))?.text
    await ui.unmount()
  }
  expect(lines).toEqual({
    'peer, named': 'builder sent an update',
    peer: 'Another Claude session sent an update',
    'peer-send-message, named': 'checker sent an update',
    'projects-relay': 'Another Claude session sent an update',
    coordinator: 'Another Claude session sent an update',
    'task finished': 'A background task finished',
    'task failed': 'A background task failed',
    'task stopped': 'A background task was stopped',
    'task other': 'A background task sent an update',
    'scheduled-trigger': 'A scheduled check-in ran',
    observer: 'An observer agent sent a report',
    'observer-activity': 'An activity digest arrived',
    'auto-continuation': 'A message arrived from outside this chat',
    sdk: 'A message arrived from outside this chat',
    'bridge with a sender': 'worker sent an update',
  })
})

test('L2: the gray line falls through: detail on, ctrl+o, mod off, empty text, other surfaces', async ($, on) => {
  engineDraws(on)
  const PEER = { ...PROMPT.props, origin: { kind: 'peer' }, from: { name: 'builder' } } as const

  const expanded = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PEER, isExpanded: true } })
  expect(await isEngine(expanded)).toBe(true)
  await expanded.unmount()

  const empty = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PEER, text: '   ' } })
  expect(await isEngine(empty)).toBe(true)
  await empty.unmount()

  const desktop = await $.ui.mount({ ...PROMPT, surface: 'desktop', props: PEER })
  expect(await isEngine(desktop)).toBe(true)
  await desktop.unmount()

  expect((await typed($, 'detail on')).text).toBe('Detail on.')
  const detail = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: PEER })
  expect(await isEngine(detail)).toBe(true)
  await detail.unmount()

  expect((await typed($, 'detail off')).text).toBe('Detail off.')
  expect((await typed($, 'off')).text).toBe('Chat bubbles off.')
  const off = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: PEER })
  expect(await isEngine(off)).toBe(true)
  await off.unmount()
})

test('G1: a message carrying a sender or a task is never a blue bubble', async ($, on) => {
  engineDraws(on)
  const withSender = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, origin: { kind: 'bridge' }, from: { name: 'worker' } },
  })
  expect(await withSender.find({ key: 'bubble-user' })).toBeUndefined()
  await withSender.unmount()

  // H5: a task, too.
  const withTask = await $.ui.mount({
    ...PROMPT,
    surface: 'terminal',
    props: { ...PROMPT.props, origin: { kind: 'bridge' }, task: { id: 't1', status: 'completed' } },
  })
  expect(await withTask.find({ key: 'bubble-user' })).toBeUndefined()
  expect((await grayLine(withTask))?.text).toBe('A background task finished')
  await withTask.unmount()
})

// H1: every message the person sent joins the thread record. The kit mints no
// uuid for a row a test raises, so the stamping decision is tested on its own
// and the drawing from the record it makes.
test('H1: a message from the phone or Slack is recorded like a typed one', () => {
  const row = (kind: string, extra: Record<string, unknown> = {}) => ({
    origin: { kind },
    message: { type: 'user' },
    ...extra,
  })
  expect(isRecorded(row('composer'), 'u1')).toBe(true)
  expect(isRecorded(row('bridge'), 'u1')).toBe(true)
  expect(isRecorded(row('slack-ping'), 'u1')).toBe(true)
  // Never: another party, a subagent's row, meta text, no stored id.
  expect(isRecorded(row('peer'), 'u1')).toBe(false)
  const asUser = { origin: { kind: 'plugin', name: 'x', asUser: true }, message: { type: 'user' } }
  expect(isRecorded(asUser, 'u1')).toBe(false)
  expect(isRecorded(row('bridge', { agentId: 'a1' }), 'u1')).toBe(false)
  expect(isRecorded({ origin: { kind: 'bridge' }, message: { type: 'user', isMeta: true } }, 'u1')).toBe(false)
  expect(isRecorded(row('bridge'), undefined)).toBe(false)
})

test('H1: a phone message that opens the thread gets the header; a later typed prompt does not', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START + 10 * MINUTE })
  stamped(on, [
    { uuid: 'phone', at: START },
    { uuid: 'typed', at: START + MINUTE },
  ])
  const BRIDGE = { origin: { kind: 'bridge' } } as const

  const phone = await $.ui.mount({ ...PROMPT, requestId: 'phone', viewport: FULLSCREEN, surface: 'terminal', props: { ...PROMPT.props, ...BRIDGE } })
  expect((await phone.find({ type: 'Text', text: /^Claude$/ }))?.props.bold).toBe(true)
  expect((await phone.find({ type: 'Text', text: /^ \d{1,2}:\d{2} (AM|PM)$/ }))?.text).toBe(' 12:21 AM')
  expect(await phone.find({ type: 'Client', key: 'delivered' })).toBeUndefined()
  await phone.unmount()

  const typed = await $.ui.mount({ ...PROMPT, requestId: 'typed', viewport: FULLSCREEN, surface: 'terminal' })
  expect(await typed.find({ type: 'Text', text: /✻|Claude|iMessage/ })).toBeUndefined()
  expect(await typed.find({ type: 'Client', key: 'delivered' })).toBeDefined()
  await typed.unmount()
})

test('H1: a phone message that is the newest carries Delivered; the older typed prompt does not', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START + 10 * MINUTE })
  stamped(on, [
    { uuid: 'typed', at: START },
    { uuid: 'phone', at: START + MINUTE },
  ])

  const typed = await $.ui.mount({ ...PROMPT, requestId: 'typed', viewport: FULLSCREEN, surface: 'terminal' })
  expect(await typed.find({ type: 'Client', key: 'delivered' })).toBeUndefined()
  await typed.unmount()

  const phone = await $.ui.mount({
    ...PROMPT,
    requestId: 'phone',
    viewport: FULLSCREEN,
    surface: 'terminal',
    props: { ...PROMPT.props, origin: { kind: 'bridge' } },
  })
  expect(await phone.find({ type: 'Client', key: 'delivered' })).toBeDefined()
  await phone.unmount()
})

test('the ctrl+o view keeps the engine row for a prompt', async ($, on) => {
  engineDraws(on)
  const prompt = await $.ui.mount({ ...PROMPT, surface: 'terminal', props: { ...PROMPT.props, isExpanded: true } })
  expect(await prompt.find({ key: 'bubble-user' })).toBeUndefined()
  await prompt.unmount()
})

// L1: a summary of the model's text between tool calls is a reply bubble.
test('L1: a summary row is a received bubble in clean mode; the engine row with detail on', async ($, on) => {
  engineDraws(on)
  const SUMMARY = { ...REPLY.props, text: 'Both workers are running.', isSummary: true } as const

  const clean = await $.ui.mount({ ...REPLY, surface: 'terminal', props: SUMMARY })
  const body = await clean.find({ key: 'bubble-assistant' })
  expect(body?.props.backgroundColor).toBe('userMessageBackground')
  expect((await clean.find({ type: 'Markdown' }))?.props.text).toBe('Both workers are running.')
  expect(await isEngine(clean)).toBe(false)
  await clean.unmount()

  expect((await typed($, 'detail on')).text).toBe('Detail on.')
  const detail = await $.ui.mount({ ...REPLY, surface: 'terminal', props: SUMMARY })
  expect(await isEngine(detail)).toBe(true)
  await detail.unmount()
})

test('L1: in round, full screen, a summary carries the same caps as any reply', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({
    ...REPLY,
    requestId: 's1',
    viewport: FULLSCREEN,
    surface: 'terminal',
    props: { ...REPLY.props, text: 'Both workers\nare running.', isSummary: true },
  })
  expect(await capColumnOf(ui, 'cap-left:s1')).toMatchObject({ first: g(0xe0b2, 0xe0b3), last: g(0xe0cd, 0xe0b5), fill: 'userMessageBackground' })
  await ui.unmount()
})

test('/bubbles off passes everything through, the spinner, the hint and the hidden rows included', async ($, on) => {
  engineDraws(on)

  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail off. Style block. Tail on.')
  expect((await typed($, 'off')).text).toBe('Chat bubbles off.')
  expect((await typed($, '')).text).toBe('Chat bubbles off. Detail off. Style block. Tail on.')

  for (const target of [PROMPT, REPLY, SPINNER, ...HIDDEN] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }

  expect((await typed($, ' ON ')).text).toBe('Chat bubbles on.')
  const ui = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect((await ui.find({ key: 'bubble-user' }))?.props.backgroundColor).toBe('#0073EB')
  await ui.unmount()
})

// ---- colours from Claude Code's theme setting ----------------------------

// The session starts with Claude Code's `theme` row holding `theme()`.
function themed(on: On, theme: () => string | undefined) {
  on('command.register', () => ({ value: { command: 'bubbles' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('config.list', () => {
    const value = theme()

    return {
      value:
        value === undefined
          ? []
          : [
              {
                key: 'theme',
                label: 'Theme',
                kind: 'choice' as const,
                value,
                provider: { plugin: 'engine', tier: 'core' as const },
                isLocked: false,
              },
            ],
    }
  })
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

// The fill of each part of a mounted bubble: body, edge-row glyphs.
async function fills(ui: Ui, who: string) {
  return {
    body: (await ui.find({ key: `bubble-${who}` }))?.props.backgroundColor,
    top: (await ui.find({ type: 'Text', text: /^▗/ }))?.props.color,
    bottom: (await ui.find({ type: 'Text', text: /^▝/ }))?.props.color,
  }
}

test('a dark theme gives the dark fills and dots', async ($, on) => {
  engineDraws(on, { style: 'pill' }) // pill, so the edge rows' colour shows too
  themed(on, () => 'dark-daltonized')
  await startSession($)

  const reply = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi.' } })
  expect(await fills(reply, 'assistant')).toEqual({ body: '#262626', top: '#262626', bottom: '#262626' })
  await reply.unmount()

  const prompt = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect(await fills(prompt, 'user')).toEqual({ body: '#0073EB', top: '#0073EB', bottom: '#0073EB' })
  await prompt.unmount()

  const typing = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(await fills(typing, 'typing')).toEqual({ body: '#262626', top: '#262626', bottom: '#262626' })
  expect((await typing.find({ type: 'Text', text: /•/, in: 'typing:Thinking' }))?.props.color).toBe('#AEAEB2')
  await typing.advance(300)
  expect((await typing.find({ type: 'Text', text: /•/, in: 'typing:Thinking' }))?.props.color).toBe('#636366')
  await typing.unmount()
})

test('a light theme gives the light fills and dots', async ($, on) => {
  engineDraws(on, { style: 'pill' })
  themed(on, () => 'light')
  await startSession($)

  const reply = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi.' } })
  expect(await fills(reply, 'assistant')).toEqual({ body: '#E9E9E9', top: '#E9E9E9', bottom: '#E9E9E9' })
  await reply.unmount()

  const prompt = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
  expect(await fills(prompt, 'user')).toEqual({ body: '#0073EB', top: '#0073EB', bottom: '#0073EB' })
  await prompt.unmount()

  const typing = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect((await typing.find({ type: 'Text', text: /•/, in: 'typing:Thinking' }))?.props.color).toBe('#8E8E93')
  await typing.advance(300)
  expect((await typing.find({ type: 'Text', text: /•/, in: 'typing:Thinking' }))?.props.color).toBe('#C7C7CC')
  await typing.unmount()
})

test('an unknown or missing theme keeps the fallback fills', async ($, on) => {
  engineDraws(on)
  let theme: string | undefined = 'solarized'
  themed(on, () => theme)

  for (const next of ['solarized', undefined]) {
    theme = next
    await startSession($)
    const reply = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi.' } })
    expect((await fills(reply, 'assistant')).body).toBe('userMessageBackground')
    await reply.unmount()

    const prompt = await $.ui.mount({ ...PROMPT, surface: 'terminal' })
    expect((await fills(prompt, 'user')).body).toBe('#0073EB')
    await prompt.unmount()
  }
})

test('a change of theme in /config is picked up', async ($, on) => {
  engineDraws(on)
  let theme = 'dark'
  themed(on, () => theme)
  on('config.set', (_, e) => {
    theme = String(e.value)

    return { value: e.value }
  })
  await startSession($)

  await $.config.set({
    key: 'theme',
    value: 'light',
    previous: 'dark',
    provider: { plugin: 'engine', tier: 'core' },
    origin: { kind: 'composer' },
  })

  const reply = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { ...REPLY.props, text: 'Hi.' } })
  expect((await fills(reply, 'assistant')).body).toBe('#E9E9E9')
  await reply.unmount()
})

// ---- round: the Bubble Caps font --------------------------------------------

const g = (...points: number[]) => String.fromCodePoint(...points)
const rep = (point: number, n: number) => g(point).repeat(n)

// A drawn node's text, its children's joined.
type Drawn = { type?: string; children?: unknown[] }
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === undefined || node === null) return ''
  const kids = (node as Drawn).children ?? []

  return kids.map(textOf).join('')
}

test('round: a one-line sent bubble with its tail', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'm1', viewport: FULLSCREEN, surface: 'terminal' })

  // L = 11 ("hello there"), the bubble 15 wide plus the tail column.
  expect((await ui.find({ key: 'shape-user' }))?.props.width).toBe(16)
  const body = await ui.find({ key: 'bubble-user' })
  expect(body?.props.width).toBe(11)
  expect(body?.props.backgroundColor).toBe('#0073EB')
  const top = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b0)}`) })
  expect(top?.text).toBe(g(0xe0b0, 0xe0b1) + rep(0xe0a4, 11) + g(0xe0bb, 0xe0ba))
  expect(top?.props.color).toBe('#0073EB')
  expect(top?.props.backgroundColor).toBeUndefined()
  const bottom = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b8)}`) })
  expect(bottom?.text).toBe(g(0xe0b8, 0xe0b9) + rep(0xe0a5, 11) + g(0xe0c5, 0xe0c6, 0xe0c7))
  // S3: a one-line bubble prints its one-line caps itself, no Client columns.
  expect(await ui.find({ type: 'Client', key: 'cap-left:m1' })).toBeUndefined()
  expect(await ui.find({ type: 'Client', key: 'cap-right:m1' })).toBeUndefined()
  const left = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b6, 0xe0b7)}$`) })
  const right = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0c1, 0xe0c4)}$`) })
  expect([left?.props.color, right?.props.color]).toEqual(['#0073EB', '#0073EB'])
  await ui.unmount()
})

test('S3: a bubble whose text wraps or has a line break keeps its cap columns', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const broken = await $.ui.mount({ ...PROMPT, requestId: 'm2', viewport: FULLSCREEN, surface: 'terminal', props: { ...PROMPT.props, text: 'hello\nthere' } })
  expect(await capColumnOf(broken, 'cap-left:m2')).toMatchObject({ first: g(0xe0b2, 0xe0b3), last: g(0xe0b4, 0xe0b5), fill: '#0073EB' })
  expect(await capColumnOf(broken, 'cap-right:m2')).toMatchObject({ first: g(0xe0bd, 0xe0bc), last: g(0xe0bf, 0xe0c8), fill: '#0073EB' })
  await broken.unmount()

  const long = await $.ui.mount({ ...PROMPT, requestId: 'm3', viewport: FULLSCREEN, surface: 'terminal', props: { ...PROMPT.props, text: LONG } })
  expect((await capColumnOf(long, 'cap-left:m3'))?.type).toBe('Box')
  await long.unmount()
})

test('round: tail off draws the plain pill', async ($, on) => {
  engineDraws(on, { style: 'round', tail: false })
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'm1', viewport: FULLSCREEN, surface: 'terminal' })

  expect((await ui.find({ key: 'shape-user' }))?.props.width).toBe(15)
  const bottom = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b8)}`) })
  expect(bottom?.text).toBe(g(0xe0b8, 0xe0b9) + rep(0xe0a5, 11) + g(0xe0c3, 0xe0c2))
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0c1, 0xe0c0)}$`) }))?.props.color).toBe('#0073EB')
  await ui.unmount()
})

test('round: a received bubble with its tail on the left', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', viewport: FULLSCREEN, surface: 'terminal', props: { ...REPLY.props, text: 'Hi there, friend.' } })

  expect((await ui.find({ key: 'shape-assistant' }))?.props.width).toBe(22)
  expect((await ui.find({ key: 'bubble-assistant' }))?.props.width).toBe(17)
  const bottom = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0cc)}`) })
  expect(bottom?.text).toBe(g(0xe0cc, 0xe0cb, 0xe0ca) + rep(0xe0a5, 17) + g(0xe0c3, 0xe0c2))
  // One line: the caps printed directly, the left one with the tail.
  expect(await ui.find({ key: 'cap-left:r1' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0c9, 0xe0b7)}$`) }))?.props.color).toBe('userMessageBackground')
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0c1, 0xe0c0)}$`) }))?.props.color).toBe('userMessageBackground')
  await ui.unmount()

  const two = await $.ui.mount({ ...REPLY, requestId: 'r2', viewport: FULLSCREEN, surface: 'terminal', props: { ...REPLY.props, text: 'Hi there,\nfriend.' } })
  expect(await capColumnOf(two, 'cap-left:r2')).toMatchObject({ first: g(0xe0b2, 0xe0b3), last: g(0xe0cd, 0xe0b5), fill: 'userMessageBackground' })
  expect(await capColumnOf(two, 'cap-right:r2')).toMatchObject({ first: g(0xe0bd, 0xe0bc), last: g(0xe0bf, 0xe0be), fill: 'userMessageBackground' })
  await two.unmount()
})

test('round: the cap glyphs by height: 0, 1, 2 and 5 rows', () => {
  const sized = (props: CapProps, rows: number) => capGlyphs(props, rows)
  const left = { side: 'left', fill: '#0073EB', tail: false } as const
  const right = { side: 'right', fill: '#0073EB', tail: true } as const

  // Left, sent (no tail on this side).
  expect(sized(left, 0)).toEqual([])
  expect(sized(left, 1)).toEqual([g(0xe0b6, 0xe0b7)])
  expect(sized(left, 2)).toEqual([g(0xe0b2, 0xe0b3), g(0xe0b4, 0xe0b5)])
  expect(sized(left, 5)).toEqual([g(0xe0b2, 0xe0b3), '  ', '  ', '  ', g(0xe0b4, 0xe0b5)])
  // Right, sent, with the tail.
  expect(sized(right, 1)).toEqual([g(0xe0c1, 0xe0c4)])
  expect(sized(right, 3)).toEqual([g(0xe0bd, 0xe0bc), '  ', g(0xe0bf, 0xe0c8)])
})

// A cap column of a bubble that wraps, as drawn: its first-row cap, the fill
// between, its last-row cap.
async function capColumnOf(ui: { find: (q: { key?: string }) => Promise<unknown> }, key: string) {
  const box = (await ui.find({ key })) as { type?: string; props?: Record<string, unknown>; children?: unknown[] } | undefined
  if (box === undefined) return undefined
  const kids = (box.children ?? []) as { type?: string; props?: Record<string, unknown> }[]

  return {
    type: box.type,
    width: box.props?.width,
    first: textOf(kids[0]),
    color: kids[0]?.props?.color,
    fill: kids[1]?.props?.backgroundColor,
    grow: kids[1]?.props?.flexGrow,
    last: textOf(kids[2]),
    lastColor: kids[2]?.props?.color,
  }
}

// A cap column sits in the row's flow, no Client and no absolute span. A Box out of the flow inside a message partly scrolled off
// the top was drawn from the first visible row, its last cap below the bubble.
// In the flow, the column is its first cap, a fill that grows, and its last
// cap: two rows of its own, so the row is as tall as the body and the column
// follows it down as well as up. (The kit lays out no host tree: the live
// scroll and resize captures prove the rows.)
test('B: cap columns are in the flow: first cap, growing fill, last cap; no Client, no absolute span', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'm1', viewport: FULLSCREEN, surface: 'terminal', props: { ...PROMPT.props, text: 'hello\nthere' } })

  expect(await ui.find({ type: 'Client', key: 'cap-left:m1' })).toBeUndefined()
  expect(await ui.find({ type: 'Client', key: 'cap-right:m1' })).toBeUndefined()
  expect(await ui.find({ key: 'cap-left-span:m1' })).toBeUndefined()
  const fill = '#0073EB'
  expect(await capColumnOf(ui, 'cap-left:m1')).toEqual({
    type: 'Box', width: 2, first: g(0xe0b2, 0xe0b3), color: fill, fill, grow: 1, last: g(0xe0b4, 0xe0b5), lastColor: fill,
  })
  expect(await capColumnOf(ui, 'cap-right:m1')).toEqual({
    type: 'Box', width: 2, first: g(0xe0bd, 0xe0bc), color: fill, fill, grow: 1, last: g(0xe0bf, 0xe0c8), lastColor: fill,
  })
  await ui.unmount()
})

test('round: a received cap column with the tail, and one without', () => {
  const left = { side: 'left', fill: 'userMessageBackground', tail: true } as const
  const right = { side: 'right', fill: 'userMessageBackground', tail: false } as const

  expect(capGlyphs(left, 1)).toEqual([g(0xe0c9, 0xe0b7)])
  expect(capGlyphs(left, 2)).toEqual([g(0xe0b2, 0xe0b3), g(0xe0cd, 0xe0b5)])
  expect(capGlyphs(right, 1)).toEqual([g(0xe0c1, 0xe0c0)])
  expect(capGlyphs(right, 2)).toEqual([g(0xe0bd, 0xe0bc), g(0xe0bf, 0xe0be)])
})

test('round: the typing pill, its dots the font\'s dot, the bright one moving', async ($, on) => {
  engineDraws(on, { style: 'round' })
  const ui = await $.ui.mount({ ...SPINNER, viewport: FULLSCREEN, surface: 'terminal' })

  const top = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b0)}`) })
  expect(top?.text).toBe(g(0xe0b0, 0xe0b1) + rep(0xe0a4, 5) + g(0xe0bb, 0xe0ba))
  const bottom = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b8)}`) })
  expect(bottom?.text).toBe(g(0xe0b8, 0xe0b9) + rep(0xe0a5, 5) + g(0xe0c3, 0xe0c2))
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0b6)}`) }))?.text).toBe(g(0xe0b6, 0xe0b7))
  expect((await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0c1)}`) }))?.text).toBe(g(0xe0c1, 0xe0c0))
  // Each dot starts its own run: the dot, then its space.
  const firstDot = async () => ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0a6)}`), in: 'typing:Thinking' })
  expect((await firstDot())?.text).toBe(`${g(0xe0a6)} `)
  expect((await firstDot())?.props.color).toBe('#AEAEB2')
  await ui.advance(300)
  expect((await firstDot())?.props.color).toBe('#636366')
  await ui.unmount()
})

test('J1: the registered command names every style and the tail switch', async ($, on) => {
  engineDraws(on)
  const registered: { description?: string; argumentHint?: string }[] = []
  on('command.register', (_, e) => {
    registered.push(e)

    return { value: { command: 'bubbles' } }
  })
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(registered[0]?.argumentHint).toBe('on|off | detail on|off | style block|pill|tail|round | tail on|off')
  expect(registered[0]?.description).toBe(
    'Chat bubbles: on, off, detail on|off, style block|pill|tail|round, tail on|off',
  )
})

test('/bubbles tail on|off is stored and reported', async ($, on) => {
  engineDraws(on)

  expect((await typed($, 'tail off')).text).toBe('Tail off.')
  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail off. Style block. Tail off.')
  expect((await typed($, 'tail on')).text).toBe('Tail on.')
  expect((await typed($, 'style round')).text).toBe('Style round.')
  expect((await typed($, '')).text).toBe('Chat bubbles on. Detail off. Style round. Tail on.')
})

// K1: the round thread opens with the avatar.
test('K1: in round, full screen, the thread opens with the two avatar rows', async ($, on) => {
  engineDraws(on, { style: 'round' })
  mock.clock(on, { now: START + 5 * MINUTE })
  stamped(on, [{ uuid: 'p1', at: START }])

  const ui = await $.ui.mount({ ...PROMPT, requestId: 'p1', viewport: FULLSCREEN, surface: 'terminal' })
  const row1 = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0ce)}`) })
  const row2 = await ui.find({ type: 'Text', text: new RegExp(`^${g(0xe0d2)}`) })
  expect(row1?.text).toBe(g(0xe0ce, 0xe0cf, 0xe0d0, 0xe0d1))
  expect(row2?.text).toBe(g(0xe0d2, 0xe0d3, 0xe0d4, 0xe0d5))
  expect(row1?.props.color).toBe('#D97757')
  expect(row1?.props.backgroundColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^✻$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Claude$/ }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^iMessage$/ })).toBeDefined()
  await ui.unmount()
})

test('K1: block, pill and tail keep the ✻ header', async ($, on) => {
  engineDraws(on)
  mock.clock(on, { now: START + 5 * MINUTE })
  stamped(on, [{ uuid: 'p1', at: START }])

  for (const style of ['block', 'pill', 'tail']) {
    expect((await typed($, `style ${style}`)).text).toBe(`Style ${style}.`)
    const ui = await $.ui.mount({ ...PROMPT, requestId: 'p1', viewport: FULLSCREEN, surface: 'terminal' })
    expect({ style, mark: (await ui.find({ type: 'Text', text: /^✻$/ }))?.props.color }).toEqual({ style, mark: '#D97757' })
    expect({ style, avatar: await ui.find({ type: 'Text', text: new RegExp(g(0xe0ce)) }) }).toEqual({ style, avatar: undefined })
    await ui.unmount()
  }
})

// K2: round needs rows that redraw; off full screen it draws block.
test('K2: a saved round off full screen draws block everywhere', async ($, on) => {
  engineDraws(on, { style: 'round' })
  mock.clock(on, { now: START + 5 * MINUTE })
  stamped(on, [{ uuid: 'p1', at: START }])
  const roundGlyph = new RegExp(`[${g(0xe0a4)}-${g(0xe0d5)}]`)

  for (const [target, who] of [
    [{ ...PROMPT, requestId: 'p1' }, 'user'],
    [REPLY, 'assistant'],
    [SPINNER, 'typing'],
  ] as const) {
    const ui = await $.ui.mount({ ...target, viewport: VIEWPORT, surface: 'terminal' })
    expect({ who, paddingY: (await ui.find({ key: `bubble-${who}` }))?.props.paddingY }).toEqual({ who, paddingY: 1 })
    expect({ who, glyph: await ui.find({ type: 'Text', text: roundGlyph }) }).toEqual({ who, glyph: undefined })
    await ui.unmount()
  }

  const header = await $.ui.mount({ ...PROMPT, requestId: 'p1', viewport: VIEWPORT, surface: 'terminal' })
  expect((await header.find({ type: 'Text', text: /^✻$/ }))?.props.color).toBe('#D97757')
  await header.unmount()
})

test('K2: the same saved round, full screen, draws round', async ($, on) => {
  engineDraws(on, { style: 'round' })
  for (const [target, glyph] of [
    [PROMPT, 0xe0b0],
    [REPLY, 0xe0b0],
    [SPINNER, 0xe0b6],
  ] as const) {
    const ui = await $.ui.mount({ ...target, viewport: FULLSCREEN, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${g(glyph)}`) })).toBeDefined()
    await ui.unmount()
  }
})

// ---- N: healing after a Client fault ---------------------------------------

// The kit has no call that raises `ui.fault`, and the typing and Delivered
// modules cannot be made to fail in it (their trees are fixed and small);
// their fallbacks are proven in a real chat with a scratch copy whose modules
// throw once.

test('N3: the typing Client\'s key follows the turn word', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...SPINNER, requestId: 'agent', surface: 'terminal' })
  expect(await ui.find({ type: 'Client', key: 'typing:Thinking' })).toBeDefined()
  await ui.redraw({ ...SPINNER.props, word: 'Brewing' })
  expect(await ui.find({ type: 'Client', key: 'typing:Brewing' })).toBeDefined()
  await ui.unmount()
})

// The cap columns are not Clients, so nothing in the mod can be made to fault
// in the kit (the typing and Delivered trees are fixed and
// small). The fault rules are pinned on the bookkeeping itself, on this test
// file's own copy of the module; the wiring (`ui.fault` notes a fault, the next
// prompt recovers) is proven in a real chat only.
const KEY = 'typing:Thinking'

// P3: a repeat fault keeps its fallback until a prompt at least 60 s after the
// last fault, then the piece is tried again: never locked for the session.
test('P3: stall, recover too early, fault again, then a later prompt brings the Client back', () => {
  forgetAllFaults()
  let now = START
  noteFault(KEY, now) // the stall
  now += 1_000
  expect(recoverFaults(now)).toBe(true) // first fault: tried again at once
  expect(hasFaulted(KEY)).toBe(false)
  now += 1_000
  noteFault(KEY, now) // a repeat fault
  now += 9_000
  recoverFaults(now) // 9 s after it: too early, kept
  expect(hasFaulted(KEY)).toBe(true)
  now += 30_000
  recoverFaults(now) // 39 s after it: still too early
  expect(hasFaulted(KEY)).toBe(true)
  now += 25_000
  expect(recoverFaults(now)).toBe(true) // 64 s after it: tried again
  expect(hasFaulted(KEY)).toBe(false)
})

// Q2: the red lines follow a rule with no memory, so no redraw, scroll or
// order can change them: a group with failed or stopped calls, a result row
// that errored, and a call row that was stopped each draw their line; a call
// row that only errored draws nothing (its result row or group carries it).
const failedCall = (id: string) => ({ tool_use_id: id, tool: 'Read', input: {}, isRunning: false, isErrored: true, isInterrupted: false })

test('Q2: the same rows drawn in three orders give the same lines every time', async ($, on) => {
  engineDraws(on)
  const rows = {
    use: { ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool: 'Read', tool_use_id: 'q1', isErrored: true } },
    result: { ...TOOL_RESULT, surface: 'terminal', props: { ...TOOL_RESULT.props, tool: 'Read', tool_use_id: 'q1', isErrored: true } },
    group: {
      ...TOOL_GROUP,
      requestId: 'group-q',
      surface: 'terminal',
      props: { calls: [failedCall('q1')], isActive: false, isExpanded: false, isCallsOnly: false },
    },
  } as const
  const orders = [
    ['use', 'result', 'group'],
    ['result', 'group', 'use'],
    ['group', 'use', 'result'],
  ] as const
  const seen: Record<string, unknown>[] = []
  for (const order of orders) {
    const lines: Record<string, unknown> = {}
    for (const name of order) {
      const ui = await $.ui.mount(rows[name] as never) as unknown as Ui & { redraw: () => Promise<void>; unmount: () => Promise<void> }
      await ui.redraw()
      lines[name] = (await failLine(ui))?.text ?? null
      await ui.unmount()
    }
    seen.push(lines)
  }
  const expected = { use: null, result: 'Read failed', group: 'Read failed' }
  expect(seen).toEqual([expected, expected, expected])
})

test('Q2: a stopped call row draws its own line', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({ ...TOOL_USE, surface: 'terminal', props: { ...TOOL_USE.props, tool_use_id: 's1', isInterrupted: true } })
  for (let i = 0; i < 3; i += 1) {
    await ui.redraw()
    expect((await failLine(ui))?.text).toBe('Bash stopped')
  }
  await ui.unmount()
})

// Q4: a fault whose time could not be read is forgettable at the next prompt,
// even a repeat one.
test('Q4: a repeat fault recorded while the clock fails is tried again at the next prompt', () => {
  forgetAllFaults()
  let now = START
  noteFault(KEY, now) // first fault, at START
  now += 1_000
  recoverFaults(now) // tried again
  noteFault(KEY, Number.NaN) // a repeat, time unknown
  now += 1_000
  // 1 s later: a repeat with a known time would wait 60 s; this one is tried.
  expect(recoverFaults(now)).toBe(true)
  expect(hasFaulted(KEY)).toBe(false)
  // And a known-time repeat 1 s later is kept, for contrast.
  noteFault(KEY, now)
  expect(recoverFaults(now + 1_000)).toBe(false)
  expect(hasFaulted(KEY)).toBe(true)
  forgetAllFaults()
})

// T1: while the person has collapsed the band above the prompt, its rows are
// left out of the list, so nothing (not even the "plugin panel hidden" hint)
// is drawn there. Expanded, a survey, detail on or the mod off: rows as given.
const BAND = {
  plugin: 'chat-bubbles',
  component: 'AbovePromptList',
  viewport: VIEWPORT,
  props: {
    rows: [{ plugin: 'some-plugin', tree: { type: 'Text', props: { children: ['1. pinned'] } } }],
    hasSurvey: false,
    isCollapsed: true,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

function bandBeneath(on: On, seen: number[]) {
  on('ui.render', { component: 'AbovePromptList' }, ($, e) => {
    seen.push(e.props.rows.length)
    const { Text } = $.ui.resolve(e)

    return <Text>{`band of ${e.props.rows.length}`}</Text>
  })
}

test('T1: a collapsed band hands on no rows; expanded, a survey, detail on or mod off hand them all', async ($, on) => {
  mock.store(on)
  on('ui.invalidate', () => ({ value: undefined }))
  const seen: number[] = []
  bandBeneath(on, seen)
  const draw = async (props: { isCollapsed?: boolean; hasSurvey?: boolean }) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, ...props } } as never)
    await ui.unmount()
  }

  await draw({}) // collapsed: none
  await draw({ isCollapsed: false }) // expanded (ctrl+x ctrl+a): all
  await draw({ hasSurvey: true }) // a survey holds it: all
  expect((await typed($, 'detail on')).text).toBe('Detail on.')
  await draw({})
  expect((await typed($, 'detail off')).text).toBe('Detail off.')
  expect((await typed($, 'off')).text).toBe('Chat bubbles off.')
  await draw({})
  expect(seen).toEqual([0, 1, 1, 1, 1])
})
