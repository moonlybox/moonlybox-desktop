/**
 * 消息接入网关（#286，Hermes gateway 范式 TS 轻量版）。
 *
 * 架构：daemon 内常驻网关——settings.messaging.providers 配置驱动，每启用平台一个 adapter；
 * 收件（轮询/长连接）→ 统一 InboundMessage → runAgentTools（无头小月，chatId=msg:<platform>:<chatId> 持久化）→ 回复投递。
 * Hermes 范式裁剪：不做媒体转码/房间授权/配额治理；做密钥钥匙串、失败隔离（单平台炸不拖垮网关）、轮询退避。
 * 分批：第一批 Telegram（getUpdates 长轮询，零依赖）；飞书/钉钉/Slack(ws)/QQbot/企微/个人微信逐个后续迭代接入。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import qrcodeGen from 'qrcode-generator'
import { loadSettings } from './settings'

/** 消息接入凭据钥匙串（account=msg:<platform>:<key>，secret 字段一律不入 settings.json） */
function msgKeyGet(platform: string, key: string): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry('moonlybox', `msg:${platform}:${key}`).getPassword() || null
  } catch {
    return null
  }
}

export interface InboundMessage {
  platform: string
  /** 平台内会话标识（telegram=chat.id，qqbot=group:/c2c:前缀+openid） */
  chatId: string
  /** 发送者展示名（可空） */
  sender?: string
  text: string
  /** 原始消息 id（QQbot 被动回复 5min 窗口用，可空） */
  replyTo?: string
}

/** 平台发送凭据（钥匙串读取由 daemon 侧注入，本模块不碰 keyring） */
export type PlatformConfig = Record<string, string>

/** 平台适配器接口（Hermes BasePlatformAdapter 最小面） */
export interface PlatformAdapter {
  id: string
  /** 启动收件循环；返回 stop 函数。onMessage 回调抛错由网关兜 */
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void>
  /** 发送文本到指定会话；replyTo=原始消息 id（QQbot 被动回复窗口用，可空） */
  send(chatId: string, text: string, replyTo?: string): Promise<void>
}

/* ============================ Telegram ============================ */

const TG_POLL_TIMEOUT_S = 30

/** fetch 注入形态（生产=global fetch；e2e 注 mock——bun test 对 global.fetch 替换的时序不可靠） */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>
/** ws 注入形态（同上——生产=global WebSocket，e2e 注 mock 服务器） */
export type WsImpl = new (url: string) => WebSocket

export class TelegramAdapter implements PlatformAdapter {
  id = 'telegram'
  private offset = 0
  private offsetFile: string
  private stopped = false

  constructor(private token: string, stateDir: string, private fetchImpl: FetchImpl = global.fetch) {
    // offset 落盘：重启不重放旧消息（Hermes pending-update 语义）
    this.offsetFile = path.join(stateDir, 'telegram-offset.txt')
    try {
      this.offset = Number(fs.readFileSync(this.offsetFile, 'utf8').trim()) || 0
    } catch {
      this.offset = 0
    }
  }

  private async api(method: string, body?: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: TG_POLL_TIMEOUT_S, ...(body ?? {}) }),
      signal: AbortSignal.timeout((TG_POLL_TIMEOUT_S + 15) * 1000),
    })
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string }
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`)
    return json.result
  }

  private saveOffset(): void {
    try {
      fs.mkdirSync(path.dirname(this.offsetFile), { recursive: true })
      fs.writeFileSync(this.offsetFile, String(this.offset), 'utf8')
    } catch {
      /* 状态丢失=重启可能重放，可接受 */
    }
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    void this.loop(onMessage)
    return () => {
      this.stopped = true
    }
  }

  private async loop(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    let backoff = 2
    while (!this.stopped) {
      try {
        const updates = (await this.api('getUpdates', {
          offset: this.offset ? this.offset + 1 : undefined,
          allowed_updates: ['message'],
        })) as Array<{ update_id: number; message?: { chat?: { id: number }; from?: { first_name?: string; username?: string }; text?: string } }>
        backoff = 2
        for (const u of updates ?? []) {
          this.offset = u.update_id
          this.saveOffset()
          const msg = u.message
          const text = msg?.text?.trim()
          if (!msg?.chat?.id || !text) continue
          await onMessage({
            platform: 'telegram',
            chatId: String(msg.chat.id),
            sender: msg.from?.first_name ?? msg.from?.username,
            text,
          })
        }
      } catch (e: any) {
        if (this.stopped) return
        console.log(`（消息网关 telegram 轮询失败：${String(e?.message ?? e).slice(0, 120)}，${backoff}s 后重试）`)
        await new Promise((r) => setTimeout(r, backoff * 1000))
        backoff = Math.min(backoff * 2, 120)
      }
    }
  }

  async send(chatId: string, text: string, _replyTo?: string): Promise<void> {
    // 4096 字符上限分片（Telegram 无被动回复窗口语义，replyTo 忽略）
    for (let i = 0; i < text.length; i += 4000) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
    }
  }
}

/* ============================ 钉钉（Stream 模式，零依赖自实现） ============================ */

const DT_GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
const DT_TOPIC_ROBOT = '/v1.0/im/bot/messages/get'

/**
 * 钉钉 Stream 模式适配器（协议照 dingtalk-stream 官方客户端实现取直）：
 * open 领 endpoint+ticket → wss 连接 → SYSTEM ping 原样回执保活 → CALLBACK 机器人消息 →
 * ws 回执 socketResponse（防服务端 60s 重试重推）→ 回复走机器人消息 API（单聊 oTo/群聊 group）。
 */
export class DingtalkAdapter implements PlatformAdapter {
  id = 'dingtalk'
  private ws: WebSocket | null = null
  private stopped = false
  private stopFns: Array<() => void> = []
  /** accessToken 缓存（7200s 有效，内存缓存 1h） */
  private token: string | null = null
  private tokenAt = 0

  constructor(
    private clientId: string,
    private clientSecret: string,
    private fetchImpl: FetchImpl = global.fetch,
    private wsImpl: WsImpl = WebSocket,
  ) {}

  private async api(url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json', ...(headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`dingtalk ${new URL(url).pathname}: ${JSON.stringify(json).slice(0, 160)}`)
    return json
  }

  /** 机器人消息 API 需要 accessToken（企业内部应用凭据换 token） */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() - this.tokenAt < 3_600_000) return this.token
    const res = await this.fetchImpl(
      `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(this.clientId)}&appsecret=${encodeURIComponent(this.clientSecret)}`,
      { signal: AbortSignal.timeout(30_000) },
    )
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('dingtalk gettoken 失败')
    this.token = json.access_token
    this.tokenAt = Date.now()
    return this.token
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    void this.loop(onMessage)
    return () => {
      this.stopped = true
      for (const fn of this.stopFns) fn()
      try {
        this.ws?.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private async loop(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    let backoff = 2
    while (!this.stopped) {
      try {
        const open = (await this.api(DT_GATEWAY_URL, {
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          ua: 'moonlybox',
          subscriptions: [{ type: 'CALLBACK', topic: DT_TOPIC_ROBOT }],
          localIp: '',
        })) as { endpoint?: string; ticket?: string }
        if (!open.endpoint || !open.ticket) throw new Error('open 未返回 endpoint/ticket')
        backoff = 2
        await this.serve(`${open.endpoint}?ticket=${open.ticket}`, onMessage)
      } catch (e: any) {
        if (this.stopped) return
        console.log(`（消息网关 dingtalk 连接失败：${String(e?.message ?? e).slice(0, 120)}，${backoff}s 后重试）`)
        await new Promise((r) => setTimeout(r, backoff * 1000))
        backoff = Math.min(backoff * 2, 120)
      }
    }
  }

  /** 单次 ws 会话：正常退回（服务端断/stop）后 loop 重新 open 领新 ticket */
  private serve(url: string, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.wsImpl(url)
      this.ws = ws
      let settled = false
      let keepalive: ReturnType<typeof setInterval> | null = null
      const done = (err?: unknown) => {
        if (settled) return
        settled = true
        if (keepalive) clearInterval(keepalive)
        err ? reject(err) : resolve()
      }
      ws.onopen = () => {
        // SYSTEM ping 保活：协议=收到 headers.topic=ping 的帧原样回 code 200（onSystem 分支处理）；这里兜底定时 ping 由服务端推
      }
      ws.onmessage = (ev) => {
        void (async () => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type?: string; headers?: Record<string, string>; data?: string; code?: number }
            const topic = msg.headers?.topic ?? msg.headers?.type
            if (msg.type === 'SYSTEM') {
              if (topic === 'ping') {
                ws.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: msg.data }))
              }
              return
            }
            if (msg.type === 'CALLBACK' && topic === DT_TOPIC_ROBOT) {
              const messageId = msg.headers?.messageId ?? ''
              try {
                const payload = JSON.parse(msg.data ?? '{}') as {
                  conversationId?: string
                  conversationType?: string
                  senderStaffId?: string
                  senderNick?: string
                  text?: { content?: string }
                }
                const text = (payload.text?.content ?? '').trim()
                if (text && payload.senderStaffId) {
                  await onMessage({
                    platform: 'dingtalk',
                    chatId: payload.conversationType === '1' ? `oTo:${payload.senderStaffId}` : `group:${payload.conversationId}`,
                    sender: payload.senderNick,
                    text,
                  })
                }
                // 回执防重推（60s 重试）
                ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data: JSON.stringify({ response: 'OK' }) }))
              } catch (e: any) {
                console.log(`（消息网关 dingtalk 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
                ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data: JSON.stringify({ response: 'ERR' }) }))
              }
            }
          } catch {
            /* 非 JSON 帧忽略 */
          }
        })()
      }
      ws.onerror = (err) => done(err as unknown as Event)
      ws.onclose = () => done()
      this.stopFns.push(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        done()
      })
    })
  }

  async send(chatId: string, text: string, _replyTo?: string): Promise<void> {
    const token = await this.accessToken()
    const [mode, id] = chatId.includes(':') ? [chatId.slice(0, chatId.indexOf(':')), chatId.slice(chatId.indexOf(':') + 1)] : ['oTo', chatId]
    const msgParam = JSON.stringify({ content: text })
    if (mode === 'group') {
      await this.api(`https://api.dingtalk.com/v1.0/robot/groupMessages/send?access_token=${token}`, {
        robotCode: this.clientId,
        openConversationId: id,
        msgKey: 'sampleText',
        msgParam,
      })
    } else {
      await this.api(`https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend?access_token=${token}`, {
        robotCode: this.clientId,
        userIds: [id],
        msgKey: 'sampleText',
        msgParam,
      })
    }
  }
}

/* ============================ QQbot（官方开放平台 ws 接入，零依赖自实现） ============================ */

const QQ_API = 'https://api.bot.qq.com'
const QQ_INTENT_GROUP_AND_C2C = 1 << 25

/**
 * QQ 机器人适配器（官方开放平台 v2 ws 接入，协议照 bot.q.qq.com wiki 取直）：
 * getAppAccessToken → GET /gateway 领 wss → op10 hello(心跳周期) → op2 identify(token=Bot {appid}.{secret}, intents=1<<25)
 * → READY → 按 interval 发 op1 心跳(d=最新 s) → op0 dispatch（GROUP_AT_MESSAGE_CREATE/C2C_MESSAGE_CREATE）
 * → 回复 POST /v2/groups|users/{openid}/messages（msg_type=0 纯文本，msg_id 被动回复+msg_seq 防重）。
 */
export class QQBotAdapter implements PlatformAdapter {
  id = 'qqbot'
  private ws: WebSocket | null = null
  private stopped = false
  private stopFns: Array<() => void> = []
  private token: string | null = null
  private tokenAt = 0
  private lastSeq: number | null = null

  constructor(
    private appId: string,
    private clientSecret: string,
    private fetchImpl: FetchImpl = global.fetch,
    private wsImpl: WsImpl = WebSocket,
  ) {}

  private async apiToken(): Promise<string> {
    if (this.token && Date.now() - this.tokenAt < 6_600_000) return this.token // 7200s 有效，提前 10min 刷新
    const res = await this.fetchImpl(`${QQ_API}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('QQ getAppAccessToken 失败')
    this.token = json.access_token
    this.tokenAt = Date.now()
    return this.token
  }

  private async authedFetch(path: string, body?: Record<string, unknown>): Promise<any> {
    const token = await this.apiToken()
    const res = await this.fetchImpl(`${QQ_API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', Authorization: `QQBot ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`QQ ${path}: ${JSON.stringify(json).slice(0, 160)}`)
    return json
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    void this.loop(onMessage)
    return () => {
      this.stopped = true
      for (const fn of this.stopFns) fn()
      try {
        this.ws?.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private async loop(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    let backoff = 2
    while (!this.stopped) {
      try {
        const gw = (await this.authedFetch('/gateway')) as { url?: string }
        if (!gw.url) throw new Error('/gateway 未返回 url')
        backoff = 2
        await this.serve(gw.url, onMessage)
      } catch (e: any) {
        if (this.stopped) return
        console.log(`（消息网关 qqbot 连接失败：${String(e?.message ?? e).slice(0, 120)}，${backoff}s 后重试）`)
        await new Promise((r) => setTimeout(r, backoff * 1000))
        backoff = Math.min(backoff * 2, 120)
      }
    }
  }

  /** 单次 ws 会话：hello→identify→心跳→dispatch；断开返回后 loop 重连 */
  private serve(url: string, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.wsImpl(url)
      this.ws = ws
      let settled = false
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      const done = (err?: unknown) => {
        if (settled) return
        settled = true
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        err ? reject(err) : resolve()
      }
      ws.onopen = () => {
        /* 等 op10 hello */
      }
      ws.onmessage = (ev) => {
        void (async () => {
          try {
            const p = JSON.parse(String(ev.data)) as { op: number; s?: number; t?: string; d?: any }
            if (p.s !== undefined) this.lastSeq = p.s
            if (p.op === 10) {
              const interval = p.d?.heartbeat_interval ?? 45_000
              // identify（v1 不做 resume——断线重连走全新 identify，简单可靠）
              ws.send(JSON.stringify({
                op: 2,
                d: {
                  token: `Bot ${this.appId}.${this.clientSecret}`,
                  intents: QQ_INTENT_GROUP_AND_C2C,
                  shard: [0, 0],
                  properties: { $os: 'moonlybox', $browser: 'moonlybox', $device: 'moonlybox' },
                },
              }))
              heartbeatTimer = setInterval(() => {
                try {
                  ws.send(JSON.stringify({ op: 1, d: this.lastSeq }))
                } catch {
                  /* 发送失败由 onclose 兜 */
                }
              }, interval)
            } else if (p.op === 0 && p.t && p.d) {
              const d = p.d as {
                id?: string
                content?: string
                group_openid?: string
                author?: { user_openid?: string; id?: string }
              }
              const text = (d.content ?? '').trim()
              if (!text) return
              if (p.t === 'GROUP_AT_MESSAGE_CREATE' && d.group_openid) {
                await onMessage({ platform: 'qqbot', chatId: `group:${d.group_openid}`, sender: undefined, text, replyTo: d.id })
              } else if (p.t === 'C2C_MESSAGE_CREATE' && d.author?.user_openid) {
                await onMessage({ platform: 'qqbot', chatId: `c2c:${d.author.user_openid}`, sender: undefined, text, replyTo: d.id })
              }
            }
            // op11 心跳 ack 无需处理
          } catch (e: any) {
            console.log(`（消息网关 qqbot 帧处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
          }
        })()
      }
      ws.onerror = (err) => done(err as unknown as Event)
      ws.onclose = () => done()
      this.stopFns.push(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        done()
      })
    })
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const [mode, openid] = chatId.includes(':') ? [chatId.slice(0, chatId.indexOf(':')), chatId.slice(chatId.indexOf(':') + 1)] : ['c2c', chatId]
    const body: Record<string, unknown> = { msg_type: 0, content: text, msg_seq: Math.floor(Math.random() * 1000) + 1 }
    if (replyTo) body.msg_id = replyTo // 被动回复（5min 内有效）；过期则服务端按主动消息处理/拒绝
    if (mode === 'group') await this.authedFetch(`/v2/groups/${openid}/messages`, body)
    else await this.authedFetch(`/v2/users/${openid}/messages`, body)
  }
}

/* ============================ 飞书（官方 SDK 长连接，照 Hermes 验证过的通道形态） ============================ */

/**
 * 飞书适配器：官方 @larksuiteoapi/node-sdk WSClient（与 Hermes feishu 通道同款官方实现，
 * ws 协议/断线重连/分片拼装由 SDK 托管）。收件=EventDispatcher im.message.receive_v1（文本）；
 * 回复=client.im.message.reply（message_id 被动回复通道，text）。
 * 体积实测：bundle 增量 ~0.7MB（tree-shake 后），推翻早前 30MB 盘面顾虑。
 */
export class FeishuAdapter implements PlatformAdapter {
  id = 'feishu'
  private client: import('@larksuiteoapi/node-sdk').Client | null = null
  private wsClient: import('@larksuiteoapi/node-sdk').WSClient | null = null
  private stopped = false

  constructor(
    private appId: string,
    private appSecret: string,
  ) {}

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    const lark = await import('@larksuiteoapi/node-sdk')
    const dispatcher = new lark.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const msg = data?.message
          if (!msg?.message_id || msg.message_type !== 'text' || !msg.content) return
          let text = ''
          try {
            text = String((JSON.parse(msg.content) as { text?: string }).text ?? '').trim()
          } catch {
            return
          }
          if (!text) return
          text = text.replace(/^@_user_1\s*/, '').trim() // 群聊 @机器人前缀
          await onMessage({
            platform: 'feishu',
            chatId: `fs:${msg.chat_id ?? ''}`,
            sender: data?.sender?.sender_id?.user_id,
            text,
            replyTo: msg.message_id,
          })
        } catch (e: any) {
          console.log(`（消息网关 feishu 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
        }
      },
    })
    this.client = new lark.Client({ appId: this.appId, appSecret: this.appSecret, domain: lark.Domain.Feishu })
    this.wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret, loggerLevel: lark.LoggerLevel.warn })
    // SDK 内置断线重连；start 阻塞直至断开——detached 跑，错误只报告
    void this.wsClient.start({ eventDispatcher: dispatcher }).catch((e: any) => {
      if (!this.stopped) console.log(`（消息网关 feishu 连接退出：${String(e?.message ?? e).slice(0, 120)}）`)
    })
    console.log('（消息网关 feishu 已启动）')
    return () => {
      this.stopped = true
      try {
        this.wsClient?.close()
      } catch {
        /* ignore */
      }
      this.wsClient = null
      this.client = null
    }
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const messageId = replyTo ?? ''
    if (!messageId || !this.client) throw new Error('飞书回复需要原始消息 id（被动回复通道）')
    const r = await this.client.im.message.reply({
      data: { content: JSON.stringify({ text }), msg_type: 'text' },
      path: { message_id: messageId },
    })
    if ((r as any)?.code !== 0 && (r as any)?.msg) throw new Error(`飞书回复失败：${(r as any).msg}`)
  }
}

/* ============================ 企业微信（AI Bot openws 长连接，协议照 Hermes wecom adapter 取直） ============================ */

/**
 * 企业微信适配器：AI Bot WebSocket 网关（wss://openws.work.weixin.qq.com）——无需公网回调。
 * 协议（照 Hermes plugins/platforms/wecom 逐帧核对）：连接后发 aibot_subscribe{bot_id,secret,device_id}，
 * 等 req_id 匹配的 ack（errcode=0）→ 收 aibot_msg_callback（{body:{msgid,from:{userid},chatid,chattype,msgtype,text:{content}}}）；
 * 回复=被动 aibot_respond_msg（headers.req_id=收件 req_id，群聊唯一通路）/主动 aibot_send_msg{chatid,...}（仅单聊）；
 * 客户端 30s 发 cmd=ping 心跳；另一连接上线会被踢（disconnected_event）——v1 不自动重连踢出场景。
 * botId/secret 来源=企微管理后台「智能机器人」凭据页。
 */
const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
const WECOM_HEARTBEAT_MS = 30_000

export class WeComAdapter implements PlatformAdapter {
  id = 'wecom'
  private ws: WebSocket | null = null
  private stopped = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 收件帧缓存：chatId → 最新 req_id（群聊被动回复必须） */
  private chatReqIds = new Map<string, string>()
  private reqCounter = 0

  constructor(
    private botId: string,
    private secret: string,
    private wsImpl?: WsImpl,
  ) {}

  private newReqId(tag: string): string {
    this.reqCounter += 1
    return `${tag}_${Date.now().toString(36)}_${this.reqCounter}`
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    const WSCtor = this.wsImpl ?? (globalThis as any).WebSocket
    if (!WSCtor) throw new Error('WebSocket 不可用')
    await new Promise<void>((resolve, reject) => {
      const ws: WebSocket = new WSCtor(WECOM_WS_URL)
      this.ws = ws
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* ignore */ }
        reject(new Error('企业微信连接超时（20s）'))
      }, 20_000)
      ws.onopen = () => {
        this.sendJson({ cmd: 'aibot_subscribe', headers: { req_id: this.newReqId('subscribe') }, body: { bot_id: this.botId, secret: this.secret, device_id: `moonlybox-${Math.random().toString(36).slice(2, 10)}` } })
      }
      ws.onmessage = (ev) => {
        let payload: any
        try {
          payload = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (!payload || typeof payload !== 'object') return
        const cmd = String(payload.cmd ?? '')
        if (cmd === 'ping') return
        const reqId = String(payload.headers?.req_id ?? '')
        // subscribe ack：errcode!=0 = 凭据错误
        if (reqId.startsWith('subscribe_')) {
          clearTimeout(timer)
          const errcode = payload.body?.errcode ?? payload.errcode ?? 0
          if (errcode !== 0 && errcode !== null && errcode !== undefined) {
            reject(new Error(`企业微信订阅失败（errcode=${errcode}）：${payload.body?.errmsg ?? payload.errmsg ?? '认证失败'}`))
            try { ws.close() } catch { /* ignore */ }
            return
          }
          resolve()
          return
        }
        if (cmd === 'aibot_msg_callback') void this.handleCallback(payload, onMessage)
      }
      ws.onerror = () => { /* onclose 会兜 */ }
      ws.onclose = () => {
        clearTimeout(timer)
        if (!this.stopped) reject(new Error('企业微信连接被关闭'))
      }
    })
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendJson({ cmd: 'ping', headers: { req_id: this.newReqId('ping') }, body: {} })
      } catch { /* ignore */ }
    }, WECOM_HEARTBEAT_MS)
    console.log('（消息网关 wecom 已启动）')
    return () => {
      this.stopped = true
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      try { this.ws?.close() } catch { /* ignore */ }
      this.ws = null
      this.chatReqIds.clear()
    }
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('企业微信 ws 未连接')
    this.ws.send(JSON.stringify(payload))
  }

  private async handleCallback(payload: any, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    try {
      const body = payload?.body
      if (!body || typeof body !== 'object') return
      const reqId = String(payload.headers?.req_id ?? '')
      const senderId = String(body.from?.userid ?? '').trim()
      const chatId = String(body.chatid ?? senderId).trim()
      if (!chatId) return
      const msgtype = String(body.msgtype ?? '').toLowerCase()
      let text = ''
      if (msgtype === 'text') text = String(body.text?.content ?? '')
      else if (msgtype === 'mixed') {
        const items = Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : []
        text = items.filter((it: any) => String(it?.msgtype ?? '').toLowerCase() === 'text').map((it: any) => String(it?.text?.content ?? '')).join('\n')
      }
      text = text.trim()
      const isGroup = String(body.chattype ?? '').toLowerCase() === 'group'
      if (isGroup) text = text.replace(/^@\S+\s*/, '').trim() // @机器人前缀
      if (!text) return // 图片/文件等 v1 不处理
      if (reqId) this.chatReqIds.set(chatId, reqId)
      await onMessage({ platform: 'wecom', chatId: `wecom:${chatId}`, sender: senderId, text, replyTo: reqId })
    } catch (e: any) {
      console.log(`（消息网关 wecom 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
    }
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const rawChat = chatId.startsWith('wecom:') ? chatId.slice(6) : chatId
    const body = { msgtype: 'markdown', markdown: { content: text.slice(0, 4000) } }
    // 被动回复优先（群聊唯一通路；req_id 失效降级主动发——单聊）
    const cachedReqId = replyTo || this.chatReqIds.get(rawChat) || ''
    if (cachedReqId) {
      try {
        const resp = await this.request('aibot_respond_msg', cachedReqId, body)
        if ((resp?.errcode ?? 0) === 0) return
      } catch { /* 落主动发 */ }
    }
    if (this.chatReqIds.has(rawChat) || cachedReqId) {
      // 有收件记录但被动失败且无主动通路的场景=群聊——报错（与 Hermes 一致：群必须被动回复）
      if (!replyTo && this.isGroupChat(rawChat)) throw new Error('企业微信群聊回复失败（req_id 失效，需重新@机器人）')
    }
    const resp = await this.request('aibot_send_msg', this.newReqId('send'), { chatid: rawChat, ...body })
    const errcode = (resp as any)?.errcode ?? (resp as any)?.body?.errcode ?? 0
    if (errcode !== 0) throw new Error(`企业微信发送失败（errcode=${errcode}）`)
  }

  private isGroupChat(_chatId: string): boolean {
    // chatid 无群/单聊标记——v1 简化：有缓存 req_id 时被动失败直接报错由上层兜底
    return false
  }

  private request(cmd: string, reqId: string, body: unknown, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('企业微信 ws 未连接'))
      const timer = setTimeout(() => reject(new Error('企业微信响应超时')), timeoutMs)
      const onMsg = (ev: MessageEvent) => {
        let p: any
        try { p = JSON.parse(String(ev.data)) } catch { return }
        if (p?.headers?.req_id !== reqId) return
        this.ws?.removeEventListener('message', onMsg)
        clearTimeout(timer)
        resolve(p)
      }
      this.ws.addEventListener('message', onMsg)
      try {
        this.sendJson({ cmd, headers: { req_id: reqId }, body })
      } catch (e) {
        this.ws.removeEventListener('message', onMsg)
        clearTimeout(timer)
        reject(e as Error)
      }
    })
  }
}

/* ============================ 个人微信（iLink Bot API，协议照 Hermes weixin.py 取直） ============================ */

/**
 * 个人微信适配器：腾讯 iLink Bot API（ilinkai.weixin.qq.com）——扫码登录获得 bot token，长轮询收件，无需公网。
 * 协议（照 Hermes gateway/platforms/weixin.py 逐帧核对）：POST {base}/ilink/bot/getupdates{get_updates_buf 游标}
 * → {msgs:[{message_id,from_user_id,item_list:[{type:1,text_item:{text}}],context_token}]}；
 * 回复=POST ilink/bot/sendmessage{msg:{to_user_id,client_id,message_type:2,message_state:2,item_list,context_token}}——
 * context_token 必须回显收件帧对应发件人的最新值（缺失降级无 token 发送）；会话过期（ret=-14）停 10 分钟。
 * 头：AuthorizationType: ilink_bot_token + iLink-App-Id: bot + iLink-App-ClientVersion + X-WECHAT-UIN（随机 b64）。
 * 限制（Hermes 文档）：iLink bot 身份≠普通个人号——多数账号只有单聊可靠，群聊投递不保证。
 */
const WX_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WX_CHANNEL_VERSION = '2.2.0'
const WX_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)
const WX_POLL_TIMEOUT_MS = 35_000
const WX_API_TIMEOUT_MS = 15_000

function wxHeaders(token: string, body: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff)).padStart(10, '0')).toString('base64')
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': WX_CLIENT_VERSION,
    Authorization: `Bearer ${token}`,
  }
}

async function wxPost(fetchImpl: FetchImpl, endpoint: string, token: string, payload: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: WX_CHANNEL_VERSION } })
  const r = await fetchImpl(`${WX_BASE_URL}/${endpoint}`, { method: 'POST', headers: wxHeaders(token, body), body })
  if (!r.ok) throw new Error(`iLink ${endpoint} HTTP ${r.status}`)
  return (await r.json()) as any
}

export class WeixinAdapter implements PlatformAdapter {
  id = 'weixin'
  private stopped = false
  /** 发件人 → 最新 context_token（回复必回显） */
  private contextTokens = new Map<string, string>()

  constructor(
    private token: string,
    private accountId: string,
    private fetchImpl?: FetchImpl,
  ) {}

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    const f = this.fetchImpl ?? fetch
    const poll = async () => {
      let syncBuf = ''
      let failureStreak = 0
      while (!this.stopped) {
        try {
          const resp = await wxPost(f, 'ilink/bot/getupdates', this.token, { get_updates_buf: syncBuf }).catch(async (e: any) => {
            // 长轮询超时形态：fetch 15s 超时视为空轮询继续（iLink 35s 挂起，fetch 端 15s 先断——正常节拍）
            if (String(e?.message ?? '').includes('abort')) return { ret: 0, msgs: [], get_updates_buf: syncBuf }
            throw e
          })
          const ret = resp?.ret ?? 0
          const errcode = resp?.errcode ?? 0
          if (ret !== 0 || errcode !== 0) {
            if (ret === -14 || errcode === -14) {
              console.log('（消息网关 weixin 会话过期——暂停 10 分钟）')
              await new Promise((r) => setTimeout(r, 600_000))
              continue
            }
            failureStreak += 1
            if (failureStreak >= 3) {
              await new Promise((r) => setTimeout(r, 30_000))
              failureStreak = 0
            } else {
              await new Promise((r) => setTimeout(r, 2_000))
            }
            continue
          }
          failureStreak = 0
          if (resp.get_updates_buf) syncBuf = String(resp.get_updates_buf)
          for (const msg of resp.msgs ?? []) {
            if (this.stopped) break
            try {
              await this.handleMsg(msg, onMessage)
            } catch (e: any) {
              console.log(`（消息网关 weixin 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
            }
          }
        } catch (e: any) {
          if (this.stopped) break
          failureStreak += 1
          console.log(`（消息网关 weixin 轮询失败 ${failureStreak}：${String(e?.message ?? e).slice(0, 120)}）`)
          await new Promise((r) => setTimeout(r, failureStreak >= 3 ? 30_000 : 2_000))
          if (failureStreak >= 3) failureStreak = 0
        }
      }
    }
    void poll()
    console.log('（消息网关 weixin 已启动）')
    return () => {
      this.stopped = true
      this.contextTokens.clear()
    }
  }

  private async handleMsg(msg: any, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    const senderId = String(msg?.from_user_id ?? '').trim()
    if (!senderId || senderId === this.accountId) return // 自己发的回环
    const items = Array.isArray(msg?.item_list) ? msg.item_list : []
    let text = ''
    for (const it of items) {
      if (Number(it?.type) === 1) text += String(it?.text_item?.text ?? '')
    }
    text = text.trim()
    if (!text) return // 图片/语音等 v1 不处理
    const contextToken = String(msg?.context_token ?? '').trim()
    if (contextToken) this.contextTokens.set(senderId, contextToken)
    await onMessage({ platform: 'weixin', chatId: `wx:${senderId}`, sender: senderId, text, replyTo: contextToken || undefined })
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const f = this.fetchImpl ?? fetch
    const peer = chatId.startsWith('wx:') ? chatId.slice(3) : chatId
    const contextToken = replyTo || this.contextTokens.get(peer) || ''
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: peer,
      client_id: `moonlybox-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
      message_type: 2, // MSG_TYPE_BOT
      message_state: 2, // MSG_STATE_FINISH
      item_list: [{ type: 1, text_item: { text: text.slice(0, 2048) } }],
    }
    if (contextToken) message.context_token = contextToken
    const resp = await wxPost(f, 'ilink/bot/sendmessage', this.token, { msg: message })
    const ret = resp?.ret ?? 0
    if (ret !== 0) throw new Error(`个人微信发送失败（ret=${ret}）：${resp?.errmsg ?? '未知错误'}`)
  }
}

/* ============================ 个人微信扫码登录（iLink qr_login，照 Hermes 流程） ============================ */

const WX_QR_TIMEOUT_MS = 35_000

/**
 * 取登录二维码：GET ilink/bot/get_bot_qrcode?bot_type=3 → {qrcode, qrcode_img_content}。
 * qrcode_img_content=微信需扫描的 liteapp URL（非裸 hex token）；本机用 qrcode-generator 渲染 SVG（零外链）。
 */
export async function wxQrLoginStart(fetchImpl?: FetchImpl): Promise<{ qrcode: string; svg: string }> {
  const f = fetchImpl ?? fetch
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), WX_QR_TIMEOUT_MS)
  try {
    const r = await f(`${WX_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': WX_CLIENT_VERSION },
      signal: ctl.signal,
    } as RequestInit)
    if (!r.ok) throw new Error(`取二维码失败（HTTP ${r.status}）`)
    const j = (await r.json()) as any
    const qrcode = String(j?.qrcode ?? '')
    const content = String(j?.qrcode_img_content ?? '') || qrcode
    if (!qrcode || !content) throw new Error('二维码响应缺少字段')
    const qr = qrcodeGen(0, 'M')
    qr.addData(content)
    qr.make()
    return { qrcode, svg: qr.createSvgTag({ cellSize: 4, margin: 8 }) }
  } finally {
    clearTimeout(t)
  }
}

/** 轮询扫码状态：wait / scaned / scaned_but_redirect / expired / confirmed（含 ilink_bot_id+bot_token+baseurl） */
export async function wxQrLoginPoll(qrcode: string, baseUrl = WX_BASE_URL, fetchImpl?: FetchImpl): Promise<{
  status: string
  redirectHost?: string
  accountId?: string
  token?: string
  baseUrl?: string
}> {
  const f = fetchImpl ?? fetch
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), WX_QR_TIMEOUT_MS)
  try {
    const r = await f(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': WX_CLIENT_VERSION },
      signal: ctl.signal,
    } as RequestInit)
    if (!r.ok) throw new Error(`扫码状态查询失败（HTTP ${r.status}）`)
    const j = (await r.json()) as any
    const status = String(j?.status ?? 'wait')
    if (status === 'scaned_but_redirect') return { status, redirectHost: String(j?.redirect_host ?? '') }
    if (status === 'confirmed') {
      return {
        status,
        accountId: String(j?.ilink_bot_id ?? ''),
        token: String(j?.bot_token ?? ''),
        baseUrl: String(j?.baseurl ?? WX_BASE_URL),
      }
    }
    return { status }
  } finally {
    clearTimeout(t)
  }
}

/* ============================ Slack（Socket Mode，协议照官方 socket-mode 客户端取直） ============================ */

/**
 * Slack 适配器：Socket Mode 长连接（免公网回调，零依赖自实现——协议照 @slack/socket-mode 逐帧核对，
 * 与钉钉同款自实现先例）。链路：POST apps.connections.open（Bearer app-level token，xapp- 形态）→ wss url
 * → 收 type:hello=就绪 → 收 type:events_api{envelope_id,payload} 必须回 {envelope_id,payload:{}} ack（3 秒窗）；
 * type:disconnect=服务端要求重连（重领 url）。收件 event={type:'message',channel,user,text,bot_id,subtype}——
 * bot_id 非空=机器人自己/其他 bot 的消息，跳过防回环；编辑/删除类 subtype 跳过。
 * 回复=REST chat.postMessage（Bearer bot token，xoxb- 形态）{channel,text}。
 * 凭据两个 token：botToken（xoxb-，bot scope）+ appToken（xapp-，connections:write scope）。
 */
const SLACK_API = 'https://slack.com/api'

export class SlackAdapter implements PlatformAdapter {
  id = 'slack'
  private ws: WebSocket | null = null
  private stopped = false
  private closedByUs = false

  constructor(
    private botToken: string,
    private appToken: string,
    private fetchImpl?: FetchImpl,
    private wsImpl?: WsImpl,
  ) {}

  private async slackApi(method: string, token: string, body: Record<string, unknown>): Promise<any> {
    const f = this.fetchImpl ?? fetch
    const r = await f(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Slack ${method} HTTP ${r.status}`)
    const j = (await r.json()) as any
    if (!j?.ok) throw new Error(`Slack ${method} 失败：${j?.error ?? 'unknown'}`)
    return j
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    this.closedByUs = false
    const open = await this.slackApi('apps.connections.open', this.appToken, {})
    const url = String(open?.url ?? '')
    if (!url.startsWith('wss://')) throw new Error('Slack apps.connections.open 未返回 wss 地址（检查 app token 的 connections:write scope）')
    const WSCtor = this.wsImpl ?? (globalThis as any).WebSocket
    if (!WSCtor) throw new Error('WebSocket 不可用')
    await new Promise<void>((resolve, reject) => {
      const ws: WebSocket = new WSCtor(url)
      this.ws = ws
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* ignore */ }
        reject(new Error('Slack 连接超时（20s）'))
      }, 20_000)
      ws.onmessage = (ev) => {
        let frame: any
        try {
          frame = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (frame?.type === 'hello') {
          clearTimeout(timer)
          resolve()
          return
        }
        if (frame?.type === 'disconnect') {
          // 服务端回收连接（pod recycling）——关闭让外层重连
          try { ws.close() } catch { /* ignore */ }
          return
        }
        if (frame?.type === 'events_api' && frame.envelope_id) {
          // ack 必须回（3 秒窗，超时 Slack 重推）
          try {
            ws.send(JSON.stringify({ envelope_id: frame.envelope_id, payload: {} }))
          } catch { /* ignore */ }
          void this.handleEvent(frame.payload, onMessage)
        }
        // 其它类型（slash_commands/interactivity 等）v1 不处理
      }
      ws.onclose = () => {
        clearTimeout(timer)
        if (!this.stopped && !this.closedByUs) reject(new Error('Slack 连接被关闭'))
      }
      ws.onerror = () => { /* onclose 兜 */ }
    })
    console.log('（消息网关 slack 已启动）')
    return () => {
      this.stopped = true
      this.closedByUs = true
      try { this.ws?.close() } catch { /* ignore */ }
      this.ws = null
    }
  }

  private async handleEvent(payload: any, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    try {
      const ev = payload?.event
      if (!ev || ev.type !== 'message') return
      if (ev.bot_id || ev.subtype) return // 机器人消息/编辑删除等系统 subtype——防回环
      const text = String(ev.text ?? '').trim()
      const channel = String(ev.channel ?? '').trim()
      if (!text || !channel) return
      // 线程语境保留（thread_ts 存在=回复进线程）；频道前缀保持原样进 chatId
      await onMessage({ platform: 'slack', chatId: `slack:${channel}`, sender: String(ev.user ?? ''), text, replyTo: ev.thread_ts ? String(ev.thread_ts) : undefined })
    } catch (e: any) {
      console.log(`（消息网关 slack 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
    }
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const channel = chatId.startsWith('slack:') ? chatId.slice(6) : chatId
    const body: Record<string, unknown> = { channel, text: text.slice(0, 40_000) }
    if (replyTo) body.thread_ts = replyTo // 原消息在线程里→回复跟进线程
    await this.slackApi('chat.postMessage', this.botToken, body)
  }
}

/* ============================ Email（IMAP 轮询收 + SMTP 发，行为照 Hermes email adapter） ============================ */

/**
 * Email 适配器：用户发邮件给小月——IMAP 周期轮询收（UNSEEN），SMTP 发回复（线程头 In-Reply-To/References）。
 * 协议依赖 imapflow（IMAP 客户端）+ mailparser（MIME 解析）+ nodemailer（SMTP 发送），bundle 增量 ~2.5MB。
 * 行为照 Hermes plugins/platforms/email：
 * - 自动发件人过滤（noreply/mailer-daemon 类地址 + Auto-Submitted/Precedence: bulk 类头）防回环省 token
 * - 自己发给自己的回环跳过；seen-UID 去重（上限 2000，过半裁剪）
 * - 回复主题=「Re: 原主题」、正文前缀「[Subject: X]」（原主题非 Re: 开头时）——收件人上下文清晰
 * - SMTP 安全：465=隐式 TLS，587=STARTTLS，其余按配置
 * 凭据：address+password+imapHost+smtpHost（端口/安全可省，默认 993/587）。
 */

const EMAIL_NOREPLY_PATTERNS = ['noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'notifications@', 'automated@', 'auto-confirm', 'auto-reply', 'automailer']
const EMAIL_POLL_INTERVAL_MS = 15_000
const EMAIL_SEEN_UIDS_MAX = 2000

export function emailIsAutomated(fromAddr: string, headers: Record<string, string>): boolean {
  const a = fromAddr.toLowerCase()
  if (EMAIL_NOREPLY_PATTERNS.some((p) => a.includes(p))) return true
  // Auto-Submitted 非 no / Precedence bulk|list|junk / X-Auto-Response-Suppress 有值 = 自动邮件
  const auto = headers['auto-submitted']
  if (auto && auto.toLowerCase() !== 'no') return true
  const prec = headers['precedence']
  if (prec && ['bulk', 'list', 'junk'].includes(prec.toLowerCase())) return true
  if (headers['x-auto-response-suppress']) return true
  return false
}

export function emailStripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class EmailAdapter implements PlatformAdapter {
  id = 'email'
  private stopped = false
  /** 收件人 → {subject, messageId}（回复线程语境） */
  private threadContext = new Map<string, { subject: string; messageId: string }>()
  private seenUids = new Set<string>()

  constructor(
    private address: string,
    private password: string,
    private imapHost: string,
    private imapPort: number,
    private smtpHost: string,
    private smtpPort: number,
  ) {}

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void> {
    this.stopped = false
    const { ImapFlow } = await import('imapflow')
    const poll = async () => {
      while (!this.stopped) {
        const client = new ImapFlow({
          host: this.imapHost,
          port: this.imapPort || 993,
          secure: (this.imapPort || 993) === 993,
          auth: { user: this.address, pass: this.password },
          logger: false,
        } as any)
        try {
          await client.connect()
          const lock = await client.getMailboxLock('INBOX')
          try {
            // 本轮首连：把存量邮件标 seen（只处理新到的）
            const found = await client.search({ seen: false }, { uid: true })
            const uids = Array.isArray(found) ? found : []
            for (const uid of uids) {
              if (this.stopped) break
              const key = String(uid)
              if (this.seenUids.has(key)) continue
              const msg = await client.fetchOne(String(uid), { uid: true, source: true, envelope: true }, { uid: true })
              const source = (msg as any)?.source as Buffer | undefined
              if (!source) continue
              this.seenUids.add(key)
              if (this.seenUids.size > EMAIL_SEEN_UIDS_MAX) {
                const sorted = [...this.seenUids].sort((a, b) => Number(a) - Number(b))
                this.seenUids = new Set(sorted.slice(-EMAIL_SEEN_UIDS_MAX / 2))
              }
              try {
                await this.handleRaw(source, onMessage)
              } catch (e: any) {
                console.log(`（消息网关 email 消息处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
              }
            }
          } finally {
            lock.release()
          }
          await client.logout()
        } catch (e: any) {
          if (!this.stopped) console.log(`（消息网关 email 轮询失败：${String(e?.message ?? e).slice(0, 120)}）`)
          try { client.close() } catch { /* ignore */ }
        }
        // 轮询间隔（分片 sleep 以便 stop 快速生效）
        for (let i = 0; i < EMAIL_POLL_INTERVAL_MS / 500 && !this.stopped; i++) {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    }
    void poll()
    console.log('（消息网关 email 已启动）')
    return () => {
      this.stopped = true
      this.threadContext.clear()
      this.seenUids.clear()
    }
  }

  private async handleRaw(raw: Buffer, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    // @ts-expect-error mailparser 无类型声明（bundle 实测正常）
    const { simpleParser } = await import('mailparser')
    const parsed = await simpleParser(raw as any)
    const fromAddr = String(parsed.from?.value?.[0]?.address ?? '').toLowerCase()
    const fromName = String(parsed.from?.value?.[0]?.name ?? '')
    if (!fromAddr || fromAddr === this.address.toLowerCase()) return // 空发件人/自己回环
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.headers ?? {})) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
      else if (v && typeof v === 'object' && 'text' in (v as any)) headers[k.toLowerCase()] = String((v as any).text ?? '')
    }
    if (emailIsAutomated(fromAddr, headers)) return
    const subject = String(parsed.subject ?? '').trim()
    let body = String(parsed.text ?? '').trim()
    if (!body && parsed.html) body = emailStripHtml(String(parsed.html))
    if (!body) return
    const messageId = String(parsed.messageId ?? '')
    this.threadContext.set(fromAddr, { subject: subject || '(no subject)', messageId })
    const text = `[Subject: ${subject || '(no subject)'}]\n\n${body}` // 主题入正文（小月知道用户在说什么）
    await onMessage({ platform: 'email', chatId: `email:${fromAddr}`, sender: fromName || fromAddr, text, replyTo: messageId })
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    const nodemailer = await import('nodemailer')
    const to = chatId.startsWith('email:') ? chatId.slice(6) : chatId
    const ctx = this.threadContext.get(to)
    const originalSubject = ctx?.subject ?? '魔力宝盒'
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`
    // 回复正文剥掉 [Subject: X] 前缀——邮件读者只关心回答本身
    const body = text.startsWith('[Subject: ') ? text.slice(text.indexOf(']\n\n') + 3).trim() : text
    const transport = nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort || 587,
      secure: (this.smtpPort || 587) === 465, // 465=隐式 TLS；587 走 STARTTLS（nodemailer 默认 requireTLS）
      auth: { user: this.address, pass: this.password },
    } as any)
    const inReplyTo = replyTo || ctx?.messageId || undefined
    try {
      await transport.sendMail({
        from: this.address,
        to,
        subject,
        text: body,
        inReplyTo,
        references: inReplyTo,
      })
    } finally {
      transport.close()
    }
  }
}

/* ============================ 网关编排 ============================ */

export interface GatewayStatus {
  platform: string
  running: boolean
  error?: string
}

const runningStops = new Map<string, () => void>()

const SECRET_KEYS: Record<string, string[]> = {
  // 平台 id → secret 字段清单（面板 needs.secret=true 的键；token 类）
  feishu: ['appSecret'],
  wecom: ['secret'], // 企微 AI Bot（openws 通道）：bot_id + secret（非传统自建应用 corpSecret）
  weixin: ['token'], // 个人微信 iLink Bot：扫码登录获得，长期有效；accountId 落 settings.json\n  slack: ['botToken', 'appToken'], // 双 token：bot(xoxb-) + app-level(xapp-, connections:write)\n  email: ['password'], // 邮箱密码/授权码（QQ/163 类=授权码非登录密码）；其余字段落 settings.json
  dingtalk: ['appSecret'],
  telegram: ['botToken'],
  qqbot: ['appSecret'],
  slack: ['botToken'],
}

/** 平台是否已配置：enabled 且全部必填 secret 在钥匙串就绪（真凭据从钥匙串组装，settings 只落标记） */
export function enabledPlatforms(): Array<{ id: string; config: PlatformConfig }> {
  const s = loadSettings().messaging?.providers ?? {}
  const out: Array<{ id: string; config: PlatformConfig }> = []
  for (const [id, p] of Object.entries(s)) {
    if (!p?.enabled) continue
    const secrets = SECRET_KEYS[id] ?? []
    const config: PlatformConfig = {}
    let missing = false
    for (const k of secrets) {
      const v = msgKeyGet(id, k)
      if (v) config[k] = v
      else missing = true
    }
    // 已接入平台（buildAdapter 有实现的）secret 全缺=未就绪跳过；
    // 未接入平台放行走 buildAdapter 的「暂未接入」报告（用户能看到平台状态而非静默无反应）
    if (missing && GATEWAY_READY.includes(id)) {
      console.log(`（消息网关 ${id} 缺少凭据——未就绪跳过）`)
      continue
    }
    // 非敏感配置项（corpId/agentId/appId 等）落 settings.json
    for (const [k, v] of Object.entries(p.config ?? {})) {
      if (!k.startsWith('keychain:')) config[k] = v
    }
    out.push({ id, config })
  }
  return out
}

/** 已接入网关的平台（buildAdapter 有实现）；新平台接入时同步更新 */
const GATEWAY_READY = ['telegram', 'dingtalk', 'qqbot', 'feishu', 'wecom', 'weixin', 'slack', 'email']

function buildAdapter(id: string, config: PlatformConfig, stateDir: string, fetchImpl?: FetchImpl, wsImpl?: WsImpl): PlatformAdapter | null {
  switch (id) {
    case 'telegram':
      return config.botToken ? new TelegramAdapter(config.botToken, stateDir, fetchImpl) : null
    case 'dingtalk':
      return config.appKey && config.appSecret ? new DingtalkAdapter(config.appKey, config.appSecret, fetchImpl, wsImpl) : null
    case 'qqbot':
      return config.appId && config.appSecret ? new QQBotAdapter(config.appId, config.appSecret, fetchImpl, wsImpl) : null
    case 'feishu':
      return config.appId && config.appSecret ? new FeishuAdapter(config.appId, config.appSecret) : null
    case 'wecom':
      return config.botId && config.secret ? new WeComAdapter(config.botId, config.secret, wsImpl) : null
    case 'weixin':
      return config.token && config.accountId ? new WeixinAdapter(config.token, config.accountId, fetchImpl) : null
    case 'slack':
      return config.botToken && config.appToken ? new SlackAdapter(config.botToken, config.appToken, fetchImpl, wsImpl) : null
    case 'email':
      return config.address && config.password && config.imapHost && config.smtpHost
        ? new EmailAdapter(config.address, config.password, config.imapHost, Number(config.imapPort || 993), config.smtpHost, Number(config.smtpPort || 587))
        : null
    default:
      return null // 飞书/钉钉/Slack/QQbot/企微/微信逐个迭代接入（未接入平台静默跳过）
  }
}

/**
 * 启动全部已配置平台。失败隔离：单平台启动失败只进 status 不拖垮其它。
 * onAnswer=收到消息后的处理函数（daemon 侧注入 runAgentTools 包装）。
 */
export async function startGateway(
  stateDir: string,
  onMessage: (m: InboundMessage) => Promise<string>,
  fetchImpl?: FetchImpl,
  wsImpl?: WsImpl,
): Promise<GatewayStatus[]> {
  await stopGateway()
  const statuses: GatewayStatus[] = []
  for (const { id, config } of enabledPlatforms()) {
    const adapter = buildAdapter(id, config, stateDir, fetchImpl, wsImpl)
    if (!adapter) {
      statuses.push({ platform: id, running: false, error: '该平台暂未接入——本轮支持 Telegram' })
      continue
    }
    try {
      const stop = await adapter.start(async (m) => {
        try {
          const answer = await onMessage(m)
          if (answer) await adapter.send(m.chatId, answer, m.replyTo)
        } catch (e: any) {
          console.log(`（消息网关 ${m.platform} 处理失败：${String(e?.message ?? e).slice(0, 120)}）`)
          try {
            await adapter.send(m.chatId, '（小月处理这条消息时出错了，请稍后重试）')
          } catch {
            /* 投递失败静默 */
          }
        }
      })
      runningStops.set(id, stop)
      statuses.push({ platform: id, running: true })
      console.log(`（消息网关 ${id} 已启动）`)
    } catch (e: any) {
      statuses.push({ platform: id, running: false, error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  return statuses
}

export async function stopGateway(): Promise<void> {
  for (const [id, stop] of runningStops) {
    try {
      stop()
    } catch {
      /* 忽略停止失败 */
    }
    console.log(`（消息网关 ${id} 已停止）`)
  }
  runningStops.clear()
}

export function gatewayRunning(): string[] {
  return [...runningStops.keys()]
}
