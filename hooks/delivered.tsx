import type { ClientModule } from 'claude-code'

// "Delivered" (or `word`, "Read 4:02 PM") fading in under the newest sent bubble: nothing for the first
// 400 ms, then the word in each colour of `steps` for 80 ms, ending on `ink`,
// where the timer stops. The row keeps its width throughout, so nothing moves.
export type DeliveredProps = { ink: string; steps: string[]; word?: string }

const WORD = 'Delivered'
const TICK_MS = 80
const WAIT_TICKS = 5 // 5 × 80 ms = 400 ms of nothing

// State: -1 while waiting, then the index into steps; steps.length is the ink.
const Delivered: ClientModule<DeliveredProps, number> = (props, surface) => {
  if (surface.state === undefined) {
    let tick = 0
    surface.setState(-1)
    const stop = surface.every(TICK_MS, () => {
      tick += 1
      const step = Math.min(tick - WAIT_TICKS, props.steps.length)
      if (step < 0) return
      surface.setState(step)
      if (step >= props.steps.length) stop()
    })
  }

  const step = surface.state ?? -1
  const { Text } = surface.elements
  const word = props.word ?? WORD
  if (step < 0) return <Text>{' '.repeat(word.length)}</Text>

  return <Text color={props.steps[step] ?? props.ink}>{word}</Text>
}

export default Delivered
