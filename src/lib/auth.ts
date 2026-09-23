/**
 * 凭据存取（§5.14.1，#230 M2③ 落地）：token 存系统钥匙串。
 *
 * 分层（keychain 不可用时自动回落 credentials.json 0600，保证 CLI 永远可用）：
 *   - 钥匙串（@napi-rs/keyring）：service='moonlybox'，account='tokens'，存 access/refresh token
 *   - credentials.json：clientId/accountEmail/userId 等非敏感元数据（0600，gitignore 全局排除）
 *   - 旧版全量 credentials.json 首次读取时自动迁移（token 入钥匙串后文件里移除 token 字段）
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { configDir } from './config'

export interface Credentials {
  clientId: string
  accessToken?: string
  accessTokenExpiresAt?: string
  refreshToken?: string
  accountEmail?: string
  userId?: string
}

const KEYCHAIN_SERVICE = 'moonlybox'
const KEYCHAIN_ACCOUNT = 'tokens'

interface TokenBlob {
  accessToken?: string
  accessTokenExpiresAt?: string
  refreshToken?: string
}

function credsPath(): string {
  return path.join(configDir(), 'credentials.json')
}

let keychainAvailable: boolean | null = null

/** 钥匙串能力探测（懒加载+缓存；Linux 无 Secret Service/macOS/Win 以外环境回落文件） */
function hasKeychain(): boolean {
  if (keychainAvailable !== null) return keychainAvailable
  try {
    // 动态 import：打包产物在无原生绑定平台不崩
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    const probe = new Entry(KEYCHAIN_SERVICE, 'probe')
    probe.setPassword('probe:ok')
    probe.deleteCredential()
    keychainAvailable = true
  } catch {
    keychainAvailable = false
  }
  return keychainAvailable
}

function keychainRead(): TokenBlob | null {
  if (!hasKeychain()) return null
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    const raw = entry.getPassword()
    return raw ? (JSON.parse(raw) as TokenBlob) : null
  } catch {
    return null
  }
}

function keychainWrite(blob: TokenBlob): void {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
  entry.setPassword(JSON.stringify(blob))
}

function keychainDelete(): void {
  if (!hasKeychain()) return
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).deleteCredential()
  } catch {
    /* 无条目 */
  }
}

export function loadCredentials(): Credentials | null {
  try {
    const meta = JSON.parse(fs.readFileSync(credsPath(), 'utf8')) as Credentials
    const tokens = keychainRead()
    // 旧版全量文件（token 在文件里）：首次读到即迁移到钥匙串并从文件移除
    if (!tokens && (meta.accessToken || meta.refreshToken)) {
      const legacy: TokenBlob = {
        accessToken: meta.accessToken,
        accessTokenExpiresAt: meta.accessTokenExpiresAt,
        refreshToken: meta.refreshToken,
      }
      if (hasKeychain()) {
        try {
          keychainWrite(legacy)
          const { accessToken: _a, accessTokenExpiresAt: _e, refreshToken: _r, ...rest } = meta
          void _a
          void _e
          void _r
          fs.writeFileSync(credsPath(), JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 })
          fs.chmodSync(credsPath(), 0o600)
          return { ...rest, ...legacy }
        } catch {
          return meta // 迁移失败仍返回旧文件内容
        }
      }
      return meta
    }
    return { ...meta, ...(tokens ?? {}) }
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(configDir(), { recursive: true })
  const { accessToken, accessTokenExpiresAt, refreshToken, ...meta } = creds
  const blob: TokenBlob = { accessToken, accessTokenExpiresAt, refreshToken }
  let tokensSaved = false
  if (hasKeychain()) {
    try {
      keychainWrite(blob)
      tokensSaved = true
    } catch {
      tokensSaved = false
    }
  }
  // 回落：无钥匙串时 token 仍落文件（0600，行为与 M1 一致——可用性优先，M3 壳阶段再补系统提示）
  fs.writeFileSync(credsPath(), JSON.stringify(tokensSaved ? meta : { ...meta, ...blob }, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(credsPath(), 0o600)
}

export function clearCredentials(): void {
  keychainDelete()
  try {
    fs.unlinkSync(credsPath())
  } catch {
    /* 已不存在 */
  }
}
