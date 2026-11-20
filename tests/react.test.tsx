import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BAR_CELLS, ITEM_CELLS, TAPBACKS, barHit, barPlace, contextLines, isReaction, snippetOf, statusOf } from '../hooks/react'
import { glow } from '../hooks/typing'

// chat-bubbles 0.5: hold a bubble to tapback, Reply and Copy, Claude's own
// tapback, Read, and the animations that go with them.

const FULLSCREEN = { columns: 100, rows: 40, isFullscreen: true }
const START = Date.UTC(2026, 10, 20, 8, 0)

const PROMPT = {
  plugin: 'chat-bubbles',
  component: 'UserMessage',
  viewport: FULLSCREEN,
  props: { text: 'hello there', origin: { kind: 'composer' }, isExpanded: false },
} as const

const REPLY = {
  plugin: 'chat-bubbles',
  component: 'AssistantMessage',
  viewport: FULLSCREEN,
  props: { text: 'The page is live. Want me to post it on X too?', isFirstOfReply: true },
} as const

const BAND = {
  plugin: 'chat-bubbles',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 75,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

// The engine beneath: a plain row for anything the mod passes on, a store,
// and the person's prompts stamped p1 (and p2 when asked).
function engine(on: On, ids: string[] = ['p1'], seeded: Record<string, unknown> = {}, store: Record<string, unknown> = {}) {
  mock.store(on, store)
  const clock = mock.clock(on, { now: START })
  on('command.register', () => ({ value: { command: 'bubbles' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__chat-bubbles__react' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('state.get', (_, e, next) => {
    if (e.plugin === 'chat-bubbles' && e.key === 'prompts') {
      return { value: { value: { shape: 'prompts-1', value: ids.map((uuid, i) => ({ uuid, at: START + i })) }, version: 1 } }
    }
    if (e.plugin === 'chat-bubbles' && seeded[e.key] !== undefined) return { value: { value: seeded[e.key], version: 1 } }

    return next(e)
  })

  return clock
}

type Holdable = {
  pointer(e: { type: 'down'; x: number; y: number; button: 'left'; in: string }): Promise<void>
  advance(ms: number): Promise<void>
}
const hold = async (ui: Holdable, id: string) => {
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: `hold:${id}` })
  await ui.advance(500)
}

// ---- pure parts -------------------------------------------------------------

test('a release on the row above the bubble lands on the tapback under it', () => {
  // Claude's bubble: the bar starts at its left edge.
  const received = barPlace({ side: 'received', width: 30 })
  expect(barHit(received, 1, -1)?.key).toBe('love')
  expect(barHit(received, 1 + ITEM_CELLS, -1)?.key).toBe('like')
  expect(barHit(received, 1 + 5 * ITEM_CELLS, -1)?.key).toBe('question')
  expect(barHit(received, 0, -1)).toBeUndefined() // the bar's padding
  expect(barHit(received, 3, 0)).toBeUndefined() // on the bubble itself
  // The person's narrow bubble: the bar ends at its right edge and sticks out left.
  const sent = barPlace({ side: 'sent', width: 15 })
  expect(sent.barLeft).toBe(15 - BAR_CELLS)
  expect(barHit(sent, 15 - BAR_CELLS + 1, -1)?.key).toBe('love')
})

test('Claude may react with one emoji or a tapback glyph, never words', () => {
  for (const ok of ['👀', '👍', '🎉', 'HA', '!!', '?', '♥']) expect(isReaction(ok)).toBe(true)
  for (const no of ['', 'yes', 'hello world', '👍 👍', 'a'.repeat(9), 3]) expect(isReaction(no)).toBe(false)
})

test('what Claude reads: each tapback on its replies, and the message a reply quotes', () => {
  const lines = contextLines([{ id: 'r1', word: 'liked', snippet: 'Want me to post it?' }], {
    id: 'r1',
    who: 'Claude',
    snippet: 'Want me to post it?',
  })
  expect(lines[0]).toContain('The user liked one of your earlier messages')
  expect(lines[0]).toContain('"Want me to post it?"')
  expect(lines[1]).toContain('threaded reply')
  expect(lines[1]).toContain('earlier message from you')
  expect(snippetOf('**Done.** See `x`\n\n```js\nlet a\n```', 80)).toBe('Done. See x [code]')
  expect(snippetOf('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`)
})

test('the typing dots pulse on a smooth curve, exact on the 300 ms marks', () => {
  expect(glow(0, 0)).toBe(1)
  expect(glow(0, 300)).toBe(0)
  expect(glow(1, 300)).toBe(1)
  const between = glow(0, 150)
  expect(between > 0.2 && between < 0.8).toBe(true)
  // Rising before its peak, falling after: no jumps.
  expect(glow(1, 240) > glow(1, 210)).toBe(true)
  expect(glow(1, 330) < glow(1, 300)).toBe(true)
  expect(glow(2, 1000)).toBe(0) // the rest at the end of the cycle
})

// ---- the hold ---------------------------------------------------------------

test('in full screen a bubble is drawn whole by the hold module; on the main screen it is not', async ($, on) => {
  engine(on)
  const full = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  expect((await full.find({ type: 'Client', key: 'hold:p1' }))?.props.module).toMatch(/hold\.tsx$/)
  expect((await full.find({ key: 'bubble-user', in: 'hold:p1' }))?.props.backgroundColor).toBe('#0073EB')
  await full.unmount()

  const main = await $.ui.mount({ ...PROMPT, requestId: 'p1', viewport: { columns: 100, rows: 40 }, surface: 'terminal' })
  expect(await main.find({ type: 'Client', key: 'hold:p1' })).toBeUndefined()
  await main.unmount()
})

test('holding shades the bubble smoothly, then opens the tapback bar and Reply and Copy', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  const fill = async () => (await ui.find({ key: 'bubble-assistant', in: 'hold:r1' }))?.props.backgroundColor

  expect(await fill()).toBe('userMessageBackground') // the fallback theme
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'hold:r1' })
  await ui.advance(200)
  expect(await ui.find({ type: 'Client', key: 'bar:r1' })).toBeUndefined() // not yet
  await ui.advance(300)
  expect((await ui.find({ type: 'Client', key: 'bar:r1' }))?.props.module).toMatch(/bar\.tsx$/)
  expect(await ui.find({ key: 'reply:r1' })).toBeDefined()
  expect(await ui.find({ key: 'copy:r1' })).toBeDefined()
  await ui.unmount()
})

test('a dark theme shade moves in small steps toward the pressed fill', async ($, on) => {
  engine(on)
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  const fill = async () => (await ui.find({ key: 'bubble-user', in: 'hold:p1' }))?.props.backgroundColor as string

  expect(await fill()).toBe('#0073EB')
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'hold:p1' })
  const seen: string[] = []
  for (let i = 0; i < 8; i += 1) {
    await ui.advance(48)
    seen.push(await fill())
  }
  // At least five different shades on the way: an ease, not a jump.
  expect(new Set(seen).size >= 5).toBe(true)
  expect(seen.every(c => c !== '#0073EB')).toBe(true)
  await ui.unmount()
})

test('the bar unfurls, then its tapbacks pop in one after another', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  const glyphs = async () => (await ui.findAll({ type: 'Text', in: 'bar:r1' })).map(t => t.text)

  // Fresh bar: nothing in it yet.
  const counts: number[] = []
  for (let i = 0; i < 16; i += 1) {
    counts.push((await glyphs()).length)
    await ui.advance(22)
  }
  expect(counts[0]).toBe(0)
  expect(counts[counts.length - 1]).toBe(TAPBACKS.length)
  // One at a time: the count climbs through the middle values.
  expect(new Set(counts).size >= 4).toBe(true)
  await ui.unmount()
})

test('slide from the hold onto a tapback and let go: it lands as a badge and the bar goes', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  // `like` is the second tapback: one cell of padding plus one slot in.
  await ui.pointer({ type: 'up', x: 1 + ITEM_CELLS, y: -1, button: 'left', in: 'hold:r1' })
  await clock.advance(300)
  await ui.advance(50)
  expect(await ui.find({ type: 'Client', key: 'bar:r1' })).toBeUndefined()
  const badge = await ui.find({ type: 'Client', key: 'badge-you:r1:👍' })
  expect(badge?.props.module).toMatch(/badge\.tsx$/)
  await ui.unmount()
})

test('a click on a tapback in the bar picks it; picking it again takes it off', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hold:r1' }) // let go on the bubble
  await ui.advance(300)
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'bar:r1' }) // the heart
  await clock.advance(300)
  await ui.advance(30)
  expect(await ui.find({ type: 'Client', key: 'badge-you:r1:♥' })).toBeDefined()

  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hold:r1' })
  await ui.advance(300)
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'bar:r1' })
  await clock.advance(300)
  await ui.advance(30)
  expect(await ui.find({ type: 'Client', key: 'badge-you:r1:♥' })).toBeUndefined()
  await ui.unmount()
})

test('a badge pops: it swells past its size and settles', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 1, y: -1, button: 'left', in: 'hold:r1' })
  await clock.advance(270)
  const key = 'badge-you:r1:♥'
  const pads: unknown[] = []
  for (let i = 0; i < 9; i += 1) {
    const box = (await ui.findAll({ type: 'Box', in: key })).find(b => b.props.paddingX !== undefined)
    pads.push(box?.props.paddingX)
    await ui.advance(24)
  }
  expect(pads).toContain(2)
  expect(pads[pads.length - 1]).toBe(1)
  await ui.unmount()
})

test('a quick tap on any bubble closes an open bar; so does waiting 15 s', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hold:r1' })
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'hold:r1' })
  await ui.pointer({ type: 'up', x: 3, y: 1, button: 'left', in: 'hold:r1' })
  await ui.advance(50)
  expect(await ui.find({ type: 'Client', key: 'bar:r1' })).toBeUndefined()

  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hold:r1' })
  expect(await ui.find({ type: 'Client', key: 'bar:r1' })).toBeDefined()
  await clock.advance(15_100)
  await ui.advance(30)
  expect(await ui.find({ type: 'Client', key: 'bar:r1' })).toBeUndefined()
  await ui.unmount()
})

// ---- telling Claude, threads, Claude's tapback ----------------------------

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' } } as Parameters<Engine['prompt']['submit']>[0])

test('a tapback on Claude\'s reply goes to Claude with the next message, once', async ($, on) => {
  engine(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    contexts.push(e.context)

    return { text: e.text, context: e.context ?? [] }
  })
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 1 + ITEM_CELLS, y: -1, button: 'left', in: 'hold:r1' })
  await ui.advance(400)
  await ui.unmount()

  await submit($, 'ok go')
  await submit($, 'and then?')
  expect(contexts[0]?.join('\n')).toContain('The user liked one of your earlier messages')
  expect(contexts[0]?.join('\n')).toContain('Want me to post it on X too?')
  expect(contexts[1]).toBeUndefined()
})

test('Reply: a "Replying to" row over the prompt, the quote goes to Claude, ✕ cancels', async ($, on) => {
  engine(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    contexts.push(e.context)

    return { text: e.text, context: e.context ?? [] }
  })
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'hold:r1' })
  await ui.press({ key: 'reply:r1' })
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /Replying to Claude/ }))?.text).toContain('Replying to Claude')
  await band.unmount()

  await submit($, 'yes, but tweak the headline first')
  expect(contexts[0]?.join('\n')).toContain('threaded reply')
  expect(contexts[0]?.join('\n')).toContain('Want me to post it on X too?')

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Replying to/ })).toBeUndefined()
  await after.unmount()
})

test('a reply shows a faded copy of the original joined by a line, and "1 Reply" under the original', async ($, on) => {
  engine(on, ['p1', 'p2'], { replies: { p2: { id: 'r1', who: 'Claude', snippet: 'The page is live.' } } })
  const reply = await $.ui.mount({ ...PROMPT, requestId: 'p2', surface: 'terminal' })
  // The faded copy of Claude's message, then the line turning into the reply.
  const quote = await reply.find({ key: 'quote:r1' })
  expect(quote).toBeDefined()
  expect((await reply.find({ type: 'Text', text: /^The page is live\.$/ }))?.props.color).toBe('#8E8E93')
  expect((await reply.find({ type: 'Text', text: /^  ├$/ }))?.text).toBe('  ├')
  expect(await reply.find({ key: 'thread-row' })).toBeDefined()
  await reply.unmount()

  const original = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  expect((await original.find({ type: 'Text', text: /Repl/ }))?.text).toBe('1 Reply')
  await original.unmount()
})

test('Claude\'s react tool puts its emoji on the newest message and marks it Read', async ($, on) => {
  engine(on, ['p1', 'p2'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__chat-bubbles__react', emoji: '👀' } as Parameters<Engine['tool']['call']>[0])
  expect(String((ran as { result?: unknown; text?: unknown }).result ?? (ran as { text?: unknown }).text)).toContain('Reacted 👀')

  const newest = await $.ui.mount({ ...PROMPT, requestId: 'p2', surface: 'terminal' })
  expect(await newest.find({ type: 'Client', key: 'badge-claude:p2:👀' })).toBeDefined()
  expect((await newest.find({ type: 'Client', key: 'read' }))?.props.props).toMatchObject({ word: expect.stringMatching(/^Read /) })
  await newest.unmount()

  const words = await $.tool.call({ tool: 'mcp__chat-bubbles__react', emoji: 'on it' } as Parameters<Engine['tool']['call']>[0])
  expect(String((words as { deny?: unknown; text?: unknown }).deny ?? (words as { text?: unknown }).text)).toContain('one emoji')
})

test('subagents are never offered the react tool; the main conversation is', async ($, on) => {
  engine(on)
  on('tool.offer', () => ({ isOffered: true }))
  const offer = (agentId?: string) =>
    $.tool.offer({
      tool: 'mcp__chat-bubbles__react',
      provider: { plugin: 'chat-bubbles', tier: 'user' as const },
      isOffered: true,
      ...(agentId === undefined ? {} : { agentId }),
    } as Parameters<Engine['tool']['offer']>[0])
  expect((await offer())?.isOffered).toBe(true)
  expect((await offer('agent-1'))?.isOffered).toBe(false)
})

test('a very long reply keeps the bubble drawn without the hold', async ($, on) => {
  engine(on)
  const long = 'word '.repeat(5_000)
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r9', surface: 'terminal', props: { ...REPLY.props, text: long } })
  expect(await ui.find({ type: 'Client', key: 'hold:r9' })).toBeUndefined()
  expect(await ui.find({ key: 'bubble-assistant' })).toBeDefined()
  await ui.unmount()
})

test('Claude\'s answer to a threaded reply hooks onto the thread line', async ($, on) => {
  engine(on, ['p1', 'p2'], { threaded: { a1: 'p2' } })
  const answer = await $.ui.mount({ ...REPLY, requestId: 'a1', surface: 'terminal' })
  expect(await answer.find({ key: 'thread-answer' })).toBeDefined()
  expect((await answer.find({ type: 'Text', text: /^  ╰─$/ }))?.text).toBe('  ╰─')
  expect(await answer.find({ type: 'Client', key: 'hold:a1' })).toBeDefined()
  await answer.unmount()

  const other = await $.ui.mount({ ...REPLY, requestId: 'a2', surface: 'terminal' })
  expect(await other.find({ key: 'thread-answer' })).toBeUndefined()
  await other.unmount()
})

test('a round badge is a small round bubble: pad rows above and below the glyph', async ($, on) => {
  const clock = engine(on, ['p1'], {}, { style: 'round' })
  const ui = await $.ui.mount({ ...REPLY, requestId: 'r1', surface: 'terminal' })
  await hold(ui, 'r1')
  await ui.pointer({ type: 'up', x: 1 + ITEM_CELLS, y: -1, button: 'left', in: 'hold:r1' })
  await clock.advance(300)
  await ui.advance(200)
  const key = 'badge-you:r1:👍'
  const texts = (await ui.findAll({ type: 'Text', in: key })).map(t => t.text)
  const g = (...points: number[]) => String.fromCodePoint(...points)
  expect(texts[0]?.startsWith(g(0xe0b0, 0xe0b1))).toBe(true)
  expect(texts).toContain('👍')
  expect(texts[texts.length - 1]?.startsWith(g(0xe0b8, 0xe0b9))).toBe(true)
  await ui.unmount()
})

test('a long think gets 🤔 after 4 s when Claude has not reacted; Claude\'s own reaction is kept', async ($, on) => {
  const clock = engine(on, ['p1'])
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  await submit($, 'think hard about this')
  await clock.advance(3_900)
  const early = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  expect(await early.find({ type: 'Client', key: 'badge-claude:p1:🤔' })).toBeUndefined()
  await early.unmount()
  await clock.advance(200)
  const late = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  expect(await late.find({ type: 'Client', key: 'badge-claude:p1:🤔' })).toBeDefined()
  await late.unmount()
})

test('no 🤔 when Claude reacted first', async ($, on) => {
  const clock = engine(on, ['p1'])
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await submit($, 'look at the logs')
  await $.tool.call({ tool: 'mcp__chat-bubbles__react', emoji: '🔍' } as Parameters<Engine['tool']['call']>[0])
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  expect(await ui.find({ type: 'Client', key: 'badge-claude:p1:🔍' })).toBeDefined()
  expect(await ui.find({ type: 'Client', key: 'badge-claude:p1:🤔' })).toBeUndefined()
  await ui.unmount()
})

test('Claude\'s reaction carries a few words on what it is doing, shown when the pointer rests on its badge', async ($, on) => {
  engine(on, ['p1'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__chat-bubbles__react', emoji: '🔍', status: 'reading register.tsx' } as Parameters<Engine['tool']['call']>[0])
  expect(String((ran as { result?: unknown; text?: unknown }).result ?? (ran as { text?: unknown }).text)).toContain('reading register.tsx')
  const ui = await $.ui.mount({ ...PROMPT, requestId: 'p1', surface: 'terminal' })
  const key = 'badge-claude:p1:🔍'
  const said = async () => (await ui.find({ type: 'Text', text: /register/, in: key }))?.text
  // Hidden until the pointer rests on the badge, then slid out in full.
  expect(await said()).toBeUndefined()
  await ui.pointer({ type: 'enter', x: 1, y: 1, in: key })
  await ui.advance(200)
  expect(await said()).toBe('reading register.tsx ')
  // It slides back when the pointer leaves.
  await ui.pointer({ type: 'leave', x: 1, y: 1, in: key })
  await ui.advance(200)
  expect(await said()).toBeUndefined()
  await ui.unmount()
})

test('the status words are one clean line, cut at 48 characters', () => {
  expect(statusOf('  reading the tests  ')).toBe('reading the tests')
  expect(statusOf('first line\nsecond')).toBe('first line')
  expect(statusOf('')).toBeUndefined()
  expect(statusOf(7)).toBeUndefined()
  expect(statusOf('x'.repeat(60))?.length).toBe(48)
})
