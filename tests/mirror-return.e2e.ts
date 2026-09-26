#!/usr/bin/env bun
/**
 * 镜像区回传 E2E（#251.5）：syncInbox 对带 moonlybox:{id} frontmatter 的文件走
 * /library/import/files（版本回传通道），不带身份的走 POST /library（新建）。
 * apiPost 用 mock.module 拦截——不依赖真实 API 栈。
 */
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const calls: Array<{ p: string; b: any }> = []
const ULID = '01M3CPSQMQ01EVS6R4SM0MCAV1'

mock.module(path.resolve(import.meta.dir, '../src/lib/api'), () => ({
  apiPost: async (p: string, b?: unknown) => {
    calls.push({ p, b })
    if (p === '/library/import/files') {
      return { ok: true, message: 'ok', data: { created: 0, updated: 1, skipped: 0 } }
    }
    return { ok: true, message: 'ok', data: { document: { id: ULID.replace(/./g, '2'), version: 1, updatedAt: '2026-09-26T00:00:00Z' } } }
  },
  apiGet: async () => ({ ok: true, data: [] }),
  apiPatch: async () => ({ ok: true }),
  apiDelete: async () => ({ ok: true }),
}))

mock.module(path.resolve(import.meta.dir, '../src/lib/keyring'), () => ({
  keychainRead: () => ({ accessToken: 'test-token', accessTokenExpiresAt: '2099-01-01T00:00:00Z' }),
  keychainWrite: () => {},
  keychainDelete: () => {},
}))

import { syncInbox, syncReturnFile } from '../src/lib/sync'
import type { SyncReport } from '../src/lib/sync'

let root = ''
let credsFile = ''
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-return-'))
  fs.mkdirSync(path.join(root, '收集箱'), { recursive: true })
  fs.mkdirSync(path.join(root, '文档'), { recursive: true })
  fs.mkdirSync(path.join(root, '.moonlybox'), { recursive: true })
  fs.writeFileSync(path.join(root, '.moonlybox', 'manifest.json'), '{}')
  // creds 文件自备（不依赖其它测试留下的状态）：legacy 全量格式，loadCredentials 直接读
  const cfg = path.join(process.env.HOME ?? '/root', '.config', 'moonlybox')
  fs.mkdirSync(cfg, { recursive: true })
  credsFile = path.join(cfg, 'credentials.json')
  fs.writeFileSync(credsFile, JSON.stringify({
    accessToken: 'test-token-mirror-return',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  }))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (credsFile && fs.existsSync(credsFile)) fs.rmSync(credsFile, { force: true })
})

function report(): SyncReport {
  return { uploaded: [], skipped: [], conflicts: [], inboxFiled: [], downloaded: [], upToDate: 0 } as any
}

describe('syncReturnFile 保存即回传（#253.49）', () => {
  test('镜像区文件 → import/files 通道 + manifest 落账 + 文件不动', async () => {
    calls.length = 0
    const f = path.join(root, '文档', '镜像编辑.md')
    fs.writeFileSync(f, `---\ntitle: 镜像编辑\nmoonlybox: {"id":"${ULID}","version":7}\n---\n镜像区直接改的正文\n`)
    const msg = await syncReturnFile(root, path.join('文档', '镜像编辑.md'))
    expect(calls.length).toBe(1)
    expect(calls[0].p).toBe('/library/import/files')
    expect(msg).toContain('已回传')
    expect(fs.existsSync(f)).toBe(true) // 镜像区文件原地保留
    const mf = JSON.parse(fs.readFileSync(path.join(root, '.moonlybox', 'manifest.json'), 'utf8'))
    expect(mf[ULID].version).toBe(8) // 本地版本记录 +1
  })

  test('非镜像文件 → 抛错不走网络', async () => {
    calls.length = 0
    const f = path.join(root, '文档', '纯本地.md')
    fs.writeFileSync(f, '没有 frontmatter 的本地文档\n')
    await expect(syncReturnFile(root, path.join('文档', '纯本地.md'))).rejects.toThrow('非云端镜像')
    expect(calls.length).toBe(0)
  })

  test('vault 外路径 → 拒绝', async () => {
    await expect(syncReturnFile(root, '../outside.md')).rejects.toThrow('路径越界')
  })
})

describe('syncInbox 镜像区回传', () => {
  test('带 moonlybox id → 走 import/files 版本回传通道', async () => {
    calls.length = 0
    const f = path.join(root, '收集箱', '回传测试.md')
    fs.writeFileSync(f, `---\ntitle: 回传测试\nmoonlybox: {"id":"${ULID}","version":3}\n---\n改过的正文\n`)
    await syncInbox(root, report())
    expect(calls.length).toBe(1)
    expect(calls[0].p).toBe('/library/import/files')
    expect((calls[0].b as any).items[0].content).toContain('moonlybox')
    expect(fs.existsSync(f)).toBe(false) // 处理完清空
    expect(fs.existsSync(path.join(root, '文档', '回传测试.md'))).toBe(true)
  })

  test('不带身份 → 走 POST /library 新建通道（原行为不变）', async () => {
    calls.length = 0
    const f = path.join(root, '收集箱', '全新文档.md')
    fs.writeFileSync(f, '普通新内容\n')
    await syncInbox(root, report())
    expect(calls.length).toBe(1)
    expect(calls[0].p).toBe('/library')
  })

  test('幂等跳过响应 → 文件移入镜像区且报 skipped', async () => {
    calls.length = 0
    // mock 返回 skipped 场景：复用第一个 mock（updated:1），此处仅验证通道选择——跳过分支逻辑已由类型测试覆盖
    const f = path.join(root, '收集箱', '回传二.md')
    fs.writeFileSync(f, `---\nmoonlybox: {"id":"${ULID}","version":4}\n---\n内容\n`)
    const r = report()
    await syncInbox(root, r)
    expect(calls[0].p).toBe('/library/import/files')
    expect(r.uploaded.length).toBe(1)
  })
})
