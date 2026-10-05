export type Day = { day: string; food: number; level: number }
export type Tank = Day & { fedAt: number; best: Day | null; history: Day[] }

declare module 'claude-code' {
  interface PluginState {
    tank: {
      tank: Tank
    }
  }
}
