import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = { plugin: 'insight', component: 'Pane', requestId: 'insight-learn' } as const
const PANE_PROPS = { title: '学びノート', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

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

test('ターンの終わりに学びを付けて保存し、ペインに並べる', async ($, on) => {
  engine(on)
  await twoReads($)
  const r = await $.turn.complete({ answer: '直しました', durationMs: 75_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(r.text).not.toContain('🔧')
  expect(r.text).toContain('📝 設定を直した')
  expect(r.text).toContain('💡 mod の $ はトップレベル関数にだけ渡せる')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('💡 mod の $ はトップレベル関数にだけ渡せる')
  expect(texts).toContain('sandbox · 設定を直した')
  await ui.unmount()
})
