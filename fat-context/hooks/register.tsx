import { update } from 'claude-code'
import type { Elements, EngineInterface, RenderElement, RenderNode, Register, ThemeKey } from 'claude-code'

import type { FatContextLook, FatContextState } from '../types'

// The session puts on weight as its context window fills. One number drives
// everything: the context percent the engine pushes at `session.measure`
// (or a `/fat <n>` preview). Render hooks only read it from `$.state`.
//
// Three looks, each switchable: solid FRAMES around messages, a solid BELLY
// above the prompt, and fat LETTERS (words drawn double width).

const PLUGIN = 'fat-context'
const COMMAND = 'fat'
const TOOL_NAME = 'weigh'
const TOOL = `mcp__${PLUGIN}__${TOOL_NAME}`

const LOOKS = ['all', 'frames', 'belly', 'letters'] as const
const SHAPE = 'fat-2'
const EMPTY: FatContextState = { real: null, preview: null, isOff: false, lastClass: null, look: 'all' }

// One stored value, tagged by its shape. `fat-2` is read as is, `fat-1` (round one,
// no look) is carried over, anything else is read as EMPTY.
const REF = { plugin: 'fat-context', key: 'state' } as const

type Class = 0 | 1 | 2 | 3 | 4

const NAMES = ['lean', 'filling out', 'chubby', 'stuffed', 'about to pop'] as const
const UP = ['Feeling light.', 'Filling out.', 'Getting chubby.', 'Getting stuffed.', 'About to pop.'] as const
const TINT: Record<Class, ThemeKey> = { 0: 'inactive', 1: 'inactive', 2: 'claude', 3: 'warning', 4: 'error' }

const classOf = (percent: number): Class =>
  percent >= 85 ? 4 : percent >= 70 ? 3 : percent >= 50 ? 2 : percent >= 30 ? 1 : 0

// --- reading state safely (a reload keeps whatever an older version stored) ---

const percentOf = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(100, Math.max(0, Math.round(value)))
  if (typeof value === 'string' && /^\s*\d{1,3}(\.\d+)?\s*$/.test(value)) return percentOf(Number(value))

  return null
}

const lookOf = (value: unknown): FatContextLook | null =>
  typeof value === 'string' && (LOOKS as readonly string[]).includes(value.trim().toLowerCase())
    ? (value.trim().toLowerCase() as FatContextLook)
    : null

const cleanBody = (raw: unknown): FatContextState => {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const last = o.lastClass

  return {
    real: percentOf(o.real),
    preview: percentOf(o.preview),
    isOff: o.isOff === true,
    lastClass: typeof last === 'number' && Number.isInteger(last) && last >= 0 && last <= 4 ? last : null,
    look: lookOf(o.look) ?? 'all',
  }
}

/** The stored value, whatever version wrote it. */
const clean = (stored: unknown): FatContextState => {
  const o = stored !== null && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}

  return o.shape === SHAPE || o.shape === 'fat-1' ? cleanBody(o.value) : EMPTY
}

type Weight = { percent: number; cls: Class; isPreview: boolean; look: FatContextLook }

/** What everything draws from: null while the visuals are off. */
const weightOf = (s: FatContextState): Weight | null => {
  if (s.isOff) return null
  const percent = s.preview ?? s.real ?? 0

  return { percent, cls: classOf(percent), isPreview: s.preview !== null, look: s.look }
}

const shows = (w: Weight, part: Exclude<FatContextLook, 'all'>) => w.look === 'all' || w.look === part

const readState = async ($: Pick<EngineInterface, 'state'>) => clean((await $.state.get(REF)).value)
const change = async ($: Pick<EngineInterface, 'state'>, fn: (s: FatContextState) => FatContextState) =>
  (await update($, REF, stored => ({ shape: SHAPE, value: fn(clean(stored)) }))).value

// --- words ---

/** ASCII letters and digits as their fullwidth forms: each two cells wide. */
const widen = (text: string) =>
  [...text]
    .map(ch => {
      const c = ch.charCodeAt(0)
      if (c >= 65 && c <= 90) return String.fromCharCode(0xff21 + c - 65)
      if (c >= 97 && c <= 122) return String.fromCharCode(0xff41 + c - 97)
      if (c >= 48 && c <= 57) return String.fromCharCode(0xff10 + c - 48)

      return ch
    })
    .join('')

/** Terminal cells a string takes: fullwidth forms count two. */
const cells = (text: string) => [...text].reduce((n, ch) => n + (ch >= '！' && ch <= '｠' ? 2 : 1), 0)

const WORD = /^[A-Za-z0-9]+[,.!?;:]?$/

// "Am I inside code" follows CommonMark, the markdown the engine draws, and fails
// closed: wherever it can't be sure text is prose, it leaves the text alone.

type Fence = { mark: '`' | '~'; length: number; isContained: boolean }

/** Strips container prefixes: blockquote markers and list markers, repeated for nesting. */
const stripContainers = (line: string) => {
  let rest = line
  for (;;) {
    const prefix = /^ {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(rest)?.[0] ?? ''
    if (prefix === '') return rest
    rest = rest.slice(prefix.length)
  }
}

/** A fence opener: 3 or more of one character, indented at most 3 spaces (inside any containers); a backtick opener's info string holds no backtick. */
const fenceOpens = (line: string): Fence | null => {
  const inner = stripContainers(line)
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(inner)
  const run = m?.[1] ?? ''
  if (run === '') return null
  const mark = run.startsWith('~') ? '~' : '`'
  if (mark === '`' && (m?.[2] ?? '').includes('`')) return null

  return { mark, length: run.length, isContained: inner !== line }
}

/**
 * A fence closes only on the same character, a run at least as long, and nothing after but
 * spaces or tabs: indented at most 3 spaces for a fence at the top level, at any indent and
 * behind any container prefix for one opened inside a container.
 */
const fenceCloses = (line: string, fence: Fence) => {
  const body = fence.isContained ? stripContainers(line).trimStart() : line
  const run = (fence.isContained ? /^(`{3,}|~{3,})[ \t]*$/ : /^ {0,3}(`{3,}|~{3,})[ \t]*$/).exec(body)?.[1] ?? ''

  return run !== '' && run.startsWith(fence.mark) && run.length >= fence.length
}

/**
 * Where a paragraph's code spans lie, [start, end), and whether any backtick run matched no
 * closer. A run of N backticks opens a span only if a later run of exactly N closes it.
 * Outside a span a backslash-escaped backtick is a literal; inside one, backslashes do nothing.
 */
const codeSpans = (text: string): { spans: [number, number][]; hasUnmatched: boolean } => {
  const runs = [...text.matchAll(/`+/g)].map(m => {
    const at = m.index ?? 0
    const slashes = /\\*$/.exec(text.slice(0, at))?.[0].length ?? 0

    return { at, n: m[0].length, isEscaped: slashes % 2 === 1 }
  })
  const spans: [number, number][] = []
  let hasUnmatched = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    if (run === undefined) break
    // An escaped first backtick is a literal; the rest of the run may still open a span.
    const open = run.isEscaped ? { at: run.at + 1, n: run.n - 1 } : { at: run.at, n: run.n }
    if (open.n === 0) continue
    const j = runs.findIndex((other, k) => k > i && other.n === open.n)
    const close = runs[j]
    if (close === undefined) {
      hasUnmatched = true
      continue
    }
    spans.push([open.at, close.at + close.n])
    i = j
  }

  return { spans, hasUnmatched }
}

const isSkippedLine = (line: string) => {
  const lead = line.trimStart()

  return (
    /^( {4,}|\t)/.test(line) || // indented (code, or a continuation: left alone either way)
    lead.startsWith('|') ||
    /\s\|\s/.test(line) || // a table row
    lead.startsWith('/') // a slash command
  )
}

/**
 * One paragraph's lines: plain words swell outside its code spans; paths, URLs, markup and
 * skipped lines stay. Left whole when unsure: an HTML-looking block, a link reference
 * definition, or a backtick run that matched no closer.
 */
const fattenParagraph = (lines: readonly string[]): string[] => {
  const first = lines[0] ?? ''
  if (/^ {0,3}</.test(first) || /^ {0,3}\[[^\]]+\]:/.test(first)) return [...lines]
  const { spans, hasUnmatched } = codeSpans(lines.join('\n'))
  if (hasUnmatched) return [...lines]
  const isCode = (at: number) => spans.some(([from, to]) => at >= from && at < to)
  let offset = 0

  return lines.map(line => {
    const start = offset
    offset += line.length + 1
    if (isSkippedLine(line)) return line
    let out = ''
    let isFirst = true

    for (let i = 0; i < line.length; ) {
      const code = isCode(start + i)
      let j = i
      while (j < line.length && isCode(start + j) === code) j++
      const piece = line.slice(i, j)
      i = j

      if (code) {
        if (piece.trim() !== '') isFirst = false
        out += piece
        continue
      }
      out += piece
        .split(/(\s+)/)
        .map(token => {
          if (token === '' || /^\s+$/.test(token)) return token
          const wasFirst = isFirst
          isFirst = false
          if (wasFirst && /^\d+[.)]$/.test(token)) return token // an ordered-list marker

          return WORD.test(token) ? widen(token) : token
        })
        .join('')
    }

    return out
  })
}

/**
 * Markdown with its plain words drawn double width. The one way in for every caller.
 * Fenced code (to its true close, or to the end when unclosed), indented code blocks
 * and code spans (across line breaks within a paragraph) are left exactly as written.
 */
export const fatten = (text: string) => {
  const out: string[] = []
  let paragraph: string[] = []
  let fence: Fence | null = null
  const flush = () => {
    out.push(...fattenParagraph(paragraph))
    paragraph = []
  }

  for (const line of text.split('\n')) {
    if (fence !== null) {
      out.push(line)
      if (fenceCloses(line, fence)) fence = null
      continue
    }
    const opens = fenceOpens(line)
    if (opens !== null) {
      flush()
      fence = opens
      out.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      out.push(line)
      continue
    }
    if (paragraph.length === 0 && /^( {4,}|\t)/.test(line)) {
      out.push(line) // an indented code block
      continue
    }
    paragraph.push(line)
  }
  flush()

  return out.join('\n')
}

const weighLine = (s: FatContextState) => {
  const percent = s.preview ?? s.real ?? 0
  const source = s.preview !== null ? 'preview' : 'real'

  return `${percent}% · ${NAMES[classOf(percent)]} (${source}${s.isOff ? '; visuals off' : ''}) · look: ${s.look}`
}

const describe = (s: FatContextState) => {
  const real = s.real === null ? 'no real reading yet' : `real reading ${s.real}%`
  const percent = s.preview ?? s.real ?? 0
  const head = `Context ${percent}% · ${NAMES[classOf(percent)]}`
  const source = s.preview !== null ? ` (preview; ${real})` : s.real === null ? ' (no real reading yet)' : ' (real)'

  return `${head}${source}. Look: ${s.look}.${s.isOff ? ' Visuals are off: /fat on brings them back.' : ''}`
}

const USAGE = `Usage: /${COMMAND} shows the reading, /${COMMAND} <0-100> previews a percent, /${COMMAND} real drops the preview, /${COMMAND} off|on turns the visuals off or on, /${COMMAND} look <all|frames|belly|letters> picks a look.`

const showStatus = ($: Pick<EngineInterface, 'ui'>, s: FatContextState) => {
  const w = weightOf(s)
  $.ui.status(w === null || w.cls === 0 ? undefined : `${NAMES[w.cls]} · ${w.percent}%${w.isPreview ? ' (preview)' : ''}`)
}

// --- A. fat frames: solid slabs of the theme color, thicker per class ---

type Slab = { side: number; cap: number }

const slabOf = (cls: Class, columns: number | undefined): Slab => {
  if (cls === 1) return { side: 1, cap: 0 }
  if (cls === 2) return { side: 2, cap: 1 }
  if (cls === 3) return { side: 4, cap: 1 }
  if (cls === 4) {
    const width = columns ?? 0
    // A quarter of the width each side, at least 8, and always 30 columns left for the words.
    const quarter = Math.max(8, Math.floor(width / 4))
    const room = Math.floor((width - 30 - 2) / 2)

    return { side: Math.max(1, width === 0 ? 8 : Math.min(quarter, room)), cap: 2 }
  }

  return { side: 0, cap: 0 }
}

/** The engine's own drawing, framed by solid slabs (Box backgroundColor), the words 1 column off each wall. */
const frame = (t: Elements['terminal'], inner: RenderElement, w: Weight, columns: number | undefined): RenderElement => {
  const { Box, Text } = t
  const color = TINT[w.cls]
  const { side, cap } = slabOf(w.cls, columns)
  const isLeftOnly = w.cls === 1

  return (
    <Box flexDirection="column">
      {cap > 0 && (
        <Box height={cap} backgroundColor={color} justifyContent="center" alignItems="center">
          {w.cls === 4 && (
            // No color of its own: it would inherit the slab's background and vanish.
            // Inverse of the plain text on the slab cuts a plate out of it.
            <Text inverse bold>
              {` ${w.percent}% FULL `}
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="row">
        <Box width={side} flexShrink={0} backgroundColor={color} />
        <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={1}>
          {inner}
        </Box>
        {!isLeftOnly && <Box width={side} flexShrink={0} backgroundColor={color} />}
      </Box>
      {cap > 0 && <Box height={cap} backgroundColor={color} />}
    </Box>
  )
}

// --- B. the solid belly ---

const SIZES: Record<Class, [number, number]> = { 0: [6, 2], 1: [10, 3], 2: [22, 5], 3: [40, 9], 4: [60, 14] }
const FACES: Record<Class, { eye: string; mouth: string }> = {
  0: { eye: '•', mouth: '‿' },
  1: { eye: '•', mouth: '‿' },
  2: { eye: '-', mouth: '‿' },
  3: { eye: '°', mouth: '~' },
  4: { eye: '×', mouth: '_' },
}

/** A filled oval, two pixels to a cell (▀ ▄ █), with the face cut into it: [text, isFace][] per row. */
export const bellyRows = (cls: Class, width: number, height: number): [string, boolean][][] => {
  const w = Math.max(2, width)
  const h = Math.max(1, height)
  const grid: string[][] = []

  for (let r = 0; r < h; r++) {
    const row: string[] = []
    for (let x = 0; x < w; x++) {
      const inside = (y: number) => {
        const dx = (x + 0.5 - w / 2) / (w / 2)
        const dy = (y + 0.5 - h) / h

        return dx * dx + dy * dy <= 1
      }
      const top = inside(2 * r)
      const bottom = inside(2 * r + 1)
      row.push(top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ')
    }
    grid.push(row)
  }

  const face = new Map<string, string>()
  const put = (r: number, x: number, text: string) => {
    ;[...text].forEach((ch, i) => {
      if (grid[r]?.[x + i] === '█') face.set(`${r}:${x + i}`, ch)
    })
  }
  const { eye, mouth } = FACES[cls]
  const eyeWidth = cls >= 3 ? 2 : 1
  const gap = Math.max(0, Math.round(w * 0.1))
  const eyeRow = h <= 2 ? 0 : Math.round(h * 0.3)
  const mouthRow = Math.min(h - 1, eyeRow + Math.max(1, Math.round(h * 0.18)))
  let mouthWidth = Math.max(1, Math.round(w * 0.12))
  if ((w - mouthWidth) % 2 !== 0) mouthWidth += 1
  put(eyeRow, Math.floor(w / 2) - gap - eyeWidth, eye.repeat(eyeWidth))
  put(eyeRow, Math.ceil(w / 2) + gap, eye.repeat(eyeWidth))
  put(mouthRow, Math.floor((w - mouthWidth) / 2), mouth.repeat(mouthWidth))
  if (cls >= 3) {
    const button = w % 2 === 0 ? '()' : 'o'
    put(Math.min(h - 1, Math.round(h * 0.72)), Math.floor((w - button.length) / 2), button)
  }

  return grid.map((row, r) => {
    const runs: [string, boolean][] = []
    row.forEach((ch, x) => {
      const cut = face.get(`${r}:${x}`)
      const piece: [string, boolean] = cut === undefined ? [ch, false] : [cut, true]
      const prev = runs[runs.length - 1]
      if (prev !== undefined && prev[1] === piece[1]) prev[0] += piece[0]
      else runs.push(piece)
    })

    return runs
  })
}

// Giant digits: a 3x5 font, each pixel two cells wide.
const FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '%': ['101', '001', '010', '100', '101'],
}

export const giant = (text: string): string[] =>
  [0, 1, 2, 3, 4].map(row =>
    [...text]
      .map(ch => (FONT[ch]?.[row] ?? '000').replace(/1/g, '██').replace(/0/g, '  '))
      .join(' '),
  )

const VERBS: Record<Class, readonly string[]> = {
  0: [],
  1: [],
  2: ['Chewing', 'Munching'],
  3: ['Digesting', 'Waddling'],
  4: ['Wheezing', "Can't reach the keyboard"],
}

/** A steady pick, so the spinner's word holds still across redraws of one turn. */
const pick = (list: readonly string[], seed: string) => {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0

  return list[h % list.length] ?? list[0] ?? ''
}

export const register: Register = on => {
  // --- setup: the command, the tool, and a first reading (no toast on first load) ---
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        'Reads or previews how full the session\'s context window is, as fat-context draws it. action "read" returns the percent, weight class, whether it is a preview, and the look. action "preview" with percent 0-100 makes the whole interface draw as if context were that full; percent "real" (or no percent and no look) goes back to the real reading. look (all, frames, belly or letters) picks which visuals draw; it can be given with preview, or with action "look" by itself.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'preview', 'look'] },
          percent: {
            anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'string', enum: ['real'] }],
            description: 'For preview: 0-100, or "real" to drop the preview.',
          },
          look: { type: 'string', enum: [...LOOKS], description: 'Which visuals draw: all, frames, belly or letters.' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'How full the context is, as fat-context draws it; preview a percent, pick a look, or turn the visuals off',
      argumentHint: '[0-100 | real | off | on | look <all|frames|belly|letters>]',
    })

    try {
      const usage = await $.session.usage()
      const now = percentOf(usage.context.percent)
      const s = await change($, c => {
        const real = now ?? c.real

        return { ...c, real, lastClass: real === null ? c.lastClass : classOf(real) }
      })
      showStatus($, s)
    } catch {
      showStatus($, await readState($))
    }

    return next(e)
  })

  // --- the signal: the engine pushes the context fill after each main-thread turn ---
  on('session.measure', async ($, e, next) => {
    const now = percentOf(e.context.percent)

    if (now !== null) {
      let before: number | null = null
      const s = await change($, c => {
        before = c.lastClass

        return { ...c, real: now, lastClass: classOf(now) }
      })
      const after = classOf(now)

      if (before !== null && !s.isOff) {
        if (after > before) $.ui.toast(`Context hit ${now}%. ${UP[after]}`)
        else if (after < before) $.ui.toast(`Dropped to ${now}%. Feeling light.`)
      }
      showStatus($, s)
    }

    return next(e)
  })

  // After a compaction the engine has no reading until the next response: draw lean meanwhile.
  // lastClass stays, so the next real reading toasts the drop.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) showStatus($, await change($, c => ({ ...c, real: null })))

    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') showStatus($, await change($, c => ({ ...c, real: null })))

    return next(e)
  })

  // --- /fat ---
  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    if (word === '') return { text: describe(await readState($)) }

    if (word === 'real') {
      const s = await change($, c => ({ ...c, preview: null }))
      showStatus($, s)

      return { text: `Preview dropped. ${describe(s)}` }
    }

    if (word === 'off' || word === 'on') {
      const s = await change($, c => ({ ...c, isOff: word === 'off' }))
      showStatus($, s)

      return { text: word === 'off' ? 'fat-context visuals off. /fat on brings them back.' : `fat-context visuals on. ${describe(s)}` }
    }

    const asked = /^look(\s+(\S+))?$/.exec(word)
    if (asked !== null) {
      const look = lookOf(asked[2])
      if (look === null) return { text: `Look: ${(await readState($)).look}. Pick one: /${COMMAND} look <all|frames|belly|letters>.` }
      const s = await change($, c => ({ ...c, look }))

      return { text: `Look set to ${look}. ${describe(s)}` }
    }

    const percent = /^\d{1,3}%?$/.test(word) ? Number(word.replace('%', '')) : NaN

    if (Number.isInteger(percent) && percent >= 0 && percent <= 100) {
      const s = await change($, c => ({ ...c, preview: percent }))
      showStatus($, s)

      return { text: `Previewing ${percent}% · ${NAMES[classOf(percent)]}. /fat real goes back to the real reading.` }
    }

    return { text: USAGE }
  }).catch(() => ({ text: `${PLUGIN}: /${COMMAND} hit an error.` }))

  // --- the weigh tool ---
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const look = input.look === undefined ? undefined : lookOf(input.look)

    if (look === null) return { deny: 'look must be all, frames, belly or letters.' }
    if (input.action === 'read') return { result: weighLine(await readState($)) }

    if (input.action === 'look') {
      if (look === undefined) return { deny: 'action "look" needs look: all, frames, belly or letters.' }
      const s = await change($, c => ({ ...c, look }))

      return { result: `Now drawing ${weighLine(s)}.` }
    }

    if (input.action === 'preview') {
      const raw = input.percent
      const isReal = (raw === undefined && look === undefined) || raw === null || (typeof raw === 'string' && raw.trim().toLowerCase() === 'real')
      const percent = percentOf(raw)

      if (!isReal && raw !== undefined && percent === null) return { deny: 'percent must be a number from 0 to 100, or "real".' }
      const s = await change($, c => ({
        ...c,
        preview: isReal ? null : percent ?? c.preview,
        look: look ?? c.look,
      }))
      showStatus($, s)

      return { result: `Now drawing ${weighLine(s)}.` }
    }

    return { deny: 'action must be "read", "preview" or "look".' }
  }).catch(() => ({ deny: `${PLUGIN}: the weigh tool hit an error.` }))

  // --- A + C. messages: solid frames and fat letters (terminal only; other surfaces pass through) ---
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.surface !== 'terminal' || w === null || w.cls === 0) return next(e)
    const isFat = w.cls === 4 && shows(w, 'letters')
    const inner = await next(isFat ? { ...e, props: { ...e.props, text: fatten(e.props.text) } } : e)

    return shows(w, 'frames') ? frame($.ui.resolve(e), inner, w, e.viewport?.columns) : inner
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.surface !== 'terminal' || w === null || w.cls === 0) return next(e)
    const isFat = w.cls >= 3 && shows(w, 'letters')
    const inner = await next(isFat ? { ...e, props: { ...e.props, text: fatten(e.props.text) } } : e)

    return shows(w, 'frames') ? frame($.ui.resolve(e), inner, w, e.viewport?.columns) : inner
  })

  // Tool rows only put on weight from stuffed up. The row's own hook re-runs on every
  // prop change (running -> done), so the engine's node inside keeps updating.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.surface !== 'terminal' || w === null || w.cls < 3 || !shows(w, 'frames')) return next(e)

    return frame($.ui.resolve(e), await next(e), w, e.viewport?.columns)
  })

  // A folded group's one line; an unfolded group's rows are ToolUse rows, framed above.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.surface !== 'terminal' || w === null || w.cls < 3 || e.props.isExpanded || !shows(w, 'frames')) return next(e)

    return frame($.ui.resolve(e), await next(e), w, e.viewport?.columns)
  })

  // --- heavier spinner verbs (every look) ---
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.surface !== 'terminal' || w === null || w.cls < 2 || e.props.message !== null) return next(e)
    const word = pick(VERBS[w.cls], `${e.requestId}:${e.props.word}`)

    return next({ ...e, props: { ...e.props, word } })
  })

  // --- B. the solid belly above the prompt ---
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = weightOf(await readState($))

    if (e.props.hasSurvey || w === null || !shows(w, 'belly')) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = TINT[w.cls]
    const columns = Math.max(1, e.props.bodyColumns)
    const rows = Math.max(1, e.props.maxRows)
    const preview = w.isPreview ? ' (preview)' : ''

    // The words beside it: one line up to chubby; giant digits from stuffed up.
    const label: RenderNode[] =
      w.cls <= 2
        ? [<Text color={w.cls === 0 ? undefined : color} dimColor={w.cls === 0}>{`${NAMES[w.cls]} · ${w.percent}%${preview}`}</Text>]
        : [
            ...giant(`${w.percent}%`).map(line => <Text color={color}>{line}</Text>),
            <Text color={color} bold>{`${w.cls === 4 ? 'ＡＢＯＵＴ ＴＯ ＰＯＰ' : NAMES[w.cls]}${preview}`}</Text>,
            ...(w.cls === 4 ? [<Text dimColor>/compact to slim down</Text>] : []),
          ]
    const labelWidth =
      w.cls <= 2 ? cells(`${NAMES[w.cls]} · ${w.percent}%${preview}`) : Math.max(cells(giant(`${w.percent}%`)[0] ?? ''), cells(`ＡＢＯＵＴ ＴＯ ＰＯＰ${preview}`))
    const labelBox = (
      <Box flexDirection="column" justifyContent="center" flexShrink={0}>
        {label}
      </Box>
    )

    const [wantWidth, wantHeight] = SIZES[w.cls]
    const isBeside = wantWidth + 2 + labelWidth <= columns
    const width = Math.min(wantWidth, 60, columns)
    const height = Math.max(1, Math.min(wantHeight, isBeside ? rows : rows - label.length))
    const body = bellyRows(w.cls, width, height).map(runs => (
      <Text color={color}>
        {runs.map(([text, isFace]) =>
          isFace ? (
            <Text inverse color={color}>
              {text}
            </Text>
          ) : (
            text
          ),
        )}
      </Text>
    ))
    const bodyBox = (
      <Box flexDirection="column" flexShrink={0}>
        {body}
      </Box>
    )

    return isBeside ? (
      <Box flexDirection="row" gap={2}>
        {bodyBox}
        {labelBox}
      </Box>
    ) : (
      <Box flexDirection="column">
        {labelBox}
        {bodyBox}
      </Box>
    )
  })
}
