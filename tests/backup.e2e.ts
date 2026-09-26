/**
 * #257 备份同步引擎：注册表/格式过滤/sha256 跳过/归属目录传参——api 层 mock，XDG 隔离。
 */
import { describe, test, expect, mock } from 'bun:test'

process.env.XDG_CONFIG_HOME = '/tmp/mf-backup-' + Date.now()
// 隔离目录种登录态（configDir 认 XDG）
require('node:fs').mkdirSync(process.env.XDG_CONFIG_HOME + '/moonlybox', { recursive: true })
require('node:fs').writeFileSync(
  process.env.XDG_CONFIG_HOME + '/moonlybox/credentials.json',
  JSON.stringify({ accessToken: 'test-token', accessTokenExpiresAt: '2099-01-01T00:00:00.000Z' }),
)

const captured: any[] = []
mock.module('../src/lib/api', () => ({
  apiGet: async () => ({ ok: true, data: { directories: [
    { id: 'dirA', name: '工作备份', children: [{ id: 'dirA1', name: '子目录', children: [] }] },
    { id: 'dirB', name: '资料', children: [] },
  ] } }),
  apiPost: async (p: string, body: any) => { captured.push({ p, body }); return { ok: true, data: { document: { id: 'doc_' + captured.length, version: 1 } } } },
  apiPatch: async () => ({ ok: true }),
  apiDelete: async () => ({ ok: true }),
}))

const { addEntry, listCloudDirs, backupSync, BACKUP_EXTS, loadRegistry, setEnabled, removeEntry } = await import('../src/lib/backup')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

describe('#257 备份同步', () => {
  test('格式常量与说明一致（.md/.txt）', () => {
    expect(BACKUP_EXTS).toEqual(['.md', '.txt'])
  })
  test('listCloudDirs 平铺带层级', async () => {
    const dirs = await listCloudDirs()
    expect(dirs.length).toBe(4)
    expect(dirs[0].label).toBe('书房根目录')
    expect(dirs[2].label).toContain('子目录')
  })
  test('注册→同步：只传可识别格式+directoryId 正确', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'))
    fs.writeFileSync(path.join(local, '笔记.md'), '# 内容A')
    fs.writeFileSync(path.join(local, '说明.txt'), '纯文本B')
    fs.writeFileSync(path.join(local, '图片.png'), 'binary') // 应跳过
    fs.writeFileSync(path.join(local, '.hidden.md'), 'hide') // 隐藏文件跳过
    const entry = addEntry(local, 'dirA', '工作备份')
    const rep = await backupSync(entry.id)
    expect(rep.uploaded.length).toBe(2)
    expect(rep.skipped.some((s: string) => s.includes('图片.png'))).toBe(false) // png 直接不在候选
    expect(captured.length).toBe(2)
    expect(captured[0].body.directoryId).toBe('dirA')
    expect(captured[0].body.title).toBe('笔记')
  })
  test('sha256 未变更跳过（幂等）', async () => {
    const reg = loadRegistry()
    const rep = await backupSync(reg.entries[0].id)
    expect(rep.uploaded.length).toBe(0)
    expect(rep.skipped.filter((s: string) => s.includes('未变更')).length).toBe(2)
  })
  test('修改文件后重新上传', async () => {
    const reg = loadRegistry()
    const local = reg.entries[0].localPath
    fs.writeFileSync(path.join(local, '笔记.md'), '# 内容A已修改')
    const rep = await backupSync(reg.entries[0].id)
    expect(rep.uploaded).toEqual(['笔记.md'])
  })
  test('停用/删除', () => {
    const reg = loadRegistry()
    setEnabled(reg.entries[0].id, false)
    expect(loadRegistry().entries[0].enabled).toBe(false)
    removeEntry(reg.entries[0].id)
    expect(loadRegistry().entries.length).toBe(0)
  })
})
