// The cap glyphs of a `round` bubble (Bubble Caps font), two cells wide:
// - 0 rows: nothing;
// - 1 row: the one-line caps;
// - n >= 2 rows: the first-row caps, body-coloured cells for each middle row,
//   the last-row caps.
// A tail swaps the outer cap of the one-line or last row (sent: the right
// column; received: the left). Glyphs as listed in assets/glyph-map.json.
export type CapProps = { side: 'left' | 'right'; fill: string; tail: boolean }

const g = (...points: number[]) => String.fromCodePoint(...points)

const LEFT = {
  one: g(0xe0b6, 0xe0b7),
  oneTail: g(0xe0c9, 0xe0b7),
  first: g(0xe0b2, 0xe0b3),
  last: g(0xe0b4, 0xe0b5),
  lastTail: g(0xe0cd, 0xe0b5),
}
const RIGHT = {
  one: g(0xe0c1, 0xe0c0),
  oneTail: g(0xe0c1, 0xe0c4),
  first: g(0xe0bd, 0xe0bc),
  last: g(0xe0bf, 0xe0be),
  lastTail: g(0xe0bf, 0xe0c8),
}

export function capRows(props: CapProps, rows: number): string[] {
  const set = props.side === 'left' ? LEFT : RIGHT
  if (rows <= 0) return []
  if (rows === 1) return [props.tail ? set.oneTail : set.one]

  return [set.first, ...Array.from({ length: rows - 2 }, () => '  '), props.tail ? set.lastTail : set.last]
}
