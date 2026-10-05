import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, ModelInfo, Usage } from '../types'

const branchAtom = atom({ plugin: 'status-band', key: 'branch' } as const, null)
const modelAtom = atom({ plugin: 'status-band', key: 'model' } as const, null)
const usageAtom = atom({ plugin: 'status-band', key: 'usage' } as const, null)

const BAR_WIDTH = 12
const HOUR = 3_600_000
const JST_OFFSET = 9 * HOUR
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const LIMIT_ICON: Record<string, string> = { five_hour: '🕐', seven_day: '🗓️' }

const C = {
  subtext: '#9ca3af',
  muted: '#4b5563',
  surface: '#374151',
  base: '#111827',
  dir: '#60a5fa',
  branch: '#4ade80',
  model: '#22d3ee',
}

const EFFORT_COLOR: Record<string, string> = {
  low: '#9ca3af',
  medium: '#4ade80',
  high: '#facc15',
  xhigh: '#f87171',
  max: '#f87171',
}

// 使用率 0..100 を 緑 → 黄 → 橙 → 赤 のグラデーションに写す
const STOPS: [number, number, number, number][] = [
  [0, 0x22, 0xc5, 0x5e],
  [0.55, 0xea, 0xb3, 0x08],
  [0.8, 0xf9, 0x73, 0x16],
  [1, 0xef, 0x44, 0x44],
]

function levelColor(usedPercent: number): string {
  const x = Math.min(1, Math.max(0, usedPercent / 100))
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, r1, g1, b1] = STOPS[i]!
    const [p0, r0, g0, b0] = STOPS[i - 1]!
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0)
      const mix = (a: number, b: number) => Math.round(a + (b - a) * k)
      return '#' + [mix(r0, r1), mix(g0, g1), mix(b0, b1)].map(v => v.toString(16).padStart(2, '0')).join('')
    }
  }
  return '#ef4444'
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// リセット時刻を JST で。今日なら HH:MM、別の日なら MM/DD HH:MM
function resetLabel(resetsAt: number, now: number): string {
  const d = new Date(resetsAt + JST_OFFSET)
  const today = new Date(now + JST_OFFSET)
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  const sameDay = d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate()
  return sameDay ? time : `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${time}`
}

// 表示する指標ひとつ分: 絵文字、ラベル、値の文字列、ゲージの塗り(%)、色、補足
type Metric = { icon: string; label: string; value: string; fill: number; color: string; note?: string }

async function refreshBranch($: EngineInterface) {
  const cwd = await $.session.cwd()
  const head = await $.process.run(['git', '-C', cwd, 'symbolic-ref', '--short', 'HEAD'])
  let branch: string | null = head.exitCode === 0 ? head.stdout.trim() : null
  if (branch === null) {
    // detached HEAD ならコミットの短縮ハッシュ、リポジトリ外なら null
    const rev = await $.process.run(['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'])
    branch = rev.exitCode === 0 ? `@${rev.stdout.trim()}` : null
  }
  await update($, branchAtom, () => branch)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshBranch($)
    const u = await $.session.usage()
    const usage: Usage = {
      ctxPercent: u.context.percent,
      limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }
    await update($, usageAtom, () => usage)
    const name = await $.session.model()
    await update($, modelAtom, m => ({ ...m, name }))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const usage: Usage = {
      ctxPercent: e.context.percent,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }
    await update($, usageAtom, () => usage)
    return next(e)
  })

  // turn.step はストリーミングのイベントなので async generator で受けて流す
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const name = await $.session.model()
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const info: ModelInfo = effort === undefined ? { name } : { name, effort }
      await update($, modelAtom, () => info)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshBranch($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const branch = await read($, branchAtom)
    const model = await read($, modelAtom)
    const usage = await read($, usageAtom)
    const cwd = await $.session.cwd()
    const now = await $.clock.now()

    const { Box, Text } = $.ui.resolve(e)

    // 指標をまとめる。どれも残量で塗り、色は使用量で決める
    const ctx = usage?.ctxPercent
    const ctxLeft = ctx === undefined ? undefined : clamp(100 - ctx, 0, 100)
    const metrics: Metric[] = [
      {
        icon: '🪣',
        label: 'ctx',
        value: ctxLeft === undefined ? '--' : `${ctxLeft}%`,
        fill: ctxLeft ?? 0,
        color: levelColor(ctx ?? 0),
      },
      ...(usage?.limits ?? [])
        .filter((l: Limit) => l.kind in LIMIT_LABEL)
        .map((l: Limit): Metric => {
          const left = clamp(Math.round(100 - l.percentUsed), 0, 100)
          const resetsAt = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
          const metric: Metric = {
            icon: LIMIT_ICON[l.kind]!,
            label: LIMIT_LABEL[l.kind]!,
            value: `${left}%`,
            fill: left,
            color: levelColor(l.percentUsed),
          }
          return Number.isFinite(resetsAt) ? { ...metric, note: `↺${resetLabel(resetsAt, now)}` } : metric
        }),
    ]

    const sep = <Text color={C.muted}> │ </Text>

    // ラベルはバーの外、値はバーの中。塗った部分の背景色で量を見せる
    const bar = (m: Metric) => {
      const text = ` ${m.value}`.padEnd(BAR_WIDTH).slice(0, BAR_WIDTH)
      const filled = Math.round((clamp(m.fill, 0, 100) / 100) * BAR_WIDTH)
      return (
        <Box>
          <Text>{m.icon} </Text>
          <Text color={C.subtext}>{m.label} </Text>
          <Text backgroundColor={m.color} color={C.base} bold>
            {text.slice(0, filled)}
          </Text>
          <Text backgroundColor={C.surface} color={C.subtext}>
            {text.slice(filled)}
          </Text>
          {m.note !== undefined && <Text color={C.subtext}> {m.note}</Text>}
        </Box>
      )
    }

    // 1行目: ディレクトリ・ブランチ
    const dir = cwd.split('/').filter(Boolean).pop() ?? cwd
    const row1 = (
      <Box>
        <Text color={C.dir} bold>
          📁 {dir}
        </Text>
        {branch !== null && sep}
        {branch !== null && <Text color={C.branch}>🌱 {branch}</Text>}
      </Box>
    )

    // 2行目: モデル(effort)・コンテキスト
    const [ctxMetric, ...limitMetrics] = metrics
    const effort = model?.effort
    const row2 = (
      <Box>
        <Text color={C.model} bold>
          🤖 {model?.name ?? '…'}
        </Text>
        {effort !== undefined && <Text color={EFFORT_COLOR[effort] ?? C.subtext}> ({effort})</Text>}
        {sep}
        {bar(ctxMetric!)}
      </Box>
    )

    // 3行目: レート制限。1行に収まらない幅では縦に並べる
    const row3 =
      limitMetrics.length === 0 ? null : e.props.bodyColumns < 72 ? (
        limitMetrics.map(bar)
      ) : (
        <Box>
          {limitMetrics.map((m, i) => (
            <Box>
              {i > 0 && sep}
              {bar(m)}
            </Box>
          ))}
        </Box>
      )

    // 同じ場所に描く他の mod(insight のクイズなど)の分も残す
    const theirs = await next(e)

    return (
      <Box flexDirection="column">
        {row1}
        {row2}
        {row3}
        {theirs}
      </Box>
    )
  })
}
