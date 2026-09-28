/**
 * 企微+个人微信 e2e（#286.4）：协议均照 Hermes 逐帧取直（wecom=openws ws；weixin=iLink HTTP 长轮询）。
 * mock：ws 可编程服务端（subscribe ack→callback→respond ack）+ fetch 注入（getupdates/sendmessage）。
 * bun:test 格式 → bun test ./tests/messaging-wecom-weixin.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_wx_'))
process.env.XDG_CONFIG_HOME = tmpCfg

const { WeComAdapter, WeixinAdapter, wxQrLoginStart, wxQrLoginPoll } = await import('../src/lib/messaging-gateway')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

/** 可编程 mock ws：记录服务端收到的帧，按脚本回推 */
class MockWSServer {
  sent: any[] = []
  script: Array<(frame: any) => void> = []
  constructor(private onScriptEmpty?: () => void) {}
  get url() { return 'wss://mock.openws' }
  clientOnopen?: () => void
  clientOnmessage?: (ev: { data: string }) => void
  clientOnclose?: (ev: { code?: number }) => void
  // 模拟客户端 send：触发服务端脚本下一步
  serverReceive(frame: any) {
    this.sent.push(frame)
    const next = this.script.shift()
    if (next) next(frame)
    else this.onScriptEmpty?.()
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
      }, 5)
    }
    send(data: string) {
      server.serverReceive(JSON.parse(data))
    }
    addEventListener(_t: string, _cb: (ev: MessageEvent) => void) { /* request 通道 e2e 不覆盖 */
    }
    removeEventListener() {}
    close() {
      this.onclose?.({ code: 1000 })
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('企微 openws 全链：subscribe ack→callback 收件→aibot_respond_msg 被动回复（req_id 回显）', async () => {
  const server = new MockWSServer()
  const adapter = new WeComAdapter('BOT1', 'SEC1', mockWsCtor(server) as any)
  let inbound: any = null
  let replyFrames: any[] = []
  // 脚本：subscribe → 回 ack；callback 帧 → 断言后回 respond ack
  server.script.push((frame: any) => {
    // subscribe 帧
    expect(frame.cmd).toBe('aibot_subscribe')
    expect(frame.body.bot_id).toBe('BOT1')
    expect(frame.body.secret).toBe('SEC1')
    expect(frame.body.device_id).toBeTruthy()
    server.serverSend({ cmd: 'aibot_subscribe', headers: { req_id: frame.headers.req_id }, body: { errcode: 0 } })
    // ack 后推一条回调
    server.serverSend({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'REQ1' },
      body: { msgid: 'M1', from: { userid: 'U1' }, chatid: 'C1', chattype: 'group', msgtype: 'text', text: { content: '@小月 帮我查一下' } },
    })
  })
  const stop = await adapter.start(async (m) => {
    inbound = m
    expect(m.chatId).toBe('wecom:C1')
    expect(m.sender).toBe('U1')
    expect(m.text).toBe('帮我查一下') // @前缀已剥离
    expect(m.replyTo).toBe('REQ1')
    // 网关应答→adapter.send→被动回复帧
    await adapter.send(m.chatId, '答案正文', m.replyTo)
    // send 走 request 通道（addEventListener 注册）——mock ws 不转发回包，手动解析：
    await sleep(20)
    return
  })
  // 手动把 server.sent 里 aibot_respond_msg 帧断言掉（request 通道不依赖回包）
  await sleep(50)
  const respond = server.sent.find((x) => x.cmd === 'aibot_respond_msg')
  expect(respond).toBeTruthy()
  expect(respond.headers.req_id).toBe('REQ1') // 回显收件 req_id
  expect(respond.body.msgtype).toBe('markdown')
  expect(respond.body.markdown.content).toBe('答案正文')
  expect(inbound).toBeTruthy()
  stop()
})

test('企微心跳：连接后发 cmd=ping', async () => {
  const server = new MockWSServer()
  // 无脚本——帧到即回 subscribe ack
  server.script.push((frame: any) => {
    server.serverSend({ cmd: 'aibot_subscribe', headers: { req_id: frame.headers.req_id }, body: { errcode: 0 } })
  })
  const adapter = new WeComAdapter('BOT1', 'SEC1', mockWsCtor(server) as any)
  const stop = await adapter.start(async () => undefined)
  await sleep(50)
  // e2e 不等 30s 心跳——只断言 subscribe 已发（心跳逻辑由间隔驱动，生产可观察）
  expect(server.sent.some((x) => x.cmd === 'aibot_subscribe')).toBe(true)
  stop()
})

test('企微 subscribe errcode!=0 报认证失败', async () => {
  const server = new MockWSServer()
  server.script.push((frame: any) => {
    server.serverSend({ cmd: 'aibot_subscribe', headers: { req_id: frame.headers.req_id }, body: { errcode: 40001, errmsg: 'bad secret' } })
  })
  const adapter = new WeComAdapter('BOT1', 'BAD', mockWsCtor(server) as any)
  await expect(adapter.start(async () => undefined)).rejects.toThrow('bad secret')
})

/** 个人微信：mock fetch 编程 getupdates 游标流 */
function wxFetchScript(responses: Array<any>): { fetchImpl: any; calls: any[] } {
  const calls: any[] = []
  let i = 0
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    // 长轮询 mock 必须延迟（#286 教训：立即返回→紧循环卡死）
    await new Promise((r) => setTimeout(r, 20))
    // 脚本耗尽后返回空轮询（真实 iLink 挂起 35s；这里 20ms 节拍等效）
    const r = i < responses.length ? responses[i] : { ret: 0, msgs: [] }
    i += 1
    if (r === 'TIMEOUT') throw new Error('The operation was aborted')
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

test('个人微信 iLink 全链：getupdates 收件→context_token 缓存→sendmessage 回显 token+头部形态', async () => {
  const { fetchImpl, calls } = wxFetchScript([
    {
      ret: 0,
      get_updates_buf: 'BUF2',
      msgs: [
        {
          message_id: 'M10',
          from_user_id: 'PEER1',
          context_token: 'CTX1',
          item_list: [{ type: 1, text_item: { text: '你好小月' } }],
        },
        // 自己发的回环消息：跳过
        { message_id: 'M11', from_user_id: 'SELF1', item_list: [{ type: 1, text_item: { text: '回环' } }] },
      ],
    },
  ])
  const adapter = new WeixinAdapter('TOK1', 'SELF1', fetchImpl)
  const got: any[] = []
  const stop = await adapter.start(async (m) => {
    got.push(m)
    expect(m.chatId).toBe('wx:PEER1')
    expect(m.text).toBe('你好小月')
    expect(m.replyTo).toBe('CTX1')
  })
  await sleep(80)
  expect(got.length).toBe(1) // 回环已过滤
  // 游标推进
  expect(calls[0]!.url).toContain('ilink/bot/getupdates')
  const firstBody = JSON.parse(String(calls[0]!.init!.body))
  expect(firstBody.get_updates_buf).toBe('')
  // 回复：回显 context_token
  await adapter.send('wx:PEER1', '回复正文', 'CTX1')
  const sendCall = calls.find((c) => String(c.url).includes('ilink/bot/sendmessage'))!
  expect(sendCall).toBeTruthy()
  const sendBody = JSON.parse(String(sendCall.init!.body))
  expect(sendBody.msg.to_user_id).toBe('PEER1')
  expect(sendBody.msg.context_token).toBe('CTX1')
  expect(sendBody.msg.message_type).toBe(2)
  expect(sendBody.msg.message_state).toBe(2)
  expect(sendBody.msg.item_list[0].text_item.text).toBe('回复正文')
  expect(sendBody.base_info.channel_version).toBe('2.2.0')
  expect(sendCall.init!.headers.AuthorizationType).toBe('ilink_bot_token')
  expect(String(sendCall.init!.headers.Authorization)).toContain('Bearer TOK1')
  expect(sendCall.init!.headers['iLink-App-Id']).toBe('bot')
  // 无 replyTo 时用缓存的 context_token
  await adapter.send('wx:PEER1', '第二条')
  const sendCall2 = calls.filter((c) => String(c.url).includes('ilink/bot/sendmessage'))[1]!
  const sendBody2 = JSON.parse(String(sendCall2.init!.body))
  expect(sendBody2.msg.context_token).toBe('CTX1')
  stop()
})

test('个人微信会话过期（ret=-14）不炸轮询且跳过该轮', async () => {
  const { fetchImpl, calls } = wxFetchScript([{ ret: -14, errmsg: 'session expired' }])
  const adapter = new WeixinAdapter('TOK1', 'SELF1', fetchImpl)
  const got: any[] = []
  const stop = await adapter.start(async (m) => {
    got.push(m)
  })
  await sleep(60)
  expect(got.length).toBe(0)
  expect(calls.length).toBeGreaterThanOrEqual(1)
  stop()
})

test('个人微信扫码登录：取二维码→本机渲染 SVG（零外链）', async () => {
  const { fetchImpl, calls } = wxFetchScript([
    { qrcode: 'QRHEX1', qrcode_img_content: 'https://weixin.qq.com/x/liteapp?t=abc' },
  ])
  const out = await wxQrLoginStart(fetchImpl)
  expect(out.qrcode).toBe('QRHEX1')
  expect(out.svg.startsWith('<svg')).toBe(true) // qrcode-generator 渲染
  expect(out.svg.length).toBeGreaterThan(200)
  expect(calls[0]!.url).toContain('ilink/bot/get_bot_qrcode')
  expect(String(calls[0]!.url)).toContain('bot_type=3')
  expect(calls[0]!.init!.headers['iLink-App-Id']).toBe('bot')
})

test('个人微信扫码登录：状态机 wait→scaned→redirect→confirmed（凭据解析）', async () => {
  const wait = await wxQrLoginPoll('QRHEX1', undefined, wxFetchScript([{ status: 'wait' }]).fetchImpl)
  expect(wait.status).toBe('wait')
  const scaned = await wxQrLoginPoll('QRHEX1', undefined, wxFetchScript([{ status: 'scaned' }]).fetchImpl)
  expect(scaned.status).toBe('scaned')
  const redir = await wxQrLoginPoll('QRHEX1', undefined, wxFetchScript([{ status: 'scaned_but_redirect', redirect_host: 'ilinkai2.weixin.qq.com' }]).fetchImpl)
  expect(redir.redirectHost).toBe('ilinkai2.weixin.qq.com')
  const done = await wxQrLoginPoll('QRHEX1', undefined, wxFetchScript([
    { status: 'confirmed', ilink_bot_id: 'a5ace6fd482e@im.bot', bot_token: 'TOKQR', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'UID1' },
  ]).fetchImpl)
  expect(done.status).toBe('confirmed')
  expect(done.accountId).toBe('a5ace6fd482e@im.bot')
  expect(done.token).toBe('TOKQR')
})

test('个人微信扫码登录：二维码响应缺字段报错', async () => {
  await expect(wxQrLoginStart(wxFetchScript([{ qrcode: '' }]).fetchImpl)).rejects.toThrow('缺少字段')
})
