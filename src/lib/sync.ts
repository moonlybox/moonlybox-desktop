/**
 * vault 同步引擎（WBS 任务 5，§5.10 设计落地）。
 *
 * 不变量（§5.10.4）：镜像区永远等于云端；一切分歧只存在于收集箱里。
 * 方向由子目录定（§5.10.1）：文档/ 知识页/ = 下行镜像区；收集箱/ = 唯一上行口；.moonlybox/ = 元数据。
 *
 * M1 范围（D10：对账为权威，监听/决策卡归壳阶段）：
 *   - 下行全量：GET /library → 镜像区写盘（frontmatter 带 moonlybox:{id,version}）
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

/** 下行：云端全量 → 镜像区。镜像区文件以云端为权威；本地多出的 tracked 文件=外部修改→conflicts */
export async function syncDown(root: string, report: SyncReport): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const d = vaultDirs(root)
  const res = await apiGet<any>('/library')
  const documents: any[] = res.data?.documents ?? []
  const directories: any[] = res.data?.directories ?? []
  const manifest = loadManifest(root)

  const cloudIds = new Set<string>()
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
  }

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
  saveManifest(root, manifest)
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
    try {
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
      log(root, { op: 'upload-inbox', file: name, doc: doc?.id })
    } catch (e: any) {
      report.conflicts.push({ path: `${INBOX}/${name}`, reason: `上传失败：${e.message}（留收集箱待重试）` })
    }
  }
  saveManifest(root, manifest)
}
