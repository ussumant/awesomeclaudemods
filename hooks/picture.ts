// Pictures in the thread (chat-bubbles 0.5): a small BMP, as `sips` writes it,
// turned into terminal cells two pixels tall: each cell an upper-half block whose
// foreground is the top pixel and background the bottom one. Drawn as a
// `Raster`, so it shows on every terminal, Cursor's included (the `Image`
// element shows pixels only on kitty, Ghostty and iTerm2 3.5+).
//
// The corners are rounded by half a cell, as a photo bubble's are: the two top
// corner cells draw only their lower half (a lower-half block on the
// terminal's own background), the two bottom ones only their upper half.
//
// The glyphs: in the `round` style the Bubble Caps font's half blocks
// (U+E0A5 upper, U+E0A4 lower), in the range a terminal's minimum-contrast rule
// leaves alone, so two near colours stay as they are; otherwise the standard
// blocks (U+2580, U+2584).

export type Pixels = { width: number; height: number; rgba: Uint8Array }
export type PictureCells = { cols: number; rows: number; cells: string }
export type Glyphs = { upper: number; lower: number }

export const FONT_GLYPHS: Glyphs = { upper: 0xe0a5, lower: 0xe0a4 }
export const BLOCK_GLYPHS: Glyphs = { upper: 0x2580, lower: 0x2584 }
// A Raster colour meaning the terminal's own (bit 24 alone).
export const DEFAULT_COLOR = 0x01000000

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const i32 = (b: Uint8Array, at: number) => u32(b, at) | 0

// The lowest set bit of a channel mask, and its width, to read a channel out
// of a pixel word.
function maskShift(mask: number): { shift: number; max: number } {
  if (mask === 0) return { shift: 0, max: 0 }
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift += 1
  let width = 0
  while (((mask >>> (shift + width)) & 1) === 1) width += 1

  return { shift, max: 2 ** width - 1 }
}

// A BMP's pixels as RGBA, top row first; undefined for any BMP this can't read
// (only uncompressed 24-bit and 32-bit, plain or with bit fields, as `sips`
// writes them).
export function parseBmp(bytes: Uint8Array): Pixels | undefined {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const offset = u32(bytes, 10)
  const header = u32(bytes, 14)
  const width = i32(bytes, 18)
  const rawHeight = i32(bytes, 22)
  const bpp = u16(bytes, 28)
  const compression = u32(bytes, 30)
  if (width <= 0 || rawHeight === 0 || width > 4096 || Math.abs(rawHeight) > 4096) return undefined
  if (bpp !== 24 && bpp !== 32) return undefined
  if (compression !== 0 && compression !== 3) return undefined
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  const stride = Math.ceil((bpp * width) / 32) * 4
  if (offset + stride * height > bytes.length) return undefined

  // Channel masks: the header's own (bit fields), else BGR(A).
  let masks = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: bpp === 32 ? 0xff000000 : 0 }
  if (compression === 3 && header >= 52) {
    masks = { r: u32(bytes, 54), g: u32(bytes, 58), b: u32(bytes, 62), a: header >= 56 ? u32(bytes, 66) : 0 }
  }
  const ch = { r: maskShift(masks.r), g: maskShift(masks.g), b: maskShift(masks.b), a: maskShift(masks.a) }
  const read = (word: number, c: { shift: number; max: number }, fallback: number) =>
    c.max === 0 ? fallback : Math.round((((word >>> c.shift) & c.max) * 255) / c.max)

  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const row = offset + stride * (topDown ? y : height - 1 - y)
    for (let x = 0; x < width; x += 1) {
      const at = row + x * (bpp / 8)
      const word = bpp === 32 ? u32(bytes, at) : bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
      const o = (y * width + x) * 4
      rgba[o] = read(word, ch.r, 0)
      rgba[o + 1] = read(word, ch.g, 0)
      rgba[o + 2] = read(word, ch.b, 0)
      rgba[o + 3] = read(word, ch.a, 255)
    }
  }

  return { width, height, rgba }
}

// The size to resample a picture to: as large as fits `maxCols` cells wide and
// `maxRows` cells (twice as many pixels) tall, its shape kept; even in height.
export function fitSize(width: number, height: number, maxCols: number, maxRows: number): { w: number; h: number } {
  const scale = Math.min(maxCols / width, (maxRows * 2) / height, 1)
  const w = Math.max(2, Math.round(width * scale))
  const h = Math.max(2, Math.round((height * scale) / 2) * 2)

  return { w, h }
}

// A pixel as a Raster colour, laid over `matte` (0xRRGGBB) by its alpha.
function colorAt(px: Pixels, x: number, y: number, matte: number): number {
  if (y >= px.height) return matte
  const o = (y * px.width + x) * 4
  const a = px.rgba[o + 3]! / 255
  const mix = (c: number, shift: number) => Math.round(c * a + ((matte >>> shift) & 0xff) * (1 - a))

  return (mix(px.rgba[o]!, 16) << 16) | (mix(px.rgba[o + 1]!, 8) << 8) | mix(px.rgba[o + 2]!, 0)
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]!)

  return btoa(text)
}

// The picture's cells for a `Raster`: one column per pixel, one row per two.
export function toCells(px: Pixels, o: { glyphs: Glyphs; matte: number }): PictureCells {
  const cols = px.width
  const rows = Math.ceil(px.height / 2)
  const words = new Uint32Array(cols * rows * 3)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const top = colorAt(px, c, r * 2, o.matte)
      const bottom = colorAt(px, c, r * 2 + 1, o.matte)
      const isCorner = (c === 0 || c === cols - 1) && (r === 0 || r === rows - 1) && cols > 2 && rows > 1
      const at = (r * cols + c) * 3
      if (isCorner && r === 0) {
        // Top corner: its lower half only, on the terminal's background.
        words[at] = o.glyphs.lower
        words[at + 1] = bottom
        words[at + 2] = DEFAULT_COLOR
      } else if (isCorner) {
        // Bottom corner: its upper half only.
        words[at] = o.glyphs.upper
        words[at + 1] = top
        words[at + 2] = DEFAULT_COLOR
      } else {
        words[at] = o.glyphs.upper
        words[at + 1] = top
        words[at + 2] = bottom
      }
    }
  }

  return { cols, rows, cells: toBase64(new Uint8Array(words.buffer)) }
}

// Cells drawn with one glyph set, redrawn with another (the style changed
// after the picture was made): every half block swapped for its twin.
export function swapGlyphs(cells: string, from: Glyphs, to: Glyphs): string {
  if (from.upper === to.upper && from.lower === to.lower) return cells
  const fromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  const bytes = typeof fromB64 === 'function' ? fromB64(cells) : Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  for (let i = 0; i < words.length; i += 3) {
    if (words[i] === from.upper) words[i] = to.upper
    else if (words[i] === from.lower) words[i] = to.lower
  }

  return toBase64(new Uint8Array(words.buffer, words.byteOffset, words.byteLength))
}

// Picture files a message may name, by extension.
export const PICTURE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i

// A file's last path part.
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

// "[Image #1]" marks a pasted picture leaves in the prompt's text.
export function withoutImageMarks(text: string): string {
  return text.replace(/\[Image #\d+\]\s?/g, '').trim()
}

// Picture files a message names by absolute path, as a drag from Finder or a
// pasted path leaves them: quoted ('…' or "…", spaces allowed inside) or bare
// (no spaces). At most four, in order, each once.
export function picturePaths(text: string): { path: string; written: string }[] {
  const found: { path: string; written: string }[] = []
  const pattern = /'(\/[^'\n]+)'|"(\/[^"\n]+)"|(?<![\w/])(\/[^\s'"]+)/g
  for (const match of text.matchAll(pattern)) {
    // A bare path loses the punctuation after it ("see /tmp/a.png, then").
    const bare = match[3]?.replace(/[),.;:!?]+$/, '')
    const path = (match[1] ?? match[2] ?? bare ?? '').replace(/\\ /g, ' ')
    if (!PICTURE_EXT.test(path) || found.some(f => f.path === path)) continue
    found.push({ path, written: bare ?? match[0] })
    if (found.length === 4) break
  }

  return found
}

// The words with the picture paths taken out.
export function withoutPaths(text: string, written: readonly string[]): string {
  let out = text
  for (const w of written) out = out.split(w).join('')

  return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim()
}

// Real pixels (chat-bubbles 0.5.7). Claude Code's `Image` element draws a PNG
// as pixels in kitty, Ghostty and iTerm2 3.5 or later (iTerm2 only in full
// screen), and its alt text everywhere else. Claude Code decides by asking the
// terminal its version; a mod can't see that answer, so this reads the same
// facts from the environment the terminal sets. Inside tmux or screen it says
// no: Claude Code can draw there only with passthrough on, and cells are the
// safe side. `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` forces Claude Code's kitty
// pictures on, so it does here too.
export type PixelKind = 'kitty' | 'iterm'

export function pixelKind(env: Record<string, string | undefined>): PixelKind | undefined {
  if ((env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES ?? '') !== '') return 'kitty'
  if ((env.TMUX ?? '') !== '' || (env.STY ?? '') !== '') return undefined
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  if (term.includes('kitty') || term === 'xterm-ghostty' || program === 'ghostty') return 'kitty'
  const version = program === 'iTerm.app' ? env.TERM_PROGRAM_VERSION : env.LC_TERMINAL === 'iTerm2' ? env.LC_TERMINAL_VERSION : undefined
  if (version === undefined) return undefined
  const [major = 0, minor = 0] = version.split('.').map(Number)

  return major > 3 || (major === 3 && minor >= 5) ? 'iterm' : undefined
}

// `env`'s output as a table.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }

  return out
}

// A preview PNG must stay under this, so its base64 fits the Image element's
// 2 MiB cap with room to spare.
export const PNG_MAX_BYTES = 1.5 * 1024 * 1024
// The longest side of a preview, tried in turn until one fits PNG_MAX_BYTES.
export const PNG_SIDES = [1000, 700, 480] as const
