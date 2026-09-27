
/**
 * 钉钉 Stream 模式 e2e（#286 第二批）：mock fetch + mock ws（可编程服务端）全链。
 * bun:test 格式 → bun test ./tests/messaging-dingtalk.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_dt_'))
process.env.XDG_CONFIG_HOME = tmpCfg

/** mock ws 服务端：单客户端，可编程推帧，收集客户端发来的帧 */
class MockWs {
  static instances: MockWs[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(public url: string) {
    MockWs.instances.push(this)
    setTimeout(() => this.onopen?.(), 5)
  }
  /** 服务端推帧 */
  serverSend(frame: unknown): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 5)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    setTimeout(() => this.onclose?.(), 5)
  }
}

const sentApi: Array<{ url: string; body: any }> = []
const mockFetch = (async (url: any, init?: any) => {
  const u = String(url)
  sentApi.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined })
  if (u.includes('/gateway/connections/open')) {
    return new Response(JSON.stringify({ endpoint: 'wss://gateway.mock', ticket: 'TICKET1' }), { headers: { 'content-type': 'application/json' } })
  }
  if (u.includes('oapi.dingtalk.com/gettoken')) {
    return new Response(JSON.stringify({ access_token: 'AT1', expires_in: 7200 }), { headers: { 'content-type': 'application/json' } })
  }
  if (u.includes('/robot/oToMessages/batchSend') || u.includes('/robot/groupMessages/send')) {
    return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ message: 'unknown' }), { status: 404, headers: { 'content-type': 'application/json' } })
}) as any

const { DingtalkAdapter } = await import('../src/lib/messaging-gateway')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

function robotFrame(text: string, conversationType = '1', senderStaffId = 'STAFF1', conversationId = 'CID1'): unknown {
  return {
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'MSG1' },
    data: JSON.stringify({ conversationId, conversationType, senderStaffId, senderNick: '测试用户', text: { content: text } }),
  }
}

test('钉钉全链：open→ws 连接→CALLBACK 收件→ws 回执→oTo 回复 API', async () => {
  MockWs.instances = []
  const adapter = new DingtalkAdapter('AK', 'SK', mockFetch, MockWs as unknown as new (url: string) => WebSocket)
  const received: any[] = []
  const stop = await adapter.start(async (m) => {
    received.push(m)
    try {
      await adapter.send(m.chatId, `回复：${m.text}`)
    } catch {
      /* 回复失败不影响断言 */
    }
  })
  await new Promise((r) => setTimeout(r, 100))
  const ws = MockWs.instances[0]!
  expect(ws.url).toContain('wss://gateway.mock?ticket=TICKET1')
  // 服务端 ping → 客户端原样回执
  ws.serverSend({ type: 'SYSTEM', headers: { topic: 'ping' }, data: 'x' })
  await new Promise((r) => setTimeout(r, 30))
  expect(ws.sent.some((s) => s.includes('"topic":"ping"'))).toBe(true)
  // 机器人单聊消息 → 收件+回执+oTo API
  ws.serverSend(robotFrame('帮我记一条：喜欢钉钉'))
  await new Promise((r) => setTimeout(r, 100))
  expect(received.length).toBe(1)
  expect(received[0]!.platform).toBe('dingtalk')
  expect(received[0]!.chatId).toBe('oTo:STAFF1')
  expect(received[0]!.sender).toBe('测试用户')
  // CALLBACK 回执（防 60s 重推）
  expect(ws.sent.some((s) => s.includes('MSG1') && s.includes('"code":200'))).toBe(true)
  // 回复走 oTo API
  const oTo = sentApi.find((x) => x.url.includes('oToMessages'))
  expect(oTo).toBeTruthy()
  expect(oTo!.body.robotCode).toBe('AK')
  expect(oTo!.body.userIds).toEqual(['STAFF1'])
  expect(JSON.parse(oTo!.body.msgParam).content).toBe('回复：帮我记一条：喜欢钉钉')
  stop()
  await new Promise((r) => setTimeout(r, 50))
})

test('钉钉群聊：group chatId 走 groupMessages API', async () => {
  const adapter = new DingtalkAdapter('AK', 'SK', mockFetch, MockWs as unknown as new (url: string) => WebSocket)
  await adapter.send('group:CID9', '群里你好')
  const grp = sentApi.filter((x) => x.url.includes('groupMessages/send')).at(-1)!
  expect(grp.body.openConversationId).toBe('CID9')
  expect(grp.body.msgKey).toBe('sampleText')
})

test('钉钉 ping 帧：headers 原样回传', async () => {
  MockWs.instances = []
  const adapter = new DingtalkAdapter('AK', 'SK', mockFetch, MockWs as unknown as new (url: string) => WebSocket)
  const stop = await adapter.start(async () => undefined)
  await new Promise((r) => setTimeout(r, 100))
  const ws = MockWs.instances[0]!
  const headers = { topic: 'ping', messageId: 'P1' }
  ws.serverSend({ type: 'SYSTEM', headers, data: 'keep' })
  await new Promise((r) => setTimeout(r, 50))
  const echo = ws.sent.map((s) => JSON.parse(s)).find((f) => f.headers?.topic === 'ping')
  expect(echo).toBeTruthy()
  expect(echo!.code).toBe(200)
  expect(echo!.message).toBe('OK')
  stop()
  await new Promise((r) => setTimeout(r, 50))
})
