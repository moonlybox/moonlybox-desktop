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
  /** 平台内会话标识（telegram=chat.id） */
  chatId: string
  /** 发送者展示名（可空） */
  sender?: string
  text: string
}

/** 平台发送凭据（钥匙串读取由 daemon 侧注入，本模块不碰 keyring） */
export type PlatformConfig = Record<string, string>

/** 平台适配器接口（Hermes BasePlatformAdapter 最小面） */
export interface PlatformAdapter {
  id: string
  /** 启动收件循环；返回 stop 函数。onMessage 回调抛错由网关兜 */
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<() => void>
  /** 发送文本到指定会话 */
  send(chatId: string, text: string): Promise<void>
}

/* ============================ Telegram ============================ */

const TG_POLL_TIMEOUT_S = 30

/** fetch 注入形态（生产=global fetch；e2e 注 mock——bun test 对 global.fetch 替换的时序不可靠） */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

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

  async send(chatId: string, text: string): Promise<void> {
    // 4096 字符上限分片
    for (let i = 0; i < text.length; i += 4000) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
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
  wecom: ['corpSecret'],
  dingtalk: ['appSecret'],
  telegram: ['botToken'],
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
const GATEWAY_READY = ['telegram']

function buildAdapter(id: string, config: PlatformConfig, stateDir: string, fetchImpl?: FetchImpl): PlatformAdapter | null {
  switch (id) {
    case 'telegram':
      return config.botToken ? new TelegramAdapter(config.botToken, stateDir, fetchImpl) : null
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
): Promise<GatewayStatus[]> {
  await stopGateway()
  const statuses: GatewayStatus[] = []
  for (const { id, config } of enabledPlatforms()) {
    const adapter = buildAdapter(id, config, stateDir, fetchImpl)
    if (!adapter) {
      statuses.push({ platform: id, running: false, error: '该平台暂未接入——本轮支持 Telegram' })
      continue
    }
    try {
      const stop = await adapter.start(async (m) => {
        try {
          const answer = await onMessage(m)
          if (answer) await adapter.send(m.chatId, answer)
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
