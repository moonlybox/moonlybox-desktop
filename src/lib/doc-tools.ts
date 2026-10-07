/**
 * 文档处理（#287，D 项）：文件→文本解析，给小月 doc_read 内置工具消费。
 * 形态照 #279 web-tools（设置驱动+provider 分发+key 钥匙串）：
 * - settings.docproc: {mode: 'local'|'provider', provider, config{baseUrl}}；key=钥匙串 docproc-key（daemon settings save 剥离）
 * - 本地档：builtin=纯文本/md/txt 直读 + PDF 文本层（pdfjs-dist）+ docx（mammoth）；winocr/paddle=预留档位（未配置引擎时回落 builtin 并说明）
 * - provider 档：Doc2X/MinerU/Mathpix/TextIn——REST 上传文件→轮询/直返 markdown
 * - 恒装配 doc_read 工具（本地档零网络可用）；provider 档按配置分发
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadSettings } from './settings'
import { WINOCR_IMAGE_EXTS, winocrDetect, winocrRecognize } from './winocr'

/** docproc API key 钥匙串（service=moonlybox/account=docproc-key，daemon settings save 剥离落） */
function loadDocProcKey(): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry('moonlybox', 'docproc-key').getPassword() || null
  } catch {
    return null
  }
}

export interface DocReadResult {
  ok: boolean
  path?: string
  kind?: string // txt|md|pdf|docx|html|other
  text?: string
  pages?: number
  truncated?: boolean
  error?: string
  engine?: string // 实际用的引擎（builtin/pdfjs/mammoth/<provider>）
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.log', '.ts', '.js', '.py', '.html', '.htm', '.xml', '.toml', '.ini'])
const MAX_TEXT_CHARS = 60_000 // 注入 LLM 的上限（超长截断+标记）

function detectKind(ext: string): string {
  if (TEXT_EXTS.has(ext)) return ext === '.html' || ext === '.htm' ? 'html' : 'txt'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (WINOCR_IMAGE_EXTS.has(ext)) return 'image'
  return 'other'
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 本地解析：纯文本直读 / PDF 文本层（pdfjs）/ 图片与扫描 PDF（winocr OCR，#332）/ docx（mammoth）/ html 剥标签 */
async function parseLocal(filePath: string, kind: string): Promise<DocReadResult> {
  const buf = fs.readFileSync(filePath)
  if (kind === 'image') {
    return ocrImage(filePath)
  }
  if (kind === 'txt') {
    const text = buf.toString('utf8')
    const truncated = text.length > MAX_TEXT_CHARS
    return { ok: true, path: filePath, kind: 'txt', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated, engine: 'builtin' }
  }
  if (kind === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await (pdfjs as any).getDocument({ data: new Uint8Array(buf), useSystemFonts: false }).promise
    const parts: string[] = []
    const maxPages = Math.min(doc.numPages, 200)
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      parts.push(tc.items.map((it: any) => it.str).join(' ').trim())
    }
    let text = parts.filter(Boolean).join('\n\n').trim()
    const pages = doc.numPages
    if (!text) {
      // #332：无文本层→winocr 扫描件 OCR（Windows 检测到即用；检测不到保持原说明文案）
      const ocr = await ocrPdfScan(filePath, pages)
      if (ocr.ok) return ocr
      return { ok: false, path: filePath, kind: 'pdf', error: `PDF 无文本层（${pages} 页，扫描件）——本机 OCR 不可用或未识别出内容，可配置第三方服务商（如 Doc2X）`, engine: 'pdfjs' }
    }
    const truncated = text.length > MAX_TEXT_CHARS || pages > maxPages
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS)
    return { ok: true, path: filePath, kind: 'pdf', text, pages, truncated, engine: 'pdfjs' }
  }
  if (kind === 'html') {
    const text = stripHtml(buf.toString('utf8'))
    const truncated = text.length > MAX_TEXT_CHARS
    return { ok: true, path: filePath, kind: 'html', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated, engine: 'builtin' }
  }
  if (kind === 'docx') {
    const mammoth = await import('mammoth')
    const r = await (mammoth as any).extractRawText({ buffer: buf })
    let text = String(r?.value ?? '').trim()
    const truncated = text.length > MAX_TEXT_CHARS
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS)
    return { ok: true, path: filePath, kind: 'docx', text, truncated, engine: 'mammoth' }
  }
  return { ok: false, path: filePath, kind, error: `暂不支持该格式（.${kind === 'other' ? path.extname(filePath).slice(1) || '未知' : kind}）——支持 txt/md/code/PDF（文本层）/docx/html，或配置第三方服务商` }
}

/** PDF 扫描件 OCR：pdfjs 逐页光栅化→winocr 识别（#332；A2 裁决=页数不限制；单页失败跳过并在尾部标注） */
async function ocrPdfScan(filePath: string, numPages: number): Promise<DocReadResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await (pdfjs as any).getDocument({ data: new Uint8Array(fs.readFileSync(filePath)), useSystemFonts: false }).promise
  const parts: string[] = []
  const failedPages: number[] = []
  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await doc.getPage(i)
      // 光栅化 scale=2（约 144dpi——OCR 精度与内存的平衡点；A3 语言=系统引擎默认）
      const viewport = page.getViewport({ scale: 2 })
      const canvas = document?.createElement?.('canvas')
      let dataUrl: string | null = null
      if (canvas) {
        // DOM canvas（旧路径，bun 无 DOM 不会走）
        const ctx = canvas.getContext('2d')
        await page.render({ canvasContext: ctx, viewport }).promise
        dataUrl = canvas.toDataURL('image/png')
      } else {
        // 无 DOM 环境：@napi-rs/canvas（可用则用）
        let mod: any = null
        try { mod = await import('@napi-rs/canvas') } catch { mod = null }
        if (!mod) throw new Error('NO_CANVAS')
        const cv = mod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const ctx = cv.getContext('2d')
        await page.render({ canvasContext: ctx, viewport }).promise
        dataUrl = cv.toDataURL('image/png')
      }
      const b64Raw = dataUrl ?? ''
      const b64 = b64Raw.slice(b64Raw.indexOf(',') + 1)
      if (!b64) throw new Error('CANVAS_EMPTY')
      const tmp = path.join(path.dirname(filePath), `.__ocr_p${i}__.png`)
      fs.writeFileSync(tmp, Buffer.from(b64, 'base64'))
      try {
        const line = await winocrRecognize(tmp)
        if (line) parts.push(line)
        else failedPages.push(i)
      } finally {
        try { fs.unlinkSync(tmp) } catch { /* 临时页图清理失败忽略 */ }
      }
    } catch {
      failedPages.push(i)
    }
  }
  const text = parts.join('\n\n').trim()
  const truncated = text.length > MAX_TEXT_CHARS
  if (!text) {
    return { ok: false, path: filePath, kind: 'pdf', error: `PDF 无文本层且 OCR 未能识别出内容（${numPages} 页${failedPages.length ? `，失败页：${failedPages.join('、')}` : ''}）——可配置第三方服务商（Doc2X）`, engine: 'winocr' }
  }
  return { ok: true, path: filePath, kind: 'pdf', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, pages: numPages, truncated, engine: 'winocr' }
}

/** 图片 OCR（#332 A1：Windows 检测到 winocr 即启用，无需设置；检测不到回落说明文案） */
async function ocrImage(filePath: string): Promise<DocReadResult> {
  const ok = await winocrDetect()
  if (!ok) {
    return { ok: false, path: filePath, kind: 'txt', error: '图片识别需 Windows 本机 OCR（当前环境不可用）——可配置第三方服务商或改用包含文本的格式', engine: 'builtin' }
  }
  const text = await winocrRecognize(filePath)
  if (!text) return { ok: false, path: filePath, kind: 'txt', error: 'OCR 未能识别出文本内容（可能是空白图片或无文字图形）', engine: 'winocr' }
  const truncated = text.length > MAX_TEXT_CHARS
  return { ok: true, path: filePath, kind: 'txt', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated, engine: 'winocr' }
}

async function parseProvider(filePath: string, provider: string, baseUrl: string, key: string | null): Promise<DocReadResult> {
  if (!key) return { ok: false, path: filePath, error: `该服务商（${provider}）需要 API Key——设置-文档处理里填写` }
  const buf = fs.readFileSync(filePath)
  const name = path.basename(filePath)
  const mimeMap: Record<string, string> = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }
  const mime = mimeMap[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  // v1 适配：Doc2X（v2 接口：/api/v2/convert/pdf 上传→轮询）/MinerU（/file-urls/batch 异步）形态各异——
  // 统一实现为「上传→轮询直到完成→取文本」，逐商分支。v1 先落 Doc2X 与 Mathpix（文档明确、同步度高），其余报「暂未适配该服务商的调用」。
  if (provider === 'doc2x') {
    // Doc2X v2: POST {base}/api/v2/convert/pdf (multipart file, options) → {code:ok, data:{uid}} → GET {base}/api/v2/convert/uid/status?uid= → {data:{state:'success', full_result:{md_content}}}
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), name)
    const r1 = await fetch(`${baseUrl || 'https://v2.doc2x.noedgeai.com'}/api/v2/convert/pdf`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
    if (!r1.ok) return { ok: false, path: filePath, error: `Doc2X 上传失败（HTTP ${r1.status}）` }
    const j1 = (await r1.json()) as any
    if (j1?.code !== 'ok' || !j1?.data?.uid) return { ok: false, path: filePath, error: `Doc2X 响应异常：${JSON.stringify(j1).slice(0, 200)}` }
    const uid = j1.data.uid
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const r2 = await fetch(`${baseUrl || 'https://v2.doc2x.noedgeai.com'}/api/v2/convert/uid/status?uid=${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!r2.ok) continue
      const j2 = (await r2.json()) as any
      const state = j2?.data?.state
      if (state === 'success') {
        const text = String(j2?.data?.full_result?.md_content ?? '').trim()
        return { ok: !!text, path: filePath, kind: 'pdf', text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, engine: 'doc2x' }
      }
      if (state === 'failed') return { ok: false, path: filePath, error: `Doc2X 解析失败：${j2?.data?.errmsg ?? '未知原因'}` }
    }
    return { ok: false, path: filePath, error: 'Doc2X 解析超时（3 分钟）' }
  }
  if (provider === 'mathpix') {
    // Mathpix PDF: POST {base}/v3/pdf (multipart) → {pdf_md...}? 实际=async: headers app_id/app_key——v1 按图片形态处理单页文档；
    // PDF 需 app_id+app_key 双凭据，当前设置只有单 key——报说明。
    return { ok: false, path: filePath, error: 'Mathpix 需要 App ID + App Key 双凭据（当前设置只有单 Key）——建议用 Doc2X 或本地档' }
  }
  return { ok: false, path: filePath, error: `服务商 ${provider} 的调用暂未适配——当前可用：本地档（内置/PDF 文本层/docx）、Doc2X` }
}

/** 解析单文件（设置驱动入口） */
export async function docRead(filePath: string): Promise<DocReadResult> {
  const p = path.resolve(filePath)
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { ok: false, path: p, error: `文件不存在或不是文件：${p}` }
  }
  const s = loadSettings().docproc ?? { mode: 'local', provider: '', config: {} }
  const kind = detectKind(path.extname(p).toLowerCase())
  if (s.mode === 'provider' && s.provider && s.provider !== 'winocr') { // winocr=#332 已变自动引擎，存量档位值兜底归本地
    const baseUrl = String(s.config?.baseUrl ?? '')
    const key = loadDocProcKey()
    return parseProvider(p, s.provider, baseUrl, key)
  }
  // 本地档：winocr/paddle 未实装引擎时回落 builtin（纯文本/PDF/docx/html 可用）
  return parseLocal(p, kind)
}

/** 小月工具定义（照 web-tools webToolDefs 形态） */
export function docToolDefs(): Array<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'doc_read',
      title: '读取文档',
      description: '读取本地文件内容并解析为文本。支持纯文本/Markdown/代码文件、PDF（文本层）、Word docx、HTML、图片与扫描版 PDF（Windows 本机 OCR 自动启用）；扫描件 PDF 也可在设置-文档处理配置第三方服务商（如 Doc2X）获得更强解析。返回文件文本内容。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径（如 D:\\资料\\报告.pdf）' },
        },
        required: ['path'],
      },
    },
  ]
}

/** 小月工具执行（照 runWebTool 形态，返回字符串给 LLM） */
export async function runDocTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'doc_read') return JSON.stringify({ ok: false, error: `未知文档工具：${name}` })
  const p = String(args.path ?? '').trim()
  if (!p) return JSON.stringify({ ok: false, error: '缺少 path 参数' })
  const r = await docRead(p)
  if (!r.ok) return JSON.stringify({ ok: false, path: r.path, error: r.error })
  const meta = [r.kind ? `格式=${r.kind}` : '', r.pages ? `页数=${r.pages}` : '', r.engine ? `引擎=${r.engine}` : '', r.truncated ? '（内容过长已截断）' : ''].filter(Boolean).join('，')
  return JSON.stringify({ ok: true, path: r.path, meta, text: r.text })
}
