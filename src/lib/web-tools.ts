/**
 * 网络搜索 + URL 提取工具（#279，盘点缺口 B+C）——小月 Agent 内置工具（并列于 MoonLink 29 工具）。
 * 服务商分发：
 *   websearch：bocha（博查）/ tavily / bing（Azure）/ serpapi（Serper）/ custom（OpenAI 兼容类自定义端点）
 *   urlextract：local（内置零依赖 HTML→正文提取）/ jina（r.jina.ai 免 Key）/ firecrawl / custom
 * key 纪律（原则⑤）：apiKey 只存本机钥匙串（service=moonlybox/account=websearch-key|urlextract-key），
 * settings.json 只落非敏感 config（baseUrl 等）；响应只回配置态布尔，key 绝不出内核。
 * 本地提取零依赖：无第三方 readability 库——HTML 去脚本样式→块级文本抽取→空白规整（纯字符串处理，全平台可用）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { loadSettings, WEBSEARCH_PROVIDERS, URL_EXTRACT_PROVIDERS } from './settings'

const KEYCHAIN_SERVICE = 'moonlybox'

function keychainAccount(kind: 'websearch' | 'urlextract'): string {
  return kind === 'websearch' ? 'websearch-key' : 'urlextract-key'
}

export function saveProviderKey(kind: 'websearch' | 'urlextract', apiKey: string): void {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  new Entry(KEYCHAIN_SERVICE, keychainAccount(kind)).setPassword(apiKey)
}

/** 读取 key 本体（仅内核内部使用——响应用只回 hasKey 布尔） */
export function loadProviderKey(kind: 'websearch' | 'urlextract'): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry(KEYCHAIN_SERVICE, keychainAccount(kind)).getPassword() || null
  } catch {
    return null
  }
}

export function clearProviderKey(kind: 'websearch' | 'urlextract'): void {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    new Entry(KEYCHAIN_SERVICE, keychainAccount(kind)).deleteCredential()
  } catch {
    /* 无条目 */
  }
}

/** 服务商清单（云端源 #276：resolveProviders 优先，内置表兜底）——settings 节 config 之外的非敏感形态 */
export function resolveWebsearchProviders(): typeof WEBSEARCH_PROVIDERS {
  try {
    const cacheFile = path.join(configDir(), 'providers-cache.json')
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { fetchedAt?: string; providers?: { websearch?: typeof WEBSEARCH_PROVIDERS } }
    if (cache.providers?.websearch?.length && cache.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < 24 * 3600 * 1000) {
      return cache.providers.websearch
    }
  } catch {
    /* 回落内置 */
  }
  return WEBSEARCH_PROVIDERS
}

export function resolveUrlextractProviders(): typeof URL_EXTRACT_PROVIDERS {
  try {
    const cacheFile = path.join(configDir(), 'providers-cache.json')
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { fetchedAt?: string; providers?: { urlextract?: typeof URL_EXTRACT_PROVIDERS } }
    if (cache.providers?.urlextract?.length && cache.fetchedAt && Date.now() - new Date(cache.fetchedAt).getTime() < 24 * 3600 * 1000) {
      return cache.providers.urlextract
    }
  } catch {
    /* 回落内置 */
  }
  return URL_EXTRACT_PROVIDERS
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 20_000): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text }
}

/* ============================== web_search ============================== */

export interface WebSearchHit { title: string; url: string; snippet: string }
export interface WebSearchResult { ok: boolean; query: string; hits: WebSearchHit[]; error?: string; provider?: string }

/** 归一各家响应 → WebSearchHit[] */
function normalizeSearchHit(item: any): WebSearchHit | null {
  if (!item) return null
  const url = item.url || item.link || ''
  if (!url) return null
  return { title: item.title || item.name || url, url, snippet: (item.summary || item.snippet || item.description || item.content || '').slice(0, 400) }
}

export async function webSearch(query: string, count = 8): Promise<WebSearchResult> {
  const cfg = loadSettings().websearch ?? { provider: '', config: {} }
  const providerId = cfg.provider || ''
  const conf = cfg.config ?? {}
  const apiKey = loadProviderKey('websearch')
  const provider = WEBSEARCH_PROVIDERS.find((p) => p.id === providerId)
  if (!providerId || !provider) return { ok: false, query, hits: [], error: '未配置搜索服务商：设置→搜索 选择服务商并填 Key' }
  if (provider.needs.includes('apiKey') && !apiKey) return { ok: false, query, hits: [], error: `搜索服务商 ${provider.label} 缺 API Key：设置→搜索 保存后重试` }
  try {
    let hits: WebSearchHit[] = []
    if (providerId === 'bocha') {
      const r = await postJson(provider.baseUrl, { query, count, freshness: 'noLimit', summary: true }, { Authorization: `Bearer ${apiKey}` })
      hits = (r.json?.data?.webPages?.value ?? []).map(normalizeSearchHit).filter(Boolean)
    } else if (providerId === 'tavily') {
      const r = await postJson(provider.baseUrl, { api_key: apiKey, query, max_results: count, search_depth: 'basic' }, {})
      hits = (r.json?.results ?? []).map(normalizeSearchHit).filter(Boolean)
    } else if (providerId === 'bing') {
      const res = await fetch(`${provider.baseUrl}?q=${encodeURIComponent(query)}&count=${count}`, {
        headers: { 'Ocp-Apim-Subscription-Key': apiKey ?? '' },
        signal: AbortSignal.timeout(20_000),
      })
      const j = await res.json().catch(() => null)
      hits = (j?.webPages?.value ?? []).map(normalizeSearchHit).filter(Boolean)
    } else if (providerId === 'serpapi') {
      const r = await postJson(provider.baseUrl, { q: query, num: count }, { 'X-API-KEY': apiKey ?? '', 'Content-Type': 'application/json' })
      hits = (r.json?.organic ?? r.json?.results ?? []).map(normalizeSearchHit).filter(Boolean)
    } else {
      // custom：OpenAI 兼容类自定义端点 {baseUrl, apiKey}——POST {query,count} 期望 {results:[...]}（fail 透传）
      const base = (conf.baseUrl || provider.baseUrl || '').replace(/\/$/, '')
      if (!base) return { ok: false, query, hits: [], error: '自定义搜索端点缺 baseUrl' }
      const r = await postJson(base, { query, count }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      hits = (r.json?.results ?? r.json?.data?.results ?? []).map(normalizeSearchHit).filter(Boolean)
    }
    return { ok: hits.length > 0, query, hits, provider: provider.label }
  } catch (e: any) {
    return { ok: false, query, hits: [], error: `搜索失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/* ============================== fetch_url ============================== */

export interface FetchUrlResult { ok: boolean; url: string; title?: string; content?: string; error?: string; mode?: string }

/** 本地零依赖 HTML→正文：去 script/style/注释→取 title→块级文本抽取→空白规整 */
export function extractHtmlText(html: string): { title: string; content: string } {
  const decode = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decode(titleMatch[1]!.replace(/\s+/g, ' ').trim()) : ''
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
  // 块级标签边界转换行（保留段落结构）
  body = body
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
  const text = decode(body.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
  return { title, content: text }
}

const FETCH_MAX_CHARS = 8000

export async function fetchUrl(url: string): Promise<FetchUrlResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: '仅支持 http(s) 链接' }
  const cfg = loadSettings().urlextract ?? { mode: 'local' as const, provider: '', config: {} }
  const conf = cfg.config ?? {}
  try {
    if (cfg.mode === 'provider' && cfg.provider && cfg.provider !== 'local') {
      const provider = URL_EXTRACT_PROVIDERS.find((p) => p.id === cfg.provider)
      if (!provider) return { ok: false, url, error: `未知提取服务商：${cfg.provider}` }
      const apiKey = loadProviderKey('urlextract')
      if (provider.needs?.includes('apiKey') && !apiKey) {
        return { ok: false, url, error: `提取服务商 ${provider.label} 缺 API Key：设置→搜索·URL 提取 保存后重试` }
      }
      if (cfg.provider === 'jina') {
        const res = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) return { ok: false, url, error: `Jina Reader HTTP ${res.status}` }
        const text = await res.text()
        return { ok: text.length > 0, url, content: text.slice(0, FETCH_MAX_CHARS), mode: 'jina' }
      }
      if (cfg.provider === 'firecrawl') {
        const base = (conf.baseUrl || provider.baseUrl || 'https://api.firecrawl.dev').replace(/\/$/, '')
        const r = await postJson(`${base}/v1/scrape`, { url, formats: ['markdown'] }, { Authorization: `Bearer ${apiKey}` }, 30_000)
        const md = r.json?.data?.markdown ?? ''
        return { ok: !!md, url, content: md.slice(0, FETCH_MAX_CHARS), mode: 'firecrawl' }
      }
      // custom：POST {baseUrl}/v1/scrape 或直接 GET conf.baseUrl?url=
      const base = (conf.baseUrl || '').replace(/\/$/, '')
      if (!base) return { ok: false, url, error: '自定义提取端点缺 baseUrl' }
      const r = await postJson(`${base}/v1/scrape`, { url }, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, 30_000)
      const md = r.json?.data?.markdown ?? r.json?.content ?? ''
      return { ok: !!md, url, content: String(md).slice(0, FETCH_MAX_CHARS), mode: 'custom' }
    }
    // local（默认）：本机直抓 HTML→零依赖正文提取
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MoonlyBox/1.0; +https://moonlybox.cn)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) {
      return { ok: false, url, error: `不支持的内容类型：${ct.split(';')[0] || '未知'}（仅网页/文本）` }
    }
    const html = await res.text()
    const { title, content } = extractHtmlText(html)
    if (!content) return { ok: false, url, error: '未能提取到正文' }
    return { ok: true, url, title, content: content.slice(0, FETCH_MAX_CHARS), mode: 'local' }
  } catch (e: any) {
    return { ok: false, url, error: `提取失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/* ============================== agent-loop 工具面 ============================== */

/** 小月内置网络工具定义（OpenAI tools 协议形态）——settings 未配置 provider 时 web_search 不装配（fetch_url 恒装配） */
export function webToolDefs(): Array<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }> {
  const defs: Array<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }> = []
  const ws = loadSettings().websearch ?? { provider: '', config: {} }
  if (ws.provider) {
    defs.push({
      name: 'web_search',
      title: '网络搜索',
      description: '联网搜索公开网页，返回标题/链接/摘要列表。用户问到时事、新知识、书房外信息时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'number', description: '可选，结果数（默认 8，最多 10）' },
        },
        required: ['query'],
      },
    })
  }
  defs.push({
    name: 'fetch_url',
    title: '读取网页',
    description: '抓取指定网页 URL 的正文内容（纯文本/Markdown）。与 web_search 搭配：先搜后读；用户给出链接时直接读取。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 http(s) 链接' } },
      required: ['url'],
    },
  })
  defs.push({
    name: 'download_file',
    title: '下载文件',
    description: '下载文件到主工作目录的 .download 子目录（不进书房收集箱）。适合课件/真题/压缩包/安装包等文件类链接（网页正文请用 fetch_url）。上限 100MB，超时不支持。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 http(s) 文件链接' },
        filename: { type: 'string', description: '可选，保存文件名（缺省从 URL 推导；同名自动加序号不覆盖）' },
      },
      required: ['url'],
    },
  })
  return defs
}

/** 执行内置网络工具（agent-loop localTools 同款签名）；未装配的工具名返回错误文本 */
export async function runWebTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'web_search') {
    const r = await webSearch(String(args.query ?? ''), Math.min(10, Math.max(1, Number(args.count ?? 8) || 8)))
    return JSON.stringify({ ok: r.ok, query: r.query, provider: r.provider, error: r.error, results: r.hits })
  }
  if (name === 'fetch_url') {
    const r = await fetchUrl(String(args.url ?? ''))
    return JSON.stringify({ ok: r.ok, url: r.url, title: r.title, mode: r.mode, error: r.error, content: r.content })
  }
  if (name === 'download_file') {
    const dest = String(args.__destDir ?? '')
    if (!dest) return JSON.stringify({ ok: false, error: '下载目录未提供（需工作空间对话）' })
    const url = String(args.url ?? '')
    const filename = typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : undefined
    const r = await downloadFile(url, dest, filename)
    return JSON.stringify(r.ok ? { ok: true, url: r.url, path: r.path, bytes: r.bytes } : { ok: false, url, error: r.error })
  }
  return JSON.stringify({ ok: false, error: `未知内置工具：${name}` })
}

/* ============================== download_file（#333） ============================== */

export interface DownloadResult {
  ok: boolean
  url?: string
  path?: string
  bytes?: number
  error?: string
}

const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024 // B1：100MB 上限
const DOWNLOAD_TIMEOUT_MS = 600_000          // B4：600 秒
const DOWNLOAD_MAX_REDIRECTS = 5

/** 同名不覆盖（B5）：name.ext → name-1.ext → name-2.ext… */
function dedupeFilename(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length) || 'file'
  let candidate = path.join(dir, name)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`)
    i++
    if (i > 999) throw new Error('同名文件过多（>999），请清理下载目录')
  }
  return candidate
}

/** 从 URL 推导文件名（basename；查询串剔除；空名兜底 download） */
function filenameFromUrl(u: string): string {
  try {
    const clean = u.split('?')[0].split('#')[0]
    const base = decodeURIComponent(clean.split('/').filter(Boolean).pop() ?? '')
    return (base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download').slice(0, 120)
  } catch {
    return 'download'
  }
}

/** 流式下载到 destDir（B3：目录不存在自动创建；100MB 硬顶；600s 超时；filename 可选自定义名） */
export async function downloadFile(url: string, destDir: string, filename?: string): Promise<DownloadResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http(s) 链接' }
  try {
    fs.mkdirSync(destDir, { recursive: true })
  } catch (e: any) {
    return { ok: false, error: `下载目录不可创建：${String(e?.message ?? e)}` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    let target = url
    let redirects = 0
    for (;;) {
      const res = await fetch(target, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoonlyBox/0.5' } })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { ok: false, error: `重定向无 Location（HTTP ${res.status}）` }
        if (++redirects > DOWNLOAD_MAX_REDIRECTS) return { ok: false, error: `重定向超过 ${DOWNLOAD_MAX_REDIRECTS} 次` }
        target = new URL(loc, target).toString()
        continue
      }
      if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` }
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > DOWNLOAD_MAX_BYTES) return { ok: false, url, error: `文件超过 100MB 上限（${Math.round(declared / 1024 / 1024)}MB）` }
      const finalName = (filename && filename.replace(/[\\/:*?"<>|]/g, '_').trim()) || filenameFromUrl(new URL(target).toString())
      const outPath = dedupeFilename(destDir, finalName)
      const tmpPath = outPath + '.part'
      const writer = fs.createWriteStream(tmpPath)
      let received = 0
      const reader = res.body?.getReader()
      if (!reader) return { ok: false, url, error: '响应无内容体' }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > DOWNLOAD_MAX_BYTES) {
          reader.cancel()
          writer.end()
          try { fs.unlinkSync(tmpPath) } catch { /* 清理失败忽略 */ }
          return { ok: false, url, error: '文件超过 100MB 上限（下载中止，临时文件已清理）' }
        }
        if (!writer.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => writer.once('drain', resolve))
        }
      }
      await new Promise<void>((resolve, reject) => { writer.end(() => resolve()); writer.on('error', reject) })
      fs.renameSync(tmpPath, outPath)
      return { ok: true, url: target, path: outPath, bytes: received }
    }
  } catch (e: any) {
    return { ok: false, url, error: e?.name === 'AbortError' ? '下载超时（600 秒）' : String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}
