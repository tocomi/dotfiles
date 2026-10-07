import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, Tank } from '../types'

const EMPTY: Tank = { day: '', food: 0, level: 0, fedAt: 0, best: null, history: [] }
const tankAtom = atom({ plugin: 'tank', key: 'tank' } as const, EMPTY)

const JST_OFFSET = 9 * 3_600_000
const TICK_MS = 250
// 魚が泳ぐ幅とゲージの幅(1行に収める)
const TANK_WIDTH = 14
const BAR_WIDTH = 10
const HISTORY_MAX = 14
// Lv.1 に必要な餌(出力トークン)。以降はレベルごとに倍
const BASE_FOOD = 500

// レベルごとの姿
const STAGES: [number, string, string][] = [
  [0, '🥚', 'たまご'],
  [1, '🐟', 'さかな'],
  [3, '🐠', 'ねったいぎょ'],
  [5, '🐡', 'ふぐ'],
  [7, '🐬', 'いるか'],
  [9, '🦈', 'さめ'],
  [11, '🐋', 'くじら'],
]

const C = { water: '#38bdf8', bubble: '#7dd3fc', food: '#fbbf24', label: '#9ca3af', level: '#facc15', bar: '#4ade80', track: '#374151' }

function stage(level: number): { icon: string; name: string } {
  let found = STAGES[0]!
  for (const s of STAGES) if (level >= s[0]) found = s
  return { icon: found[1], name: found[2] }
}

const levelOf = (food: number) => (food < BASE_FOOD ? 0 : Math.floor(Math.log2(food / BASE_FOOD)) + 1)
const foodFor = (level: number) => (level === 0 ? 0 : BASE_FOOD * 2 ** (level - 1))

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function today(now: number): string {
  const d = new Date(now + JST_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

// 日付が変わっていたら昨日の分を記録に回してリセットする
function rollover(t: Tank, day: string): Tank {
  if (t.day === day) return t
  if (t.day === '') return { ...t, day }
  const done: Day = { day: t.day, food: t.food, level: t.level }
  const isBest = t.best === null || done.level > t.best.level || (done.level === t.best.level && done.food > t.best.food)
  return {
    day,
    food: 0,
    level: 0,
    fedAt: 0,
    best: isBest ? done : t.best,
    history: [...t.history, done].slice(-HISTORY_MAX),
  }
}

async function feed($: EngineInterface, amount: number) {
  const now = await $.clock.now()
  const before = await read($, tankAtom)
  const next = await update($, tankAtom, t => {
    const base = rollover(t ?? EMPTY, today(now))
    const food = base.food + amount
    return { ...base, food, level: levelOf(food), fedAt: now }
  })
  await $.store.set('tank', next)
  if (next.level > before.level && next.day === before.day) {
    const s = stage(next.level)
    $.ui.toast(`🎉 Lv.${next.level} ${s.icon} ${s.name}に成長！`)
  }
}

export const register: Register = on => {
  let working = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'tank', description: '水槽の様子と記録を見る' })
    const saved = await $.store.get('tank')
    const now = await $.clock.now()
    const loaded = saved !== undefined && typeof saved === 'object' ? (saved as Tank) : EMPTY
    await update($, tankAtom, () => rollover(loaded, today(now)))
    // 作業中だけ、泳ぐアニメーションのために描き直す
    $.clock.every(TICK_MS, () => {
      if (working) $.ui.invalidate('ui.render')
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    working = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) working = false
    return next(e)
  })

  // モデルが出力したトークンを餌にする(サブエージェントの分も)
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const food = result.usage?.output_tokens ?? 0
    if (food > 0) await feed($, food)
    return result
  })

  on('command.run', { command: 'tank' }, async ($, e) => {
    const t = await read($, tankAtom)
    const s = stage(t.level)
    const days = [...t.history.slice(-6), { day: t.day, food: t.food, level: t.level }]
    const max = Math.max(1, ...days.map(d => d.level))
    const lines = [
      `${s.icon} 今日: Lv.${t.level} ${s.name} · 餌 ${compact(t.food)} トークン`,
      t.best === null ? '最高記録: まだなし' : `最高記録: Lv.${t.best.level} ${stage(t.best.level).icon} (${t.best.day})`,
      '',
      ...days.map(d => `${d.day.slice(5)} ${'█'.repeat(Math.round((d.level / max) * 12)).padEnd(12, '░')} Lv.${d.level} ${stage(d.level).icon}`),
    ]
    return { text: lines.join('\n') }
  })

  // スピナーの下にレベルと水槽を1行で描く。動く水槽は右端に置いて、文字がずれないようにする
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const spinner = await next(e)
    const t = await read($, tankAtom)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const tick = Math.floor(now / TICK_MS)
    // 魚は水槽の端から端へ往復する(絵文字は2マス)
    const span = TANK_WIDTH - 2
    const pos = tick % (span * 2)
    const x = pos < span ? pos : span * 2 - pos
    const lane = Array.from({ length: TANK_WIDTH }, (_, i) => {
      const phase = (tick + i * 7) % 23
      return i % 5 === 2 && phase < 3 ? ['·', '°', 'o'][phase]! : ' '
    })
    const isEating = now - t.fedAt < 3000
    const left = lane.slice(0, x).join('')
    const right = lane.slice(x + 2).join('')
    const s = stage(t.level)
    const from = foodFor(t.level)
    const to = foodFor(t.level + 1)
    const progress = Math.min(BAR_WIDTH, Math.round(((t.food - from) / Math.max(1, to - from)) * BAR_WIDTH))

    return (
      <Box flexDirection="column">
        {spinner}
        {/* レベルとゲージは縮めず、幅が足りないときは右側の情報と水槽から切り詰める */}
        <Box>
          <Box flexShrink={0}>
            <Text>
              <Text color={C.level} bold>
                Lv.{t.level}
              </Text>
              <Text color={C.label}> {s.name} </Text>
              <Text backgroundColor={C.bar}>{' '.repeat(progress)}</Text>
              <Text backgroundColor={C.track}>{' '.repeat(BAR_WIDTH - progress)}</Text>
            </Text>
          </Box>
          <Text wrap="truncate-end">
            <Text color={C.label}>
              {' '}
              {compact(t.food)}/{compact(to)}
            </Text>
            {t.best !== null && <Text color={C.label}> · 最高 Lv.{t.best.level}</Text>}
            <Text color={C.water}> 🌊</Text>
            <Text color={C.bubble}>{left}</Text>
            <Text>{s.icon}</Text>
            {isEating && <Text color={C.food}>·∴</Text>}
            <Text color={C.bubble}>{isEating ? right.slice(2) : right}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
