/**
 * vault 同步引擎（WBS 任务 5，§5.10 设计落地；#230 M2② 增量下行）。
 *
 * 不变量（§5.10.4）：镜像区永远等于云端；一切分歧只存在于收集箱里。
 * 方向由子目录定（§5.10.1）：文档/ 知识页/ = 下行镜像区；收集箱/ = 唯一上行口；.moonlybox/ = 元数据。
 *
 * 下行两模式（D6 增量 API 落地）：
 *   - 增量（有 cursor）：GET /library/changes?since=<cursor> → 只落变更文档（文档增量+目录全量）
 *   - 全量（无 cursor/服务端无接口回落）：GET /library → 镜像区写盘（frontmatter 带 moonlybox:{id,version}）
 *   - 对账：manifest sha256 比对 → 镜像区分歧列清单（v1 CLI 不自动合并，决策卡 M4）
 *   - 收集箱上行：新 .md → POST /library → 成功后本地归位 文档/
 *   - manifest + 同步日志（JSONL，原则⑥完全可查）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { apiGet, apiPost } from './api'
import { loadCredentials } from './auth'

export const MIRROR_DOCS = '文档'
export const MIRROR_KB = '知识页'
export const INBOX = '收集箱'
export const META = '.moonlybox'

export interface VaultManifest {
  /** docId → 本地落点与对账基线 */
  [docId: string]: { path: string; sha256: string; version: number; updatedAt: string }
}

export interface SyncReport {
  downloaded: string[]
  updated: string[]
  uploaded: string[]
  inboxFiled: string[]
  conflicts: Array<{ path: string; reason: string }>
  skipped: string[]
}

export function vaultDirs(root: string) {
  return {
    docs: path.join(root, MIRROR_DOCS),
    kb: path.join(root, MIRROR_KB),
    inbox: path.join(root, INBOX),
    meta: path.join(root, META),
  }
}

export function initVault(root: string): void {
  const d = vaultDirs(root)
  for (const dir of [d.docs, d.kb, d.inbox, d.meta]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const readme = path.join(root, 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '# MyMoonVault',
      '',
      '- `文档/`、`知识页/`：云端镜像区（客户端管理；外部修改会在下次同步时被检测并提示）',
      '- `收集箱/`：把新文件扔进这里 = 上传到云端（唯一上行口，处理完自动归位）',
      '- `.moonlybox/`：同步元数据（请勿编辑）',
      '',
    ].join('\n'))
  }
}

function manifestPath(root: string): string {
  return path.join(root, META, 'manifest.json')
}

export function loadManifest(root: string): VaultManifest {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')) as VaultManifest
  } catch {
    return {}
  }
}

export function saveManifest(root: string, m: VaultManifest): void {
  fs.writeFileSync(manifestPath(root), JSON.stringify(m, null, 2))
}

export function sha256(buf: string | Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function log(root: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  fs.appendFileSync(path.join(root, META, 'sync.log'), line + '\n')
}

/** frontmatter 注入/更新（moonlybox:{id,version}；已有 frontmatter 则保留其余字段） */
export function withFrontmatter(content: string, id: string, version: number, extra?: Record<string, unknown>): string {
  const fm: Record<string, unknown> = { moonlybox: { id, version }, ...(extra ?? {}) }
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (m) {
    // 已有 frontmatter：把 moonlybox 键并入（替换旧的 moonlybox 块）
    const rest = m[1].replace(/^moonlybox:\s*(\{[^}]*\}|[\s\S]*?(?=^\w|\Z))/gm, '').trimEnd()
    return `---\n${rest}\nmoonlybox: ${JSON.stringify(fm.moonlybox)}\n---\n${content.slice(m[0].length)}`
  }
  return `---\nmoonlybox: ${JSON.stringify(fm.moonlybox)}\n---\n${content}`
}

function safeName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) || 'untitled'
}

function docDir(doc: any, directories: any[], base: string): string {
  if (doc.kind === 'wiki') return base // 知识页平铺
  const dir = directories.find((x: any) => x.id === doc.directoryId)
  if (!dir?.name) return base
  return path.join(base, safeName(dir.name))
}

function cursorPath(root: string): string {
  return path.join(root, META, 'sync-cursor.json')
}

function loadCursor(root: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(cursorPath(root), 'utf8')) as { cursor?: string }).cursor ?? null
  } catch {
    return null
  }
}

function saveCursor(root: string, cursor: string | null): void {
  if (cursor) fs.writeFileSync(cursorPath(root), JSON.stringify({ cursor }, null, 2))
}

/** 单文档下行落盘（增量与全量共用）：版本对账 + 外部修改检测，返回 true=已处理 */
function applyDownDoc(root: string, doc: any, directories: any[], manifest: VaultManifest, report: SyncReport, d: ReturnType<typeof vaultDirs>): boolean {
  const base = doc.kind === 'wiki' ? d.kb : d.docs
  const dir = docDir(doc, directories, base)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safeName(doc.title)}.md`)
  const rel = path.relative(root, file)
  const content = withFrontmatter(doc.content ?? '', doc.id, doc.version, {
    title: doc.title,
    kind: doc.kind,
    summary: doc.summary ?? undefined,
  })
  const prev = manifest[doc.id]
  if (prev && fs.existsSync(prev.path ? path.join(root, prev.path) : file)) {
    const localPath = prev.path ? path.join(root, prev.path) : file
    const localHash = sha256(fs.readFileSync(localPath))
    const baseline = sha256(withFrontmatter(doc.content ?? '', doc.id, prev.version, {
      title: doc.title, kind: doc.kind,
    }))
    if (localHash !== baseline && prev.version === doc.version) {
      // 本地内容 ≠ 云端基线且云端版本没动 → 外部修改（分歧，不覆盖，列清单）
      report.conflicts.push({ path: rel, reason: '镜像区文件被外部修改（云端版本未变）' })
      return true
    }
    if (localHash === baseline && prev.version === doc.version && fs.existsSync(file) && sha256(fs.readFileSync(file)) === localHash) {
      // 内容未变：只更新 path（目录可能改名）不重写文件
      if (prev.path !== rel.split(path.sep).join('/')) {
        manifest[doc.id] = { ...prev, path: rel.split(path.sep).join('/') }
      }
      return true
    }
  }
  // 新文档 / 云端版本前进 → 写盘（自写排除窗：登记 hash）
  fs.writeFileSync(file, content)
  manifest[doc.id] = { path: rel.split(path.sep).join('/'), sha256: sha256(content), version: doc.version, updatedAt: doc.updatedAt }
  if (prev) report.updated.push(rel); else report.downloaded.push(rel)
  log(root, { op: prev ? 'update-down' : 'download', doc: doc.id, version: doc.version, path: rel })
  return true
}

/** 下行（自动选模式）：有 cursor 走增量 /library/changes，否则全量 /library；失败回落全量 */
export async function syncDown(root: string, report: SyncReport): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const d = vaultDirs(root)
  const manifest = loadManifest(root)
  const since = loadCursor(root)

  if (since) {
    try {
      let cursor = since
      let hasMore = true
      while (hasMore) {
        const res = await apiGet<any>(`/library/changes?since=${encodeURIComponent(cursor)}&limit=200`)
        const documents: any[] = res.data?.changed ?? []
        const directories: any[] = res.data?.directories ?? []
        const deleted: any[] = res.data?.deleted ?? []
        for (const doc of documents) {
          if (doc.status !== 'active' || doc.isArchived) continue
          applyDownDoc(root, doc, directories, manifest, report, d)
        }
        // 增量删除：云端回收站 → 本地移除（镜像区=云端权威）
        for (const del of deleted) {
          const entry = manifest[del.id]
          if (entry && fs.existsSync(path.join(root, entry.path))) {
            fs.unlinkSync(path.join(root, entry.path))
            report.skipped.push(`removed ${entry.path} (云端已删除)`)
            log(root, { op: 'remove-down', doc: del.id, path: entry.path })
          }
          delete manifest[del.id]
        }
        hasMore = Boolean(res.data?.hasMore)
        if (res.data?.cursor) cursor = res.data.cursor
      }
      saveCursor(root, cursor)
      saveManifest(root, manifest)
      return
    } catch (e: any) {
      // 增量失败（服务端无接口/404 等）回落全量——镜像区一致性优先于流量优化
      log(root, { op: 'down-fallback-full', reason: String(e?.message ?? e) })
    }
  }

  await syncDownFull(root, report)
}

/** 下行全量（兜底 + 首次同步）：云端全量 → 镜像区。镜像区文件以云端为权威；本地多出的 tracked 文件=外部修改→conflicts */
export async function syncDownFull(root: string, report: SyncReport): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const d = vaultDirs(root)
  const res = await apiGet<any>('/library')
  const documents: any[] = res.data?.documents ?? []
  const directories: any[] = res.data?.directories ?? []
  const manifest = loadManifest(root)

  const cloudIds = new Set<string>()
  // D6 断点续传：下行每 N 篇落一次 manifest（中断后下轮从已存进度续跑，不整体重来）
  let processedSinceSave = 0
  const SAVE_EVERY = 20
  for (const doc of documents) {
    if (doc.status !== 'active' || doc.isArchived) continue
    cloudIds.add(doc.id)
    const base = doc.kind === 'wiki' ? d.kb : d.docs
    const dir = docDir(doc, directories, base)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safeName(doc.title)}.md`)
    const rel = path.relative(root, file)
    const content = withFrontmatter(doc.content ?? '', doc.id, doc.version, {
      title: doc.title,
      kind: doc.kind,
      summary: doc.summary ?? undefined,
    })
    const prev = manifest[doc.id]
    if (prev && fs.existsSync(prev.path ? path.join(root, prev.path) : file)) {
      const localPath = prev.path ? path.join(root, prev.path) : file
      const localHash = sha256(fs.readFileSync(localPath))
      const baseline = sha256(withFrontmatter(doc.content ?? '', doc.id, prev.version, {
        title: doc.title, kind: doc.kind,
      }))
      if (localHash !== baseline && prev.version === doc.version) {
        // 本地内容 ≠ 云端基线且云端版本没动 → 外部修改（分歧，不覆盖，列清单）
        report.conflicts.push({ path: rel, reason: '镜像区文件被外部修改（云端版本未变）' })
        continue
      }
      if (localHash === baseline && prev.version === doc.version && fs.existsSync(file) && sha256(fs.readFileSync(file)) === localHash) {
        // 内容未变：只更新 path（目录可能改名）不重写文件
        if (prev.path !== rel.split(path.sep).join('/')) {
          manifest[doc.id] = { ...prev, path: rel.split(path.sep).join('/') }
        }
        continue
      }
    }
    // 新文档 / 云端版本前进 → 写盘（自写排除窗：登记 hash）
    fs.writeFileSync(file, content)
    manifest[doc.id] = { path: rel.split(path.sep).join('/'), sha256: sha256(content), version: doc.version, updatedAt: doc.updatedAt }
    if (prev) report.updated.push(rel); else report.downloaded.push(rel)
    log(root, { op: prev ? 'update-down' : 'download', doc: doc.id, version: doc.version, path: rel })
    // D6：批量落盘断点（写盘过的才计数；中断时已处理进度在 manifest 里持久化）
    if (++processedSinceSave >= SAVE_EVERY) {
      saveManifest(root, manifest)
      processedSinceSave = 0
    }
  }

  // D6：主循环正常走完后清理残余断点计数（finally 兜底见下）
  try {
    // 云端已删除/归档的 tracked 文件 → 本地移除（镜像区=云端权威；用户资产仍在云端回收站，不做人质原则不受影响）
    for (const [id, entry] of Object.entries(manifest)) {
      if (cloudIds.has(id)) continue
      const abs = path.join(root, entry.path)
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs)
        report.skipped.push(`removed ${entry.path} (云端已删除/归档)`)
        log(root, { op: 'remove-down', doc: id, path: entry.path })
      }
      delete manifest[id]
    }
  } finally {
    // D6 断点续传兜底：任何路径退出（含异常/中断）都把已处理进度持久化
    saveManifest(root, manifest)
  }
  // 全量成功 → cursor 重置为全量集最大 updatedAt（下轮走增量）
  const maxUpdated = documents
    .filter((x) => x.status === 'active' && !x.isArchived)
    .map((x) => x.updatedAt as string)
    .sort()
    .pop()
  saveCursor(root, maxUpdated ?? new Date().toISOString())
}

/** 收集箱上行：新 .md → POST /library → 归位 文档/（§5.10.2 流水线 2-5 步；归类/聪明步骤云端侧完成） */
export async function syncInbox(root: string, report: SyncReport): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const d = vaultDirs(root)
  const manifest = loadManifest(root)
  const entries = fs.existsSync(d.inbox) ? fs.readdirSync(d.inbox) : []
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md') || name.startsWith('.')) continue
    const abs = path.join(d.inbox, name)
    if (!fs.statSync(abs).isFile()) continue
    const raw = fs.readFileSync(abs, 'utf8')
    const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
    if (!stripped) {
      report.skipped.push(`${INBOX}/${name}（空文件）`)
      continue
    }
    const title = name.replace(/\.md$/i, '').slice(0, 200)
    // 镜像区回传识别（§5.10.4「作为新版本回传」）：文件带 moonlybox:{id,version} frontmatter
    // → 走 /library/import/files（服务端识别既有实体进版本管道/幂等跳过/非本人降级新建），
    // 走 POST /library 会剥掉身份重复建档
    const fmBlock = raw.match(/^---\n[\s\S]*?\n---/)?.[0] ?? ''
    const mirrorId = fmBlock.match(/"id"\s*:\s*"([0-9A-HJKMNP-TV-Z]{26})"/i)?.[1]
      ?? fmBlock.match(/^moonlybox:\s*([0-9A-HJKMNP-TV-Z]{26})/im)?.[1]
    try {
      if (mirrorId) {
        const res = await apiPost<any>('/library/import/files', { channel: 'upload', items: [{ title, content: raw }] })
        log(root, { op: 'mirror-return', file: name, doc: mirrorId, updated: res.data?.updated ?? 0, skipped: res.data?.skipped ?? 0, created: res.data?.created ?? 0 })
        if ((res.data?.updated ?? 0) > 0 || (res.data?.skipped ?? 0) > 0) {
          // 版本已回传（或幂等跳过）：本地移入镜像区，版本号以下次下行为准（不臆测）
          const dest = path.join(d.docs, name)
          fs.writeFileSync(dest, raw)
          manifest[mirrorId] = { path: path.relative(root, dest).split(path.sep).join('/'), sha256: sha256(raw), version: manifest[mirrorId]?.version ?? 1, updatedAt: new Date().toISOString() }
          if ((res.data?.updated ?? 0) > 0) report.uploaded.push(name)
          else report.skipped.push(`${INBOX}/${name}（云端内容无变化，幂等跳过）`)
          report.inboxFiled.push(`${INBOX}/${name} → ${MIRROR_DOCS}/${name}（回传）`)
        } else if ((res.data?.created ?? 0) > 0) {
          // id 非本人/不存在：服务端已降级新建——本地按普通上传归位（frontmatter 已被服务端剥除，重新走下行修正）
          report.uploaded.push(name)
          report.inboxFiled.push(`${INBOX}/${name} → ${MIRROR_DOCS}/${name}（id 失效，按新文档）`)
          const dest = path.join(d.docs, name)
          fs.writeFileSync(dest, raw)
        }
        fs.unlinkSync(abs)
        saveManifest(root, manifest)
        continue
      }
      const res = await apiPost<any>('/library', { title, content: stripped })
      const doc = res.data?.document
      // 归位：移入镜像区（云端产物回流由下次下行完成；本地先按上传版落位）
      const dest = path.join(d.docs, name)
      if (doc?.id) {
        const rel = path.relative(root, dest).split(path.sep).join('/')
        fs.writeFileSync(dest, withFrontmatter(stripped, doc.id, doc.version ?? 1, { title }))
        manifest[doc.id] = { path: rel, sha256: sha256(fs.readFileSync(dest)), version: doc.version ?? 1, updatedAt: doc.updatedAt ?? new Date().toISOString() }
        report.uploaded.push(name)
        report.inboxFiled.push(`${INBOX}/${name} → ${MIRROR_DOCS}/${name}`)
      }
      fs.unlinkSync(abs) // 处理完即清空（§5.10.2 步骤5）
      saveManifest(root, manifest) // D6 断点续传：上传成功即时落账（中断不重复上传已传文件）
      log(root, { op: 'upload-inbox', file: name, doc: doc?.id })
    } catch (e: any) {
      report.conflicts.push({ path: `${INBOX}/${name}`, reason: `上传失败：${e.message}（留收集箱待重试）` })
    }
  }
  saveManifest(root, manifest)
}
