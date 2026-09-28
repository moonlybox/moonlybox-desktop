/**
 * Slack e2e（#286.5）：Socket Mode 零依赖自实现全链——mock fetch（connections.open/postMessage）+ mock ws（可编程帧服务端）。
 * 断言：双 token 鉴权、hello 握手、events_api 收件→ack 回显 envelope_id、bot/subtype 回环过滤、线程回复 thread_ts。
 * bun:test 格式 → bun test ./tests/messaging-slack.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_slack_'))
process.env.XDG_CONFIG_HOME = tmpCfg

const { SlackAdapter } = await import('../src/lib/messaging-gateway')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可编程 mock ws（同企微 e2e 形态） */
class MockWSServer {
  sent: any[] = []
  script: Array<(frame: any) => void> = []
  autoHello = true // 连接即发 hello（真实 Slack 行为；start await resolve 依赖它）
  clientOnmessage?: (ev: { data: string }) => void
  serverReceive(frame: any) {
    this.sent.push(frame)
    const next = this.script.shift()
    if (next) next(frame)
  }
  serverSend(payload: any) {
    this.clientOnmessage?.({ data: JSON.stringify(payload) })
  }
}

function mockWsCtor(server: MockWSServer): any {
  return class MockWS {
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: ((ev: { code?: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(_url: string) {
      setTimeout(() => {
        server.clientOnmessage = (ev) => this.onmessage?.(ev)
        this.onopen?.()
        if (server.autoHello) server.serverSend({ type: 'hello' })
      }, 5)
    }
    send(data: string) {
      server.serverReceive(JSON.parse(data))
    }
    close() {
      this.onclose?.({ code: 1000 })
    }
  }
}

/** mock fetch：connections.open + chat.postMessage 捕获 */
function slackFetch(responses: Record<string, any>): { fetchImpl: any; calls: any[] } {
  const calls: any[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    await new Promise((r) => setTimeout(r, 10)) // 防紧循环
    const method = String(url).split('/').pop() ?? ''
    const r = responses[method]
    if (!r) throw new Error(`mock 未编程 ${method}`)
    if (r === 'FAIL') return new Response(JSON.stringify({ ok: false, error: 'mock_fail' }), { status: 200 })
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

test('Slack Socket Mode 全链：connections.open→hello→events_api 收件→ack 回显→chat.postMessage 回复', async () => {
  const server = new MockWSServer()
  const { fetchImpl, calls } = slackFetch({
    'apps.connections.open': { ok: true, url: 'wss://mock.slack.ws' },
    'chat.postMessage': { ok: true, ts: '1700.0002' },
  })
  const adapter = new SlackAdapter('xoxb-TEST', 'xapp-TEST', fetchImpl, mockWsCtor(server) as any)
  let inbound: any = null
  // 脚本：hello 后推一条用户消息 + 一条 bot 消息（应过滤）+ 一条编辑 subtype（应过滤）
  server.script.push((frame: any) => {
    expect(frame.envelope_id).toBe('ENV1') // ack 帧形态
    expect(frame.payload).toEqual({})
  })
  const stop = await adapter.start(async (m) => {
    inbound = m
  })
  await sleep(30)
  server.serverSend({
    type: 'events_api',
    envelope_id: 'ENV1',
    payload: { event: { type: 'message', channel: 'C123', user: 'U1', text: '你好 Slack', ts: '1700.0001' } },
  })
  await sleep(30)
  server.serverSend({
    type: 'events_api',
    envelope_id: 'ENV2',
    payload: { event: { type: 'message', channel: 'C123', bot_id: 'B1', text: '机器人回环' } },
  })
  server.serverSend({
    type: 'events_api',
    envelope_id: 'ENV3',
    payload: { event: { type: 'message', channel: 'C123', subtype: 'message_changed', text: '编辑' } },
  })
  await sleep(50)
  expect(inbound).toBeTruthy()
  expect(inbound.chatId).toBe('slack:C123')
  expect(inbound.sender).toBe('U1')
  expect(inbound.text).toBe('你好 Slack')
  expect(inbound.replyTo).toBeUndefined() // 非线程消息无 replyTo
  // ack 帧
  expect(server.sent.some((x) => x.envelope_id === 'ENV1' && x.payload)).toBeTruthy()
  // ack 在协议层先回（handleEvent 之前）——bot/subtype 过滤发生在事件处理层：inbound 仅收到用户消息
  expect(inbound.text).not.toBe('机器人回环')
  expect(inbound.text).not.toBe('编辑')
  // 回复：chat.postMessage 走 botToken
  await adapter.send('slack:C123', '答案正文')
  const post = calls.find((c) => String(c.url).includes('chat.postMessage'))!
  expect(post).toBeTruthy()
  const postBody = JSON.parse(String(post.init!.body))
  expect(postBody.channel).toBe('C123')
  expect(postBody.text).toBe('答案正文')
  expect(post.init!.headers.Authorization).toBe('Bearer xoxb-TEST')
  // connections.open 走 appToken
  const open = calls.find((c) => String(c.url).includes('apps.connections.open'))!
  expect(open.init!.headers.Authorization).toBe('Bearer xapp-TEST')
  stop()
})

test('Slack 线程语境：thread_ts 消息→replyTo→回复跟进线程', async () => {
  const server = new MockWSServer()
  const { fetchImpl, calls } = slackFetch({
    'apps.connections.open': { ok: true, url: 'wss://mock.slack.ws' },
    'chat.postMessage': { ok: true, ts: '1700.0004' },
  })
  const adapter = new SlackAdapter('xoxb-T', 'xapp-T', fetchImpl, mockWsCtor(server) as any)
  let inbound: any = null
  const stop = await adapter.start(async (m) => {
    inbound = m
  })
  await sleep(20)
  server.serverSend({
    type: 'events_api',
    envelope_id: 'ENV9',
    payload: { event: { type: 'message', channel: 'C9', user: 'U9', text: '线程里问', thread_ts: '1700.0003', ts: '1700.0004' } },
  })
  await sleep(40)
  expect(inbound!.replyTo).toBe('1700.0003')
  await adapter.send('slack:C9', '线程回复', inbound!.replyTo)
  const post = JSON.parse(String(calls.find((c) => String(c.url).includes('chat.postMessage'))!.init!.body))
  expect(post.thread_ts).toBe('1700.0003')
  stop()
})

test('Slack 凭据错误：connections.open 失败→报错不炸网关', async () => {
  const server = new MockWSServer()
  const { fetchImpl } = slackFetch({ 'apps.connections.open': 'FAIL' })
  const adapter = new SlackAdapter('xoxb-BAD', 'xapp-BAD', fetchImpl, mockWsCtor(server) as any)
  await expect(adapter.start(async () => undefined)).rejects.toThrow('mock_fail')
})

test('Slack disconnect 帧：不报错由外层重连逻辑处理（stop 正常）', async () => {
  const server = new MockWSServer()
  const { fetchImpl } = slackFetch({ 'apps.connections.open': { ok: true, url: 'wss://mock.slack.ws' } })
  const adapter = new SlackAdapter('xoxb-T', 'xapp-T', fetchImpl, mockWsCtor(server) as any)
  const stop = await adapter.start(async () => undefined)
  await sleep(20)
  // disconnect 帧 → mock ws close → onclose 触发但 closedByUs=false → 会 reject？当前实现 onclose 在未 stop 时 reject——
  // disconnect 由我们主动 close，需不 reject。验证：发 disconnect 后 stop() 正常返回即可（重连由网关层退避）。
  server.serverSend({ type: 'disconnect', reason: 'too_many_websockets' })
  await sleep(20)
  stop()
})
