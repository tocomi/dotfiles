import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Note, Question, ToolRun } from '../types'

const liveAtom = atom({ plugin: 'insight', key: 'live' } as const, { thinking: '', tools: [] })
const notesAtom = atom({ plugin: 'insight', key: 'notes' } as const, [])
const quizAtom = atom({ plugin: 'insight', key: 'quiz' } as const, null)
const makingAtom = atom({ plugin: 'insight', key: 'making' } as const, false)

const PANE = 'insight-learn'
const QUIZ_PANE = 'insight-quiz'
const NOTES_MAX = 300
const THINKING_MAX = 6000
const LIVE_TOOLS = 6
const THROTTLE_MS = 250
const JST_OFFSET = 9 * 3_600_000

// 学びノートが少ないうちに出題する分野
const TOPICS = ['TypeScript', 'Git', 'シェルと Unix コマンド', 'Claude Code', 'HTTP と Web', '正規表現', 'React', 'テスト']

const C = {
  ok2: '#22c55e',
  question: '#e5e7eb',
  thinking: '#c4b5fd',
  label: '#9ca3af',
  muted: '#6b7280',
  ok: '#4ade80',
  err: '#f87171',
  learn: '#facc15',
  did: '#60a5fa',
  date: '#22d3ee',
}

const ICON: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  NotebookEdit: '📓',
  Bash: '💻',
  Grep: '🔍',
  Glob: '🗂️',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
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

function seconds(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function jstStamp(now: number): string {
  const d = new Date(now + JST_OFFSET)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// ツールの流れを「Read×5 Grep×3」の形に数える
function tally(tools: ToolRun[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  return [...counts].map(([name, n]) => `${name}×${n}`).join(' ')
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

// クイズの題材にするファイルの拡張子
const QUIZ_EXT = /\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift|sh|zsh|sql|css|scss|html|vue|svelte|md|ya?ml|toml)$/
const QUIZ_SKIP = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\/|\.min\.|lock|\.d\.ts$/
const SNIPPET_LINES = 60
const RECENT_MAX = 20

// 最近出した問題と題材。同じものを続けて出さないために使う
let recentQuestions: string[] = []
let recentFiles: string[] = []

const pickRandom = <T,>(items: readonly T[]): T | undefined => items[Math.floor(Math.random() * items.length)]

// 作業中のリポジトリから、最近使っていないファイルの一部を切り出す
async function pickSnippet($: EngineInterface): Promise<{ label: string; repo: string; text: string } | null> {
  const repo = await $.session.repo()
  if (repo === null) return null
  const listed = await $.process.run(['git', '-C', repo.root, 'ls-files'])
  if (listed.exitCode !== 0) return null
  const files = listed.stdout.split('\n').filter(f => QUIZ_EXT.test(f) && !QUIZ_SKIP.test(f))
  const fresh = files.filter(f => !recentFiles.includes(f))
  const path = pickRandom(fresh.length > 0 ? fresh : files)
  if (path === undefined) return null
  const text = await $.fs.read(`${repo.root}/${path}`)
  if (typeof text !== 'string' || text.trim() === '') return null
  const lines = text.split('\n')
  const start = Math.floor(Math.random() * Math.max(1, lines.length - SNIPPET_LINES))
  const end = Math.min(lines.length, start + SNIPPET_LINES)
  recentFiles = [...recentFiles, path].slice(-RECENT_MAX)
  return { label: `${path}:${start + 1}-${end}`, repo: basename(repo.root), text: lines.slice(start, end).join('\n') }
}

// 4択クイズを1問作って出題待ちにする。題材はリポジトリのコードを主に、ときどき学びノートから
async function makeQuiz($: EngineInterface): Promise<boolean> {
  const notes = (await read($, notesAtom)).slice(-30)
  const useNote = notes.length > 0 && Math.random() < 0.2
  // リポジトリの外や読めないファイルなら、学びノートか分野から出す
  const snippet = useNote ? null : await pickSnippet($).catch(() => null)
  const note = snippet === null ? (pickRandom(notes) ?? null) : null
  const topic = pickRandom(TOPICS)!
  const source = snippet !== null ? snippet.label : note !== null ? note.learn : topic
  const task =
    snippet !== null
      ? [
          `次のコードは、利用者が作業中のリポジトリ「${snippet.repo}」の ${snippet.label} です。`,
          'このコードの理解を確かめる4択クイズを1問作ってください。',
          '関数や値の役割、処理の流れ、なぜそう書かれているか、を問うものにし、行番号や細かい字面の暗記は問わないでください。',
          '```',
          cut(snippet.text, 4000),
          '```',
        ].join('\n')
      : note !== null
        ? `次の学びを復習する4択クイズを1問作ってください。\n学び: ${note.learn}\n背景: ${note.did}`
        : `「${topic}」について、ソフトウェアエンジニア向けの4択クイズを1問作ってください。`
  const prompt = [
    task,
    recentQuestions.length > 0 ? `最近出した問題とは違う観点にしてください:\n${recentQuestions.map(q => `- ${q}`).join('\n')}` : '',
    '日本語で、JSON だけを返してください。',
    '{"q": "問題文(60字以内)", "choices": ["選択肢(各25字以内)", "", "", ""], "answer": 正解の添字(0-3), "explain": "解説(60字以内)"}',
  ]
    .filter(line => line !== '')
    .join('\n')
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 400, effort: 'low', timeoutMs: 20_000 })
  if (!r.isAnswered) return false
  const json = r.text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return false
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const choices = Array.isArray(parsed.choices) ? parsed.choices.map(str).filter(c => c !== '') : []
    const answer = typeof parsed.answer === 'number' ? parsed.answer : -1
    if (choices.length !== 4 || answer < 0 || answer > 3 || str(parsed.q) === '') return false
    const question: Question = { q: str(parsed.q), choices, answer, explain: str(parsed.explain), source: cut(source, 60) }
    recentQuestions = [...recentQuestions, question.q].slice(-RECENT_MAX)
    await update($, quizAtom, () => ({ question, picked: null }))
    return true
  } catch {
    return false
  }
}

// 今の問題を捨てて次の問題を作る。作っている間は making を立てる(重ねては作らない)
async function nextQuiz($: EngineInterface): Promise<boolean> {
  if (await read($, makingAtom)) return false
  await update($, quizAtom, () => null)
  await update($, makingAtom, () => true)
  try {
    return await makeQuiz($)
  } finally {
    await update($, makingAtom, () => false)
  }
}

async function answerQuiz($: EngineInterface, picked: number) {
  const quiz = await read($, quizAtom)
  if (quiz === null || quiz.picked !== null) return
  await update($, quizAtom, () => ({ ...quiz, picked }))
}

export const register: Register = on => {
  // このターンの材料。描画に使う分は liveAtom にも写す
  let prompt = ''
  let thinking = ''
  let tools: ToolRun[] = []
  let lastPush = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'learn', description: '学びノートを開く' })
    await $.command.register({ name: 'quiz', description: '復習クイズを解く(成績も見られる)' })
    const saved = await $.store.get('notes')
    if (Array.isArray(saved)) await update($, notesAtom, () => saved as Note[])
    return result
  })

  // 新しい依頼でターンの材料をリセットする
  on('prompt.submit', async ($, e, next) => {
    prompt = e.text
    thinking = ''
    tools = []
    await update($, liveAtom, () => ({ thinking: '', tools: [] }))
    // 回答済み(か未作成)なら、次の問題を裏で作り始める
    const quiz = await read($, quizAtom)
    if (quiz === null || quiz.picked !== null) {
      $.clock.after(0, () => {
        void nextQuiz($)
      })
    }
    return next(e)
  })

  // 思考のストリームを横から読み、そのまま流す。描き直しは間引く
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) {
      if (e.agentId === undefined && chunk.kind === 'thinking') {
        thinking = (thinking + chunk.text).slice(-THINKING_MAX)
        const now = await $.clock.now()
        if (now - lastPush >= THROTTLE_MS) {
          lastPush = now
          const latest = thinking
          await update($, liveAtom, l => ({ ...(l ?? { tools: [] }), thinking: latest }))
        }
      }
      yield chunk
    }
    return stream.result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const run: ToolRun = { name: shortName(e.tool), detail: describe(e.tool, e as unknown as Record<string, unknown>) }
    const index = tools.length
    tools = [...tools, run]
    await update($, liveAtom, l => ({ thinking: l?.thinking ?? thinking, tools }))
    const startedAt = await $.clock.now()
    const result = await next(e)
    // state に渡した値は書き換えず、終わった呼び出しを新しい値で差し替える
    const done: ToolRun = {
      ...run,
      ms: (await $.clock.now()) - startedAt,
      ok: result.deny === undefined && result.isError !== true,
    }
    tools = tools.map((t, i) => (i === index ? done : t))
    await update($, liveAtom, l => ({ thinking: l?.thinking ?? thinking, tools }))
    return result
  })

  // ターンの終わりに、回答の下へツールのまとめと学びを付ける
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    const lines: string[] = []
    if (tools.length > 0) lines.push(`🔧 ${tally(tools)} · ${seconds(e.durationMs)}`)

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

    await update($, liveAtom, () => ({ thinking: '', tools: [] }))
    return lines.length === 0 ? result : { ...result, text: lines.join('\n') }
  })

  // ペインを先に開き、出題待ちの問題がなければその場で作る
  on('command.run', { command: 'quiz' }, async ($, e) => {
    await $.ui.open({ id: QUIZ_PANE, title: '復習クイズ', focus: true, closeOnEscape: true })
    const quiz = await read($, quizAtom)
    if (quiz !== null && quiz.picked === null) return { text: '復習クイズを開きました' }
    const isMade = await nextQuiz($)
    return { text: isMade ? '復習クイズを開きました' : '問題を作れませんでした。ペインで n を押すと作り直します' }
  })

  on('command.run', { command: 'learn' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: '学びノート', focus: true, closeOnEscape: true })
    const notes = await read($, notesAtom)
    return { text: `学びノート: ${notes.length} 件` }
  })

  // 作業中はスピナーの下に、最新の思考とツールの流れを出す
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const spinner = await next(e)
    const live = await read($, liveAtom)
    if (live.thinking === '' && live.tools.length === 0) return spinner

    const { Box, Text } = $.ui.resolve(e)
    const thought = oneLine(live.thinking).slice(-300)
    const recent = live.tools.slice(-LIVE_TOOLS)
    const hidden = live.tools.length - recent.length
    return (
      <Box flexDirection="column">
        {spinner}
        {thought !== '' && (
          <Text color={C.thinking} wrap="truncate-start">
            💭 {thought}
          </Text>
        )}
        {recent.length > 0 && (
          <Text wrap="truncate-end">
            {hidden > 0 && <Text color={C.muted}>+{hidden} → </Text>}
            {recent.map((t, i) => (
              <Text>
                {i > 0 && <Text color={C.muted}> → </Text>}
                <Text>{ICON[t.name] ?? '🔧'} </Text>
                <Text color={t.ok === false ? C.err : C.label}>
                  {t.name}
                  {t.detail !== '' && ` ${t.detail}`}
                </Text>
                {t.ms === undefined ? (
                  <Text color={C.muted}> …</Text>
                ) : (
                  <Text color={C.muted}> {seconds(t.ms)}</Text>
                )}
              </Text>
            ))}
          </Text>
        )}
      </Box>
    )
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
  // 作業中だけ、プロンプトの上に復習クイズを出す。回答したら n で次の問題へ
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const quiz = await read($, quizAtom)
    const isMakingQuiz = await read($, makingAtom)
    const theirs = await next(e)
    if (e.props.hasSurvey || !e.props.isWorking || (quiz === null && !isMakingQuiz)) return theirs

    const { Box, Button, Text } = $.ui.resolve(e)
    if (quiz === null) {
      return (
        <Box flexDirection="column">
          <Text color={C.muted}>❓ 次の問題を作っています…</Text>
          {theirs}
        </Box>
      )
    }
    const { question, picked } = quiz
    const isCorrect = picked === question.answer
    return (
      <Box flexDirection="column">
        <Text color={C.question} bold>
          ❓ {question.q}
        </Text>
        {picked === null ? (
          <Box flexDirection="column">
            {question.choices.map((choice, i) => (
              <Button key={`c${i}`} label={choice} hotkey={String(i + 1)} plain onPress={() => answerQuiz($, i)} />
            ))}
            <Text color={C.muted}>クリックか ctrl+x → Tab で選んで数字キー</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {question.choices.map((choice, i) => (
              <Text color={i === question.answer ? C.ok2 : i === picked ? C.err : C.muted}>
                {i === question.answer ? '✔' : i === picked ? '✘' : ' '} {i + 1}: {choice}
              </Text>
            ))}
            <Text color={isCorrect ? C.ok2 : C.err} bold>
              {isCorrect ? '正解！' : '残念…'}
              <Text color={C.label}> {question.explain}</Text>
            </Text>
            <Button key="next" label="次の問題" hotkey="n" plain onPress={() => nextQuiz($)} />
          </Box>
        )}
        {theirs}
      </Box>
    )
  })

  // /quiz のペイン: 数字キーで回答、n で次の問題。成績も出す
  on('ui.render', { component: 'Pane', requestId: QUIZ_PANE }, async ($, e) => {
    const quiz = await read($, quizAtom)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (quiz === null) {
      return (
        <Box flexDirection="column">
          <Text color={C.label}>問題を作っています…</Text>
          <Button key="next" label="作り直す" hotkey="n" plain onPress={() => nextQuiz($)} />
        </Box>
      )
    }
    const { question, picked } = quiz
    const isCorrect = picked === question.answer
    return (
      <Box flexDirection="column">
        <Text color={C.question} bold>
          ❓ {question.q}
        </Text>
        <Text color={C.muted}>出題元: {question.source}</Text>
        <Text> </Text>
        {picked === null
          ? question.choices.map((choice, i) => (
              <Button key={`c${i}`} label={choice} hotkey={String(i + 1)} plain onPress={() => answerQuiz($, i)} />
            ))
          : question.choices.map((choice, i) => (
              <Text color={i === question.answer ? C.ok2 : i === picked ? C.err : C.muted}>
                {i === question.answer ? '✔' : i === picked ? '✘' : ' '} {i + 1}: {choice}
              </Text>
            ))}
        {picked !== null && (
          <Box flexDirection="column">
            <Text color={isCorrect ? C.ok2 : C.err} bold>
              {'\n'}
              {isCorrect ? '正解！' : '残念…'}
              <Text color={C.label}> {question.explain}</Text>
            </Text>
            <Button key="next" label="次の問題" hotkey="n" plain onPress={() => nextQuiz($)} />
          </Box>
        )}
      </Box>
    )
  })
}
