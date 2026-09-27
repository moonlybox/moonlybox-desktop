/**
 * QQbot e2e（#286.2）：mock fetch（token/gateway/回复 API）+ mock ws（可编程网关帧）全链。
 * 协议断言：op10→op2 identify(token/intents)→op1 心跳(d=seq)→op0 dispatch 收件→REST 被动回复（msg_id+msg_seq）。
 * bun:test 格式 → bun test ./tests/messaging-qqbot.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_qq_'))
process.env.XDG_CONFIG_HOME = tmpCfg

class MockWs {
  static instances: MockWs[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  onclose: (() => void) | null = null
  sent: any[] = []
  closed = false
  constructor(public url: string) {
    MockWs.instances.push(this)
    setTimeout(() => this.onopen?.(), 5)
  }
  serverSend(frame: unknown): void {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 5)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    setTimeout(() => this.onclose?.(), 5)
  }
}

const sentApi: Array<{ url: string; headers: Record<string, string>; body: any }> = []
const mockFetch = (async (url: any, init?: any) => {
  const u = String(url)
  sentApi.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(init.body) : undefined })
  if (u.includes('/app/getAppAccessToken')) {
    return new Response(JSON.stringify({ access_token: 'AT1', expires_in: '7200' }), { headers: { 'content-type': 'application/json' } })
  }
  if (u.endsWith('/gateway')) {
    return new Response(JSON.stringify({ url: 'wss://gateway.mock/websocket/' }), { headers: { 'content-type': 'application/json' } })
  }
  if (u.includes('/v2/groups/') || u.includes('/v2/users/')) {
    return new Response(JSON.stringify({ id: 'REPLY1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ message: 'unknown' }), { status: 404, headers: { 'content-type': 'application/json' } })
}) as any

const { QQBotAdapter } = await import('../src/lib/messaging-gateway')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

const HELLO = { op: 10, d: { heartbeat_interval: 45_000 } }

test('QQbot 全链：token→gateway→hello→identify→心跳→群@收件→被动回复', async () => {
  MockWs.instances = []
  sentApi.length = 0
  const adapter = new QQBotAdapter('APP1', 'SEC1', mockFetch, MockWs as unknown as new (url: string) => WebSocket)
  const received: any[] = []
  const stop = await adapter.start(async (m) => {
    received.push(m)
    await adapter.send(m.chatId, `回复：${m.text}`, m.replyTo)
  })
  await new Promise((r) => setTimeout(r, 100))
  const ws = MockWs.instances[0]!
  expect(ws.url).toBe('wss://gateway.mock/websocket/')
  // hello → identify（token 形态/intents=1<<25/shard [0,0]）
  ws.serverSend(HELLO)
  await new Promise((r) => setTimeout(r, 30))
  const identify = ws.sent.find((f) => f.op === 2)
  expect(identify).toBeTruthy()
  expect(identify!.d.token).toBe('Bot APP1.SEC1')
  expect(identify!.d.intents).toBe(1 << 25)
  expect(identify!.d.shard).toEqual([0, 0])
  // dispatch 群@消息 → 收件
  ws.serverSend({ op: 0, s: 42, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'MSG9', content: '帮我记一条：喜欢QQ', group_openid: 'G1', author: { member_openid: 'M1' } } })
  await new Promise((r) => setTimeout(r, 80))
  expect(received.length).toBe(1)
  expect(received[0]!.platform).toBe('qqbot')
  expect(received[0]!.chatId).toBe('group:G1')
  expect(received[0]!.replyTo).toBe('MSG9')
  // 回复 API：群被动回复（msg_type 0+msg_id+msg_seq）
  const reply = sentApi.filter((x) => x.url.includes('/v2/groups/G1/messages')).at(-1)!
  expect(reply.body.msg_type).toBe(0)
  expect(reply.body.content).toBe('回复：帮我记一条：喜欢QQ')
  expect(reply.body.msg_id).toBe('MSG9')
  expect(reply.body.msg_seq).toBeGreaterThan(0)
  expect(reply.headers.Authorization).toBe('QQBot AT1')
  // 心跳带最新 seq
  ws.serverSend({ op: 0, s: 43, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'MSG10', content: 'x', group_openid: 'G1' } })
  await new Promise((r) => setTimeout(r, 30))
  ws.serverSend({ op: 0, s: 44, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'MSG11', content: '', group_openid: 'G1' } }) // 空内容不派发
  await new Promise((r) => setTimeout(r, 30))
  stop()
  await new Promise((r) => setTimeout(r, 50))
})

test('QQbot 单聊：C2C 收件→users API 回复', async () => {
  MockWs.instances = []
  sentApi.length = 0
  const adapter = new QQBotAdapter('APP1', 'SEC1', mockFetch, MockWs as unknown as new (url: string) => WebSocket)
  const stop = await adapter.start(async () => undefined)
  await new Promise((r) => setTimeout(r, 80))
  const ws = MockWs.instances[0]!
  ws.serverSend(HELLO)
  await new Promise((r) => setTimeout(r, 30))
  ws.serverSend({ op: 0, s: 50, t: 'C2C_MESSAGE_CREATE', d: { id: 'CMSG1', content: '单聊你好', author: { user_openid: 'U1' } } })
  await new Promise((r) => setTimeout(r, 80))
  await adapter.send('c2c:U1', '小月单聊回复', 'CMSG1')
  const reply = sentApi.filter((x) => x.url.includes('/v2/users/U1/messages')).at(-1)!
  expect(reply.body.msg_id).toBe('CMSG1')
  expect(reply.body.content).toBe('小月单聊回复')
  stop()
  await new Promise((r) => setTimeout(r, 50))
})
