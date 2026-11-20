import type { ClientModule } from 'claude-code'

// The tapback bar over a held bubble, animated in: the bar's pill unfurls from
// the bubble's corner (its fill eases in from the bubble's), then the tapbacks
// pop in one after another, then sit still. A click on one posts `pick`. When
// the hooks module hands `picked`, that tapback's background eases to blue; the
// hooks module takes the bar away a moment later.
//
// Only backgrounds and widths animate, never a glyph's colour from faint to
// full: a terminal that re-tints low-contrast text (Cursor's minimum contrast
// rule) would turn a fade of the glyphs into a jump. Glyphs appear at full ink.
export type BarItem = { key: string; glyph: string; color?: string }
export type BarProps = {
  id: string
  items: BarItem[]
  // Grows rightward from the left edge (Claude's bubble) or leftward from the
  // right edge (the person's).
  anchor: 'left' | 'right'
  current?: string
  picked?: string
  bar: string
  from: string
  ink: string
  chosen: string
  // Cells per item.
  cells: number
}

export type BarPost = { type: 'pick'; id: string; key: string }

export const FRAME_MS = 22
const OPEN_FRAMES = 7 // the pill unfurling, about 150 ms
const STAGGER = 1 // frames between one tapback and the next
const PICK_FRAMES = 6

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

function mix(a: string, b: string, t: number): string {
  const hex = /^#[0-9a-fA-F]{6}$/
  if (!hex.test(a) || !hex.test(b)) return t < 1 ? a : b
  const part = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map(i => Math.round(part(a, i) + (part(b, i) - part(a, i)) * t))

  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

// State: frames since the bar mounted, and since `picked` arrived.
type BarState = { frame: number; pickFrame: number }

// The bars whose pick is animating, by message id: one timer each.
const picking = new Set<string>()

const Bar: ClientModule<BarProps, BarState> = (props, surface) => {
  const total = OPEN_FRAMES + STAGGER * props.items.length
  if (surface.state === undefined) {
    let frame = 0
    picking.delete(props.id)
    surface.setState({ frame: 0, pickFrame: 0 })
    const stop = surface.every(FRAME_MS, () => {
      frame += 1
      surface.setState({ frame, pickFrame: 0 })
      if (frame >= total) stop()
    })
  }
  const state = surface.state ?? { frame: 0, pickFrame: 0 }
  if (props.picked !== undefined && !picking.has(props.id)) {
    picking.add(props.id)
    let pf = 0
    const stop = surface.every(FRAME_MS, () => {
      pf += 1
      surface.setState({ frame: total, pickFrame: pf })
      if (pf >= PICK_FRAMES) stop()
    })
  }

  surface.onPointer(event => {
    if (event.type !== 'up' || event.button !== 'left') return
    const index = Math.floor((event.x - 1) / props.cells)
    const item = props.items[index]
    if (event.y === 0 && event.x >= 1 && item !== undefined) {
      surface.post({ type: 'pick', id: props.id, key: item.key } satisfies BarPost)
    }
  })

  const { Box, Text } = surface.elements
  const full = 2 + props.cells * props.items.length
  const open = easeOut(state.frame / OPEN_FRAMES)
  const width = Math.max(2, Math.round(full * open))
  const fill = mix(props.from, props.bar, open)
  const pick = easeOut(state.pickFrame / PICK_FRAMES)

  const slots = props.items.map((item, i) => {
    const shown = state.frame >= OPEN_FRAMES + STAGGER * i
    const isChosen = item.key === (props.picked ?? props.current)
    const back = isChosen ? (props.picked !== undefined ? mix(fill, props.chosen, pick) : props.chosen) : fill
    const ink = isChosen ? '#FFFFFF' : (item.color ?? props.ink)

    return (
      <Box key={`slot-${item.key}`} width={props.cells} justifyContent="center" backgroundColor={fill}>
        {shown && (
          <Text color={ink} backgroundColor={back} bold>
            {item.glyph}
          </Text>
        )}
      </Box>
    )
  })

  return (
    <Box width={full} flexDirection="row" justifyContent={props.anchor === 'left' ? 'flex-start' : 'flex-end'}>
      <Box width={width} flexDirection="row" paddingX={1} backgroundColor={fill}>
        {width >= full ? slots : null}
      </Box>
    </Box>
  )
}

export default Bar
