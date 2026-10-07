/**
 * #333 download_file e2e：真实 HTTP 下载（本机临时服务）+限额+同名序号+filename 覆盖+URL 名推导。
 * bun:test 格式 → bun test ./tests/download-file.e2e.ts
 */
import { afterAll, beforeAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_dl_'))
let server: any

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/file.bin') {
        const size = Number(u.searchParams.get('size') ?? 1024)
        return new Response(new Uint8Array(size).fill(65), { headers: { 'Content-Disposition': 'attachment; filename="report.zip"' } })
      }
      if (u.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: '/file.bin?size=64' } })
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  server.stop(true)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const { downloadFile } = await import('../src/lib/web-tools')

test('#333 基础下载+URL 名推导（.part 原子改名）', async () => {
  const dest = path.join(tmpDir, 'dl1')
  const r = await downloadFile(`http://localhost:${server.port}/file.bin?size=2048`, dest)
  expect(r.ok).toBe(true)
  expect(r.bytes).toBe(2048)
  expect(fs.existsSync(String(r.path))).toBe(true)
  expect(path.basename(String(r.path))).toBe('file.bin')
})

test('#333 filename 覆盖+同名加序号不覆盖', async () => {
  const dest = path.join(tmpDir, 'dl2')
  const r1 = await downloadFile(`http://localhost:${server.port}/file.bin?size=10`, dest, '课件.zip')
  expect(r1.ok).toBe(true)
  expect(path.basename(String(r1.path))).toBe('课件.zip')
  const r2 = await downloadFile(`http://localhost:${server.port}/file.bin?size=10`, dest, '课件.zip')
  expect(r2.ok).toBe(true)
  expect(path.basename(String(r2.path))).toBe('课件-1.zip')
})

test('#333 100MB 上限拒绝（声明值超限）', async () => {
  const dest = path.join(tmpDir, 'dl3')
  const big = 101 * 1024 * 1024
  const r = await downloadFile(`http://localhost:${server.port}/file.bin?size=${big}`, dest)
  expect(r.ok).toBe(false)
  expect(String(r.error)).toContain('100MB')
})

test('#333 重定向跟随+404 报错', async () => {
  const dest = path.join(tmpDir, 'dl4')
  const r = await downloadFile(`http://localhost:${server.port}/redirect`, dest)
  expect(r.ok).toBe(true)
  expect(r.bytes).toBe(64)
  const r2 = await downloadFile(`http://localhost:${server.port}/nope`, dest)
  expect(r2.ok).toBe(false)
  expect(String(r2.error)).toContain('404')
})
