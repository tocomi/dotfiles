import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = { plugin: 'insight', component: 'Pane', requestId: 'insight-learn' } as const
const PANE_PROPS = { title: '学びノート', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const SPINNER = { plugin: 'insight', component: 'Spinner', props: { word: 'Thinking', message: null, suffix: '', mode: 'tool-use' } } as const

// エンジン側の応答: ツールは成功、Haiku は決まった JSON を返す
function engine(on: On) {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.cwd', () => ({ value: '/Users/tocomi/sandbox' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '{"did": "設定を直した", "learn": "mod の $ はトップレベル関数にだけ渡せる"}', usage: {} },
  }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>spinner</Text>
  })
}

async function twoReads($: Engine) {
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_1', file_path: '/Users/tocomi/sandbox/a.ts' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_2', command: 'git status' })
}

test('作業中はスピナーの下にツールの流れを出す', async ($, on) => {
  engine(on)
  await twoReads($)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('spinner')
  expect(texts).toContain('Read a.ts')
  expect(texts).toContain('Bash git status')
  await ui.unmount()
})

test('ターンの終わりに学びを付けて保存し、ペインに並べる', async ($, on) => {
  engine(on)
  await twoReads($)
  const r = await $.turn.complete({ answer: '直しました', durationMs: 75_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(r.text).toContain('🔧 Read×1 Bash×1 · 1m15s')
  expect(r.text).toContain('📝 設定を直した')
  expect(r.text).toContain('💡 mod の $ はトップレベル関数にだけ渡せる')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('💡 mod の $ はトップレベル関数にだけ渡せる')
  expect(texts).toContain('sandbox · 設定を直した')
  await ui.unmount()
})

const BAND = {
  plugin: 'insight',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('依頼のたびに裏でクイズを作り、作業中だけ出題して、回答後は n で次へ進む', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"q": "mod の $ を渡せる関数は？", "choices": ["どこでも", "トップレベル関数", "アロー関数", "クラス"], "answer": 1, "explain": "静的解析のため"}',
      usage: {},
    },
  }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.prompt.submit({ text: '直して', wait: false } as never)
  await clock.advance(10)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('❓ mod の $ を渡せる関数は？')
  await ui.press({ key: 'c1' })
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(after).toContain('正解！')
  expect(after).not.toContain('🔥')
  await ui.unmount()

  // n で次の問題へ
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'next' })
  expect((await band.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('❓ mod の $ を渡せる関数は？')
  expect((await band.findAll({ type: 'Text' })).map(t => t.text).join('')).not.toContain('正解！')
  await band.unmount()

  // 作業が終わったら隠す
  const idle = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect((await idle.findAll({ type: 'Text' })).map(t => t.text).join('')).not.toContain('❓')
  await idle.unmount()
})

test('/quiz でペインを開いて出題し、回答後は n で次へ進む', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  let made = 0
  on('ui.open', () => ({ value: {} }) as never)
  on('model.complete', () => {
    made += 1
    return {
      value: {
        isAnswered: true,
        text: `{"q": "問題${made}", "choices": ["a", "b", "c", "d"], "answer": 2, "explain": "c が正しい"}`,
        usage: {},
      },
    } as never
  })

  const r = await $.command.run({ command: 'quiz', args: '' } as never)
  expect(r.text).toContain('復習クイズを開きました')

  const PANE_Q = {
    plugin: 'insight',
    component: 'Pane',
    requestId: 'insight-quiz',
    props: { title: '復習クイズ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const ui = await $.ui.mount({ ...PANE_Q, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('❓ 問題1')
  await ui.press({ key: 'c0' })
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(after).toContain('残念…')
  expect(after).not.toContain('正解 0/1')

  await ui.press({ key: 'next' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('❓ 問題2')
  await ui.unmount()
})

test('リポジトリのコードを題材に出題する', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  let asked = ''
  on('ui.open', () => ({ value: {} }) as never)
  on('session.repo', () => ({ value: { root: '/repo/app', remote: null, internal: false, name: null } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'src/auth.ts\nyarn.lock\nnode_modules/x.js\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('fs.read', () => ({ value: 'export function login() {\n  return token()\n}\n' }) as never)
  on('model.complete', (_$, e) => {
    asked = e.prompt
    return {
      value: { isAnswered: true, text: '{"q": "login の役割は？", "choices": ["a", "b", "c", "d"], "answer": 0, "explain": "x"}', usage: {} },
    } as never
  })

  await $.command.run({ command: 'quiz', args: '' } as never)
  expect(asked).toContain('リポジトリ「app」の src/auth.ts:1-')
  expect(asked).toContain('export function login()')

  const ui = await $.ui.mount({
    plugin: 'insight',
    component: 'Pane',
    requestId: 'insight-quiz',
    surface: 'terminal',
    props: { title: '復習クイズ', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('出題元: src/auth.ts:1-')
  await ui.unmount()
})
