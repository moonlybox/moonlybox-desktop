/**
 * 文档处理 e2e（#287，D 项）：doc-tools 解析链——
 * ①txt/md 直读+截断 ②PDF 文本层（pdfjs 真解析）③docx（mammoth）④html 剥标签 ⑤不存在/不支持格式报错
 * ⑥doc_read 工具面（defs/执行/参数校验）⑦设置分发（provider 无 key 报错）。
 * bun:test 格式 → bun test ./tests/doc-tools.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_dp_'))
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_dp_data_'))
process.env.XDG_CONFIG_HOME = tmpCfg

const { docRead, docToolDefs, runDocTool } = await import('../src/lib/doc-tools')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
  fs.rmSync(tmpData, { recursive: true, force: true })
})

const write = (name: string, content: Buffer | string): string => {
  const p = path.join(tmpData, name)
  fs.writeFileSync(p, content)
  return p
}

test('txt/md 直读', async () => {
  const p = write('note.md', '# 标题\n\n正文内容，用于书房知识整理。')
  const r = await docRead(p)
  expect(r.ok).toBe(true)
  expect(r.kind).toBe('txt')
  expect(r.text).toContain('# 标题')
  expect(r.text).toContain('书房知识整理')
  expect(r.engine).toBe('builtin')
  expect(r.truncated).toBe(false)
})

test('PDF 文本层（pdfjs 真解析）', async () => {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 24 Tf 100 700 Td (Hello MoonlyBox DocProc) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`
  const p = write('doc.pdf', pdf)
  const r = await docRead(p)
  expect(r.ok).toBe(true)
  expect(r.kind).toBe('pdf')
  expect(r.pages).toBe(1)
  expect(r.text).toContain('Hello MoonlyBox DocProc')
  expect(r.engine).toBe('pdfjs')
})

test('docx（mammoth）', async () => {
  // 最小 docx=zip 包——用 Bun 手造太重，改用 mammoth 对非 docx 的报错路径验证 + 跳过真 docx（生成依赖 word）：
  // 实际上 mammoth 接受 {buffer}——造最小 OOXML zip 需要 zipfile 库。用 Python zipfile 造（外部准备）：
  const p = path.join(tmpData, 'test.docx')
  const py = Bun.spawnSync(['python3', '-c', `
import zipfile
with zipfile.ZipFile('${p}', 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docx 段落正文</w:t></w:r></w:p></w:body></w:document>')
print('ok')
`])
  expect(py.exitCode).toBe(0)
  const r = await docRead(p)
  expect(r.ok).toBe(true)
  expect(r.kind).toBe('docx')
  expect(r.text).toContain('Docx 段落正文')
  expect(r.engine).toBe('mammoth')
})

test('html 剥标签', async () => {
  const p = write('page.html', '<html><head><style>body{color:red}</style></head><body><p>第一段</p><p>第二段</p><script>alert(1)</script></body></html>')
  const r = await docRead(p)
  expect(r.ok).toBe(true)
  expect(r.kind).toBe('html')
  expect(r.text).toContain('第一段')
  expect(r.text).not.toContain('<p>')
  expect(r.text).not.toContain('alert')
  expect(r.text).not.toContain('color:red')
})

test('错误路径：文件不存在/不支持格式/目录', async () => {
  expect((await docRead(path.join(tmpData, 'nope.pdf'))).ok).toBe(false)
  const p = write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const r = await docRead(p)
  expect(r.ok).toBe(false)
  expect(String(r.error)).toContain('暂不支持')
  expect((await docRead(tmpData)).ok).toBe(false)
})

test('工具面：defs/执行/参数校验', async () => {
  const defs = docToolDefs()
  expect(defs.length).toBe(1)
  expect(defs[0]!.name).toBe('doc_read')
  expect(defs[0]!.inputSchema.required).toEqual(['path'])
  // 缺参数
  expect(String(await runDocTool('doc_read', {}))).toContain('缺少 path')
  // 未知工具
  expect(String(await runDocTool('doc_write', {}))).toContain('未知文档工具')
  // 正常执行（JSON 形态）
  const p = write('t.txt', '工具执行正文')
  const out = JSON.parse(String(await runDocTool('doc_read', { path: p })))
  expect(out.ok).toBe(true)
  expect(out.text).toContain('工具执行正文')
  expect(out.meta).toContain('builtin')
})

test('provider 档：无 key 报错引导（设置分发生效）', async () => {
  const s = await import('../src/lib/settings')
  // 写 provider 档设置
  const cfgPath = path.join(tmpCfg, 'moonlybox', 'settings.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify({ docproc: { mode: 'provider', provider: 'doc2x', config: { baseUrl: 'https://v2.doc2x.noedgeai.com' } } }))
  const p = write('doc.pdf', '%PDF-1.4\ntrailer<</Size 1/Root 1 0 R>>\n%%EOF')
  const r = await docRead(p)
  expect(r.ok).toBe(false)
  expect(String(r.error)).toContain('API Key')
})
