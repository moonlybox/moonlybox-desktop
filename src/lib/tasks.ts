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

/** ledger 判定：源 hash 已在某 job 中 done → 已整理 */
export function isCompiled(srcHash: string): boolean {
  return readStore().jobs.some((j) => j.items.some((it) => it.srcHash === srcHash && it.status === 'done'))
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
  srcPath: string
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
      })
    }
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
  // ledger 重置：产物被删的 item → status 'pending'（srcHash 保留——内容没变下次扫描即视为未整理）
  let resetLedger = 0
  if (deleted > 0) {
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
        resetLedger++
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
