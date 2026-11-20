import type { ClientModule } from 'claude-code'

// The typing bubble's three dots, pulsing in a smooth wave the way iMessage's
// do. Each dot brightens and dims on a cosine curve; the peaks pass dot 0, 1
// and 2 at 0, 300 and 600 ms of every 1200 ms, then all three rest dim for the
// last stretch. Painted every TICK_MS, so the brightness moves in small steps,
// not jumps. On the 300 ms marks the colours are exact: the dot at its peak is
// `bright`, the others `dim`.
//
// `fill` is the bubble's fill, painted behind the dots so the region matches
// the body around it. `dot` is the glyph (`•`, or the Bubble Caps dot in the
// `round` style, which a terminal's minimum-contrast rule leaves alone, so the
// in-between shades show). Each dot starts its own colour run, its space after
// it: a run must never start with a space (the terminal's contrast rule judges
// a run by its first cell).
export type TypingProps = { dim: string; bright: string; fill: string; dot?: string }

export const STEP_MS = 300 // from one dot's peak to the next
export const TICK_MS = 30
const PERIOD_MS = 4 * STEP_MS

function mix(a: string, b: string, t: number): string {
  const hex = /^#[0-9a-fA-F]{6}$/
  if (!hex.test(a) || !hex.test(b)) return t < 0.5 ? a : b
  const part = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map(i => Math.round(part(a, i) + (part(b, i) - part(a, i)) * t))

  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

// How lit dot `i` is at `ms` into the cycle: 1 at its peak, easing to 0 one
// step either side of it.
export function glow(i: number, ms: number): number {
  const peak = i * STEP_MS
  const raw = Math.abs((((ms - peak) % PERIOD_MS) + PERIOD_MS) % PERIOD_MS)
  const d = Math.min(raw, PERIOD_MS - raw)
  if (d >= STEP_MS) return 0

  return (Math.cos((Math.PI * d) / STEP_MS) + 1) / 2
}

// State: ms into the cycle.
const Typing: ClientModule<TypingProps, number> = (props, surface) => {
  if (surface.state === undefined) {
    let ms = 0
    surface.setState(ms)
    surface.every(TICK_MS, () => {
      ms = (ms + TICK_MS) % PERIOD_MS
      surface.setState(ms)
    })
  }

  const ms = surface.state ?? 0
  const dot = props.dot ?? '•'
  const { Box, Text } = surface.elements
  const shade = (i: number) => {
    const g = glow(i, ms)
    if (g >= 1) return props.bright
    if (g <= 0) return props.dim

    return mix(props.dim, props.bright, g)
  }
  const run = (i: number) => (
    <Text color={shade(i)} backgroundColor={props.fill}>
      {i < 2 ? `${dot} ` : dot}
    </Text>
  )

  return (
    <Box flexDirection="row">
      {run(0)}
      {run(1)}
      {run(2)}
    </Box>
  )
}

export default Typing
