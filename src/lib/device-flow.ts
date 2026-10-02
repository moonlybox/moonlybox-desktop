/**
 * OAuth Device Flow（RFC 8628）客户端实现（WBS 任务 3）。
 * 流程：DCR 注册 client → POST /oauth/device/code → 打开浏览器审批 → 轮询 /oauth/token。
 * 服务端：Passport v13 内置 device flow（DCR 已支持 client_type=desktop）。
 */
import { apiCall } from './api'
import { loadCredentials, saveCredentials, type Credentials } from './auth'
import { defaultBaseUrl } from './config'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** 确保有 desktop 客户端（DCR 幂等：每次 login 注册一次，旧客户端可在站内撤销） */
export async function ensureClient(baseUrl?: string): Promise<string> {
  const res = await apiCall<{ client_id: string }>('POST', '/oauth/register', {
    client_name: 'MoonlyBox CLI',
    client_type: 'desktop',
  }, { baseUrl })
  if (!res.ok || !res.data?.client_id) {
    throw new Error(`DCR 失败 (${res.status}): ${JSON.stringify(res.data)}`)
  }
  return res.data.client_id
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export async function requestDeviceCode(clientId: string, baseUrl?: string): Promise<DeviceCodeResponse> {
  const base = baseUrl ?? defaultBaseUrl()
  const body = new URLSearchParams({ client_id: clientId, scope: 'moonlink' })
  const res = await fetch(`${base}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json()) as any
  if (!res.ok) throw new Error(`device/code 失败 (${res.status}): ${JSON.stringify(json)}`)
  return json as DeviceCodeResponse
}

// #253.32：access_token 过期自动续（refresh_token grant）——daemon 调用前统一走 ensureFreshToken
export async function refreshAccessToken(clientId: string, refreshToken: string, baseUrl?: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const base = baseUrl ?? defaultBaseUrl()
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json().catch(() => null)) as any
  if (!res.ok || !json?.access_token) throw new Error(`refresh 失败 (${res.status}): ${JSON.stringify(json?.error ?? json)}`)
  return json
}

export type PollResult =
  | { status: 'pending'; error: string }
  | { status: 'slow_down'; error: string }
  | { status: 'done'; tokens: { access_token: string; refresh_token: string; expires_in: number } }
  | { status: 'denied' | 'expired'; error: string }

export async function pollToken(clientId: string, deviceCode: string, baseUrl?: string): Promise<PollResult> {
  const base = baseUrl ?? defaultBaseUrl()
  const body = new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: clientId, device_code: deviceCode })
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json()) as any
  if (res.ok && json.access_token) {
    return { status: 'done', tokens: json }
  }
  if (json.error === 'authorization_pending') return { status: 'pending', error: json.error }
  if (json.error === 'slow_down') return { status: 'slow_down', error: json.error }
  if (json.error === 'access_denied') return { status: 'denied', error: json.error }
  if (json.error === 'expired_token') return { status: 'expired', error: json.error }
  return { status: 'expired', error: json.error ?? `HTTP ${res.status}` }
}

// #317.5：access_token 过期（<60s 余量）自动用 refresh_token 续期+落盘——从 daemon.ts 上收单源
// （此前只在 profile/nav 三处调用；moonlink.rpc 与 apiGet 系裸用 creds.accessToken→登录超 1h 后 MCP/同步 401「未登录或登录已过期」而 UI 仍显示已登录）
export async function ensureFreshToken(): Promise<{ accessToken: string; creds: Credentials }> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录')
  const exp = creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt).getTime() : 0
  if (exp - Date.now() > 60_000) return { accessToken: creds.accessToken, creds }
  if (!creds.refreshToken) throw new Error('登录态已过期且无 refresh_token，请重新登录')
  const clientId = creds.clientId
  if (!clientId) throw new Error('缺少 clientId，请重新登录')
  const tokens = await refreshAccessToken(clientId, creds.refreshToken)
  const fresh = {
    ...creds,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    refreshToken: tokens.refresh_token ?? creds.refreshToken,
  }
  saveCredentials(fresh)
  return { accessToken: fresh.accessToken, creds: fresh }
}
