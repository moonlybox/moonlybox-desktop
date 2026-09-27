/**
 * 提供商清单云端源（#276）：平台为统一源（`GET /api/client/providers`，登录后拉取），
 * 本地缓存 providers-cache.json；未登录/离线/过期失败 → 缓存 → 内置表兜底。
 * messaging 恒本地内置（本地组件能力，不走云端清单）。
 * 正常维护渠道=平台更新发布云端程序内置清单；admin 应急手工项为未来预留（orphan 标记不受内置覆盖）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { apiGet } from './api'
import { loadCredentials } from './auth'
import { PLATFORM_PROVIDERS, WEBSEARCH_PROVIDERS, URL_EXTRACT_PROVIDERS } from './settings'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface ProvidersManifest {
  platform: Array<{ id: string; label: string; baseUrl: string; models: string[]; docs: string }>
  websearch: Array<{ id: string; label: string; baseUrl: string; needs: string[] }>
  urlextract: Array<{ id: string; label: string; baseUrl?: string; note?: string; needs?: string[] }>
  memory: Array<{ id: string; label: string; note: string }>
  messaging: Array<{ id: string; label: string; needs: Array<{ key: string; label: string; secret?: boolean }> }>
}

function cachePath(): string {
  return path.join(configDir(), 'providers-cache.json')
}

function readCache(): { fetchedAt?: string; providers?: Partial<ProvidersManifest> } | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
  } catch {
    return null
  }
}

function writeCache(providers: Partial<ProvidersManifest>): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify({ fetchedAt: new Date().toISOString(), providers }, null, 2))
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 云端清单拉取+缓存（登录态才拉；TTL 24h 内直接用缓存）。返回每类可用清单（含兜底合并）。 */
export async function resolveProviders(): Promise<ProvidersManifest> {
  const messaging = (await import('./settings')).MESSAGING_PROVIDERS as ProvidersManifest['messaging']
  const out: ProvidersManifest = {
    platform: PLATFORM_PROVIDERS,
    websearch: WEBSEARCH_PROVIDERS,
    urlextract: URL_EXTRACT_PROVIDERS as ProvidersManifest['urlextract'],
    memory: [], // #281 记忆模式唯一（本机内置+月忆增强），客户端不消费提供方清单
    messaging,
  }
  const cache = readCache()
  const fresh = cache?.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS
  if (fresh && cache?.providers) {
    // 缓存新鲜：云端类用缓存，messaging 恒本地
    return { ...out, ...cache.providers, messaging }
  }
  const creds = loadCredentials()
  if (creds?.accessToken) {
    try {
      const res = await apiGet<any>('/client/providers')
      const p = res.data?.providers
      if (p && typeof p === 'object') {
        const cloud: Partial<ProvidersManifest> = {}
        if (Array.isArray(p.platform) && p.platform.length) cloud.platform = p.platform
        if (Array.isArray(p.websearch) && p.websearch.length) cloud.websearch = p.websearch
        if (Array.isArray(p.urlextract) && p.urlextract.length) cloud.urlextract = p.urlextract
        if (Array.isArray(p.memory) && p.memory.length) cloud.memory = p.memory
        if (Object.keys(cloud).length) {
          writeCache(cloud)
          return { ...out, ...cloud, messaging }
        }
      }
    } catch {
      /* 拉取失败 → 缓存/内置兜底 */
    }
  }
  // 未见云端：有过期缓存用缓存，否则内置
  if (cache?.providers) return { ...out, ...cache.providers, messaging }
  return out
}
