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
  const creds = loadCredentials()
  const res = await apiCall<T>('GET', `/api${path}`, undefined, { ...opts, token: creds?.accessToken })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.data as T
}

export async function apiPost<T = any>(path: string, body?: unknown, opts?: { baseUrl?: string }): Promise<T> {
  const { loadCredentials } = await import('./auth')
  const creds = loadCredentials()
  const res = await apiCall<T>('POST', `/api${path}`, body, { ...opts, token: creds?.accessToken })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`)
  return res.data as T
}
