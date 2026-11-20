// One typed prompt of this session: its stored row id and when it was stored.
export type ChatBubblesPrompt = { uuid: string; at: number }

// A message's reactions: the person's tapback (by key) and Claude's emoji,
// each with when it landed, and Claude's few words on what it is doing.
export type ChatBubblesReactions = { you?: string; youAt?: number; claude?: string; claudeAt?: number; status?: string }
// The tapback bar open over one message; `picked` once a tapback was chosen.
export type ChatBubblesOpenBar = { id: string; at: number; picked?: string }
// A message quoted by a threaded reply: its id, whose it was ('Claude' or
// 'you') and its words, cut short.
export type ChatBubblesQuoted = { id: string; who: string; snippet: string }
// A tapback on one of Claude's replies, waiting to go with the next message.
export type ChatBubblesToClaude = { id: string; word: string; snippet: string }
// A picture in the thread, drawn in cells: its file, name, size and cells
// (base64 Raster triplets), and which half blocks it was drawn with.
export type ChatBubblesPicture = {
  file: string
  name: string
  cols: number
  rows: number
  cells: string
  glyph: 'font' | 'block'
  // The path as the person's message wrote it, when it came from one.
  written?: string
  // A PNG preview under 1.5 MiB, for terminals that draw real pixels
  // (kitty, Ghostty, iTerm2 3.5+); absent on pictures made before 0.5.7.
  png?: string
}
// The person's newest message Claude has started on, and when.
export type ChatBubblesReadMark = { uuid: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'chat-bubbles': {
      // The last 500 typed prompts of the thread, in order.
      prompts: Shaped<ChatBubblesPrompt[]>
      // The thread's first typed prompt's id; '' before it and after a /clear.
      first: string
      // Claude Code's `theme` setting as last read; '' when unknown.
      theme: string
      // Bubbles off in this chat (`/bubbles off`); unset, so on, in a new one.
      isOff: boolean
      // Reactions by message id, the last 500 messages.
      tapbacks: Record<string, ChatBubblesReactions>
      // The tapback bar now open, or null.
      openBar: ChatBubblesOpenBar | null
      // Tapbacks on Claude's replies not yet told to Claude.
      outbox: ChatBubblesToClaude[]
      // The message the next one replies to, or null.
      replyTo: ChatBubblesQuoted | null
      // Threaded replies: the reply's id to the message it quotes.
      replies: Record<string, ChatBubblesQuoted>
      // The newest message marked Read, or null.
      readMark: ChatBubblesReadMark | null
      // Claude's answers in a thread: answer id to the threaded reply's id.
      threaded: Record<string, string>
      // Pictures by the message or tool call that brought them.
      pictures: Record<string, ChatBubblesPicture[]>
      // How this terminal draws real pixels: 'kitty' (kitty, Ghostty), 'iterm'
      // (iTerm2 3.5+, full screen only), 'no' (cells instead), null before the
      // check.
      pixels: 'kitty' | 'iterm' | 'no' | null
    }
  }
}
