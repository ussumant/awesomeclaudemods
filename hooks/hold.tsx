import type { ClientModule } from 'claude-code'

// A whole bubble, drawn here so it can feel a press and hold, the way a phone
// does. Hold the left button for HOLD_MS anywhere on it: the fill eases a shade
// toward `pressFill` while you hold (so you can feel it working), then the
// module posts `hold` and the hooks module opens the tapback bar above the
// bubble, while the fill eases back. Keep the button down and slide onto a
// tapback, then let go: the module posts `release` with where the pointer came
// up, in this region's cells (the row above the region is -1). A quick click
// posts `tap` (the hooks module closes an open bar on it).
//
// The cost of drawing the bubble here: after a `down` the region holds the
// pointer until the `up`, so the transcript cannot drag-select inside a bubble.
// The hold menu's Copy stands in for that.
//
// No timer runs while nothing moves: one starts on `down` and stops once the
// fill has eased back.
//
// The bubble's frame comes ready-made from the hooks module: for `round`, the
// Bubble Caps glyph rows and cap glyphs (register.tsx works them out, as it
// does for the bubble it draws without this module); for `block`, padding.
// Every part of the frame is painted with the current fill, so the press shade
// covers the whole bubble with no seam. Only colours change while animating,
// never the layout, so nothing around the bubble moves.
export type RoundFrame = {
  top: string
  bottom: string
  // One blank column left of the bubble (a received bubble's tail column).
  spacer: boolean
  oneLine: boolean
  // [one-line cap, first-row cap, last-row cap], two cells each.
  left: [string, string, string]
  right: [string, string, string]
}

export type HoldProps = {
  // The message's id (the row's requestId): what the posts name.
  id: string
  // Whose bubble (`user`, `assistant`): its body Box is keyed `bubble-<who>`,
  // as the bubble drawn without this module is.
  who: string
  text: string
  // Claude's markdown, or the person's plain words.
  isMarkdown: boolean
  // The plain words' colour; markdown keeps the engine's own colours.
  color?: string
  fill: string
  // The fill at the end of a full hold.
  pressFill: string
  // The body's columns (padding included) and padding.
  width: number
  padX: number
  padY: number
  // The `round` frame; absent, the body alone.
  round?: RoundFrame
}

export type HoldPost =
  | { type: 'hold'; id: string }
  | { type: 'release'; id: string; x: number; y: number; rows: number }
  | { type: 'tap'; id: string }

export const HOLD_MS = 450
export const TICK_MS = 24
const HOLD_TICKS = Math.ceil(HOLD_MS / TICK_MS)
const BACK_TICKS = 7 // about 170 ms to ease back

type Press = { ticks: number; fired: boolean; stop?: () => void }

// The press in progress on each bubble, and each bubble's easing back, by id.
const presses = new Map<string, Press>()
const easings = new Map<string, () => void>()

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

// A colour between two #RRGGBB colours; a theme key (not hex) is kept as is.
function mix(a: string, b: string, t: number): string {
  const hex = /^#[0-9a-fA-F]{6}$/
  if (!hex.test(a) || !hex.test(b)) return t < 1 ? a : b
  const part = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map(i => Math.round(part(a, i) + (part(b, i) - part(a, i)) * t))

  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

// State: how far the press shade is, 0 (none) to 1 (a full hold).
const Hold: ClientModule<HoldProps, number> = (props, surface) => {
  const { Box, Text, Markdown } = surface.elements

  // Eases the shade from where it is to 0.
  const easeBack = () => {
    easings.get(props.id)?.()
    const from = surface.state ?? 0
    if (from <= 0) return
    let tick = 0
    const stop = surface.every(TICK_MS, () => {
      tick += 1
      surface.setState(from * (1 - easeOut(tick / BACK_TICKS)))
      if (tick >= BACK_TICKS) {
        stop()
        easings.delete(props.id)
      }
    })
    easings.set(props.id, stop)
  }

  surface.onPointer(event => {
    const press = presses.get(props.id)
    if (event.type === 'down' && event.button === 'left') {
      press?.stop?.()
      easings.get(props.id)?.()
      easings.delete(props.id)
      const next: Press = { ticks: 0, fired: false }
      next.stop = surface.every(TICK_MS, () => {
        next.ticks += 1
        surface.setState(easeOut(next.ticks / HOLD_TICKS))
        if (next.ticks >= HOLD_TICKS) {
          next.fired = true
          next.stop?.()
          next.stop = undefined
          surface.post({ type: 'hold', id: props.id } satisfies HoldPost)
          easeBack()
        }
      })
      presses.set(props.id, next)

      return
    }
    if (press === undefined || event.type !== 'up') return
    press.stop?.()
    presses.delete(props.id)
    if (press.fired) {
      surface.post({ type: 'release', id: props.id, x: event.x, y: event.y, rows: surface.rows } satisfies HoldPost)
    } else {
      surface.post({ type: 'tap', id: props.id } satisfies HoldPost)
      easeBack()
    }
  })

  const fill = mix(props.fill, props.pressFill, surface.state ?? 0)
  const words = props.isMarkdown ? (
    <Markdown text={props.text} />
  ) : (
    <Text color={props.color} backgroundColor={fill}>{props.text}</Text>
  )
  const body = (
    <Box key={`bubble-${props.who}`} width={props.width} paddingX={props.padX} paddingY={props.padY} backgroundColor={fill}>
      {words}
    </Box>
  )
  const round = props.round
  if (round === undefined) return body

  // One cap column that stretches to the body's height (as register.tsx's
  // capColumn does), or the one-line cap.
  const cap = (glyphs: [string, string, string], name: string) =>
    round.oneLine ? (
      <Text key={name} color={fill} wrap="clip">{glyphs[0]}</Text>
    ) : (
      <Box key={name} flexDirection="column" width={2} flexShrink={0}>
        <Text color={fill} wrap="clip">{glyphs[1]}</Text>
        <Box key={`${name}-fill`} flexGrow={1} backgroundColor={fill} />
        <Text color={fill} wrap="clip">{glyphs[2]}</Text>
      </Box>
    )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {round.spacer && <Box width={1} />}
        <Text color={fill} wrap="clip">{round.top}</Text>
      </Box>
      <Box flexDirection="row" alignItems="stretch">
        {round.spacer && <Box width={1} />}
        {cap(round.left, `cap-left:${props.id}`)}
        {body}
        {cap(round.right, `cap-right:${props.id}`)}
      </Box>
      <Box flexDirection="row">
        <Text color={fill} wrap="clip">{round.bottom}</Text>
      </Box>
    </Box>
  )
}

export default Hold
