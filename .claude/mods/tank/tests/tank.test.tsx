import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-04T03:00:00Z')
const SPINNER = { plugin: 'tank', component: 'Spinner', props: { word: 'Thinking', message: null, suffix: '', mode: 'responding' } } as const

// エンジン側の応答: モデルの1ステップが output_tokens だけ出力する
// store を渡すと、テストから書き換えられる共有の保存先になる(他のセッションの書き込みを再現する)
function engine(on: On, outputs: number[], store?: Map<string, unknown>) {
  if (store === undefined) mock.store(on)
  else {
    on('store.get', async ($, e) => ({ value: store.get(e.key) }))
    on('store.set', async ($, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
  }
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

test('レベルとゲージは縮まない枠に入り、ゲージは常に10マス', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, [600])
  await step($)

  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const fixed = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexShrink === 0)
  expect(fixed).toHaveLength(1)
  // 名前の後ろの区切り1マス + ゲージ10マス
  expect(fixed[0]!.text).toMatch(/^Lv\.1 さかな {11}$/)
  await ui.unmount()
})

test('他のセッションが保存した餌を上書きせず、そこに足す', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  engine(on, [600, 1500], store)
  await step($)
  // 別のセッションが餌をやって保存した
  const saved = store.get('tank') as { food: number }
  store.set('tank', { ...saved, food: saved.food + 3000 })
  await step($)

  expect((store.get('tank') as { food: number }).food).toBe(600 + 3000 + 1500)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('5.1k/8.0k')
  await ui.unmount()
})
