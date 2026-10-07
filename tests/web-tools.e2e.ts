/**
 * web-tools e2e（#279）：网络搜索+URL 提取内置工具。
 * 覆盖：工具定义形态（未配 provider 只有 fetch_url/配了有 web_search）、本地 HTML 正文提取、
 * fetchUrl local 模式（mock fetch）、webSearch 未配置/缺 key 报错、daemon settings save key 剥离入钥匙串。
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// XDG 隔离（settings/providers-cache 全落临时目录）
const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_webtools_'))
process.env.XDG_CONFIG_HOME = tmpCfg

// 钥匙串 mock（Linux 无 Secret Service；key 断言走内存 Map）
const keyring = new Map<string, string>()
mock.module('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(_s: string, private acc: string) {}
    setPassword(v: string) { keyring.set(this.acc, v) }
    getPassword() { return keyring.get(this.acc) ?? null }
    deleteCredential() { keyring.delete(this.acc) }
  },
}))

// mock fetch（本地提取链路：返回固定 HTML；搜索端点不会被未配置场景触达）
const originalFetch = globalThis.fetch
mock.module('node:https', () => ({}))
;(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input)
  if (url.includes('example.com/doc')) {
    return new Response('<html><head><title>测试页面标题</title></head><body><script>var x=1;</script><h1>正文第一段</h1><p>正文第二段内容，包含关键词<b>加粗</b>。</p><style>.hide{}</style></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

import { extractHtmlText, fetchUrl, webSearch, webToolDefs, runWebTool, saveProviderKey, loadProviderKey } from '../src/lib/web-tools'
import { saveSettings, loadSettings } from '../src/lib/settings'

afterAll(() => {
  ;(globalThis as any).fetch = originalFetch
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

describe('web-tools 工具面', () => {
  test('#334 未配置服务商：web_search（内置源）+fetch_url+download_file 恒装配', () => {
    const defs = webToolDefs()
    expect(defs.map((d) => d.name)).toEqual(['web_search', 'fetch_url', 'download_file'])
  })

  test('配置 provider 后 web_search+fetch_url+download_file 都装配（#333）', () => {
    saveSettings({ websearch: { provider: 'bocha', config: {} } })
    const defs = webToolDefs()
    expect(defs.map((d) => d.name)).toEqual(['web_search', 'fetch_url', 'download_file'])
    expect(defs[0]!.inputSchema).toBeTruthy()
  })

  test('#334 bingcn：未配置时 webSearch 回落内置必应源（mock RSS 解析）', async () => {
    saveSettings({ websearch: { provider: '', config: {} } })
    const rss = `<?xml version="1.0"?><rss><channel>` +
      `<item><title>考研政治大纲 2026 变化解读</title><link>https://example.com/a</link><description><![CDATA[2026 考研政治大纲变化要点摘要]]></description></item>` +
      `<item><title>无效项无链接</title><description>缺 link 应被过滤</description></item>` +
      `</channel></rss>`
    const savedFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = async () => new Response(rss, { status: 200 })
    const out = JSON.parse(await runWebTool('web_search', { query: '考研政治 2026' }))
    ;(globalThis as any).fetch = savedFetch
    expect(out.ok).toBe(true)
    expect(out.provider).toContain('必应')
    expect(out.results.length).toBe(1)
    expect(out.results[0].url).toBe('https://example.com/a')
    expect(out.results[0].title).toContain('2026')
  })

  test('runWebTool：需 key 的服务商缺 key 优雅报错（不抛异常）', async () => {
    saveSettings({ websearch: { provider: 'bocha', config: {} } })
    const out = JSON.parse(await runWebTool('web_search', { query: '测试' }))
    saveSettings({ websearch: { provider: '', config: {} } })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('Key')
  })

  test('runWebTool：fetch_url local 模式提取正文（mock fetch）', async () => {
    const out = JSON.parse(await runWebTool('fetch_url', { url: 'https://example.com/doc' }))
    expect(out.ok).toBe(true)
    expect(out.title).toBe('测试页面标题')
    expect(out.content).toContain('正文第一段')
    expect(out.content).toContain('正文第二段内容')
    expect(out.content).toContain('加粗')
    expect(out.content).not.toContain('var x=1')
    expect(out.mode).toBe('local')
  })

  test('fetchUrl 拒绝非 http(s)', async () => {
    const r = await fetchUrl('ftp://example.com/x')
    expect(r.ok).toBe(false)
  })
})

describe('web-tools 本地提取', () => {
  test('extractHtmlText：去 script/style、实体解码、块级换行', () => {
    const { title, content } = extractHtmlText('<title>T&amp;T</title><div><p>A&amp;B</p><script>bad()</script><p>C</p></div>')
    expect(title).toBe('T&T')
    expect(content).toContain('A&B')
    expect(content).toContain('C')
    expect(content).not.toContain('bad()')
  })
})

describe('settings save key 剥离（daemon 逻辑同构验证）', () => {
  test('saveProviderKey 入钥匙串、loadProviderKey 读回、settings 节不带 key', () => {
    saveProviderKey('websearch', 'sk-test-123456')
    expect(loadProviderKey('websearch')).toBe('sk-test-123456')
    const s = loadSettings()
    expect(JSON.stringify(s.websearch)).not.toContain('sk-test')
  })
})

describe('agent-loop builtinTools 装配', () => {
  test('内置工具与远程并列、重名内置优先剔除远程', async () => {
    const { agentLoop } = await import('../src/lib/agent-loop')
    let seen: string[] = []
    const chat = (async (_messages: unknown[], tools?: unknown[]) => {
      seen = ((tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)
      return { ok: true, text: 'done' }
    }) as any
    // mock moonlink listTools 返回含同名 add_memory + 远程独有 search_library
    mock.module('../src/lib/moonlink', () => ({
      listTools: async () => [
        { name: 'search_library', title: '搜索书房', description: 'x', inputSchema: { type: 'object' } },
        { name: 'fetch_url', title: '远程同名的', description: '远程版本', inputSchema: { type: 'object' } },
      ],
      callTool: async () => ({ ok: true, content: [] }),
    }))
    const { webToolDefs } = await import('../src/lib/web-tools')
    await agentLoop({ system: 's', question: 'q', ready: true, chat, confirm: async () => true, say: () => {}, builtinTools: webToolDefs() as any, localTools: { fetch_url: async () => '{}' } })
    expect(seen).toContain('search_library')
    expect(seen).toContain('fetch_url')
    expect(seen.filter((n) => n === 'fetch_url').length).toBe(1) // 内置优先、远程同名剔除
  })
})
