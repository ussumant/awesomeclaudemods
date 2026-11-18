// One typed prompt of this session: its stored row id and when it was stored.
export type ChatBubblesPrompt = { uuid: string; at: number }

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
    }
  }
}
