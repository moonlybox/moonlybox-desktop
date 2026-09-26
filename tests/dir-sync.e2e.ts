#!/usr/bin/env bun
/**
 * 云端目录同步闭环 E2E（#253.50）：mock.module 拦 apiGet——
 * 场景：①多级目录树全量下行（文档/<父>/<子>/.md 落盘）
 *      ②目录改名 → 旧路径清空、新路径重建（无残留）
 *      ③目录删除 → 文档回落镜像区根 + 空目录清理
 *      ④增量：目录变更随 changes 下行同样生效
 * 跑法：bun tests/dir-sync.e2e.ts（mock 网络，无栈依赖）
 */
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type DirNode = { id: string; parentId: string | null; name: string; children: DirNode[] }
let cloudDirs: DirNode[] = []
let cloudDocs: any[] = []

mock.module(path.resolve(import.meta.dir, '../src/lib/api'), () => ({
  apiGet: async (p: string) => {
    if (p === '/library') return { ok: true, data: { documents: cloudDocs, directories: cloudDirs } }
    if (p.startsWith('/library/changes')) return { ok: true, data: { changed: cloudDocs, deleted: [], directories: cloudDirs, cursor: '2099-01-01T00:00:00Z', hasMore: false } }
    return { ok: true, data: {} }
  },
  apiPost: async () => ({ ok: true, data: {} }),
  apiPatch: async () => ({ ok: true }),
  apiDelete: async () => ({ ok: true }),
}))

mock.module(path.resolve(import.meta.dir, '../src/lib/keyring'), () => ({
  keychainRead: () => ({ accessToken: 'test-token', accessTokenExpiresAt: '2099-01-01T00:00:00Z' }),
  keychainWrite: () => {},
  keychainDelete: () => {},
}))

import { syncDownFull, syncDown } from '../src/lib/sync'
import type { SyncReport } from '../src/lib/sync'

let root = ''
let credsFile = ''
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-sync-'))
  fs.mkdirSync(path.join(root, '.moonlybox'), { recursive: true })
  fs.writeFileSync(path.join(root, '.moonlybox', 'manifest.json'), '{}')
  const cfg = path.join(process.env.HOME ?? '/root', '.config', 'moonlybox')
  fs.mkdirSync(cfg, { recursive: true })
  credsFile = path.join(cfg, 'credentials.json')
  fs.writeFileSync(credsFile, JSON.stringify({ accessToken: 'test-token-dirs', accessTokenExpiresAt: '2099-01-01T00:00:00.000Z' }))
})
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (credsFile && fs.existsSync(credsFile)) fs.rmSync(credsFile, { force: true })
})

function report(): SyncReport {
  return { uploaded: [], skipped: [], conflicts: [], inboxFiled: [], downloaded: [], updated: [] } as any
}
const exists = (...seg: string[]) => fs.existsSync(path.join(root, ...seg))
const list = (rel: string) => {
  const abs = path.join(root, rel)
  return fs.existsSync(abs) ? fs.readdirSync(abs) : []
}
const deepClean = (dir: string) => {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) deepClean(p)
    else fs.unlinkSync(p)
  }
  try { fs.rmdirSync(dir) } catch { /* 非空=保留 */ }
}

const docOf = (id: string, title: string, dirId: string | null, version = 1) => ({
  id, title, status: 'active', isArchived: false, kind: 'note', version,
  updatedAt: '2026-09-27T00:00:00Z', directoryId: dirId, content: `# ${title}\n正文`,
})

describe('云端目录同步闭环（#253.50）', () => {
  test('① 多级目录树全量下行：文档/<父>/<子>/.md', async () => {
    cloudDirs = [
      { id: 'DIR_A', parentId: null, name: '工作', children: [
        { id: 'DIR_B', parentId: 'DIR_A', name: '项目X', children: [] },
      ] },
      { id: 'DIR_C', parentId: null, name: '生活', children: [] },
    ]
    cloudDocs = [
      docOf('01M3D1TESTAAAAAAAAAAAAAA', '层级文档', 'DIR_B'),
      docOf('01M3D2TESTAAAAAAAAAAAAAA', '根下文档', null),
      docOf('01M3D3TESTAAAAAAAAAAAAAA', '一级文档', 'DIR_C'),
    ]
    await syncDownFull(root, report())
    expect(exists('文档', '工作', '项目X', '层级文档.md')).toBe(true)
    expect(exists('文档', '根下文档.md')).toBe(true)
    expect(exists('文档', '生活', '一级文档.md')).toBe(true)
    // 空父目录也镜像（结构完整投影）：
    expect(exists('文档', '工作')).toBe(true)
    expect(exists('文档', '生活')).toBe(true)
  })

  test('② 目录改名：旧路径清空、新路径重建（无残留）', async () => {
    cloudDirs = [
      { id: 'DIR_A', parentId: null, name: '工作', children: [
        { id: 'DIR_B', parentId: 'DIR_A', name: '项目Y', children: [] }, // 项目X→项目Y
      ] },
    ]
    cloudDocs = [docOf('01M3D1TESTAAAAAAAAAAAAAA', '层级文档', 'DIR_B', 2)]
    await syncDownFull(root, report())
    expect(exists('文档', '工作', '项目Y', '层级文档.md')).toBe(true)
    expect(exists('文档', '工作', '项目X')).toBe(false)
    expect(list('文档/工作')).toEqual(['项目Y'])
  })

  test('③ 目录删除：文档回落镜像区根 + 空目录清理', async () => {
    cloudDirs = [{ id: 'DIR_C', parentId: null, name: '生活', children: [] }]
    cloudDocs = [
      docOf('01M3D1TESTAAAAAAAAAAAAAA', '层级文档', null, 3), // 云端移出目录
      docOf('01M3D3TESTAAAAAAAAAAAAAA', '一级文档', 'DIR_C', 2),
    ]
    await syncDownFull(root, report())
    expect(exists('文档', '层级文档.md')).toBe(true)
    expect(exists('文档', '生活', '一级文档.md')).toBe(true)
    expect(exists('文档', '工作')).toBe(false) // 无文档的目录整枝消失
  })

  test('④ 增量下行同样重建目录（changes 带 directories）', async () => {
    fs.rmSync(path.join(root, '.moonlybox', 'sync-cursor.json'), { force: true })
    // 首轮造 cursor：
    await syncDownFull(root, report())
    cloudDirs = [{ id: 'DIR_F', parentId: null, name: '新分类', children: [] }]
    cloudDocs = [docOf('01M3D9TESTAAAAAAAAAAAAAA', '增量新文档', 'DIR_F', 1)]
    const r = report()
    await syncDown(root, r)
    expect(exists('文档', '新分类', '增量新文档.md')).toBe(true)
  })
})
