import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  BLOCK_GLYPHS,
  DEFAULT_COLOR,
  FONT_GLYPHS,
  fitSize,
  parseBmp,
  parseEnv,
  picturePaths,
  pixelKind,
  swapGlyphs,
  toCells,
  withoutImageMarks,
  withoutPaths,
} from '../hooks/picture'

// chat-bubbles 0.5: pictures as photo bubbles.

const FULLSCREEN = { columns: 100, rows: 40, isFullscreen: true }

// A BMP like the ones `sips` writes, in either row order: 32-bit BGRA.
function bmp(width: number, height: number, rgba: number[][], topDown = true): Uint8Array {
  const stride = width * 4
  const out = new Uint8Array(54 + stride * height)
  const view = new DataView(out.buffer)
  out[0] = 0x42
  out[1] = 0x4d
  view.setUint32(2, out.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, topDown ? -height : height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 32, true)
  view.setUint32(30, 0, true)
  for (let y = 0; y < height; y += 1) {
    const row = 54 + stride * (topDown ? y : height - 1 - y)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = rgba[y * width + x]!
      out.set([b!, g!, r!, a!], row + x * 4)
    }
  }

  return out
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const words = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]

test('a BMP reads back as RGBA, top row first, in either row order', () => {
  for (const topDown of [true, false]) {
    const px = parseBmp(bmp(2, 2, [RED, BLUE, BLUE, RED], topDown))
    expect(px?.width).toBe(2)
    expect([...(px?.rgba.slice(0, 8) ?? [])]).toEqual([...RED, ...BLUE])
  }
  expect(parseBmp(new Uint8Array([1, 2, 3]))).toBeUndefined()
})

test('cells: top pixel as the glyph colour, bottom as its ground; corners rounded by half a cell', () => {
  // 4 x 4: rows 0 and 2 red, rows 1 and 3 blue.
  const px = parseBmp(bmp(4, 4, Array.from({ length: 16 }, (_, i) => (Math.floor(i / 4) % 2 === 0 ? RED : BLUE))))!
  const { cols, rows, cells } = toCells(px, { glyphs: FONT_GLYPHS, matte: 0 })
  expect([cols, rows]).toEqual([4, 2])
  const w = words(cells)
  const cell = (r: number, c: number) => [...w.slice((r * cols + c) * 3, (r * cols + c) * 3 + 3)]
  expect(cell(0, 1)).toEqual([FONT_GLYPHS.upper, 0xff0000, 0x0000ff])
  // Top corners: the lower half only, on the terminal's own ground.
  expect(cell(0, 0)).toEqual([FONT_GLYPHS.lower, 0x0000ff, DEFAULT_COLOR])
  // Bottom corners: the upper half only.
  expect(cell(1, 3)).toEqual([FONT_GLYPHS.upper, 0xff0000, DEFAULT_COLOR])
  // Another style swaps the glyphs and keeps the colours.
  const swapped = words(swapGlyphs(cells, FONT_GLYPHS, BLOCK_GLYPHS))
  expect([swapped[3], swapped[4], swapped[5]]).toEqual([BLOCK_GLYPHS.upper, 0xff0000, 0x0000ff])
})

test('a picture fits the size asked, its shape kept', () => {
  expect(fitSize(1440, 900, 36, 14)).toEqual({ w: 36, h: 22 })
  expect(fitSize(400, 1200, 36, 14)).toEqual({ w: 9, h: 28 })
  expect(fitSize(10, 6, 36, 14)).toEqual({ w: 10, h: 6 })
  expect(withoutImageMarks('[Image #1] look at this')).toBe('look at this')
})

// The world beneath: sips answers a 4 x 4 picture, the thumbnail reads back
// as one, the round style is saved.
// `env`: what `/usr/bin/env` prints, so which terminal this is.
function engine(on: On, ids: string[] = ['p1'], seeded: Record<string, unknown> = {}, env = 'TERM_PROGRAM=vscode\n') {
  mock.store(on, { style: 'round' })
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 20, 9, 0) })
  on('command.register', () => ({ value: { command: 'bubbles' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__chat-bubbles__${(e as { name?: string }).name ?? ''}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('ui.invalidate', () => ({ value: undefined }))
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv.includes('-g') ? 'pixelWidth: 4\n  pixelHeight: 4\n' : e.argv[0] === '/usr/bin/env' ? env : e.argv[0] === 'stat' ? '20000\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stream: 'stdout' as const } }
  })
  const thumb = bmp(4, 4, Array.from({ length: 16 }, () => RED))
  // The BMP thumbnail, or a real 1 x 1 PNG for a preview.
  on('fs.read', (_, e) => ({ value: { base64: /\.png$/.test(String((e as { path?: unknown }).path)) ? PNG_1X1 : b64(thumb) } }))
  on('state.get', (_, e, next) => {
    if (e.plugin === 'chat-bubbles' && e.key === 'prompts') {
      return { value: { value: { shape: 'prompts-1', value: ids.map((uuid, i) => ({ uuid, at: i })) }, version: 1 } }
    }
    if (e.plugin === 'chat-bubbles' && seeded[e.key] !== undefined) return { value: { value: seeded[e.key], version: 1 } }

    return next(e)
  })

  return Object.assign(ran, { clock })
}

const TOOL_ROW = (id: string, tool: string, input: object) => ({
  plugin: 'chat-bubbles',
  component: 'ToolUse',
  viewport: FULLSCREEN,
  requestId: id,
  props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false },
}) as const

test('a picture Claude reads shows as a photo bubble on its side, with Open', async ($, on) => {
  const ran = engine(on)
  // The engine beneath answers the Read itself.
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/shot.png', tool_use_id: 't1' } as Parameters<Engine['tool']['call']>[0])
  expect(ran.some(argv => argv[0] === 'sips' && argv.includes('bmp'))).toBe(true)

  const ui = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([4, 2])
  expect((await ui.find({ type: 'Text', text: /looked at/ }))?.text).toBe('Claude looked at shot.png  ')
  await ui.press({ key: 'open:t1:0' })
  expect(ran.some(argv => argv[0] === 'open' && argv[1] === '/tmp/shot.png')).toBe(true)
  await ui.unmount()
})

test('send_image: Claude sends a picture with a caption; a relative or non-picture path is refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const sent = await $.tool.call({ tool: 'mcp__chat-bubbles__send_image', path: '/tmp/chart.png', caption: 'the new chart', tool_use_id: 't2' } as Parameters<Engine['tool']['call']>[0])
  expect(String((sent as { result?: unknown }).result ?? (sent as { text?: unknown }).text)).toContain('Sent chart.png')
  const ui = await $.ui.mount({ ...TOOL_ROW('t2', 'mcp__chat-bubbles__send_image', { path: '/tmp/chart.png' }), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /new chart/ }))?.text).toBe('the new chart  ')
  await ui.unmount()

  for (const path of ['chart.png', '/tmp/notes.txt']) {
    const no = await $.tool.call({ tool: 'mcp__chat-bubbles__send_image', path, tool_use_id: 't3' } as Parameters<Engine['tool']['call']>[0])
    expect(String((no as { deny?: unknown }).deny ?? (no as { text?: unknown }).text)).toContain('absolute path')
  }
})

test('a pasted picture sits above the person\'s words; its "[Image #1]" mark is gone', async ($, on) => {
  const pic = toCells(parseBmp(bmp(4, 4, Array.from({ length: 16 }, () => BLUE)))!, { glyphs: FONT_GLYPHS, matte: 0 })
  engine(on, ['p1'], { pictures: { p1: [{ file: '/tmp/paste.png', name: 'paste.png', ...pic, glyph: 'font' }] } })
  const ui = await $.ui.mount({
    plugin: 'chat-bubbles',
    component: 'UserMessage',
    viewport: FULLSCREEN,
    requestId: 'p1',
    surface: 'terminal',
    props: { text: '[Image #1] look at this', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /look at this/, in: 'hold:p1' }))?.text).toBe('look at this')
  expect(await ui.find({ type: 'Text', text: /\[Image/, in: 'hold:p1' })).toBeUndefined()
  await ui.unmount()
})

test('picture paths in a message are found, quoted or bare, and taken out of the words', () => {
  const text = "look '/Users/x/Desktop/Screenshot 2026-11-20 at 5.27.33 PM.png' and /tmp/a.jpg, not /tmp/notes.txt"
  const found = picturePaths(text)
  expect(found.map(f => f.path)).toEqual(['/Users/x/Desktop/Screenshot 2026-11-20 at 5.27.33 PM.png', '/tmp/a.jpg'])
  expect(found[0]!.written).toBe("'/Users/x/Desktop/Screenshot 2026-11-20 at 5.27.33 PM.png'")
  expect(withoutPaths(text, found.map(f => f.written))).toBe('look and, not /tmp/notes.txt')
})

// 0.5.7: real pixels where the terminal draws them.

test('which terminals draw real pixels: kitty, Ghostty, iTerm2 3.5+, not Cursor or tmux', () => {
  expect(pixelKind({ TERM: 'xterm-kitty' })).toBe('kitty')
  expect(pixelKind({ TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' })).toBe('kitty')
  expect(pixelKind({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.2' })).toBe('iterm')
  expect(pixelKind({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.23' })).toBeUndefined()
  expect(pixelKind({ LC_TERMINAL: 'iTerm2', LC_TERMINAL_VERSION: '3.6.0' })).toBe('iterm')
  expect(pixelKind({ TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' })).toBeUndefined()
  expect(pixelKind({ TERM_PROGRAM: 'Apple_Terminal' })).toBeUndefined()
  expect(pixelKind({ TERM: 'xterm-ghostty', TMUX: '/tmp/tmux-501/default,1,0' })).toBeUndefined()
  expect(pixelKind({ TERM_PROGRAM: 'vscode', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBe('kitty')
  expect(parseEnv('A=1\nB=x=y\n\nbad\n')).toEqual({ A: '1', B: 'x=y' })
})

const GHOSTTY = 'TERM=xterm-ghostty\nTERM_PROGRAM=ghostty\n'

test('in Ghostty a picture Claude reads is real pixels: an Image the same size as the cells', async ($, on) => {
  const ran = engine(on, ['p1'], {}, GHOSTTY)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/shot.png', tool_use_id: 't1' } as Parameters<Engine['tool']['call']>[0])
  // A PNG preview is made beside the cells, its longest side 1000 px.
  expect(ran.some(argv => argv[0] === 'sips' && argv.includes('png') && argv.includes('1000'))).toBe(true)

  const ui = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect([image?.props.columns, image?.props.rows]).toEqual([4, 2])
  expect(typeof (image?.props.source as { png?: unknown } | undefined)?.png).toBe('string')
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('in Cursor (or any terminal without pixels) the same picture is cells', async ($, on) => {
  engine(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/shot.png', tool_use_id: 't1' } as Parameters<Engine['tool']['call']>[0])
  const ui = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

test('iTerm2 draws pixels only in full screen; off it, cells', async ($, on) => {
  engine(on, ['p1'], {}, 'TERM_PROGRAM=iTerm.app\nTERM_PROGRAM_VERSION=3.5.4\n')
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/shot.png', tool_use_id: 't1' } as Parameters<Engine['tool']['call']>[0])
  const full = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  expect(await full.find({ type: 'Image' })).toBeDefined()
  await full.unmount()
  const scrolling = await $.ui.mount({
    ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }),
    viewport: { columns: 100, rows: 40, isFullscreen: false },
    surface: 'terminal',
  })
  expect(await scrolling.find({ type: 'Raster' })).toBeDefined()
  await scrolling.unmount()
})

test('a wrong guess is put right: when the engine says the Image shows its alt, photos go back to cells', async ($, on) => {
  const ran = engine(on, ['p1'], {}, GHOSTTY)
  const blits: unknown[] = []
  on('ui.blit', (_, e) => {
    blits.push(e)

    return { value: { deny: 'the Image draws its alt here: the terminal draws neither kitty placeholder images (no) nor iTerm2 inline images (no)' } }
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/shot.png', tool_use_id: 't1' } as Parameters<Engine['tool']['call']>[0])
  const first = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  expect(await first.find({ type: 'Image' })).toBeDefined()
  await ran.clock.advance(500)
  expect(blits.length).toBe(1)
  await first.unmount()
  const after = await $.ui.mount({ ...TOOL_ROW('t1', 'Read', { file_path: '/tmp/shot.png' }), surface: 'terminal' })
  expect(await after.find({ type: 'Raster' })).toBeDefined()
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  await after.unmount()
})
