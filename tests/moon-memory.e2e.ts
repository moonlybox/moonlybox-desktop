import { describe, test, expect } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { moonMemoryRetrieve, moonMemoryStats, syncMoonMemory } from '../src/lib/memory-moon'

const HOME = '/tmp/tkhome-moon'
const vault = path.join(HOME, 'vault')
function fresh() {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(path.join(vault, '.moonlybox'), { recursive: true })
}
function seed(vault: string, rows: any[]) {
  const p = path.join(vault, '.moonlybox', 'moon-memory.db')
  const db = new Database(p, { create: true })
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, subject TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', valid_until TEXT,
      superseded_by TEXT, confidence INTEGER NOT NULL DEFAULT 80, updated_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);`)
  for (const r of rows) db.query(`INSERT INTO entities (id, type, subject, content, status, valid_until, superseded_by, confidence, updated_at, retired)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.type, r.subject, r.content ?? '', r.status ?? 'active', r.valid_until ?? null, r.superseded_by ?? null, r.confidence ?? 80, r.updated_at, r.retired ?? 0)
  if (r0(rows)) db.query(`INSERT INTO meta (k, v) VALUES ('cursor', ?)`).run(r0(rows))
  db.close()
  function r0(_rows: any[]) { return (globalThis as any).__cursor ?? null }
}
describe('moon-memory 形态4', () => {
  test('检索：命中评分+失效行排除+被替代排除', () => {
    fresh()
    seed(vault, [
      { id: '1', type: 'fact', subject: '用户在研究输血信息系统', content: '条码与 BIS 对接', updated_at: '2026-10-01 10:00:00' },
      { id: '2', type: 'fact', subject: '旧偏好', content: '曾经喜欢暗色主题', updated_at: '2026-09-01 10:00:00', superseded_by: '3' },
      { id: '3', type: 'preference', subject: '新偏好', content: '现在喜欢浅色主题', updated_at: '2026-10-05 10:00:00' },
      { id: '4', type: 'fact', subject: '过期条目', content: '临时项目 Alpha', updated_at: '2026-10-03 10:00:00', valid_until: '2026-10-04 00:00:00' },
    ])
    const hits = moonMemoryRetrieve(vault, '主题偏好是什么')
    const texts = hits.map((h) => h.text)
    expect(texts.some((t) => t.includes('浅色'))).toBe(true)
    expect(texts.some((t) => t.includes('暗色'))).toBe(false) // 被替代行不进
    expect(texts.some((t) => t.includes('Alpha'))).toBe(false) // 失效行不进
    expect(hits[0].score).toBeGreaterThan(0)
  })
  test('无词命中返回空；空库不炸', () => {
    fresh()
    expect(moonMemoryRetrieve(vault, '完全无关的词组量子')).toEqual([])
    expect(moonMemoryStats(vault).rows).toBe(0)
  })
  test('sync：未登录/断网静默降级（ok=false 不抛）', async () => {
    fresh()
    const r = await syncMoonMemory(vault)
    expect(r.ok).toBe(false)
    expect(['skipped', 'full', 'incremental']).toContain(r.mode)
  })
})

describe('syncMoonMemory 游标增量（mock fetchPage）', () => {
  test('首次全量 2 页→游标推进→增量 1 行→对账全量', async () => {
    fresh()
    const { syncMoonMemory } = await import('../src/lib/memory-moon')
    let calls: { since: string; offset: number }[] = []
    const mk = (rows: any[], cursor: string) => async (since: string, offset: number) => {
      calls.push({ since, offset })
      return { items: rows, cursor }
    }
    // 首次全量：1970 起，第 1 页 1 行+cursor=c1，第 2 页 1 行+cursor=c2，第 3 页空→停
    let page = 0
    const fullPages = [
      { items: [
        { id: 'A', type: 'fact', subject: '条码', attributes: { content: 'BIS 对接' }, status: 'active', updatedAt: '2026-10-01 10:00:00', confidence: 80 },
        { id: 'B', type: 'preference', subject: '浅色主题', attributes: {}, status: 'active', updatedAt: '2026-10-05 09:00:00', confidence: 90 },
      ], cursor: '2026-10-05 09:00:00' },
      { items: [], cursor: '2026-10-05 09:00:00' },
    ]
    let r = await syncMoonMemory(vault, { fetchPage: async (since, offset) => { calls.push({ since, offset }); const pg = fullPages[page++]; return pg ?? { items: [], cursor: since } } })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('full')
    expect(r.changed).toBe(2)
    expect(moonMemoryStats(vault).rows).toBe(2)
    expect(moonMemoryStats(vault).cursor).toBe('2026-10-05 09:00:00')
    // 增量：since=c2，返回 1 行（B 被 confirm 更新）+cursor=c3
    page = 0
    calls = []
    r = await syncMoonMemory(vault, { fetchPage: async (since, offset) => { calls.push({ since, offset }); if (page++ === 0) return { items: [{ id: 'B', type: 'preference', subject: '浅色主题+大字号', attributes: {}, status: 'active', updatedAt: '2026-10-06 08:00:00', confidence: 90 }], cursor: '2026-10-06 08:00:00' }; return { items: [], cursor: since } } })
    expect(r.mode).toBe('incremental')
    expect(r.changed).toBe(1)
    expect(calls[0].since).toBe('2026-10-05 09:00:00') // 游标作为增量起点
    expect(moonMemoryRetrieve(vault, '大字号').length).toBe(1) // 增量行可检索
    // 断网：fetchPage 全 null → ok=false 静默，副本保留
    r = await syncMoonMemory(vault, { fetchPage: async () => null })
    expect(r.ok).toBe(false)
    expect(moonMemoryStats(vault).rows).toBe(2) // 旧副本不丢
  })
})
