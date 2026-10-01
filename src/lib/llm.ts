/**
 * BYOK LLM 客户端（#232 M3，D8 定案）：OpenAI-compatible /chat/completions 直连。
 *
 * key 纪律（原则⑤）：apiKey 只存本机钥匙串（service=moonlybox/account=llm-byok），
 * 永不上传云端、不落明文文件；baseUrl/model 存 credentials.json 元数据。
 * 兼容 Ollama / LM Studio / vLLM / 各家 OpenAI 兼容端点（D8 通吃）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'

export interface ByokConfig {
  baseUrl: string
  model: string
}

const KEYCHAIN_SERVICE = 'moonlybox'
const KEYCHAIN_ACCOUNT = 'llm-byok'

function byokMetaPath(): string {
  return path.join(configDir(), 'byok.json')
}

export function loadByokMeta(): ByokConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(byokMetaPath(), 'utf8')) as ByokConfig
    return raw.baseUrl && raw.model ? raw : null
  } catch {
    return null
  }
}

export function saveByokMeta(cfg: ByokConfig): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(byokMetaPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

export function clearByok(): void {
  try {
    fs.unlinkSync(byokMetaPath())
  } catch {
    /* 无文件 */
  }
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).deleteCredential()
  } catch {
    /* 无条目 */
  }
}

export function saveByokKey(apiKey: string): void {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).setPassword(apiKey)
}

/** 读取 key 本体（仅 daemon 内部使用——响应用只回 hasKey 布尔，key 绝不出内核） */
export function loadByokKey(): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).getPassword() || null
  } catch {
    return null
  }
}

/** BYOK 就绪判定（meta+key 都在才算配好） */
export function byokReady(): boolean {
  // #283：委托模型注册表（新结构 default 实例 → 旧 byok.json 回落）——两代配置任一可用即 ready
  try {
    const { modelReady } = require('./model-registry') as typeof import('./model-registry')
    return modelReady()
  } catch {
    return loadByokMeta() !== null && loadByokKey() !== null
  }
}

export interface ChatResult {
  ok: boolean
  text?: string
  error?: string
}

/** #310.14：本地端点判定（Ollama/LM Studio 等 127.0.0.1|localhost——无需 key） */
function isLocalEndpoint(baseUrl: string): boolean {
  return /\/\/?(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(baseUrl) || baseUrl.startsWith('http://[::1]')
}

/** 单轮对话（非流式，CLI 场景 300 字纪律内无需流式渲染） */
export async function byokChat(
  system: string,
  question: string,
  timeoutMs = 60_000,
  /** #283：模型注册表实例——传入时替代全局 byok 配置 */
  modelOverride?: { baseUrl: string; model: string; apiKey: string | null },
): Promise<ChatResult> {
  const meta = modelOverride ? { baseUrl: modelOverride.baseUrl, model: modelOverride.model } : loadByokMeta()
  const apiKey = modelOverride ? modelOverride.apiKey : loadByokKey()
  if (!meta) return { ok: false, error: 'BYOK 未配置' }
  // #310.14：本地端点无需 key（Ollama 等）；远端缺 key 仍报 BYOK
  if (!apiKey && !isLocalEndpoint(meta.baseUrl)) return { ok: false, error: 'BYOK 未配置（API Key 缺失）' }

  try {
    const res = await fetch(`${meta.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: meta.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        max_tokens: 4000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = body.choices?.[0]?.message?.content?.trim()
    return text ? { ok: true, text } : { ok: false, error: '空回复' }
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) }
  }
}

export interface ToolCallRequest {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCallRequest[]
  tool_call_id?: string
}

export interface ChatWithToolsResult {
  ok: boolean
  text?: string
  toolCalls?: ToolCallRequest[]
  error?: string
}

/** 多轮 messages + tools 对话（Agent loop 核心原语；BYOK 直连，key 永不出本机） */
export async function byokChatMessages(
  messages: ChatMessage[],
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters: unknown } }>,
  timeoutMs = 90_000,
  /** #283：模型注册表实例（resolveActiveModel 结果）——传入时替代全局 byok 配置 */
  modelOverride?: { baseUrl: string; model: string; apiKey: string | null },
  /** #310.19：生成上限（默认 4000 保持兼容；思考型模型 reasoning 占额+知识页长文都需要更大余量） */
  maxTokens = 4000,
): Promise<ChatWithToolsResult> {
  const meta = modelOverride ? { baseUrl: modelOverride.baseUrl, model: modelOverride.model } : loadByokMeta()
  const apiKey = modelOverride ? modelOverride.apiKey : loadByokKey()
  if (!meta) return { ok: false, error: 'BYOK 未配置' }
  // #310.14：本地端点无需 key（Ollama 等）；远端缺 key 仍报 BYOK
  if (!apiKey && !isLocalEndpoint(meta.baseUrl)) return { ok: false, error: 'BYOK 未配置（API Key 缺失）' }
  try {
    const t0 = Date.now() // #310.15：耗时/token 速度诊断
    const res = await fetch(`${meta.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: meta.model,
        messages,
        ...(tools && tools.length ? { tools } : {}),
        max_tokens: maxTokens, // #310.19：可变上限（默认 4000）
        temperature: 0.3,
        // #310.36：思考型模型关思考（编译/分析类任务无需 reasoning；思考吃满 max_tokens=空正文主因）
        // 按端点家族注入（严格校验端点对未知字段 400，不能全量注入）：
        // - Ollama 本地：think:false
        // - 智谱 GLM（glm-4.5+ 默认开思考）：thinking:{type:'disabled'}
        ...(isLocalEndpoint(meta.baseUrl) && /:11434|\/ollama/i.test(meta.baseUrl) ? { think: false } : {}),
        ...(/bigmodel\.cn|\/glm/i.test(meta.baseUrl) ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: ToolCallRequest[] }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const choice = body.choices?.[0]
    const msg = choice?.message
    if (!msg) return { ok: false, error: '空回复' }
    // #280.3 诊断行：空回答排查需要有据——模型原始形态打进活动流（content 长度/reasoning 痕迹/工具调用数/finish_reason）
    const dbgParts = [
      `content=${msg.content ? msg.content.length : 'null'}`,
      `reasoning=${(msg as Record<string, unknown>).reasoning_content ? 'yes' : 'no'}`,
      `tool_calls=${msg.tool_calls?.length ?? 0}`,
      `finish=${choice?.finish_reason ?? '?'}`,
    ]
    // #310.15：耗时/token 速度（usage 为端点可选返回——Ollama/主流平台都有；缺失则只报耗时）
    const ms = Date.now() - t0
    const ct = body.usage?.completion_tokens
    if (ct) dbgParts.push(`耗时=${(ms / 1000).toFixed(1)}s`, `tokens=${ct}`, `速度=${(ct / (ms / 1000)).toFixed(1)} tok/s`)
    else dbgParts.push(`耗时=${(ms / 1000).toFixed(1)}s`)
    console.log(`（LLM 响应：${dbgParts.join(' ')}）`)
    const text = msg.content?.trim() || undefined
    // #280.3：空内容+无工具调用=端点异常静默源（思考型模型 reasoning 吃掉 max_tokens/端点 tools 协议不兼容）
    // ——必须当失败走重试与最终报错，绝不能静默 ok 让小月零输出零报错
    if (!text && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      // #310.36：思考型模型把 max_tokens 吃满（finish=length）→ 自动加倍重试一次（上限 32k）——
      // 编译链路无上层重试，一次自愈避免整篇失败；非 length（协议异常）不重试直接报错
      if (choice?.finish_reason === 'length' && maxTokens < 32_000) {
        console.log(`（LLM 空正文 finish=length：max_tokens ${maxTokens}→${maxTokens * 2} 重试一次）`)
        return byokChatMessages(messages, tools, timeoutMs, modelOverride, Math.min(maxTokens * 2, 32_000))
      }
      const hint = (msg as Record<string, unknown>).reasoning_content
        ? '模型只输出思考未输出正文（思考型模型在 tools 协议下可能吃掉全部 max_tokens）'
        : '端点可能不兼容 tools 协议或返回格式异常'
      return { ok: false, error: `模型返回空内容（finish_reason=${choice?.finish_reason ?? '未知'}；${hint}）` }
    }
    return { ok: true, text, toolCalls: msg.tool_calls }
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) }
  }
}
