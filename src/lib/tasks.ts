/**
 * 本地任务账本（#316.5/#316.6）：
 * - 任务=客户端内部能力（类型白名单收敛：v1 只有 compile），用户不可手工创建（入口=对话 local_task_create）。
 * - 多入口单执行器：对话/任务页/CLI(v2)/MCP(v2) → daemon tasks op → 本文件单源。
 * - 持久化：~/.config/moonlybox/jobs.json（0600，workspaces.json 同范式）；重启恢复=running/queued → queued（断点由 items 逐份状态保证）。
 * - ledger（编译登记账）：items[].srcHash 已整理判定源——「未整理」=文档全集 − 已完成 items（hash 命中跳过）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { configDir } from './config'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

/** v1 任务类型白名单——新类型进此表（download/backup/diagram_batch 规划位） */
export const TASK_TYPES = ['compile'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export interface JobItem {
  /** 源文档绝对路径 */
  path: string
  status: ItemStatus
  /** 源内容 sha256（ledger 判定键——已整理判定=hash 命中，非路径命中） */
  srcHash?: string
  /** 产物相对 vault 路径（done 时有） */
  outPath?: string
  /** #316 第二批：回传云端落库的待准入知识页 ID（回传成功时写——重启恢复不重复回传的判定键） */
  cloudWikiId?: string
  /** #310.46：云端准入回执（syncDown 见到 active 对应 wiki 时打标）——清单显示「✓ 已同步」 */
  syncedAt?: string
  error?: string
}

export interface LocalJob {
  id: string
  type: TaskType
  /** origin 预留云端任务（v1 恒 'local'） */
  origin: 'local'
  status: JobStatus
  title: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  /** 执行模型标签（创建时 resolveCompileModel 解析快照，仅展示用——执行期仍按文档粒度实时解析） */
  modelLabel?: string
  progress: { done: number; total: number }
  items: JobItem[]
  error?: string
}

function jobsFile(): string {
  return path.join(configDir(), 'jobs.json')
}

/** #310.39：全账本读取（补传扫描用） */
export function allJobs(): LocalJob[] {
  return readStore().jobs
}

function readStore(): { jobs: LocalJob[] } {
  try {
    const d = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'))
    return { jobs: Array.isArray(d.jobs) ? d.jobs : [] }
  } catch {
    return { jobs: [] }
  }
}

function writeStore(jobs: LocalJob[]): void {
  fs.mkdirSync(path.dirname(jobsFile()), { recursive: true })
  fs.writeFileSync(jobsFile(), JSON.stringify({ jobs }, null, 1), { mode: 0o600 })
}

function genId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `task_${t}${r}`
}

/** #310.22：UTC ISO → 本地显示串（'YYYY-MM-DD HH:mm'）——账本恒存 UTC（排序一致），展示层转本地 */
export function fmtLocal(iso?: string): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (isNaN(d.getTime())) return undefined
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 内容 hash（ledger 判定键） */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
}

export function listJobs(): LocalJob[] {
  return readStore().jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getJob(id: string): LocalJob | null {
  return readStore().jobs.find((j) => j.id === id) ?? null
}

export function createJob(type: TaskType, title: string, items: Array<{ path: string; srcHash?: string }>, modelLabel?: string): LocalJob {
  const now = new Date().toISOString()
  const job: LocalJob = {
    id: genId(),
    type,
    origin: 'local',
    status: 'queued',
    title,
    createdAt: now,
    updatedAt: now,
    modelLabel,
    progress: { done: 0, total: items.length },
    items: items.map((it) => ({ path: it.path, srcHash: it.srcHash, status: 'pending' })),
  }
  const store = readStore()
  store.jobs.push(job)
  writeStore(store.jobs)
  return job
}

export function updateJob(id: string, patch: Partial<Omit<LocalJob, 'id'>>): LocalJob | null {
  const store = readStore()
  const idx = store.jobs.findIndex((j) => j.id === id)
  if (idx < 0) return null
  const job = { ...store.jobs[idx], ...patch, updatedAt: new Date().toISOString() }
  store.jobs[idx] = job
  writeStore(store.jobs)
  return job
}

/** 单 item 状态更新+进度重算（执行器逐份回写入口） */
export function updateItem(jobId: string, itemPath: string, patch: Partial<Omit<JobItem, 'path'>>): LocalJob | null {
  const store = readStore()
  const job = store.jobs.find((j) => j.id === jobId)
  if (!job) return null
  const item = job.items.find((it) => it.path === itemPath)
  if (!item) return null
  Object.assign(item, patch)
  job.progress.done = job.items.filter((it) => ['done', 'failed', 'skipped', 'cancelled'].includes(it.status)).length
  job.updatedAt = new Date().toISOString()
  writeStore(store.jobs)
  return job
}

/** 取消：queued/running → cancelled（未开始 items 置 cancelled；running item 由执行器自查中止） */
export function cancelJob(id: string): LocalJob | null {
  const job = getJob(id)
  if (!job) return null
  if (!['queued', 'running'].includes(job.status)) return job
  const items = job.items.map((it) =>
    it.status === 'pending' ? { ...it, status: 'cancelled' as ItemStatus } : it,
  )
  return updateJob(id, {
    status: 'cancelled',
    items,
    finishedAt: new Date().toISOString(),
    error: '用户取消',
  })
}

/**
 * #317.7：删除任务记录本身（completed/failed/cancelled 可删；running/queued 须先取消）。
 * 产物不删——outPath 文件留盘（产物是资产）；#317.8 定案：ledger 独立于任务（ledger.json 按文档 hash 闭环）——删任务不影响「已整理」判定。
 */
export function deleteJob(id: string): { ok: boolean; reason?: string } {
  const job = getJob(id)
  if (!job) return { ok: false, reason: '任务不存在' }
  if (job.status === 'running' || job.status === 'queued') return { ok: false, reason: '任务进行中，请先取消再删除' }
  const store = readStore()
  store.jobs = store.jobs.filter((j) => j.id !== id)
  writeStore(store.jobs)
  return { ok: true }
}

/** 启动恢复：daemon 重启后 running/queued → queued（items 保留断点——pending 从头，done 不重做） */
export function recoverOnBoot(): number {
  const store = readStore()
  let n = 0
  for (const job of store.jobs) {
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'queued'
      job.updatedAt = new Date().toISOString()
      n++
    }
  }
  if (n) writeStore(store.jobs)
  return n
}

// ==================== ledger（#317.8 独立编译登记账——回归文档本身闭环） ====================
// 此前 ledger 寄生在 jobs.items[].srcHash——但全链零写入点（判定恒 false），且删任务会连带「未整理」判定漂移。
// 现独立 ledger.json：{ hash, srcPath, outPath, at, jobId? }——文档内容 hash 为键，任务删除不影响已整理判定。
interface LedgerEntry { hash: string; srcPath: string; outPath?: string; at: string; jobId?: string }

function ledgerFile(): string {
  return path.join(configDir(), 'ledger.json')
}

function ledgerLoad(): LedgerEntry[] {
  try {
    const raw = fs.readFileSync(ledgerFile(), 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function ledgerSave(entries: LedgerEntry[]): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(ledgerFile(), JSON.stringify(entries, null, 2), { mode: 0o600 })
}

/** upsert：同 hash 更新（重编/产物更新）；同 hash 不同源路径=并存条目（内容相同的不同文件各自闭环） */
/** #317.8：done 写入点调用（compile-runner）——独立账本 upsert */
export function ledgerUpsert(entry: LedgerEntry): void {
  const entries = ledgerLoad()
  const idx = entries.findIndex((e) => e.hash === entry.hash && e.srcPath === entry.srcPath)
  if (idx >= 0) entries[idx] = { ...entries[idx], ...entry }
  else entries.push(entry)
  ledgerSave(entries)
}

/** 按 hash 判定（含 in-flight 迁移：旧 jobs done items 有 srcHash 的灌入一次） */
export function isCompiled(srcHash: string, vaultRoot?: string): boolean {
  {
    const entries = ledgerLoad()
    const hit = entries.filter((e) => e.hash === srcHash)
    if (hit.length) {
      // #317.8b A1 惰性修复：命中条目 srcPath 失联时同 hash 找新家（vaultRoot 缺省=跳过跟随，语义不变）
      if (vaultRoot && hit.some((e) => !e.srcPath || !fs.existsSync(e.srcPath))) ledgerFollow(entries, vaultRoot)
      return true
    }
  }
  // #317.8 迁移：旧账（jobs.items 带 srcHash 的 done）一次性灌入独立账本
  const store = readStore()
  let migrated = false
  for (const j of store.jobs) {
    for (const it of j.items) {
      if (it.status === 'done' && it.srcHash && it.srcHash === srcHash) {
        ledgerUpsert({ hash: it.srcHash, srcPath: it.path, outPath: it.outPath, at: j.updatedAt, jobId: j.id })
        migrated = true
      }
    }
  }
  if (migrated) return true
  return store.jobs.some((j) => j.items.some((it) => it.srcHash === srcHash && it.status === 'done'))
}

/** 删产物时同步删 ledger 条目（源回「未整理」——按产物绝对路径定位） */
function ledgerDeleteByOutPath(absOut: string, vaultRoot: string): number {
  const entries = ledgerLoad()
  const kept = entries.filter((e) => {
    if (!e.outPath) return true
    const abs = path.isAbsolute(e.outPath) ? e.outPath : path.join(vaultRoot, e.outPath)
    return abs !== absOut
  })
  const n = entries.length - kept.length
  if (n > 0) ledgerSave(kept)
  return n
}

// ==================== #317.8b ledger 与源文档关联细化（挂账收口） ====================
// A1 惰性修复：判定/列举命中时发现 srcPath 失联 → 全书房扫同 hash 文件自动改写条目（无 watcher，零新增基建）
// A2 源删除：全书房无同 hash → 条目保留（产物是独立资产照常列出），仅标注 srcMissing
// C1 边界收口：ledgerUpsert 拒书房外路径入账
/** 书房内判定（C1） */
function underVault(p: string, vaultRoot: string): boolean {
  const abs = path.isAbsolute(p) ? p : path.join(vaultRoot, p)
  const rel = path.relative(vaultRoot, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** ledgerUpsert 的书房内校验包装（C1）：书房外路径不入账（防将来入口放宽时账本被污染） */
export function ledgerUpsertGuarded(entry: LedgerEntry, vaultRoot: string): boolean {
  if (!underVault(entry.srcPath, vaultRoot)) return false
  ledgerUpsert(entry)
  return true
}

/** 全书房扫同内容文件（A1）：返回与 hash 匹配的首个路径（确定性排序保证幂等） */
export function findSrcByHash(vaultRoot: string, hash: string, exclude: string[] = []): string | null {
  if (!vaultRoot) return null
  const hits: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let list: fs.Dirent[] = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of list) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue
      const p = path.join(dir, d.name)
      if (d.isDirectory()) walk(p, depth + 1)
      else if (/\.(md|markdown|txt)$/i.test(d.name)) {
        try {
          const h = contentHash(fs.readFileSync(p, 'utf8'))
          if (h === hash) hits.push(p)
        } catch { /* 跳过不可读 */ }
      }
    }
  }
  walk(vaultRoot, 0)
  hits.sort()
  const ex = new Set(exclude.map((x) => path.resolve(x)))
  return hits.find((h) => !ex.has(path.resolve(h))) ?? null
}

/** 惰性跟随（A1+A2）：校验条目 srcPath；失联→同 hash 找新家改写；全书房无→保留条目（isCompiled 用，注意别在热路径频繁全扫） */
function ledgerFollow(entries: LedgerEntry[], vaultRoot: string): void {
  if (!vaultRoot) return
  let changed = false
  for (const e of entries) {
    if (e.srcPath && fs.existsSync(e.srcPath)) continue
    // srcPath 空（老数据兼容）或失联：
    const fresh = findSrcByHash(vaultRoot, e.hash, [e.srcPath])
    if (fresh) {
      e.srcPath = fresh
      changed = true
    }
    // 找不到新家=A2 保留条目原样（srcMissing 标注在展示层按 existsSync 现算，不落账）
  }
  if (changed) ledgerSave(entries)
}


/** #316 骨架批配套：知识页产物聚合（任务页「知识页」tab 数据源——jobs items done 的 outPath，去重+存在性） */
export interface PageEntry {
  path: string
  /** 产物绝对路径 */
  abs: string
  /** 产物是否还在盘上 */
  exists: boolean
  /** 来源任务 */
  jobId: string
  jobTitle: string
  finishedAt?: string
  /** 回传云端：pending 待准入（cloudWikiId 有值=已回传）/ 未回传 / 无回传机制 */
  cloudWikiId?: string
  /** #310.46：云端准入回执（下行打标）——「✓ 已同步」态 */
  syncedAt?: string
  srcPath: string
  /** #317.8b A2：源文档失联（已删/移走且全书房无同内容）——展示「源已删除」标注 */
  srcMissing?: boolean
}

export function listPages(vaultRoot: string): PageEntry[] {
  const byPath = new Map<string, PageEntry>()
  for (const job of readStore().jobs) {
    for (const it of job.items) {
      if (it.status !== 'done' || !it.outPath) continue
      // #310.26：outPath 形态兼容——#316 第一批真链路 writeOut 存绝对路径，早期/测试数据为相对路径
      const abs = path.isAbsolute(it.outPath) ? it.outPath : path.join(vaultRoot, it.outPath)
      const prev = byPath.get(abs)
      // 同产物多任务（重编译）：保留最近任务
      if (prev && prev.finishedAt && job.finishedAt && prev.finishedAt >= job.finishedAt) continue
      byPath.set(abs, {
        path: it.outPath,
        abs,
        exists: fs.existsSync(abs),
        jobId: job.id,
        jobTitle: job.title,
        finishedAt: job.finishedAt,
        cloudWikiId: it.cloudWikiId,
        srcPath: it.path,
        srcMissing: it.path ? !fs.existsSync(it.path) : undefined,
      })
    }
  }

  // #317.8：ledger 合并——任务已删除但 ledger 记录的产物仍列出（产物是资产，不随任务记录消失）
  const jobsById = new Map(readStore().jobs.map((j) => [j.id, j]))
  // #317.8b A1 惰性修复：合并前先跟随一次（srcPath 失联的同 hash 条目找新家；找不到=A2 保留）
  ledgerFollow(ledgerLoad(), vaultRoot)
  for (const e of ledgerLoad()) {
    if (!e.outPath) continue
    const abs = path.isAbsolute(e.outPath) ? e.outPath : path.join(vaultRoot, e.outPath)
    if (byPath.has(abs)) continue
    const srcExists = e.srcPath ? fs.existsSync(e.srcPath) : false
    // A2：源删除但产物在 → 照常列出（产物是独立资产）；源产物都无 → 孤儿条目跳过
    if (!srcExists && !fs.existsSync(abs)) continue
    byPath.set(abs, {
      path: e.outPath,
      abs,
      exists: fs.existsSync(abs),
      jobId: e.jobId ?? '',
      jobTitle: (e.jobId && jobsById.get(e.jobId)?.title) ?? '（任务已删除）',
      finishedAt: e.at,
      srcPath: e.srcPath,
      srcMissing: e.srcPath ? !fs.existsSync(e.srcPath) : undefined,
    })
  }

  return [...byPath.values()].sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
}

/**
 * 删除知识页产物+重置 ledger（#316：删除=该源重新视为未整理）。
 * 只删 jobs.json 记录过的产物路径（白名单防误删）；返回实际删除数与 ledger 重置数。
 */
export function deletePages(vaultRoot: string, absPaths: string[]): { deleted: number; resetLedger: number; missing: string[] } {
  const known = new Set(listPages(vaultRoot).map((e) => e.abs))
  let deleted = 0
  const missing: string[] = []
  for (const abs of absPaths) {
    if (!known.has(abs)) { missing.push(abs); continue }
    try {
      fs.unlinkSync(abs)
      deleted++
    } catch {
      missing.push(abs)
    }
  }
  // #317.8：ledger 重置=独立账本删条目（按产物路径）——源回「未整理」；任务 items 仍同步回退（展示层一致性）
  let resetLedger = 0
  if (deleted > 0) {
    for (const abs of absPaths) resetLedger += ledgerDeleteByOutPath(abs, vaultRoot)
    const delSet = new Set(absPaths)
    const store = readStore()
    for (const job of store.jobs) {
      let changed = false
      for (const it of job.items) {
        if (it.status !== 'done' || !it.outPath) continue
        const itAbs = path.isAbsolute(it.outPath) ? it.outPath : path.join(vaultRoot, it.outPath)
        if (!delSet.has(itAbs)) continue
        it.status = 'pending'
        delete it.outPath
        delete it.cloudWikiId
        changed = true
        // resetLedger 计数以上面 ledger.json 删条目为准（同一份源不双计）
      }
      if (changed) {
        // 完成态任务回退为可续跑语义（done 计数同步收缩）
        job.progress.done = job.items.filter((x) => ['done', 'failed', 'skipped', 'cancelled'].includes(x.status)).length
        if (job.status === 'completed' || job.status === 'failed') {
          job.status = 'queued'
          delete job.finishedAt
        }
        job.updatedAt = new Date().toISOString()
      }
    }
    writeStore(store.jobs)
  }

  return { deleted, resetLedger, missing }
}
