/**
 * API 客户端：moonlybox CLI ↔ 平台（HTTP）
 * 骨架期直接 fetch；token 存取在 auth.ts。
 */
import { defaultBaseUrl } from './config'

export interface ApiResult<T = any> {
  status: number
  ok: boolean
  data: T | null
}

export async function apiCall<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { token?: string; baseUrl?: string; timeoutMs?: number },
): Promise<ApiResult<T>> {
  const base = opts?.baseUrl ?? defaultBaseUrl()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30_000)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts?.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    return { status: res.status, ok: res.ok, data }
  } finally {
    clearTimeout(timer)
  }
}

/** 便捷封装：自动注入登录 token；非 2xx 抛错（sync 引擎用） */
export async function apiGet<T = any>(path: string, opts?: { baseUrl?: string }): Promise<T> {
  const { loadCredentials } = await import('./auth')
  // #317.5：调用前续期（access_token 1h——此前 sync/图示/备份链超 1h 后 401「未登录或登录已过期」；续期失败按原 401 语义抛）
  try {
    const { ensureFreshToken } = await import('./device-flow')
    await ensureFreshToken()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('未登录')) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    // 其他续期失败（网络抖动等）不阻断——用现 token 走请求，由 401 分支兜底报错
  }
  const creds = loadCredentials()
  const res = await apiCall<T>('GET', `/api${path}`, undefined, { ...opts, token: creds?.accessToken })
  if (!res.ok) {
    if (res.status === 401) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    throw new Error(`GET ${path} → ${res.status}`)
  }
  return res.data as T
}

export async function apiPatch<T = any>(path: string, body?: unknown, opts?: { baseUrl?: string }): Promise<T> {
  const { loadCredentials } = await import('./auth')
  // #317.5：调用前续期（access_token 1h——此前 sync/图示/备份链超 1h 后 401「未登录或登录已过期」；续期失败按原 401 语义抛）
  try {
    const { ensureFreshToken } = await import('./device-flow')
    await ensureFreshToken()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('未登录')) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    // 其他续期失败（网络抖动等）不阻断——用现 token 走请求，由 401 分支兜底报错
  }
  const creds = loadCredentials()
  const res = await apiCall<T>('PATCH', `/api${path}`, body, { ...opts, token: creds?.accessToken })
  if (!res.ok) {
    if (res.status === 401) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    throw new Error(`PATCH ${path} → ${res.status}`)
  }
  return res.data as T
}

export async function apiDelete<T = any>(path: string, opts?: { baseUrl?: string }): Promise<T> {
  const { loadCredentials } = await import('./auth')
  // #317.5：调用前续期（access_token 1h——此前 sync/图示/备份链超 1h 后 401「未登录或登录已过期」；续期失败按原 401 语义抛）
  try {
    const { ensureFreshToken } = await import('./device-flow')
    await ensureFreshToken()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('未登录')) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    // 其他续期失败（网络抖动等）不阻断——用现 token 走请求，由 401 分支兜底报错
  }
  const creds = loadCredentials()
  const res = await apiCall<T>('DELETE', `/api${path}`, undefined, { ...opts, token: creds?.accessToken })
  if (!res.ok) {
    if (res.status === 401) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    throw new Error(`DELETE ${path} → ${res.status}`)
  }
  return res.data as T
}

export async function apiPost<T = any>(path: string, body?: unknown, opts?: { baseUrl?: string }): Promise<T> {
  const { loadCredentials } = await import('./auth')
  // #317.5：调用前续期（access_token 1h——此前 sync/图示/备份链超 1h 后 401「未登录或登录已过期」；续期失败按原 401 语义抛）
  try {
    const { ensureFreshToken } = await import('./device-flow')
    await ensureFreshToken()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('未登录')) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    // 其他续期失败（网络抖动等）不阻断——用现 token 走请求，由 401 分支兜底报错
  }
  const creds = loadCredentials()
  const res = await apiCall<T>('POST', `/api${path}`, body, { ...opts, token: creds?.accessToken })
  if (!res.ok) {
    if (res.status === 401) throw new Error('未登录或登录已过期：先运行 `moonlybox login`')
    throw new Error(`POST ${path} → ${res.status}`)
  }
  return res.data as T
}
