import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'tool-stats',
  component: 'Pane',
  requestId: 'tool-stats',
  props: { title: 'ツール統計', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('ツール・ファイル・Bash コマンドを集計してペインに出す', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.cwd', () => ({ value: '/Users/tocomi/sandbox' }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/Users/tocomi/sandbox/src/a.ts' })
  await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: '/Users/tocomi/sandbox/src/a.ts' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 't3', command: 'cd /tmp && git status --short' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 't4', command: 'ls -la' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain('計 4 回')
    expect(texts).toMatch(/Read\s+█+░* 2/)
    expect(texts).toContain('   2 src/a.ts')
    expect(texts).toContain('   1 git status')
    expect(texts).toContain('   1 ls')

    await ui.press({ key: 'all' })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(all).toContain('計 4 回')
    await ui.unmount()
  }
})
