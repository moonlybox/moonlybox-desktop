/**
 * 消息平台网关（#286，Hermes gateway 范式 TS 轻量版）。
 *
 * 架构：daemon 内常驻网关——settings.messaging.providers 配置驱动，每启用平台一个 adapter；
 * 收件（轮询/长连接）→ 统一 InboundMessage → runAgentTools（无头小月，chatId=msg:<platform>:<chatId> 持久化）→ 回复投递。
 * Hermes 范式裁剪：不做媒体转码/房间授权/配额治理；做密钥钥匙串、失败隔离（单平台炸不拖垮网关）、轮询退避。
 * 分批：第一批 Telegram（getUpdates 长轮询，零依赖）；飞书/钉钉/Slack(ws)/QQbot/企微/个人微信逐个后续迭代接入。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadSettings } from './settings'

/** 消息平台凭据钥匙串（account=msg:<platform>:<key>，secret 字段一律不入 settings.json） */
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
  wecom: ['corpSecret'],
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
const GATEWAY_READY = ['telegram', 'dingtalk', 'qqbot', 'feishu']

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
