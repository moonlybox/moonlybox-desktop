/**
 * #256.3 对话上下文：会话组装/压缩触发/重试次数——settings 驱动（XDG 隔离）。
 */
import { describe, test, expect, mock } from 'bun:test'

process.env.XDG_CONFIG_HOME = '/tmp/mf-chatctx-' + Date.now()
const { buildMessages, appendTurn, chatWithRetry, getSession, clearSession } = await import('../src/lib/chat-context')
const { saveSettings } = await import('../src/lib/settings')

describe('#256.3 上下文管理', () => {
  test('默认（contextEnabled）携带历史', () => {
    clearSession('s1')
    appendTurn('s1', '你好', '幸会')
    const { messages } = buildMessages('s1', 'SYS', '新问题')
    expect(messages.some((m) => m.role === 'user' && m.content === '你好')).toBe(true)
    expect(String(messages.at(-1)?.content)).toBe('新问题')
  })
  test('contextEnabled=false 不携带历史', () => {
    appendTurn('s2', '旧问题', '旧回答')
    saveSettings({ chat: { contextEnabled: false } })
    const { messages } = buildMessages('s2', 'SYS', '新问题')
    expect(messages.some((m) => m.role === 'user' && m.content === '旧问题')).toBe(false)
    saveSettings({ chat: { contextEnabled: true } })
  })
  test('autoCompress+阈值触发压缩（摘要占位+历史收缩）', () => {
    clearSession('s3')
    saveSettings({ chat: { contextEnabled: true, autoCompress: true, compressThreshold: 50, compressTarget: 10 } })
    for (let i = 0; i < 30; i++) appendTurn('s3', `问题${i} ${'x'.repeat(200)}`, `回答${i} ${'x'.repeat(200)}`)
    const { compressed, messages } = buildMessages('s3', 'SYS', '新问题')
    expect(compressed).toBe(true)
    expect(String(messages[0]?.content).startsWith('[CONTEXT_SUMMARY]')).toBe(true)
    expect(messages.some((m) => m.role === 'user' && m.content === '问题0 ' + 'x'.repeat(200))).toBe(false)
  })
  test('chatWithRetry 成功即停', async () => {
    let n = 0
    const r = await chatWithRetry(async () => { n++; return { ok: true } })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(n).toBe(1)
  })
  test('chatWithRetry 按设置重试后成功', async () => {
    saveSettings({ chat: { maxRetries: 3 } })
    let n = 0
    const r = await chatWithRetry(async () => { n++; return n < 3 ? { ok: false, error: 'e' } : { ok: true } })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(3)
  }, 120_000)
  test('chatWithRetry 重试耗尽报错', async () => {
    saveSettings({ chat: { maxRetries: 2 } })
    const r = await chatWithRetry(async () => ({ ok: false, error: 'bad' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('重试 2 次')
  }, 60_000)
})
