export type ToolStat = { n: number; ms: number; err: number }
export type Stats = {
  tools: Record<string, ToolStat>
  files: Record<string, number>
  bash: Record<string, number>
}
export type Scope = 'session' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'tool-stats': {
      session: Stats
      totals: Stats
      scope: Scope
    }
  }
}
