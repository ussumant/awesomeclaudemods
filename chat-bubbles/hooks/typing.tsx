import type { ClientModule } from 'claude-code'

// The typing bubble's three dots. Every 300 ms the bright dot moves one place:
// steps 0, 1, 2 light dot 0, 1, 2; step 3 leaves all three dim; then again.
// `fill` is the bubble's fill, painted behind the dots so the region matches
// the body around it. `dot` is the glyph (`•`, or the Bubble Caps dot in the
// `round` style). Each dot starts its own colour run, its space after it: a
// run must never start with a space (the terminal's contrast rule judges a run
// by its first cell).
export type TypingProps = { dim: string; bright: string; fill: string; dot?: string }

export const STEP_MS = 300

const Typing: ClientModule<TypingProps, number> = (props, surface) => {
  if (surface.state === undefined) {
    let step = 0
    surface.setState(step)
    surface.every(STEP_MS, () => {
      step = (step + 1) % 4
      surface.setState(step)
    })
  }

  const step = surface.state ?? 0
  const dot = props.dot ?? '•'
  const { Box, Text } = surface.elements
  const run = (i: number) => (
    <Text color={i === step ? props.bright : props.dim} backgroundColor={props.fill}>
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
