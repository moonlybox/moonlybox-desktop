/**
 * 备份同步引擎（#257）：本地备份目录 → 云端书房「归属目录」。
 *
 * 职责：
 * - 注册表（~/.config/moonlybox/backups.json）：多个 { id, localPath, directoryId, directoryName, enabled } 
 * - 上行：遍历本地目录，限可识别格式（.md/.txt 文本文件——服务端 /library 文档管道仅收文本内容），
 *   POST /library { title, content, directoryId }；backups.json 落 sha256 账（未变更跳过，断点续传）。
 * - 备份文件不进书房 vault 镜像区（独立注册表，与书房同步互不干扰）；云端产生的文档由书房「云端列」正常可见。
 * - 归属目录=云端书房目录树任一目录（GET /library 的 directories，嵌套树平铺选择）；不选=根目录。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { apiGet, apiPost } from './api'
import { loadCredentials } from './auth'

/** 可识别格式（新建界面说明同步展示）——服务端文档管道仅支持文本 */
export const BACKUP_EXTS = ['.md', '.txt']

export interface BackupEntry {
  id: string
  localPath: string
  directoryId: string | null
  directoryName: string
  enabled: boolean
  lastSyncAt?: string
  /** sha256 账：absolutePath → hash（未变更跳过） */
  files: Record<string, { sha256: string; docId: string; uploadedAt: string }>
}

export interface BackupRegistry {
  entries: BackupEntry[]
}

function registryPath(): string {
  return path.join(configDir(), 'backups.json')
}

export function loadRegistry(): BackupRegistry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as BackupRegistry
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] }
  } catch {
    return { entries: [] }
  }
}

export function saveRegistry(reg: BackupRegistry): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
}

export function addEntry(localPath: string, directoryId: string | null, directoryName: string): BackupEntry {
  const reg = loadRegistry()
  if (reg.entries.some((e) => e.localPath === localPath)) throw new Error('该目录已注册备份')
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) throw new Error('本地目录不存在')
  const entry: BackupEntry = {
    id: `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    localPath,
    directoryId,
    directoryName,
    enabled: true,
    files: {},
  }
  reg.entries.push(entry)
  saveRegistry(reg)
  return entry
}

export function removeEntry(id: string): void {
  const reg = loadRegistry()
  reg.entries = reg.entries.filter((e) => e.id !== id)
  saveRegistry(reg)
}

export function setEnabled(id: string, enabled: boolean): void {
  const reg = loadRegistry()
  const e = reg.entries.find((x) => x.id === id)
  if (!e) throw new Error('备份目录不存在')
  e.enabled = enabled
  saveRegistry(reg)
}

function sha256(s: string): string {
  // Bun/Node 21+ 全局 crypto；Bun 下 require('crypto') 同源
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(s).digest('hex')
}

/** 云端目录树 → 平铺选项（带层级缩进名） */
export async function listCloudDirs(): Promise<Array<{ id: string | null; label: string }>> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先在壳端头像登录')
  const res = await apiGet<any>('/library')
  if (!res.ok) throw new Error(`目录树获取失败：HTTP ${res.status}`)
  const dirs = res.data?.directories ?? []
  const out: Array<{ id: string | null; label: string }> = [{ id: null, label: '书房根目录' }]
  const walk = (nodes: any[], depth: number) => {
    for (const n of nodes) {
      out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` })
      if (Array.isArray(n.children) && n.children.length) walk(n.children, depth + 1)
    }
  }
  walk(dirs, 1)
  return out
}

export interface BackupReport {
  uploaded: string[]
  skipped: string[]
  conflicts: Array<{ path: string; reason: string }>
  entryId: string
  directoryName: string
}

/** 同步单个注册目录：限 BACKUP_EXTS，sha256 未变更跳过 */
export async function backupSync(id: string): Promise<BackupReport> {
  const reg = loadRegistry()
  const entry = reg.entries.find((x) => x.id === id)
  if (!entry) throw new Error('备份目录不存在')
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先在壳端头像登录')
  const report: BackupReport = { uploaded: [], skipped: [], conflicts: [], entryId: id, directoryName: entry.directoryName }
  let names: string[] = []
  try {
    names = fs.readdirSync(entry.localPath)
  } catch (e: any) {
    throw new Error(`本地目录不可读：${String(e?.message ?? e)}`)
  }
  // 只取根层可识别文本文件（备份目录不递归子目录——备份语义=「这堆文件的原样副本」，层级交给云端归属目录）
  const files = names
    .filter((n) => !n.startsWith('.') && BACKUP_EXTS.includes(path.extname(n).toLowerCase()))
    .sort()
  for (const name of files) {
    const abs = path.join(entry.localPath, name)
    if (!fs.statSync(abs).isFile()) continue
    try {
      const raw = fs.readFileSync(abs, 'utf8')
      const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
      if (!stripped) {
        report.skipped.push(`${name}（空文件）`)
        continue
      }
      const hash = sha256(raw)
      const prev = entry.files[abs]
      if (prev && prev.sha256 === hash) {
        report.skipped.push(`${name}（未变更）`)
        continue
      }
      const title = name.replace(/\.(md|txt)$/i, '').slice(0, 200)
      const res = await apiPost<any>('/library', {
        title,
        content: stripped,
        ...(entry.directoryId ? { directoryId: entry.directoryId } : {}),
      })
      const doc = res.data?.document
      if (!doc?.id) throw new Error(res.message ?? '上传失败')
      entry.files[abs] = { sha256: hash, docId: doc.id, uploadedAt: new Date().toISOString() }
      entry.lastSyncAt = new Date().toISOString()
      saveRegistry(reg)
      report.uploaded.push(name)
    } catch (e: any) {
      report.conflicts.push({ path: name, reason: String(e?.message ?? e) })
    }
  }
  entry.lastSyncAt = new Date().toISOString()
  saveRegistry(reg)
  return report
}

/** 全部启用的备份目录依次同步 */
export async function backupSyncAll(): Promise<BackupReport[]> {
  const reg = loadRegistry()
  const out: BackupReport[] = []
  for (const e of reg.entries.filter((x) => x.enabled)) {
    out.push(await backupSync(e.id))
  }
  return out
}
