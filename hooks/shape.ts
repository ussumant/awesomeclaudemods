// The glyph rows above and below a bubble's body.
//
// `pill`: `▗▄…▄▖` above and `▝▀…▀▘` below, both exactly as wide as the body:
//   half a cell of fill above and below, the corners cut. No tail.
// `tail`: the pill with a tail on the bottom row one cell past the body:
//   right of a sent bubble, left of a received one. The bottom row is then one
//   cell wider than the body.
// `block`: no edge rows. The body carries one filled blank line above and below
//   its text instead, so no seam between glyph rows can show.

// `round` is drawn with the Bubble Caps font's glyphs (register.tsx, cap.tsx);
// it has no rows here.
export type Shape = 'pill' | 'tail' | 'block' | 'round'
export type Side = 'sent' | 'received'
export type Edges = {
  top: string
  bottom: string
  tailAt: 'left' | 'right' | 'none'
}

export const SHAPES: readonly Shape[] = ['pill', 'tail', 'block', 'round']

export function isShape(value: unknown): value is Shape {
  return typeof value === 'string' && (SHAPES as readonly string[]).includes(value)
}

export function bubbleEdges(shape: Shape, width: number, side: Side): Edges {
  const w = Math.max(2, Math.floor(width))
  const top = `▗${'▄'.repeat(w - 2)}▖`
  const middle = '▀'.repeat(w - 2)

  if (shape === 'pill') {
    return { top, bottom: `▝${middle}▘`, tailAt: 'none' }
  }

  if (shape === 'tail') {
    return side === 'sent'
      ? { top, bottom: `▝${middle}▀▘`, tailAt: 'right' }
      : { top, bottom: `▝▀${middle}▘`, tailAt: 'left' }
  }

  return { top: '', bottom: '', tailAt: 'none' }
}
