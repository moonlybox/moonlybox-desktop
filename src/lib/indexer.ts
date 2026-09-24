/**
 * 本地混合检索索引（#231 M2.5，§5.16.5）。
 *
 * `.moonlybox/index.db`（sqlite 单文件，不进同步、永不回传云端）：
 *   - docs_meta：docId → title/content/updatedAt/version（向量+FTS 共用正文源）
 *   - docs_fts：FTS5 trigram（中文 3-gram，与云端 ngram 同思路）
 *   - docs_vec：vec0 float[512]（rowid=docs_meta.rowid）
 * 增量重建：与 manifest 对账（updatedAt+version 变化才重新 embed）；
 * 删除文档 → 镜像区移除时同步清索引（对账全量扫描兜底）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { EMBEDDING_DIM, embedBatch } from './embedding'
import { loadManifest, vaultDirs, type VaultManifest } from './sync'

interface IndexedDoc {
  docId: string
  title: string
  content: string
  updatedAt: string
  version: number
}

function indexPath(root: string): string {
  return path.join(vaultDirs(root).meta, 'index.db')
}

export function openIndex(root: string): Database {
  const p = indexPath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const db = new Database(p, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  sqliteVec.load(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs_meta (
      rowid INTEGER PRIMARY KEY,
      doc_id TEXT UNIQUE,
      title TEXT,
      content TEXT,
      updated_at TEXT,
      version INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title, content, tokenize='trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec0(embedding float[${EMBEDDING_DIM}]);
  `)
  return db
}

/** 镜像区当前应有内容（读盘 frontmatter 解析出 docId） */
function mirrorDocs(root: string, manifest: VaultManifest): IndexedDoc[] {
  const docs: IndexedDoc[] = []
  for (const [docId, entry] of Object.entries(manifest)) {
    const abs = path.join(root, entry.path)
    if (!fs.existsSync(abs)) continue
    const raw = fs.readFileSync(abs, 'utf8')
    // frontmatter 剥离（moonlybox: {id, version}）——正文供 FTS/向量
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    const body = m ? raw.slice(m[0].length) : raw
    const vm = m?.[1].match(/moonlybox:\s*(\{[^}]*\})/)
    let version = entry.version
    if (vm) {
      try {
        version = JSON.parse(vm[1]).version ?? version
      } catch {
        /* 保 manifest 版本 */
      }
    }
    docs.push({ docId, title: path.basename(entry.path, '.md'), content: body, updatedAt: entry.updatedAt ?? '', version })
  }
  return docs
}

export interface ReindexReport {
  indexed: number
  skipped: number
  removed: number
}

/** 增量重建索引：云端 manifest 对账（内容变化才重新 embed） */
export async function reindex(root: string): Promise<ReindexReport> {
  const manifest = loadManifest(root)
  const docs = mirrorDocs(root, manifest)
  const db = openIndex(root)
  const report: ReindexReport = { indexed: 0, skipped: 0, removed: 0 }

  const rows = db.query('SELECT rowid, doc_id, updated_at, version FROM docs_meta').all() as Array<{
    rowid: number
    doc_id: string
    updated_at: string
    version: number
  }>
  const byId = new Map(rows.map((r) => [r.doc_id, r]))

  const toEmbed: Array<{ doc: IndexedDoc; rowid?: number }> = []
  const wantIds = new Set<string>()
  // 向量存在性校验（#246）：坏引擎时代的索引可能 docs_meta 有记录但 docs_vec 空（embed 半途失败，
  // meta 已 autocommit）——只对账 updatedAt 会永远 skip 坏记录。skip 必须同时满足向量存在。
  const vecRows = new Set(
    (db.query('SELECT rowid FROM docs_vec').all() as Array<{ rowid: number }>).map((r) => r.rowid),
  )
  for (const doc of docs) {
    wantIds.add(doc.docId)
    const prev = byId.get(doc.docId)
    if (prev && prev.updated_at === doc.updatedAt && prev.version === doc.version && vecRows.has(prev.rowid)) {
      report.skipped++
      continue
    }
    toEmbed.push({ doc, rowid: prev?.rowid })
  }

  // 移除：镜像区已没有的 docId（云端删除/归档后 sync 移除了本地文件）
  const delVec = db.prepare('DELETE FROM docs_vec WHERE rowid = ?')
  for (const r of rows) {
    if (wantIds.has(r.doc_id)) continue
    delVec.run(r.rowid)
    db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(r.rowid)
    db.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(r.rowid)
    report.removed++
  }

  // 更新/新建：先删旧行（FTS contentless 用 rowid 删；vec 用 rowid 删）再写
  for (const { doc, rowid } of toEmbed) {
    if (rowid !== undefined) {
      delVec.run(rowid)
      db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(rowid)
      db.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(rowid)
    }
    db.prepare('INSERT INTO docs_meta (doc_id, title, content, updated_at, version) VALUES (?, ?, ?, ?, ?)').run(
      doc.docId,
      doc.title,
      doc.content,
      doc.updatedAt,
      doc.version,
    )
  }

  // 批量 embedding（新行 rowid = lastInsertRowid 顺序取）
  if (toEmbed.length > 0) {
    const vectors = await embedBatch(toEmbed.map(({ doc }) => `${doc.title}\n${doc.content}`))
    const maxRow = (db.query('SELECT COALESCE(MAX(rowid), 0) AS m FROM docs_meta').get() as { m: number }).m
    const rowsAgain = db.query('SELECT rowid, doc_id FROM docs_meta').all() as Array<{ rowid: number; doc_id: string }>
    const rowidOf = new Map(rowsAgain.map((r) => [r.doc_id, r.rowid]))
    const insVec = db.prepare('INSERT INTO docs_vec (rowid, embedding) VALUES (?, ?)')
    const insFts = db.prepare('INSERT INTO docs_fts (rowid, title, content) VALUES (?, ?, ?)')
    for (let i = 0; i < toEmbed.length; i++) {
      const rid = rowidOf.get(toEmbed[i].doc.docId)
      if (rid === undefined) continue
      insVec.run(rid, vectors[i])
      insFts.run(rid, toEmbed[i].doc.title, toEmbed[i].doc.content)
    }
    void maxRow
    report.indexed = toEmbed.length
  }

  return report
}

export interface LocalHit {
  docId: string
  title: string
  score: number
  source: 'fts' | 'vec' | 'both'
}

/** 混合检索：FTS5 关键词路 + vec KNN 语义路 → RRF 融合（k=60，与云端管道同构） */
export function searchLocal(root: string, query: string, limit = 5): LocalHit[] {
  const db = openIndex(root)
  const k = 60
  const scores = new Map<string, { score: number; title: string; sources: Set<string> }>()
  const bump = (docId: string, rank: number, source: string, title: string) => {
    const cur = scores.get(docId) ?? { score: 0, title, sources: new Set<string>() }
    cur.score += 1 / (k + rank + 1)
    cur.sources.add(source)
    scores.set(docId, cur)
  }

  // FTS5 路：trigram 对中文 query 天然切片；MATCH 失败（无有效 token）静默空集
  try {
    const ftsRows = db
      .query(
        `SELECT m.doc_id, m.title FROM docs_fts f JOIN docs_meta m ON m.rowid = f.rowid
         WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?`,
      )
      .all(query, limit * 2) as Array<{ doc_id: string; title: string }>
    ftsRows.forEach((r, i) => bump(r.doc_id, i, 'fts', r.title))
  } catch {
    /* 查询词全为停用符等 → 空集 */
  }

  // 向量路（同步 embed 查询串——13ms 量级）
  const vecRows = db.query('SELECT COUNT(*) AS c FROM docs_vec').get() as { c: number }
  if (vecRows.c > 0) {
    // embed 是 async——用 deasync 不可取；searchLocal 由 async 入口包装（searchAsync）
    throw new Error('use searchLocalAsync')
  }

  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([docId, v]) => ({
      docId,
      title: v.title,
      score: v.score,
      source: (v.sources.has('fts') && v.sources.has('vec') ? 'both' : v.sources.has('vec') ? 'vec' : 'fts') as LocalHit['source'],
    }))
}

/** 异步混合检索（向量路需要 async embedding） */
export async function searchLocalAsync(root: string, query: string, limit = 5): Promise<LocalHit[]> {
  const db = openIndex(root)
  const k = 60
  const scores = new Map<string, { score: number; title: string; sources: Set<string> }>()
  const bump = (docId: string, rank: number, source: string, title: string) => {
    const cur = scores.get(docId) ?? { score: 0, title, sources: new Set<string>() }
    cur.score += 1 / (k + rank + 1)
    cur.sources.add(source)
    scores.set(docId, cur)
  }

  try {
    const ftsRows = db
      .query(
        `SELECT m.doc_id, m.title FROM docs_fts f JOIN docs_meta m ON m.rowid = f.rowid
         WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?`,
      )
      .all(query, limit * 2) as Array<{ doc_id: string; title: string }>
    ftsRows.forEach((r, i) => bump(r.doc_id, i, 'fts', r.title))
  } catch {
    /* 空集 */
  }

  const vecRows = db.query('SELECT COUNT(*) AS c FROM docs_vec').get() as { c: number }
  if (vecRows.c > 0) {
    const qv = await (await import('./embedding')).embed(query)
    const vecHits = db
      .query(
        `SELECT v.rowid, v.distance FROM docs_vec v WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?`,
      )
      .all(qv, limit * 2) as Array<{ rowid: number; distance: number }>
    for (let i = 0; i < vecHits.length; i++) {
      const meta = db.query('SELECT doc_id, title FROM docs_meta WHERE rowid = ?').get(vecHits[i].rowid) as
        | { doc_id: string; title: string }
        | undefined
      if (meta) bump(meta.doc_id, i, 'vec', meta.title)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([docId, v]) => ({
      docId,
      title: v.title,
      score: v.score,
      source: (v.sources.has('fts') && v.sources.has('vec') ? 'both' : v.sources.has('vec') ? 'vec' : 'fts') as LocalHit['source'],
    }))
}

export function indexStats(root: string): { docs: number; vectors: number } {
  const db = openIndex(root)
  const docs = (db.query('SELECT COUNT(*) AS c FROM docs_meta').get() as { c: number }).c
  const vectors = (db.query('SELECT COUNT(*) AS c FROM docs_vec').get() as { c: number }).c
  return { docs, vectors }
}
