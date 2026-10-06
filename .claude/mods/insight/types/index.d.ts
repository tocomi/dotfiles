export type ToolRun = { name: string; detail: string; ok: boolean }
export type Note = { at: string; dir: string; prompt: string; did: string; learn: string }

declare module 'claude-code' {
  interface PluginState {
    insight: {
      notes: Note[]
    }
  }
}
