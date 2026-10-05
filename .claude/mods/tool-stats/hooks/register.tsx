import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Stats } from '../types'

const EMPTY: Stats = { tools: {}, files: {}, bash: {} }

const sessionAtom = atom({ plugin: 'tool-stats', key: 'session' } as const, EMPTY)
const totalsAtom = atom({ plugin: 'tool-stats', key: 'totals' } as const, EMPTY)
const scopeAtom = atom({ plugin: 'tool-stats', key: 'scope' } as const, 'session')

const PANE = 'tool-stats'
const TOP = 8
// サブコマンドまで含めて数えるコマンド
const SUBCOMMANDS = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'claude', 'docker', 'brew', 'cargo', 'go', 'kubectl'])

const C = {
  title: '#22d3ee',
  bar: '#60a5fa',
  err: '#f87171',
  label: '#e5e7eb',
  muted: '#9ca3af',
  track: '#374151',
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// Bash のコマンドを集計用のキーにする。先頭の cd ... && は飛ばす
function commandKey(command: string): string {
  const segment =
    command
      .split(/&&|;|\|\|/)
      .map(s => s.trim())
      .find(s => s !== '' && !s.startsWith('cd ')) ?? command.trim()
  const [first = '', second = ''] = segment.split(/\s+/)
  const name = first.split('/').pop() ?? first
  return SUBCOMMANDS.has(name) && second !== '' && !second.startsWith('-') ? `${name} ${second}` : name
}

const shortName = (name: string) => (name.startsWith('mcp__') ? (name.split('__').slice(1).join(':') ?? name) : name)

function add(stats: Stats, tool: string, ms: number, isError: boolean, file: string, bash: string): Stats {
  const t = stats.tools[tool] ?? { n: 0, ms: 0, err: 0 }
  return {
    tools: { ...stats.tools, [tool]: { n: t.n + 1, ms: t.ms + ms, err: t.err + (isError ? 1 : 0) } },
    files: file === '' ? stats.files : { ...stats.files, [file]: (stats.files[file] ?? 0) + 1 },
    bash: bash === '' ? stats.bash : { ...stats.bash, [bash]: (stats.bash[bash] ?? 0) + 1 },
  }
}

function top(record: Record<string, number>): [string, number][] {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
}

function avg(ms: number, n: number): string {
  const v = ms / Math.max(1, n)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
}

async function recordCall($: EngineInterface, tool: string, ms: number, isError: boolean, file: string, bash: string) {
  await update($, sessionAtom, s => add(s ?? EMPTY, tool, ms, isError, file, bash))
  const totals = await update($, totalsAtom, s => add(s ?? EMPTY, tool, ms, isError, file, bash))
  await $.store.set('totals', totals)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'tools', description: 'ツールの使い方の統計を開く' })
    const saved = await $.store.get('totals')
    if (saved !== undefined && typeof saved === 'object') await update($, totalsAtom, () => saved as Stats)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const args = e as unknown as Record<string, unknown>
    const tool = shortName(e.tool)
    const isError = result.deny !== undefined || result.isError === true
    // 読んだファイルは Read だけ数える。パスはセッションの場所からの相対にする
    const cwd = await $.session.cwd()
    const path = e.tool === 'Read' ? str(args.file_path) : ''
    const file = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
    const bash = e.tool === 'Bash' ? commandKey(str(args.command)) : ''
    await recordCall($, tool, ms, isError, file, bash)
    return result
  })

  on('command.run', { command: 'tools' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'ツール統計', focus: true, closeOnEscape: true })
    return { text: 'ツール統計を開きました' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const scope = await read($, scopeAtom)
    const stats = scope === 'all' ? await read($, totalsAtom) : await read($, sessionAtom)
    const { Box, Button, Text } = $.ui.resolve(e)

    const tools = Object.entries(stats.tools).sort((a, b) => b[1].n - a[1].n)
    const max = Math.max(1, ...tools.map(([, t]) => t.n))
    const total = tools.reduce((sum, [, t]) => sum + t.n, 0)
    const nameWidth = Math.min(18, Math.max(6, ...tools.map(([name]) => name.length)))
    const barWidth = Math.max(8, Math.min(30, e.props.bodyColumns - nameWidth - 24))

    const section = (title: string) => (
      <Text color={C.title} bold>
        {'\n'}
        {title}
      </Text>
    )
    const ranking = (rows: [string, number][]) =>
      rows.map(([key, n]) => (
        <Text>
          <Text color={C.muted}>{String(n).padStart(4)} </Text>
          <Text color={C.label}>{key}</Text>
        </Text>
      ))

    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="session"
            label="このセッション"
            hotkey="1"
            variant={scope === 'session' ? 'primary' : 'secondary'}
            onPress={() => update($, scopeAtom, () => 'session')}
          />
          <Text> </Text>
          <Button
            key="all"
            label="累計"
            hotkey="2"
            variant={scope === 'all' ? 'primary' : 'secondary'}
            onPress={() => update($, scopeAtom, () => 'all')}
          />
          <Text color={C.muted}> 計 {total} 回</Text>
        </Box>

        {section('ツール')}
        {tools.length === 0 && <Text color={C.muted}>まだツールは使われていません</Text>}
        {tools.map(([name, t]) => {
          const filled = Math.max(1, Math.round((t.n / max) * barWidth))
          return (
            <Text>
              <Text color={C.label}>{name.padEnd(nameWidth).slice(0, nameWidth)} </Text>
              <Text color={C.bar}>{'█'.repeat(filled)}</Text>
              <Text color={C.track}>{'░'.repeat(barWidth - filled)}</Text>
              <Text color={C.label}> {t.n}</Text>
              <Text color={C.muted}> · 平均 {avg(t.ms, t.n)}</Text>
              {t.err > 0 && <Text color={C.err}> · 失敗 {t.err}</Text>}
            </Text>
          )
        })}

        {Object.keys(stats.files).length > 0 && section('よく読んだファイル')}
        {ranking(top(stats.files))}

        {Object.keys(stats.bash).length > 0 && section('よく使った Bash')}
        {ranking(top(stats.bash))}
      </Box>
    )
  })
}
