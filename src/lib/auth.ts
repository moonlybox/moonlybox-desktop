/**
 * 凭据存取（§5.14.1）：refresh/access token 存系统钥匙串。
 * 骨架期（M1 task3）：Linux Secret Service / macOS Keychain / Win Credential Manager 的
 * 跨平台绑定（keytar 类）引入前，先落 ~/.config/moonlybox/credentials.json（0600），
 * 结构与钥匙串版一致（M2 前迁移，见 config.ts 注释）——绝不进 vault。
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

function credsPath(): string {
  return path.join(configDir(), 'credentials.json')
}

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(credsPath(), 'utf8')) as Credentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(credsPath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(credsPath(), 0o600)
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(credsPath())
  } catch {
    /* 已不存在 */
  }
}
