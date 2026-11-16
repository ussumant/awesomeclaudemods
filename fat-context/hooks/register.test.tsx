import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'

import { bellyRows, fatten, giant } from './register'

const TOOL = 'mcp__fat-context__weigh'

type Seen = { toasts: string[]; status: (string | undefined)[]; words: string[]; texts: string[] }

// Nothing sits beneath the plugin: each hook here stands for the engine.
const engine = (on: On, seen: Seen, startPercent?: number) => {
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)

    return { value: undefined }
  })
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'fat' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, ...(startPercent === undefined ? {} : { percent: startPercent }) }, rateLimits: [] },
  }))
  // The engine's own drawing of any component: one Text saying so. It records the
  // spinner's word and a message's text as it was handed down.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    if (e.component === 'Spinner') seen.words.push(e.props.word)
    if (e.component === 'AssistantMessage' || e.component === 'UserMessage') seen.texts.push(e.props.text)

    return <Text>engine</Text>
  })
}

const fresh = (): Seen => ({ toasts: [], status: [], words: [], texts: [] })
const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const measure = ($: Engine, percent: number) =>
  $.session.measure({ context: { window: 200000, percent }, rateLimits: [], changed: ['context'] })
const fat = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'fat', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''
const weigh = async ($: Engine, input: Record<string, unknown>) => {
  const ran = await $.tool.call({ tool: TOOL, ...input })

  return String(ran.deny ?? ran.result ?? ran.text ?? '')
}

const VIEW = { columns: 100, rows: 40 }
const SAMPLE = 'Hello there, friend.\n\n```bash\necho hi\nls -la\n```\n\nSee `npm test` and /tmp/a/b.txt or https://x.io now.'
const ASSISTANT = { plugin: 'fat-context', component: 'AssistantMessage', requestId: 'm1', viewport: VIEW, props: { text: SAMPLE, isFirstOfReply: true } } as const
const USER = {
  plugin: 'fat-context',
  component: 'UserMessage',
  requestId: 'u1',
  viewport: VIEW,
  props: { text: 'say hi now', origin: { kind: 'composer' }, isExpanded: false },
} as const
const TOOL_ROW = {
  plugin: 'fat-context',
  component: 'ToolUse',
  requestId: 't1',
  viewport: VIEW,
  props: { tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, isRunning: true, isErrored: false, isInterrupted: false },
} as const
const SPINNER = { plugin: 'fat-context', component: 'Spinner', requestId: 'main', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' } } as const
const BAND = {
  plugin: 'fat-context',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 155, scroll: { offset: 0, bodyRows: 39 }, view: {} },
} as const

/** The solid slabs of a frame: every Box with a background. */
const slabs = async (ui: { findAll: (q: { type: string }) => Promise<FoundElement[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(box => box.props.backgroundColor !== undefined).map(box => box.props)

/** The band's own rows, less the kit's stand-in row for the test ('engine'). */
const bandTexts = async (ui: { findAll: (q: { type: string }) => Promise<FoundElement[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t !== 'engine')

test('class boundaries: 29/30, 49/50, 69/70, 84/85', async ($, on) => {
  engine(on, fresh())
  await start($)

  const cases: [number, string][] = [
    [29, 'lean'], [30, 'filling out'], [49, 'filling out'], [50, 'chubby'],
    [69, 'chubby'], [70, 'stuffed'], [84, 'stuffed'], [85, 'about to pop'],
  ]

  for (const [percent, name] of cases) {
    await fat($, String(percent))
    expect(await weigh($, { action: 'read' })).toBe(`${percent}% · ${name} (preview) · look: all`)
  }
})

test('at 10% the message hooks hand back the engine element untouched', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)
  await measure($, 10)

  for (const target of [ASSISTANT, USER] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    expect(await ui.drawn()).toMatchObject({ type: 'Text' })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()
    await ui.unmount()
  }
  expect(seen.texts).toEqual([SAMPLE, 'say hi now'])
})

test('frame thickness grows per class: left bar, ring of 2, ring of 4, quarter-width slabs', async ($, on) => {
  engine(on, fresh())
  await start($)

  await fat($, '40')
  let ui = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
  expect(await slabs(ui)).toEqual([expect.objectContaining({ width: 1, backgroundColor: 'inactive' })])
  await ui.unmount()

  await fat($, '60')
  ui = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
  expect(await slabs(ui)).toEqual([
    expect.objectContaining({ height: 1, backgroundColor: 'claude' }),
    expect.objectContaining({ width: 2 }),
    expect.objectContaining({ width: 2 }),
    expect.objectContaining({ height: 1 }),
  ])
  await ui.unmount()

  await fat($, '75')
  ui = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
  expect((await slabs(ui)).map(p => [p.width, p.height, p.backgroundColor])).toEqual([
    [undefined, 1, 'warning'], [4, undefined, 'warning'], [4, undefined, 'warning'], [undefined, 1, 'warning'],
  ])
  await ui.unmount()

  // About to pop at 100 columns: 25 a side (a quarter), caps of 2 rows, "92% FULL" cut into the top.
  await fat($, '92')
  ui = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
  expect((await slabs(ui)).map(p => [p.width, p.height, p.backgroundColor])).toEqual([
    [undefined, 2, 'error'], [25, undefined, 'error'], [25, undefined, 'error'], [undefined, 2, 'error'],
  ])
  expect((await ui.find({ type: 'Text', text: /FULL/ }))?.props).toMatchObject({ inverse: true })
  expect((await ui.find({ type: 'Text', text: /FULL/ }))?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /FULL/ }))?.text).toBe(' 92% FULL ')
  await ui.unmount()

  // Narrow: never under 30 columns of words (60 cols: 14 a side, 60-28-2 = 30).
  ui = await $.ui.mount({ ...ASSISTANT, viewport: { columns: 60, rows: 40 }, surface: 'terminal' })
  expect((await slabs(ui)).map(p => p.width).filter(n => n !== undefined)).toEqual([14, 14])
  await ui.unmount()
})

test('message frames leave every other surface alone', async ($, on) => {
  engine(on, fresh())
  await start($)
  await fat($, '92')

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...ASSISTANT, surface })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()
    await ui.unmount()
  }
})

test('fat letters: user from stuffed, assistant at about to pop, draw-only text handed to the engine', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)

  await fat($, '60')
  await (await $.ui.mount({ ...USER, surface: 'terminal' })).unmount()
  expect(seen.texts.at(-1)).toBe('say hi now')

  await fat($, '75')
  await (await $.ui.mount({ ...USER, surface: 'terminal' })).unmount()
  expect(seen.texts.at(-1)).toBe('ｓａｙ ｈｉ ｎｏｗ')
  await (await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })).unmount()
  expect(seen.texts.at(-1)).toBe(SAMPLE)

  await fat($, '92')
  await (await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })).unmount()
  expect(seen.texts.at(-1)).toBe(fatten(SAMPLE))
  expect(seen.texts.at(-1)).toContain('Ｈｅｌｌｏ ｔｈｅｒｅ, ｆｒｉｅｎｄ.')
})

test('the letters transform leaves code, paths, URLs and markup alone', () => {
  expect(fatten('```bash\necho hi\nls -la\n```')).toBe('```bash\necho hi\nls -la\n```')
  expect(fatten('~~~\nplain words\n~~~')).toBe('~~~\nplain words\n~~~')
  expect(fatten('Run `npm test` now')).toBe('Ｒｕｎ `npm test` ｎｏｗ')
  expect(fatten('the path /tmp/a/b.txt')).toBe('ｔｈｅ ｐａｔｈ /tmp/a/b.txt')
  expect(fatten('see https://x.io/a ok')).toBe('ｓｅｅ https://x.io/a ｏｋ')
  expect(fatten('C:\\dir and a_b and me@x.io')).toBe('C:\\dir ａｎｄ a_b ａｎｄ me@x.io')
  expect(fatten('e.g. v1.2 done.')).toBe('e.g. v1.2 ｄｏｎｅ.')
  expect(fatten('    indented code')).toBe('    indented code')
  expect(fatten('| a | b |')).toBe('| a | b |')
  expect(fatten('/fat 92')).toBe('/fat 92')
  expect(fatten('**bold** and [link](u)')).toBe('**bold** ａｎｄ [link](u)')
  expect(fatten('# Title')).toBe('# Ｔｉｔｌｅ')
  expect(fatten('1. first, 22 left!')).toBe('1. ｆｉｒｓｔ, ２２ ｌｅｆｔ!')
  expect(fatten('- item')).toBe('- ｉｔｅｍ')
})

test('each single look draws only itself', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)
  await fat($, '92')

  const draw = async () => {
    const msg = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
    const hasFrame = (await slabs(msg)).length > 0
    await msg.unmount()
    const hasLetters = seen.texts.at(-1) !== SAMPLE
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const hasBelly = (await bandTexts(band)).some(t => t.includes('█'))
    await band.unmount()

    return { hasFrame, hasLetters, hasBelly }
  }

  expect(await draw()).toEqual({ hasFrame: true, hasLetters: true, hasBelly: true })
  expect(await fat($, 'look frames')).toContain('Look set to frames')
  expect(await draw()).toEqual({ hasFrame: true, hasLetters: false, hasBelly: false })
  await fat($, 'look belly')
  expect(await draw()).toEqual({ hasFrame: false, hasLetters: false, hasBelly: true })
  await fat($, 'look letters')
  expect(await draw()).toEqual({ hasFrame: false, hasLetters: true, hasBelly: false })
  expect(await fat($, '')).toContain('Look: letters.')
  expect(await fat($, 'look huge')).toContain('Pick one')
  await fat($, 'look all')
  expect(await draw()).toEqual({ hasFrame: true, hasLetters: true, hasBelly: true })
})

test('/fat 85 sets the preview and /fat real clears it', async ($, on) => {
  engine(on, fresh())
  await start($)
  await measure($, 12)

  expect(await fat($, '85')).toContain('Previewing 85% · about to pop')
  expect(await weigh($, { action: 'read' })).toBe('85% · about to pop (preview) · look: all')
  expect(await fat($, '')).toContain('real reading 12%')

  expect(await fat($, 'real')).toContain('Preview dropped')
  expect(await weigh($, { action: 'read' })).toBe('12% · lean (real) · look: all')

  expect(await fat($, 'banana')).toStartWith('Usage: /fat')
  expect(await fat($, '101')).toStartWith('Usage: /fat')
})

test('the weigh tool previews, sets a look, and goes back to real', async ($, on) => {
  engine(on, fresh())
  await start($)
  await measure($, 40)

  expect(await weigh($, { action: 'preview', percent: 90, look: 'frames' })).toBe('Now drawing 90% · about to pop (preview) · look: frames.')
  expect(await weigh($, { action: 'look', look: 'belly' })).toBe('Now drawing 90% · about to pop (preview) · look: belly.')
  expect(await weigh($, { action: 'preview', look: 'letters' })).toBe('Now drawing 90% · about to pop (preview) · look: letters.')
  expect(await weigh($, { action: 'preview' })).toBe('Now drawing 40% · filling out (real) · look: letters.')
  expect(await weigh($, { action: 'preview', percent: 'lots' })).toContain('percent must be')
  expect(await weigh($, { action: 'read', look: 'huge' })).toContain('look must be')
})

test('/fat off makes every hook pass through, /fat on brings them back', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)
  await fat($, '95')
  await fat($, 'off')
  expect(seen.status.at(-1)).toBeUndefined()

  for (const target of [ASSISTANT, USER, TOOL_ROW, SPINNER, BAND] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    expect(await ui.drawn()).toMatchObject({ type: 'Text' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }

  await fat($, 'on')
  const ui = await $.ui.mount({ ...ASSISTANT, surface: 'terminal' })
  expect((await slabs(ui)).length).toBe(4)
  await ui.unmount()
})

test('weigh-in toasts: none on first load, one going up, the slim one going 90 -> 20', async ($, on) => {
  const seen = fresh()
  engine(on, seen, 90)
  await start($)
  expect(seen.toasts).toEqual([])
  expect(seen.status.at(-1)).toBe('about to pop · 90%')

  await measure($, 92)
  expect(seen.toasts).toEqual([])

  await measure($, 20)
  expect(seen.toasts).toEqual(['Dropped to 20%. Feeling light.'])
  expect(seen.status.at(-1)).toBeUndefined()

  await measure($, 72)
  expect(seen.toasts.at(-1)).toBe('Context hit 72%. Getting stuffed.')
})

test('the first real reading of a fresh session toasts nothing', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)
  await measure($, 55)
  expect(seen.toasts).toEqual([])
  expect(seen.status.at(-1)).toBe('chubby · 55%')
})

const OLD_VALUES: [string, unknown, string][] = [
  ['a bare string', 'lots', '0% · lean (real) · look: all'],
  ['an untagged object', { real: 'x', lastClass: 9 }, '0% · lean (real) · look: all'],
  ['round one (fat-1) carried over', { shape: 'fat-1', value: { real: 40, preview: 75, isOff: false, lastClass: 1 } }, '75% · stuffed (preview) · look: all'],
  ['round one (fat-1) of wrong types', { shape: 'fat-1', value: { real: 'x', preview: [], isOff: 'yes', lastClass: 9 } }, '0% · lean (real) · look: all'],
  ['fat-2 with a look nobody knows', { shape: 'fat-2', value: { real: 12, look: 'huge' } }, '12% · lean (real) · look: all'],
  ['an unknown shape', { shape: 'fat-9', value: { real: 50 } }, '0% · lean (real) · look: all'],
]

for (const [name, stored, reads] of OLD_VALUES) {
  test(`an old or empty $.state (${name}) does not throw`, async ($, on) => {
    on('state.get', () => ({ value: { value: stored, version: 1 } }))
    engine(on, fresh())

    await start($)
    expect(await weigh($, { action: 'read' })).toBe(reads)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await bandTexts(ui)).length).toBeGreaterThan(0)
    await ui.unmount()
  })
}

test('the belly is solid and grows per class; giant digits from stuffed up', async ($, on) => {
  engine(on, fresh())
  await start($)

  const sizes: [number, number, number][] = [[10, 6, 2], [40, 10, 3], [60, 22, 5], [75, 40, 9], [93, 60, 14]]
  for (const [percent, width, height] of sizes) {
    await fat($, String(percent))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = await bandTexts(ui)
    // Body rows hold blocks; leave out the giant digit lines.
    const digitLines = new Set(giant(`${percent}%`))
    const body = texts.filter(t => /[▀▄█]/.test(t) && !digitLines.has(t))
    expect(body.length).toBe(height)
    expect(new Set(body.map(row => [...row].length))).toEqual(new Set([width]))
    // Mostly solid: at least 60% of the body's cells are fill or face.
    const filled = body.join('').replace(/ /g, '').length
    expect(filled / (width * height)).toBeGreaterThan(0.6)

    if (percent >= 75) {
      const digits = giant(`${percent}%`)
      for (const line of digits) expect(texts).toContain(line)
    } else {
      expect(texts.some(t => t.includes(`· ${percent}%`))).toBe(true)
    }
    if (percent === 93) {
      expect(texts).toContain('ＡＢＯＵＴ ＴＯ ＰＯＰ (preview)')
      expect(texts).toContain('/compact to slim down')
    }
    await ui.unmount()
  }

  // The face is cut into the body as inverse text.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const faces = (await ui.findAll({ type: 'Text' })).filter(t => t.props.inverse === true).map(t => t.text)
  expect(faces).toEqual(['××', '××', '________', '()'])
  await ui.unmount()

  // 70 columns: the digits go above the creature, which still fits (60 wide).
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 70 }, surface: 'terminal' })
  const rows = await bandTexts(narrow)
  expect(rows[0]).toBe(giant('93%')[0])
  expect(Math.max(...rows.map(r => [...r].length))).toBeLessThanOrEqual(70)
  await narrow.unmount()

  // 30 columns: the creature shrinks to the width.
  const tiny = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 30 }, surface: 'terminal' })
  expect(Math.max(...(await bandTexts(tiny)).filter(t => /[▀▄█]/.test(t)).map(r => [...r].length))).toBeLessThanOrEqual(30)
  await tiny.unmount()
})

test('belly rows line up and stay symmetric', () => {
  for (const [cls, w, h] of [[0, 6, 2], [1, 10, 3], [2, 22, 5], [3, 40, 9], [4, 60, 14]] as const) {
    const rows = bellyRows(cls, w, h).map(runs => runs.map(([text]) => text).join(''))
    expect(rows).toHaveLength(h)
    for (const row of rows) {
      expect([...row].length).toBe(w)
      const shape = row.replace(/[^ ▀▄█]/g, '█')
      expect(shape).toBe([...shape].reverse().join(''))
    }
  }
})

test('the spinner gets heavier verbs from chubby up, steady across redraws', async ($, on) => {
  const seen = fresh()
  engine(on, seen)
  await start($)

  await fat($, '20')
  let ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await ui.unmount()
  expect(seen.words.at(-1)).toBe('Sauteing')

  await fat($, '90')
  ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await ui.unmount()
  const first = seen.words.at(-1)
  expect(['Wheezing', "Can't reach the keyboard"]).toContain(first)
  ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  await ui.unmount()
  expect(seen.words.at(-1)).toBe(first)

  ui = await $.ui.mount({ ...SPINNER, props: { ...SPINNER.props, message: 'Compacting' }, surface: 'terminal' })
  await ui.unmount()
  expect(seen.words.at(-1)).toBe('Sauteing')
})

test('tool rows and folded groups put on weight only from stuffed up', async ($, on) => {
  engine(on, fresh())
  await start($)
  const GROUP = { plugin: 'fat-context', component: 'ToolGroup', requestId: 'g1', viewport: VIEW, props: { calls: [], isActive: false, isExpanded: false } } as const

  await fat($, '60')
  for (const target of [TOOL_ROW, GROUP] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()
    await ui.unmount()
  }

  await fat($, '75')
  for (const target of [TOOL_ROW, GROUP] as const) {
    const ui = await $.ui.mount({ ...target, surface: 'terminal' })
    expect((await slabs(ui)).map(p => p.backgroundColor)).toEqual(['warning', 'warning', 'warning', 'warning'])
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...GROUP, props: { ...GROUP.props, isExpanded: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Box' })).toBeUndefined()
  await ui.unmount()
})
