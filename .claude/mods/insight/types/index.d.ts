export type ToolRun = { name: string; detail: string; ms?: number; ok?: boolean }
export type Live = { thinking: string; tools: ToolRun[] }
export type Note = { at: string; dir: string; prompt: string; did: string; learn: string }
export type Question = { q: string; choices: string[]; answer: number; explain: string; source: string }
export type Quiz = { question: Question; picked: number | null }

declare module 'claude-code' {
  interface PluginState {
    insight: {
      live: Live
      notes: Note[]
      quiz: Quiz | null
      making: boolean
    }
  }
}
