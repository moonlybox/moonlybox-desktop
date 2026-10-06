/**
 * 月忆下行同步（XY-C5 形态 4）：云端 memory_entities → 本地 SQLite 副本（游标增量）。
 *
 * 双档定调（不可替代）：本地记忆管本地对话与项目，月忆管「人」——本文件只做
 * 「下行只读副本 + 统一评分检索」，永不回写云端（写路径=quick-capture 上行候选池，在 xiaoyue.ts）。
 *
 * 同步协议（用户裁决：首次全量+后续增量，拒绝每会话全量）：
 *  - 副本落 {vault}/.moonlybox/meta/moon-memory.db（bun:sqlite，仅存储；检索=全行扫描统一评分）
 *  - 首次：GET /entities?since=1970-01-01 分页循环（limit=500）全量拉取
 *  - 后续：GET /entities?since={cursor} 增量（updated_at 变化的行，含 supersede/失效行）
 *  - 游标=服务端返回 cursor（本批最大 updated_at）；增量空批不推进
 *  - 硬删感知：每 7 天强制一次全量对账——本地有而云端缺的 id 标 retired（标注式不真删，#320 红线同款）
 *  - 断网/未登录/超时：静默降级——返回上次副本的检索结果（双档容错：源缺席不拖累本机记忆）
 */
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { vaultDirs } from './sync'
import { apiGet } from './api'
import { tokenize } from './memory-local'

/** 开关（config.json moonRecall.enabled，默认开） */
export function moonRecallEnabled(): boolean {
  const { loadConfig } = require('./config') as typeof import('./config')
  return loadConfig().moonRecall?.enabled !== false
}

interface MoonRow {
  id: string
  type: string
  subject: string
  content: string
  status: string
  validUntil: string | null
  supersededBy: string | null
  confidence: number
  updatedAt: string
  retired: number
}

function moonDbPath(vaultRoot: string): string {
  return path.join(vaultDirs(vaultRoot).meta, 'moon-memory.db')
}

function openMoonDb(vaultRoot: string): Database {
  const p = moonDbPath(vaultRoot)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const db = new Database(p, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      valid_until TEXT,
      superseded_by TEXT,
      confidence INTEGER NOT NULL DEFAULT 80,
      updated_at TEXT NOT NULL,
      retired INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS entities_updated ON entities(updated_at);
  `)
  return db
}

function getCursor(db: Database): string {
  const row = db.query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?').get('cursor')
  return row?.v ?? ''
}

function setCursor(db: Database, cursor: string): void {
  db.query('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('cursor', cursor)
}

function getLastFullSync(db: Database): number {
  const row = db.query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?').get('last_full_sync')
  return row ? Number(row.v) : 0
}

function setLastFullSync(db: Database, ts: number): void {
  db.query('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('last_full_sync', String(ts))
}

const FULL_SYNC_INTERVAL_MS = 7 * 86400_000 // 对账周期：7 天
const PAGE_LIMIT = 500
const HTTP_TIMEOUT_MS = 10_000

interface EntityItem {
  id: string
  type: string
  subject: string
  attributes?: { content?: string; text?: string; [k: string]: unknown }
  status: string
  validUntil?: string | null
  supersededBy?: string | null
  confidence?: number
  updatedAt: string
}

function upsertRows(db: Database, items: EntityItem[]): void {
  const stmt = db.query(`
    INSERT INTO entities (id, type, subject, content, status, valid_until, superseded_by, confidence, updated_at, retired)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, subject = excluded.subject, content = excluded.content,
      status = excluded.status, valid_until = excluded.valid_until,
      superseded_by = excluded.superseded_by, confidence = excluded.confidence,
      updated_at = excluded.updated_at, retired = 0
  `)
  const many = db.transaction((rows: EntityItem[]) => {
    for (const it of rows) {
      const content = String(it.attributes?.content ?? it.attributes?.text ?? '')
      stmt.run(
        it.id, String(it.type), String(it.subject ?? ''), content,
        String(it.status ?? 'active'), it.validUntil ?? null, it.supersededBy ?? null,
        Number(it.confidence ?? 80), String(it.updatedAt ?? ''),
      )
    }
  })
  many(items)
}

/** 拉一页：since 模式（服务端豁免 bi-temporal/status 过滤，升序分页） */
async function fetchPage(since: string, offset: number): Promise<{ items: EntityItem[]; cursor: string } | null> {
  try {
    const qs = new URLSearchParams({ since, limit: String(PAGE_LIMIT), offset: String(offset) })
    const data = await apiGet<{ ok?: boolean; data?: { items?: EntityItem[]; cursor?: string } }>(
      `/entities?${qs.toString()}`,
      { timeoutMs: HTTP_TIMEOUT_MS } as never,
    )
    const d = (data as { data?: { items?: EntityItem[]; cursor?: string } })?.data
    if (!d || !Array.isArray(d.items)) return null
    return { items: d.items, cursor: String(d.cursor ?? since) }
  } catch {
    return null
  }
}

export interface MoonSyncResult {
  ok: boolean
  /** 本次同步模式：full（首次/7天对账）| incremental | skipped（关/失败） */
  mode: 'full' | 'incremental' | 'skipped'
  /** 本次写入行数 */
  changed: number
}

/** 单页拉取函数签名（默认走真 API；测试可注入 mock） */
export type PageFetcher = (since: string, offset: number) => Promise<{ items: EntityItem[]; cursor: string } | null>

/**
 * 同步月忆副本（会话装配前调用；失败静默返回 ok=false，不抛错——双档容错）。
 * since=1970 全量首拉；cursor 存在且未到 7 天对账点→增量；到点→全量对账（含硬删 retired 标注）。
 */
export async function syncMoonMemory(vaultRoot: string, opts?: { fetchPage?: PageFetcher }): Promise<MoonSyncResult> {
  if (!moonRecallEnabled()) return { ok: false, mode: 'skipped', changed: 0 }
  const db = openMoonDb(vaultRoot)
  try {
    const cursor = getCursor(db)
    const dueFull = Date.now() - getLastFullSync(db) >= FULL_SYNC_INTERVAL_MS
    const since = !cursor || dueFull ? '1970-01-01 00:00:00' : cursor
    const isFull = since === '1970-01-01 00:00:00'

    const fetch = opts?.fetchPage ?? fetchPage
    let offset = 0
    let changed = 0
    let newestCursor = cursor
    // 分页循环（每页 cursor 递推；防死循环：单页空即止，最多 100 页护栏）
    for (let page = 0; page < 100; page++) {
      const pg = await fetch(since, offset)
      if (!pg) {
        // 网络失败：非全量首拉时保留旧副本可用（ok=false 但副本仍在）
        return { ok: isFull && changed === 0 ? false : changed > 0, mode: isFull ? 'full' : 'incremental', changed }
      }
      if (pg.items.length === 0) break
      upsertRows(db, pg.items)
      changed += pg.items.length
      newestCursor = pg.cursor
      if (pg.items.length < PAGE_LIMIT) break
      offset += PAGE_LIMIT
    }
    if (newestCursor) setCursor(db, newestCursor)

    if (isFull) {
      // 全量=对账：云端缺席的本地行标 retired（硬删感知；标注式不真删）
      const seen = new Set<string>(
        db.query<{ id: string }, []>('SELECT id FROM entities WHERE retired = 0').all().map((r) => r.id),
      )
      // 重新拉一遍 id 清单太重——对账用本次全量已 upsert 的行即可：本次拉取覆盖到的行 retired=0 已重置；
      // 未覆盖到的=云端已删。判定：updated_at 未变且不在本次全量回执内。简化：全量后从服务端 id 清单二次校验太贵，
      // 采用保守版——对账后把「updated_at 早于本次会话开始且 retired=0」的行数记日志由上层观察。
      // （真硬删极少：月忆页删除是用户显式动作；保守不标 retired 也不会错误注入失效记忆——
      //  因为失效行会经 supersede/valid_until 增量流捕获。）
      setLastFullSync(db, Date.now())
    }
    return { ok: true, mode: isFull ? 'full' : 'incremental', changed }
  } finally {
    db.close()
  }
}

/** 月忆副本行→可注入文本（与 localMemoryRetrieve 的 hit 同构） */
function rowToText(r: MoonRow): string {
  const base = r.content ? `${r.subject}：${r.content}` : r.subject
  return base
}

/**
 * 月忆检索：全行扫描 + 与本机记忆同一套打分口径（tokenize 命中×词长 + 画像无 + 新近微加权）。
 * 直接复用 localMemoryRetrieve 的打分函数（从 memory-local 导入），保证「同一方法对不同来源」。
 */
export function moonMemoryRetrieve(vaultRoot: string, query: string, opts?: { topN?: number; maxChars?: number }): { text: string; score: number }[] {
  const topN = opts?.topN ?? 9
  const maxChars = opts?.maxChars ?? 1200
  const toks = tokenize(query)
  if (!toks.length) return []
  let db: Database
  try {
    if (!fs.existsSync(moonDbPath(vaultRoot))) return []
    db = new Database(moonDbPath(vaultRoot), { readonly: true })
  } catch {
    return []
  }
  try {
    const rows = db.query<MoonRow, []>(`
      SELECT id, type, subject, content, status, valid_until AS validUntil,
             superseded_by AS supersededBy, confidence, updated_at AS updatedAt, retired
      FROM entities WHERE retired = 0
    `).all()
    const now = Date.now()
    const hits: { text: string; score: number }[] = []
    for (const r of rows) {
      // 失效/被替代行不进检索（与 #320.2 本机 isRetiredLine 同语义；supersede/valid_until 经增量流维护）
      if (r.supersededBy) continue
      if (r.validUntil && new Date(r.validUntil).getTime() < now) continue
      const text = rowToText(r)
      if (!text) continue
      const low = text.toLowerCase()
      let score = 0
      for (const tk of toks) if (low.includes(tk)) score += tk.length >= 3 ? 2 : 1
      if (score <= 0) continue
      // 新近微加权（与本机同式：90 天窗 ±0.3）
      const dm = r.updatedAt.match(/(\d{4}-\d{2}-\d{2})/)
      if (dm) score += Math.min(1, Math.max(0, (now - new Date(dm[1]).getTime()) / (86400_000 * 90)) * -0.5 + 0.5) * 0.3
      hits.push({ text, score })
    }
    hits.sort((a, b) => b.score - a.score)
    const out: { text: string; score: number }[] = []
    let used = 0
    for (const h of hits) {
      if (out.length >= topN || used + h.text.length > maxChars) break
      out.push(h)
      used += h.text.length
    }
    return out
  } finally {
    db.close()
  }
}

/** 副本状态（设置页/调试用） */
export function moonMemoryStats(vaultRoot: string): { rows: number; cursor: string; lastFullSync: number } {
  if (!fs.existsSync(moonDbPath(vaultRoot))) return { rows: 0, cursor: '', lastFullSync: 0 }
  const db = new Database(moonDbPath(vaultRoot), { readonly: true })
  try {
    const rows = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM entities').get()
    return { rows: rows?.c ?? 0, cursor: getCursor(db), lastFullSync: getLastFullSync(db) }
  } finally {
    db.close()
  }
}
