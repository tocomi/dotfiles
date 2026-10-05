import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-04T03:00:00Z')
const SPINNER = { plugin: 'tank', component: 'Spinner', props: { word: 'Thinking', message: null, suffix: '', mode: 'responding' } } as const

// エンジン側の応答: モデルの1ステップが output_tokens だけ出力する
function engine(on: On, outputs: number[]) {
  mock.store(on)
  let i = 0
  on('turn.step', async function* () {
    const output_tokens = outputs[i++] ?? 0
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
    } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>spinner</Text>
  })
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)
  for await (const _ of stream) {
  }
  await stream.result
}

test('出力トークンを食べて育ち、スピナーの下に描く', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, [600, 1500])
  await step($)
  await step($)

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('spinner')
  expect(texts).toContain('Lv.3')
  expect(texts).toContain('🐠')
  expect(texts).toContain('2.1k/4.0k')
  await ui.unmount()
  void clock
})

test('日付が変わるとリセットされ、前日の分が最高記録になる', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, [1000, 10])
  await step($)
  await clock.advance(24 * 3_600_000)
  await step($)

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('Lv.0')
  expect(texts).toContain('最高 Lv.2')
  await ui.unmount()
})
