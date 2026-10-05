export type ToolRun = { name: string; detail: string; ok: boolean }
export type Note = { at: string; dir: string; prompt: string; did: string; learn: string }
export type Question = { q: string; choices: string[]; answer: number; explain: string; source: string }
export type Quiz = { question: Question; picked: number | null }

declare module 'claude-code' {
  interface PluginState {
    insight: {
      notes: Note[]
      quiz: Quiz | null
      making: boolean
      closed: boolean
    }
  }
}
