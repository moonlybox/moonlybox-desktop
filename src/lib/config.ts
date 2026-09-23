/**
 * 配置层：~/.config/moonlybox/config.json
 *
 * 纪律（§5.14.1）：token 只入系统钥匙串（M2 引入 keytar/安全存储，骨架期先落
 * 配置文件但 gitignore 全局排除；正式版必须迁移）；本文件不存任何明文密钥到 vault。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export interface Config {
  auth?: {
    /** 用户 id（服务端返回），仅展示用 */
    userId?: string
    accountEmail?: string
    /** token 存储占位：正式实现迁移到系统钥匙串，当前仅骨架内存态，不落盘 */
    tokenRef?: 'keychain:moonlybox'
  }
  vault?: {
    /** vault 根目录（sync/inbox 默认根） */
    root?: string
  }
  api?: {
    /** 平台 API 基址（默认 https://moonlybox.cn） */
    baseUrl?: string
  }
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? path.join(xdg, 'moonlybox') : path.join(os.homedir(), '.config', 'moonlybox')
}

export function configPath(): string {
  return path.join(configDir(), 'config.json')
}

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

export function defaultBaseUrl(): string {
  return loadConfig().api?.baseUrl ?? 'https://moonlybox.cn'
}

export function defaultVaultRoot(): string {
  return loadConfig().vault?.root ?? path.join(os.homedir(), 'MyMoonVault')
}
