/**
 * #257/#258 备份同步引擎：C1 PATCH 更新/C3 删除感知/同名冲突策略/云端编辑感知/vault 防护。
 * api 层 mock；XDG 隔离；每用例独立云端态+独立注册目录。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

process.env.XDG_CONFIG_HOME = '/tmp/mf-bk3-' + Date.now()
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
fs.mkdirSync(process.env.XDG_CONFIG_HOME + '/moonlybox', { recursive: true })
fs.writeFileSync(
  process.env.XDG_CONFIG_HOME + '/moonlybox/credentials.json',
  JSON.stringify({ accessToken: 'test-token', accessTokenExpiresAt: '2099-01-01T00:00:00.000Z' }),
)

const calls: Array<{ m: string; p: string; body: any }> = []
const cloudDocs = new Map<string, any>()
let docSeq = 0
mock.module('../src/lib/api', () => ({
  apiGet: async (p: string) => {
    calls.push({ m: 'GET', p, body: null })
    return { ok: true, status: 200, data: { documents: [...cloudDocs.values()], directories: [] } }
  },
  apiPost: async (p: string, body: any) => {
    calls.push({ m: 'POST', p, body })
    const id = 'doc_' + ++docSeq
    cloudDocs.set(id, { id, title: body.title, version: 1, directoryId: body.directoryId ?? null, content: body.content, status: 'active', kind: 'note' })
    return { ok: true, status: 201, data: { document: { id, version: 1 } } }
  },
  apiPatch: async (p: string, body: any) => {
    calls.push({ m: 'PATCH', p, body })
    const id = p.replace('/library/', '')
    const d = cloudDocs.get(id)
    if (!d) return { ok: false, status: 404, message: 'not found' }
    d.version += 1
    if (body.content !== undefined) d.content = body.content
    return { ok: true, status: 200, data: { document: { id: d.id, version: d.version } } }
  },
  apiDelete: async () => ({ ok: true, status: 200 }),
}))

const { addEntry, backupSync, loadRegistry, setPolicies } = await import('../src/lib/backup')

function mkLocal(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk3-'))
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v)
  return dir
}

describe('#258 备份策略引擎', () => {
  beforeEach(() => {
    calls.length = 0
    cloudDocs.clear()
    docSeq = 0
    // 清空注册表：直接重写文件
    fs.writeFileSync(process.env.XDG_CONFIG_HOME + '/moonlybox/backups.json', JSON.stringify({ entries: [] }))
  })

  test('首次上传 POST + 记账含 docId/docVersion；C1 修改走 PATCH 不新建', async () => {
    const local = mkLocal({ '笔记.md': '# A' })
    const e = addEntry(local, 'dirA', '工作备份')
    const rep = await backupSync(e.id)
    expect(rep.uploaded.length).toBe(1)
    const rec1 = Object.values(loadRegistry().entries[0].files)[0] as any
    expect(rec1.docId).toBe('doc_1')
    expect(rec1.docVersion).toBe(1)
    // 修改 → PATCH
    calls.length = 0
    fs.writeFileSync(path.join(local, '笔记.md'), '# A 改')
    const rep2 = await backupSync(e.id)
    expect(rep2.updated).toEqual(['笔记.md'])
    const patch = calls.find((c) => c.m === 'PATCH')
    expect(patch).toBeDefined()
    expect(patch!.p).toBe('/library/doc_1')
    expect(cloudDocs.get('doc_1').version).toBe(2)
    expect(rep2.uploaded.length).toBe(0)
  })

  test('C3-resync：云端删除后重新上传', async () => {
    const local = mkLocal({ '纪要.md': '内容R' })
    const e = addEntry(local, 'dirA', '工作备份')
    await backupSync(e.id) // doc_1
    cloudDocs.delete('doc_1')
    calls.length = 0
    const rep = await backupSync(e.id)
    expect(rep.cloudDeleted.length).toBe(1)
    expect(rep.cloudDeleted[0]).toContain('重新上传')
    expect(rep.uploaded.length).toBe(1)
    expect(calls.some((c) => c.m === 'POST')).toBe(true)
  })

  test('C3-keep：云端删除后 hold 不再同步，云端恢复也不复活', async () => {
    const local = mkLocal({ '报告.md': '内容B' })
    const e = addEntry(local, 'dirB', '资料', { onDelete: 'keep' })
    await backupSync(e.id) // doc_1
    cloudDocs.delete('doc_1')
    const rep1 = await backupSync(e.id)
    expect(rep1.cloudDeleted.length).toBe(1)
    expect(rep1.cloudDeleted[0]).toContain('不再同步')
    expect(rep1.uploaded.length).toBe(0)
    const rec = Object.values(loadRegistry().entries[0].files)[0] as any
    expect(rec.hold).toBe('cloud-deleted')
    // 云端恢复 → 仍停更
    cloudDocs.set('doc_1', { id: 'doc_1', title: '报告', version: 1, directoryId: 'dirB', status: 'active', kind: 'note' })
    calls.length = 0
    const rep2 = await backupSync(e.id)
    expect(rep2.skipped.join()).toContain('已停更')
    expect(rep2.uploaded.length).toBe(0)
    expect(calls.some((c) => c.m === 'PATCH')).toBe(false)
  })

  test('云端编辑采纳：云端版本前进+本地未改 → 记账不报冲突', async () => {
    const local = mkLocal({ '手册.md': '内容C' })
    const e = addEntry(local, 'dirA', '工作备份')
    await backupSync(e.id)
    const rec = Object.values(loadRegistry().entries[0].files)[0] as any
    cloudDocs.get(rec.docId).version += 1
    calls.length = 0
    const rep = await backupSync(e.id)
    expect(rep.cloudUpdated.length).toBe(1)
    expect(rep.conflicts.length).toBe(0)
    expect(Object.values(loadRegistry().entries[0].files)[0].docVersion).toBe(rec.docVersion + 1)
    expect(calls.some((c) => c.m === 'PATCH' || c.m === 'POST')).toBe(false)
  })

  test('双向分叉：云端版本前进+本地也改 → 冲突报告不覆盖不上传', async () => {
    const local = mkLocal({ '分叉.md': '内容D' })
    const e = addEntry(local, 'dirA', '工作备份')
    await backupSync(e.id)
    const rec = Object.values(loadRegistry().entries[0].files)[0] as any
    cloudDocs.get(rec.docId).version += 1
    fs.writeFileSync(path.join(local, '分叉.md'), '# 本地大改')
    calls.length = 0
    const rep = await backupSync(e.id)
    expect(rep.conflicts.length).toBe(1)
    expect(rep.conflicts[0].reason).toContain('分叉')
    expect(rep.updated.length).toBe(0)
    expect(rep.uploaded.length).toBe(0)
    expect(calls.some((c) => c.m === 'PATCH' || c.m === 'POST')).toBe(false)
  })

  test('同名冲突-rename：上传为「标题 2」，云端同名不被碰', async () => {
    cloudDocs.set('tw_1', { id: 'tw_1', title: '新篇', version: 3, directoryId: 'dirC', status: 'active', kind: 'note' })
    const local = mkLocal({ '新篇.md': '本地版本' })
    const e = addEntry(local, 'dirC', '共用目录')
    const rep = await backupSync(e.id)
    expect(rep.uploaded[0]).toContain('2」')
    const post = calls.find((c) => c.m === 'POST')
    expect(post!.body.title).toBe('新篇 2')
    expect(cloudDocs.get('tw_1').version).toBe(3)
  })

  test('同名冲突-overwrite：PATCH 云端同名文档并认领 docId', async () => {
    cloudDocs.set('tw_2', { id: 'tw_2', title: '报道', version: 5, directoryId: 'dirD', status: 'active', kind: 'note' })
    const local = mkLocal({ '报道.md': '本地覆盖版' })
    const e = addEntry(local, 'dirD', '另一目录', { onConflict: 'overwrite' })
    const rep = await backupSync(e.id)
    expect(rep.uploaded[0]).toContain('覆盖')
    const patch = calls.find((c) => c.m === 'PATCH')
    expect(patch!.p).toBe('/library/tw_2')
    expect(cloudDocs.get('tw_2').version).toBe(6)
    const rec = Object.values(loadRegistry().entries[0].files)[0] as any
    expect(rec.docId).toBe('tw_2')
    expect(rec.docVersion).toBe(6)
  })

  test('vault 目录防护：拒绝注册书房内部路径', () => {
    fs.writeFileSync(process.env.XDG_CONFIG_HOME + '/moonlybox/vault.json', JSON.stringify({ root: '/tmp/fake-vault-z' }))
    fs.mkdirSync('/tmp/fake-vault-z/文档', { recursive: true })
    expect(() => addEntry('/tmp/fake-vault-z/文档', null, 'x')).toThrow('书房')
    fs.rmSync('/tmp/fake-vault-z', { recursive: true, force: true })
  })

  test('setPolicies 落盘', () => {
    const local = mkLocal({ 'a.md': 'x' })
    const e = addEntry(local, null, '根')
    setPolicies(e.id, { onDelete: 'keep', onConflict: 'overwrite' })
    const e2 = loadRegistry().entries[0]
    expect(e2.onDelete).toBe('keep')
    expect(e2.onConflict).toBe('overwrite')
  })
})
