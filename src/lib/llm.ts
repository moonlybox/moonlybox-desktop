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

function loadByokKey(): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).getPassword() || null
  } catch {
    return null
  }
}

/** BYOK 就绪判定（meta+key 都在才算配好） */
export function byokReady(): boolean {
  return loadByokMeta() !== null && loadByokKey() !== null
}

export interface ChatResult {
  ok: boolean
  text?: string
  error?: string
}

/** 单轮对话（非流式，CLI 场景 300 字纪律内无需流式渲染） */
export async function byokChat(system: string, question: string, timeoutMs = 60_000): Promise<ChatResult> {
  const meta = loadByokMeta()
  const apiKey = loadByokKey()
  if (!meta || !apiKey) return { ok: false, error: 'BYOK 未配置' }

  try {
    const res = await fetch(`${meta.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: meta.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        max_tokens: 1500,
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
