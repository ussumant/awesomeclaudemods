// The state contract of fat-context: what it keeps in $.state for the session.

/** Which visuals draw: all three, or one alone (the others pass through). */
export type FatContextLook = 'all' | 'frames' | 'belly' | 'letters'

/** Everything fat-context remembers. Percentages are whole numbers, 0 to 100. */
export type FatContextState = {
  /** The last real context reading; null before the first response, or right after /compact or /clear. */
  real: number | null
  /** A percent set by `/fat <n>` or the weigh tool; everything draws as if context were there. */
  preview: number | null
  /** True after `/fat off`: every hook passes through. */
  isOff: boolean
  /** The weight class of the last real reading (0 lean ... 4 about to pop); null on first load. */
  lastClass: number | null
  /** Which visuals draw. Added in shape `fat-2`; a `fat-1` value is read as `all`. */
  look: FatContextLook
}

declare module 'claude-code' {
  interface PluginState {
    'fat-context': { state: Shaped<FatContextState> }
  }
}
