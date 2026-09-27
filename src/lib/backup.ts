/**
 * 备份同步引擎（#257/#258）：本地备份目录 → 云端书房「归属目录」。
 *
 * 职责：
 * - 注册表（~/.config/moonlybox/backups.json）：多个 { id, localPath, directoryId, directoryName, enabled,
 *   onDelete, onConflict } + sha256 账（files[path] = { sha256, docId, docVersion, uploadedAt, hold? }）。
 * - 上行：遍历本地目录根层，限可识别格式（.md/.txt 文本文件——服务端 /library 文档管道仅收文本内容）。
 *   已有 docId 的文件变更走 PATCH /library/{id}（版本+1 更新，不新建）；首次上传 POST /library。
 * - 同名冲突（A/B 机各备份同目录、同名不同 ID）：onConflict=overwrite → PATCH 覆盖云端同名文档；
 *   rename → 本地标题追加「 2」上传为新文档。
 * - 云端删除感知：账内 docId 从云端消失 → onDelete=resync 重新上传 / keep=账标 hold 不再同步（UI 显示已停更）。
 * - 云端编辑感知：账内 docVersion < 云端 version → 云端被编辑过；本地文件未改 → 采纳云端新版本记账；
 *   本地也改了（双向分叉）→ 冲突报告，本地文件不覆盖（报告提示）。
 * - 备份文件不进书房 vault 镜像区（独立注册表）；注册目录禁止 vault 内路径（防交叉污染）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { apiGet, apiPost, apiPatch } from './api'
import { loadCredentials } from './auth'
import { loadSettings } from './settings'

/** 可识别格式（新建界面说明同步展示）——服务端文档管道仅支持文本 */
export const BACKUP_EXTS = ['.md', '.txt']

/** 云端删除后的策略：resync=下次同步重新上传；keep=该文件不再同步 */
export type BackupOnDelete = 'resync' | 'keep'
/** 同名冲突策略：overwrite=覆盖（更新）云端同名文档；rename=本地标题加后缀上传为新文档 */
export type BackupOnConflict = 'overwrite' | 'rename'

export interface BackupFileRec {
  sha256: string
  docId: string
  docVersion: number
  uploadedAt: string
  /** keep 策略下云端删除后置位：该文件不再参与同步 */
  hold?: 'cloud-deleted'
}

export interface BackupEntry {
  id: string
  localPath: string
  directoryId: string | null
  directoryName: string
  enabled: boolean
  /** 云端删除后行为（默认 resync：备份目录是源，删了就补回去） */
  onDelete: BackupOnDelete
  /** 同名冲突行为（默认 rename：不碰别人传的同名文档） */
  onConflict: BackupOnConflict
  lastSyncAt?: string
  /** sha256 账：absolutePath → 记录 */
  files: Record<string, BackupFileRec>
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

/** vault 根（vault.json 的 root）——注册目录禁止落在书房内（防镜像文件被当备份交叉上传） */
function vaultRoot(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir(), 'vault.json'), 'utf8')) as { root?: string }
    return raw.root ?? null
  } catch {
    return null
  }
}

export function addEntry(
  localPath: string,
  directoryId: string | null,
  directoryName: string,
  opts?: { onDelete?: BackupOnDelete; onConflict?: BackupOnConflict },
): BackupEntry {
  // #259：同名覆盖（overwrite）已禁用——双机同目录会轮流静默覆盖且被「云端编辑采纳」洗白；一律 rename
  if (opts?.onConflict === 'overwrite') throw new Error('同名覆盖已停用：同名冲突一律重命名上传（双机备份互不覆盖）')
  const reg = loadRegistry()
  if (reg.entries.some((e) => e.localPath === localPath)) throw new Error('该目录已注册备份')
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) throw new Error('本地目录不存在')
  const vr = vaultRoot()
  if (vr) {
    const a = path.resolve(localPath)
    const b = path.resolve(vr)
    if (a === b || a.startsWith(b + path.sep)) throw new Error('备份目录不能设在书房目录内部（会与书房镜像互相污染）')
  }
  const entry: BackupEntry = {
    id: `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    localPath,
    directoryId,
    directoryName,
    enabled: true,
    onDelete: opts?.onDelete ?? 'resync',
    onConflict: opts?.onConflict ?? 'rename',
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

/** 注册表内单点修改（查→改→原子写整份，通用并发语义） */
function mutateEntry<T>(id: string, fn: (e: BackupEntry, reg: BackupRegistry) => T): T {
  const reg = loadRegistry()
  const e = reg.entries.find((x) => x.id === id)
  if (!e) throw new Error('备份目录不存在')
  const out = fn(e, reg)
  saveRegistry(reg)
  return out
}

export function setEnabled(id: string, enabled: boolean): void {
  mutateEntry(id, (e) => {
    e.enabled = enabled
  })
}

export function setPolicies(
  id: string,
  patch: { onDelete?: BackupOnDelete; onConflict?: BackupOnConflict },
): void {
  // #259：overwrite 禁止写入（存量条目由 backupSync 兜底按 rename 执行）
  if (patch.onConflict === 'overwrite') throw new Error('同名覆盖已停用：同名冲突一律重命名上传（双机备份互不覆盖）')
  mutateEntry(id, (e) => {
    if (patch.onDelete) e.onDelete = patch.onDelete
    if (patch.onConflict) e.onConflict = patch.onConflict
  })
}

function sha256(s: string): string {
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
  /** 更新（PATCH）的文件 */
  updated: string[]
  skipped: string[]
  /** 云端删除感知结果：resync 已重传 / keep 已停更 */
  cloudDeleted: string[]
  /** 云端有更新（版本前进）且本地未改 → 已采纳云端版本记账 */
  cloudUpdated: string[]
  conflicts: Array<{ path: string; reason: string }>
  entryId: string
  directoryName: string
}

interface CloudDoc {
  id: string
  title: string
  version: number
  directoryId: string | null
}

/** 拉云端文档索引（本目录范围），供查重/删除感知/编辑感知 */
async function fetchCloudDocs(): Promise<Map<string, CloudDoc>> {
  const res = await apiGet<any>('/library')
  if (!res.ok) throw new Error(`云端文档获取失败：HTTP ${res.status}`)
  const docs: any[] = res.data?.documents ?? []
  const map = new Map<string, CloudDoc>()
  for (const d of docs) {
    if (d.status !== 'active' || d.isArchived) continue
    if (d.kind === 'diagram' && d.diagramState === 'draft') continue // 图示草稿不进书房（#252 §8.2）
    map.set(d.id, {
      id: d.id,
      title: String(d.title ?? ''),
      version: Number(d.version ?? 1),
      directoryId: d.directoryId ?? null,
    })
  }
  return map
}

/** 同步单个注册目录：限 BACKUP_EXTS；C1 修复=docId 存在走 PATCH；C3=删除感知；同名冲突可配置 */
export async function backupSync(id: string): Promise<BackupReport> {
  const reg = loadRegistry()
  const entry = reg.entries.find((x) => x.id === id)
  if (!entry) throw new Error('备份目录不存在')
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先在壳端头像登录')
  const report: BackupReport = {
    uploaded: [],
    updated: [],
    skipped: [],
    cloudDeleted: [],
    cloudUpdated: [],
    conflicts: [],
    entryId: id,
    directoryName: entry.directoryName,
  }
  let names: string[] = []
  try {
    names = fs.readdirSync(entry.localPath)
  } catch (e: any) {
    throw new Error(`本地目录不可读：${String(e?.message ?? e)}`)
  }
  const files = names
    .filter((n) => !n.startsWith('.') && BACKUP_EXTS.includes(path.extname(n).toLowerCase()))
    .sort()

  const cloud = await fetchCloudDocs()
  let dirty = false

  // —— 云端删除/编辑感知（对账在先，上传在后）——
  for (const [abs, rec] of Object.entries(entry.files)) {
    const name = path.basename(abs)
    if (!files.includes(name)) continue // 本地文件已不在 → 账随下次全量对账自然淘汰，这里不处理
    const cdoc = cloud.get(rec.docId)
    if (!cdoc) {
      // C3：账内文档云端已消失
      if (entry.onDelete === 'keep') {
        if (rec.hold !== 'cloud-deleted') {
          rec.hold = 'cloud-deleted'
          dirty = true
          report.cloudDeleted.push(`${name}（云端已删除，按策略不再同步）`)
        }
        continue
      }
      // resync：清除账目走重新上传（onConflict 兜底查重）
      report.cloudDeleted.push(`${name}（云端已删除，按策略重新上传）`)
      delete entry.files[abs]
      dirty = true
      continue
    }
    // 云端编辑感知：版本前进
    if (cdoc.version > rec.docVersion) {
      const localChanged = fs.existsSync(abs) && sha256(fs.readFileSync(abs, 'utf8')) !== rec.sha256
      if (!localChanged) {
        rec.docVersion = cdoc.version
        dirty = true
        report.cloudUpdated.push(name)
      } else {
        // 双向分叉：本地文件是用户数据不覆盖，也**不上传**（防止静默 PATCH 覆盖云端编辑）；
        // 报告冲突保持双方现状，用户处理后手动再同步（改文件→hash 变→走 PATCH；或撤销本地改动→采纳云端）
        ;(rec as any).__diverged = true
        report.conflicts.push({ path: name, reason: '云端与本地都被修改过（分叉）：云端版本前进、本地文件有改动——本次不覆盖本地，也未上传；处理后手动再同步' })
      }
    }
  }

  // —— 上传/更新 ——
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
      if (prev) {
        if ((prev as any).__diverged) {
          delete (prev as any).__diverged
          report.skipped.push(`${name}（分叉待处理：本次未同步）`)
          continue
        }
        if (prev.hold === 'cloud-deleted') {
          report.skipped.push(`${name}（已停更：云端删除后不再同步）`)
          continue
        }
        if (prev.sha256 === hash) continue // 未变更（云端编辑感知分支已记账，不再重复报）
        // C1 修复：有 docId → PATCH 更新原文档（版本+1），不再 POST 新建
        const res = await apiPatch<any>(`/library/${prev.docId}`, {
          content: stripped,
          message: '备份同步更新',
        })
        const doc = res.data?.document
        if (!doc?.id) throw new Error(res.message ?? '更新失败')
        entry.files[abs] = { sha256: hash, docId: doc.id, docVersion: Number(doc.version ?? prev.docVersion + 1), uploadedAt: new Date().toISOString() }
        dirty = true
        report.updated.push(name)
        continue
      }
      // 首次上传：同名查重（同名而非同 ID——A/B 机同目录场景）
      const title = name.replace(/\.(md|txt)$/i, '').slice(0, 200)
      const twin = [...cloud.values()].find((c) => c.title === title && (c.directoryId ?? null) === (entry.directoryId ?? null))
      if (twin) {
        // #259：同名冲突一律 rename（overwrite 已禁用——存量条目 onConflict=overwrite 也按 rename 兜底）
        const res = await apiPost<any>('/library', {
          title: `${title} 2`,
          content: stripped,
          ...(entry.directoryId ? { directoryId: entry.directoryId } : {}),
        })
        const doc = res.data?.document
        if (!doc?.id) throw new Error(res.message ?? '上传失败')
        entry.files[abs] = { sha256: hash, docId: doc.id, docVersion: Number(doc.version ?? 1), uploadedAt: new Date().toISOString() }
        dirty = true
        report.uploaded.push(`${name}（同名已存在，上传为「${title} 2」）`)
        continue
      }
      const res = await apiPost<any>('/library', {
        title,
        content: stripped,
        ...(entry.directoryId ? { directoryId: entry.directoryId } : {}),
      })
      const doc = res.data?.document
      if (!doc?.id) throw new Error(res.message ?? '上传失败')
      entry.files[abs] = { sha256: hash, docId: doc.id, docVersion: Number(doc.version ?? 1), uploadedAt: new Date().toISOString() }
      dirty = true
      report.uploaded.push(name)
    } catch (e: any) {
      report.conflicts.push({ path: name, reason: String(e?.message ?? e) })
    }
  }
  if (dirty || report.uploaded.length || report.updated.length) {
    entry.lastSyncAt = new Date().toISOString()
    saveRegistry(reg)
  }
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
