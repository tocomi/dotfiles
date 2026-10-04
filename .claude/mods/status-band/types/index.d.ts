export type ModelInfo = { name: string; effort?: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = { ctxPercent?: number; limits: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'status-band': {
      branch: string | null
      model: ModelInfo | null
      usage: Usage | null
    }
  }
}
