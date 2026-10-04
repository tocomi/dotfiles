import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-04T03:00:00Z')

const BAND = {
  plugin: 'status-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// エンジン側の応答: cwd と、他に何も描かれていないバンド
function engine(on: On) {
  on('session.cwd', () => ({ value: '/Users/tocomi/sandbox' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

test('コンテキストとレート制限をバンドに描く', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)

  await $.session.measure({
    context: { tokens: 104_000, window: 200_000, percent: 52 },
    rateLimits: [
      // 61% 使用 → 残り 39%
      { kind: 'five_hour', percentUsed: 61, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    expect(texts).toContain('📁 sandbox')
    expect(texts).toContain('🪣 ctx  52%')
    expect(texts).toContain('🕐 5h  39%')
    expect(texts).toContain('🗓️ 7d  88%')
    expect(texts).toContain('↺15:00')
    expect(texts).not.toMatch(/[█░]/)
    await ui.unmount()
  }
})

test('アンケート表示中はバンドを譲る', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /sandbox/ })).toBeUndefined()
  await ui.unmount()
})

test('使用量がまだ届いていなくても描く', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(texts).toContain('sandbox')
  expect(texts).toContain('ctx  --')
  await ui.unmount()
})
