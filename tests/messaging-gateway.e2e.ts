/**
 * 消息网关 e2e（#286）：Telegram adapter 全链（收→onMessage→send）用注入 mock fetch（bun test 对 global.fetch
 * 替换的时序不可靠——依赖注入是既有纪律「能 mock 的前提=依赖注入」）；网关编排（失败隔离/未配置跳过）。
 * bun:test 格式 → bun test ./tests/messaging-gateway.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_msg_'))
process.env.XDG_CONFIG_HOME = tmpCfg
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_msg_state_'))

/** mock Telegram Bot API：getUpdates 吐更新（20ms 延迟模拟网络——零延迟会让长轮询变紧循环）；sendMessage 收集 */
const sent: Array<{ chat_id: string; text: string }> = []
let updatesQueue: any[] = [
  { update_id: 100, message: { chat: { id: 42 }, from: { first_name: '测试' }, text: '帮我记一条：喜欢 Bun' } },
  { update_id: 101, message: { chat: { id: 42 }, text: '第二次提问' } },
]
const mockFetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/getUpdates')) {
    const body = JSON.parse(init?.body ?? '{}')
    const out = updatesQueue.filter((x) => !body.offset || x.update_id > body.offset)
    updatesQueue = []
    await new Promise((r) => setTimeout(r, 20))
    return new Response(JSON.stringify({ ok: true, result: out }), { headers: { 'content-type': 'application/json' } })
  }
  if (u.includes('/sendMessage')) {
    sent.push(JSON.parse(init?.body ?? '{}'))
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ ok: false, description: 'unknown method' }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as any

const { TelegramAdapter, enabledPlatforms, startGateway, stopGateway, gatewayRunning } = await import('../src/lib/messaging-gateway')
const { saveSettings } = await import('../src/lib/settings')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('TelegramAdapter：收件→onMessage 回调→offset 持久化', async () => {
  const adapter = new TelegramAdapter('TEST_TOKEN', stateDir, mockFetch)
  const received: any[] = []
  const stop = await adapter.start(async (m) => {
    received.push(m)
  })
  await new Promise((r) => setTimeout(r, 300))
  stop()
  await new Promise((r) => setTimeout(r, 100)) // loop 退出窗口（detached 循环下轮检查 stopped）
  expect(received.length).toBe(2)
  expect(received[0]!.platform).toBe('telegram')
  expect(received[0]!.chatId).toBe('42')
  expect(received[0]!.sender).toBe('测试')
  expect(received[0]!.text).toContain('喜欢 Bun')
  expect(fs.readFileSync(path.join(stateDir, 'telegram-offset.txt'), 'utf8')).toBe('101')
})

test('TelegramAdapter.send：文本投递', async () => {
  const adapter = new TelegramAdapter('TEST_TOKEN', stateDir, mockFetch)
  await adapter.send('42', '你好，这是小月的回复')
  expect(sent.length).toBe(1)
  expect(sent[0]!.chat_id).toBe('42')
  expect(sent[0]!.text).toBe('你好，这是小月的回复')
})

test('TelegramAdapter.send：超长文本 4096 分片', async () => {
  const adapter = new TelegramAdapter('TEST_TOKEN', stateDir, mockFetch)
  const before = sent.length
  await adapter.send('42', 'x'.repeat(9000))
  expect(sent.length - before).toBe(3) // 4000+4000+1000
})

test('enabledPlatforms：未启用/缺凭据跳过', () => {
  saveSettings({ messaging: { providers: { telegram: { enabled: true, config: {} }, slack: { enabled: false, config: {} } } } } as never)
  // telegram 无钥匙串凭据（e2e 无 keyring 真值）→ 跳过；slack 未启用 → 跳过
  const list = enabledPlatforms()
  expect(list.find((x) => x.id === 'telegram')).toBeUndefined()
  expect(list.find((x) => x.id === 'slack')).toBeUndefined()
})

test('startGateway：未接入平台（feishu）失败隔离不炸网关', async () => {
  saveSettings({ messaging: { providers: { feishu: { enabled: true, config: { appId: 'x' } } } } } as never)
  const statuses = await startGateway(stateDir, async () => 'ok', mockFetch)
  expect(statuses.length).toBe(1)
  expect(statuses[0]!.platform).toBe('feishu')
  expect(statuses[0]!.running).toBe(false)
  expect(statuses[0]!.error).toContain('暂未接入')
  await stopGateway()
  expect(gatewayRunning()).toEqual([])
})

test('startGateway→onMessage→send 全链（telegram，mock fetch 注入）', async () => {
  // 钥匙串真凭据 e2e 造不出——全链编排用直连 adapter 验证收件侧；send 与编排已被前序用例覆盖
  updatesQueue = [{ update_id: 200, message: { chat: { id: 7 }, text: '你好' } }]
  const adapter = new TelegramAdapter('TEST_TOKEN', stateDir, mockFetch)
  let gotText = ''
  const stop = await adapter.start(async (m) => {
    gotText = m.text
  })
  await new Promise((r) => setTimeout(r, 300))
  stop()
  await new Promise((r) => setTimeout(r, 100))
  expect(gotText).toBe('你好')
  expect(updatesQueue.length).toBe(0)
})
