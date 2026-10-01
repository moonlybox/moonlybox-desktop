/**
 * 模型注册表（#283）：平台API 多实例+自定义多模型+本地部署（#310.14 实装 Ollama）统一解析。
 * - settings.model.default = 'platform:<id>' | 'custom:<id>' | 'local:<id>' | ''
 * - key 纪律：所有 key 只存钥匙串（service=moonlybox, account=`llm:<实例id>`），settings 只存非敏感元数据；
 *   遗留明文 apiKey 字段读取时自动迁移（daemon settings save 剥离）。
 * - 空/default 失效 → 回落旧 byok.json 单模型（≤#282 兼容，不丢用户已配模型）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { loadSettings, PLATFORM_PROVIDERS } from './settings'

export interface ActiveModel {
  /** 实例 id（'legacy_byok'=旧 byok.json 回落） */
  id: string
  kind: 'platform' | 'custom' | 'local' | 'legacy'
  label: string
  baseUrl: string
  model: string
  apiKey: string | null
}

/** 钥匙串读 key（复用 llm.ts 的 service；account=llm:<id>） */
function keychainKey(account: string): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry('moonlybox', account).getPassword() || null
  } catch {
    return null
  }
}

/** 钥匙串写 key */
export function saveModelKey(instanceId: string, apiKey: string): void {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  new Entry('moonlybox', `llm:${instanceId}`).setPassword(apiKey)
}

/** 删除实例 key */
export function deleteModelKey(instanceId: string): void {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    new Entry('moonlybox', `llm:${instanceId}`).deleteCredential()
  } catch {
    /* 无条目 */
  }
}

/** 旧 byok.json（<=#282 单模型） */
function legacyByok(): { baseUrl: string; model: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir(), 'byok.json'), 'utf8')) as { baseUrl: string; model: string }
    return raw.baseUrl && raw.model ? raw : null
  } catch {
    return null
  }
}

/** 旧钥匙串 llm-byok */
function legacyKey(): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry('moonlybox', 'llm-byok').getPassword() || null
  } catch {
    return null
  }
}

/** 解析当前应使用的模型：default 指向的已启用实例 → 旧 byok 回落 → null（未配置） */
/** 按实例引用解析（'platform:<id>'|'custom:<id>'|'local:<id>'）——#316.7 单源化：resolveActiveModel 与 compile-model 共用 */
export function pickModelInstance(id: string): ActiveModel | null {
  const m = loadSettings().model
  if (id.startsWith('platform:')) {
    const inst = (m.providers ?? []).find((p) => p.id === id.slice(9) && p.enabled)
    if (!inst) return null
    const pv = PLATFORM_PROVIDERS.find((x) => x.id === inst.providerId)
    const baseUrl = inst.baseUrl || pv?.baseUrl || ''
    if (!baseUrl || !inst.model) return null
    const apiKey = keychainKey(`llm:${inst.id}`)
    // 平台实例 key 必填——缺 key 视为未就绪（配置半成品不参与解析，避免 byokReady 语义分裂）
    if (!apiKey) return null
    return { id: inst.id, kind: 'platform', label: pv?.label ?? inst.providerId, baseUrl, model: inst.model, apiKey }
  }
  if (id.startsWith('custom:')) {
    const inst = (m.custom ?? []).find((c) => c.id === id.slice(7) && c.enabled)
    if (!inst || !inst.baseUrl || !inst.model) return null
    const apiKey = keychainKey(`llm:${inst.id}`)
    if (!apiKey) return null // 非本地自定义端点 key 必填（本地端点保底走 legacy 回落）
    return { id: inst.id, kind: 'custom', label: inst.name || '自定义', baseUrl: inst.baseUrl, model: inst.model, apiKey }
  }
  if (id.startsWith('local:')) {
    const inst = (m.local ?? []).find((l) => l.id === id.slice(6) && l.enabled)
    if (!inst) return null
    // #310.14：本地模型接通 chat——Ollama OpenAI 兼容端点（无需 key）；inst.baseUrl 预留自定义端点
    const baseUrl = (inst as { baseUrl?: string }).baseUrl || 'http://127.0.0.1:11434/v1'
    return { id: inst.id, kind: 'local', label: inst.name || '本地部署', baseUrl, model: inst.model, apiKey: null }
  }
  return null
}

export function resolveActiveModel(): ActiveModel | null {
  const m = loadSettings().model
  const hit = m.default ? pickModelInstance(m.default) : null
  if (hit) return hit
  // 回落旧 byok.json（用户已配模型不丢；key=旧钥匙串 llm-byok 或 llm:<新id>）
  const lb = legacyByok()
  if (lb) {
    const key = legacyKey() ?? keychainKey('llm:custom_migrated')
    return { id: 'legacy_byok', kind: 'legacy', label: '已配置模型', baseUrl: lb.baseUrl, model: lb.model, apiKey: key }
  }
  return null
}

/** 模型是否可用（对话/AI 功能门控） */
export function modelReady(): boolean {
  return resolveActiveModel() !== null
}
