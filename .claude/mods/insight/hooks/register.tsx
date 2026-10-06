import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note, ToolRun } from '../types'

const notesAtom = atom({ plugin: 'insight', key: 'notes' } as const, [])

const PANE = 'insight-learn'
const NOTES_MAX = 300
const THINKING_MAX = 6000
const JST_OFFSET = 9 * 3_600_000

const C = {
  label: '#9ca3af',
  muted: '#6b7280',
  learn: '#facc15',
  did: '#60a5fa',
  date: '#22d3ee',
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// ツール呼び出しを一言で表す: ファイル名、コマンドの頭、検索語など
function describe(name: string, args: Record<string, unknown>): string {
  if (args.file_path !== undefined) return basename(str(args.file_path))
  if (name === 'Bash') return cut(oneLine(str(args.command)), 32)
  if (args.pattern !== undefined) return cut(str(args.pattern), 24)
  if (args.url !== undefined) return cut(str(args.url).replace(/^https?:\/\//, ''), 28)
  if (args.query !== undefined) return cut(str(args.query), 24)
  if (args.description !== undefined) return cut(str(args.description), 24)
  return ''
}

const shortName = (name: string) => (name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name)

function jstStamp(now: number): string {
  const d = new Date(now + JST_OFFSET)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// ターンの材料から「やったこと」と「学び」を Haiku に書いてもらう
async function summarize(
  $: EngineInterface,
  input: { prompt: string; thinking: string; tools: ToolRun[]; answer: string },
): Promise<{ did: string; learn: string } | null> {
  const toolLines = input.tools.map(t => `- ${t.name} ${t.detail}${t.ok === false ? ' (失敗)' : ''}`).join('\n')
  const prompt = [
    '以下は AI コーディングアシスタントの1ターン分の記録です。',
    '利用者がこのターンから学べることを、日本語で JSON だけで返してください。',
    '{"did": "このターンでやったこと(40字以内)", "learn": "利用者にとっての学び。技術的な事実・コツ・つまずきの理由など(60字以内)。特になければ空文字"}',
    '',
    `## 依頼\n${cut(input.prompt, 1000)}`,
    `## 思考\n${cut(input.thinking, 3000)}`,
    `## ツール\n${cut(toolLines, 1500)}`,
    `## 回答\n${cut(input.answer, 2500)}`,
  ].join('\n')
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 300, effort: 'low', timeoutMs: 20_000 })
  if (!r.isAnswered) return null
  const json = r.text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    return { did: oneLine(str(parsed.did)), learn: oneLine(str(parsed.learn)) }
  } catch {
    return null
  }
}

export const register: Register = on => {
  // このターンの材料。ターンの終わりに学びを書いてもらうのに使う
  let prompt = ''
  let thinking = ''
  let tools: ToolRun[] = []

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'learn', description: '学びノートを開く' })
    const saved = await $.store.get('notes')
    if (Array.isArray(saved)) await update($, notesAtom, () => saved as Note[])
    return result
  })

  // 新しい依頼でターンの材料をリセットする
  on('prompt.submit', async ($, e, next) => {
    prompt = e.text
    thinking = ''
    tools = []
    return next(e)
  })

  // 思考のストリームを横から読み、そのまま流す
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) {
      if (e.agentId === undefined && chunk.kind === 'thinking') thinking = (thinking + chunk.text).slice(-THINKING_MAX)
      yield chunk
    }
    return stream.result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const result = await next(e)
    const run: ToolRun = {
      name: shortName(e.tool),
      detail: describe(e.tool, e as unknown as Record<string, unknown>),
      ok: result.deny === undefined && result.isError !== true,
    }
    tools = [...tools, run]
    return result
  })

  // ターンの終わりに、回答の下へやったことと学びを付ける
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    const lines: string[] = []

    const worthIt = tools.length >= 2 || thinking.length > 500
    const summary = worthIt ? await summarize($, { prompt, thinking, tools, answer: e.answer }) : null
    if (summary !== null && summary.did !== '') lines.push(`📝 ${summary.did}`)
    if (summary !== null && summary.learn !== '') {
      lines.push(`💡 ${summary.learn}`)
      const cwd = await $.session.cwd()
      const note: Note = {
        at: jstStamp(await $.clock.now()),
        dir: basename(cwd),
        prompt: cut(oneLine(prompt), 80),
        did: summary.did,
        learn: summary.learn,
      }
      const notes = await update($, notesAtom, n => [...(n ?? []), note].slice(-NOTES_MAX))
      await $.store.set('notes', notes)
    }

    return lines.length === 0 ? result : { ...result, text: lines.join('\n') }
  })

  on('command.run', { command: 'learn' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: '学びノート', focus: true, closeOnEscape: true })
    const notes = await read($, notesAtom)
    return { text: `学びノート: ${notes.length} 件` }
  })

  // 学びノートのペイン: 新しい順に日付ごとに並べる
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const notes = await read($, notesAtom)
    const { Box, Text } = $.ui.resolve(e)
    if (notes.length === 0) {
      return <Text color={C.label}>まだ学びはありません。ツールを使うターンのあとに溜まっていきます。</Text>
    }
    const rows = [...notes].reverse()
    return (
      <Box flexDirection="column">
        {rows.map((n, i) => {
          const day = n.at.slice(0, 10)
          const isNewDay = i === 0 || rows[i - 1]!.at.slice(0, 10) !== day
          return (
            <Box flexDirection="column">
              {isNewDay && (
                <Text color={C.date} bold>
                  {i > 0 ? '\n' : ''}
                  {day}
                </Text>
              )}
              <Text color={C.learn}>💡 {n.learn}</Text>
              <Text color={C.muted}>
                {'   '}
                {n.at.slice(11)} · {n.dir} · {n.did}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
