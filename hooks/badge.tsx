import type { ClientModule } from 'claude-code'

// A tapback badge that pops onto its bubble, about 150 ms in all.
//
// `round` (the Bubble Caps font, the `round` style): a small round bubble around
// the glyph, three rows: the font's top pad row, the glyph between its one-line
// caps, the bottom pad row. It pops by swelling one cell either side and
// settling, while its colour eases in from the bubble's. Every cap and pad
// glyph is in the font's range a terminal's minimum-contrast rule leaves alone,
// so the colour ease shows as an ease.
//
// Otherwise: a one-row block, its padding swelling and settling the same way.
//
// `animate` false (an old reaction, drawn again on a scroll or a redraw) draws
// it settled at once. The glyph is at full ink from the first frame.
//
// `words` (Claude's few words on what it is doing): hidden until the pointer
// rests on the badge, then they slide out to its left from behind it, the end
// nearest the badge first, and slide back when the pointer leaves. The badge
// itself never moves: the hooks module anchors this region's right edge.
export type BadgeProps = {
  glyph: string
  ink: string
  bg: string
  from: string
  animate: boolean
  round?: boolean
  words?: string
  wordsInk?: string
}

// The words' slide: this many characters a frame, out or back.
const SLIDE_STEP = 3

export const FRAME_MS = 24
// Extra cells either side of the glyph, frame by frame: swell, then settle.
const SWELL = [0, 1, 1, 1, 0, 0]
const FADE_FRAMES = 4

const cp = (...points: number[]) => String.fromCodePoint(...points)

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

function mix(a: string, b: string, t: number): string {
  const hex = /^#[0-9a-fA-F]{6}$/
  if (!hex.test(a) || !hex.test(b)) return t < 1 ? a : b
  const part = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map(i => Math.round(part(a, i) + (part(b, i) - part(a, i)) * t))

  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

// Cells a glyph takes: the tapback words their length; an emoji two (the
// picture planes, and the symbol blocks whose emoji draw two wide: ⏳ ⚡ ❗);
// the rest, the tapback heart among them, one.
function cellsOf(glyph: string): number {
  if (/^[\x20-\x7e]+$/.test(glyph)) return glyph.length
  const first = glyph.codePointAt(0) ?? 0
  const wide = first >= 0x1f000 || (first >= 0x2300 && first <= 0x23ff) || (first >= 0x2600 && first <= 0x27bf && first !== 0x2665)

  return wide ? 2 : 1
}

// The words' slide on each badge, kept outside the drawing state so the pop
// and the slide never fight over it: how many characters show, and its timer.
type Slide = { shown: number; target: number; stop?: () => void }
const slides = new Map<string, Slide>()

// State: the pop's frame (SWELL.length - 1 once settled) and how many of the
// words show.
type BadgeState = { frame: number; shown: number }

const Badge: ClientModule<BadgeProps, BadgeState> = (props, surface) => {
  const last = SWELL.length - 1
  const id = `${props.glyph}|${props.words ?? ''}|${props.bg}`
  if (surface.state === undefined) {
    if (!props.animate) {
      surface.setState({ frame: last, shown: 0 })
    } else {
      let frame = 0
      surface.setState({ frame: 0, shown: 0 })
      const stop = surface.every(FRAME_MS, () => {
        frame += 1
        surface.setState({ frame, shown: slides.get(id)?.shown ?? 0 })
        if (frame >= last) stop()
      })
    }
  }
  const words = props.words ?? ''
  // Slides the words toward `target` characters shown, a few a frame.
  const slideTo = (target: number) => {
    const slide = slides.get(id) ?? { shown: 0, target: 0 }
    slides.set(id, slide)
    slide.target = target
    if (slide.stop !== undefined) return
    slide.stop = surface.every(FRAME_MS, () => {
      const step = Math.sign(slide.target - slide.shown) * Math.min(SLIDE_STEP, Math.abs(slide.target - slide.shown))
      slide.shown += step
      surface.setState({ frame: surface.state?.frame ?? last, shown: slide.shown })
      if (slide.shown === slide.target) {
        slide.stop?.()
        slide.stop = undefined
      }
    })
  }
  if (words !== '') {
    surface.onPointer(event => {
      if (event.type === 'enter' || (event.type === 'move' && event.button === undefined)) slideTo(words.length)
      else if (event.type === 'leave') slideTo(0)
    })
  }
  const frame = props.animate ? Math.min(surface.state?.frame ?? 0, last) : last
  const shown = Math.min(words.length, surface.state?.shown ?? 0)
  // The end of the words nearest the badge shows first.
  const visible = shown > 0 ? `${words.slice(words.length - shown)} ` : ''
  const swell = SWELL[frame] ?? 0
  const bg = mix(props.from, props.bg, easeOut(frame / FADE_FRAMES))
  const { Box, Text } = surface.elements

  const said = visible !== '' && <Text key="words" color={props.wordsInk}>{visible}</Text>

  if (props.round !== true) {
    return (
      <Box flexDirection="row">
        {said}
        <Box paddingX={1 + swell} backgroundColor={bg}>
          <Text color={props.ink} backgroundColor={bg} bold>
            {props.glyph}
          </Text>
        </Box>
      </Box>
    )
  }

  // The glyph centred in an even width of 2 (or its own width), plus the swell.
  const own = cellsOf(props.glyph)
  const inner = Math.max(2, own) + 2 * swell
  const left = Math.floor((inner - own) / 2)
  const right = inner - own - left
  const top = cp(0xe0b0, 0xe0b1) + cp(0xe0a4).repeat(inner) + cp(0xe0bb, 0xe0ba)
  const bottom = cp(0xe0b8, 0xe0b9) + cp(0xe0a5).repeat(inner) + cp(0xe0c3, 0xe0c2)

  const circle = (
    <Box key="circle" flexDirection="column" width={inner + 4}>
      <Text color={bg} wrap="clip">{top}</Text>
      <Box flexDirection="row">
        <Text color={bg} wrap="clip">{cp(0xe0b6, 0xe0b7)}</Text>
        <Text color={props.ink} backgroundColor={bg} bold>
          {`${' '.repeat(left)}${props.glyph}${' '.repeat(right)}`}
        </Text>
        <Text color={bg} wrap="clip">{cp(0xe0c1, 0xe0c0)}</Text>
      </Box>
      <Text color={bg} wrap="clip">{bottom}</Text>
    </Box>
  )

  return (
    <Box flexDirection="row" alignItems="center">
      {said}
      {circle}
    </Box>
  )
}

export default Badge
