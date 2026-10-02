/**
 * 自定义 MCP 远程客户端（#280，盘点缺口 F）：streamable HTTP 连用户自配 MCP 服务器，
 * 工具与 MoonLink（内置 29 工具）并列装配进小月 Agent。
 * 设计：
 *  - 每服务器独立 JSON-RPC 会话（Mcp-Session-Id），initialize → notifications/initialized → tools/list / tools/call
 *  - 鉴权：apiKey 走钥匙串（service=moonlybox/account=`mcp:<name>`），settings.json 只落 hasKey 布尔（keyStored）；无 key 服务器裸连
 *  - 命名空间：跨服务器工具名冲突时自动改 `mcp<序>__<toolName>`（LLM 工具名必须唯一），映射表随清单返回
 *  - 失败隔离：单服务器连接失败只剔除该服务器并在结果里报原因，不拖垮其他服务器与小月主循环
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'
import { loadSettings } from './settings'

const PROTOCOL_VERSION = '2025-03-26'
const KEYCHAIN_SERVICE = 'moonlybox'

export interface CustomServerCfg {
  name: string
  url: string
  enabled: boolean
  /** 遗留字段（≤#279）：settings.json 曾明文存 key——读到时迁移入钥匙串并置 null */
  apiKey?: string | null
  /** #280：key 已入钥匙串标记（settings.json 只存布尔不存 key） */
  keyStored?: boolean
}

export function mcpKeychainAccount(serverName: string): string {
  return `mcp:${serverName}`
}

export function saveMcpKey(serverName: string, apiKey: string): void {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  new Entry(KEYCHAIN_SERVICE, mcpKeychainAccount(serverName)).setPassword(apiKey)
}

export function loadMcpKey(serverName: string): string | null {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    return new Entry(KEYCHAIN_SERVICE, mcpKeychainAccount(serverName)).getPassword() || null
  } catch {
    return null
  }
}

export function clearMcpKey(serverName: string): void {
  try {
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
    new Entry(KEYCHAIN_SERVICE, mcpKeychainAccount(serverName)).deleteCredential()
  } catch {
    /* 无条目 */
  }
}

/** 迁移遗留明文 key：settings.json 里的 apiKey 字符串→钥匙串，返回清理后的配置副本（不落盘） */
function migrateLegacyKey(srv: CustomServerCfg): CustomServerCfg {
  if (typeof srv.apiKey === 'string' && srv.apiKey) {
    try { saveMcpKey(srv.name, srv.apiKey) } catch { /* 钥匙串不可用则保持原样 */ }
    return { ...srv, apiKey: null, keyStored: true }
  }
  return srv
}

/** 已启用的自定义服务器清单（读 settings；遗留明文 key 就地迁移） */
export function enabledCustomServers(): CustomServerCfg[] {
  const list = (loadSettings().mcp?.custom ?? []) as CustomServerCfg[]
  return list.filter((s) => s && s.enabled !== false && s.url && /^https?:\/\//i.test(s.url)).map(migrateLegacyKey)
}

/* ============================== 传输层 ============================== */

interface ServerSession {
  sessionId: string | null
  nextId: number
}

const sessions = new Map<string, ServerSession>()

function sessionOf(name: string): ServerSession {
  let s = sessions.get(name)
  if (!s) { s = { sessionId: null, nextId: 1 }; sessions.set(name, s) }
  return s
}

async function rpcRaw(srv: CustomServerCfg, method: string, params?: unknown, timeoutMs = 20_000): Promise<{ status: number; json: any }> {
  const sess = sessionOf(srv.name)
  const key = loadMcpKey(srv.name)
  const res = await fetch(srv.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(sess.sessionId ? { 'Mcp-Session-Id': sess.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: sess.nextId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const sid = res.headers.get('Mcp-Session-Id')
  if (sid) sess.sessionId = sid
  // SSE 流（text/event-stream）里取 data: 行的 JSON
  const raw = await res.text()
  let json: any = null
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        try { json = JSON.parse(line.slice(5).trim()); break } catch { /* 继续 */ }
      }
    }
  } else {
    try { json = JSON.parse(raw) } catch { /* 非 JSON */ }
  }
  return { status: res.status, json }
}

async function rpc<T = any>(srv: CustomServerCfg, method: string, params?: unknown, timeoutMs = 20_000): Promise<T> {
  let { status, json } = await rpcRaw(srv, method, params, timeoutMs)
  // 会话失效 → 重新 initialize 重放一次
  if ((status === 404 || status === 400) && method !== 'initialize' && !json?.result) {
    sessions.delete(srv.name)
    await initializeServer(srv)
    ;({ json } = await rpcRaw(srv, method, params, timeoutMs))
  }
  if (json?.error) {
    throw new Error(`MCP ${method} 失败 (${json.error.code}): ${json.error.message}`)
  }
  if (status >= 400 || !json) {
    throw new Error(`MCP ${method} 失败：HTTP ${status}${json ? '（响应格式异常）' : '（非 JSON 响应）'}`)
  }
  return json.result as T
}

export async function initializeServer(srv: CustomServerCfg): Promise<void> {
  await rpc(srv, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'moonlybox-cli', version: '0.6.0' },
  })
  // Streamable HTTP 初始化完成通知（协议要求；失败不阻塞）
  const key = loadMcpKey(srv.name)
  await fetch(srv.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(sessionOf(srv.name).sessionId ? { 'Mcp-Session-Id': sessionOf(srv.name).sessionId! } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {})
}

/* ============================== 工具面 ============================== */

export interface McpCustomTool {
  /** 装配给 LLM 的唯一工具名（冲突时 mcpN__tool） */
  name: string
  title?: string
  description?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  inputSchema: unknown
  /** 实际远程服务器名与原始工具名 */
  server: string
  remoteName: string
}

export interface McpCustomCatalog {
  tools: McpCustomTool[]
  /** 连接失败的服务器与原因（装配时报告、不静默） */
  failures: Array<{ name: string; error: string }>
}

/**
 * 拉全部已启用自定义服务器的工具清单（并行化——单服务器失败不拖垮整体）。
 * #280.1：结果缓存 60s TTL——Agent 每轮装配都调本函数，远程 tools/list 不重复打（服务器改动经 resetServerSession+缓存自然过期）。
 */
let catalogCache: { at: number; cat: McpCustomCatalog } | null = null
const CATALOG_TTL_MS = 60_000

export function resetCatalogCache(): void {
  catalogCache = null
}

export async function listAllCustomTools(timeoutMs = 12_000): Promise<McpCustomCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.cat
  const servers = enabledCustomServers()
  const tools: McpCustomTool[] = []
  const failures: Array<{ name: string; error: string }> = []
  const seenNames = new Set<string>()
  const results = await Promise.allSettled(
    servers.map(async (srv) => {
      try {
        await Promise.race([
          initializeServer(srv),
          new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), timeoutMs)),
        ])
        const result = await rpc<{ tools?: Array<any> }>(srv, 'tools/list', {})
        return { srv, tools: result?.tools ?? [] }
      } catch (e: any) {
        sessions.delete(srv.name)
        throw Object.assign(new Error(String(e?.message ?? e).slice(0, 160)), { serverName: srv.name })
      }
    }),
  )
  for (const r of results) {
    if (r.status === 'rejected') {
      const reason = r.reason as any
      failures.push({ name: reason?.serverName ?? '未知服务器', error: String(reason?.message ?? reason).slice(0, 160) })
      continue
    }
    const { srv, tools: list } = r.value
    for (const t of list) {
      let name = String(t.name ?? '')
      if (!name) continue
      if (seenNames.has(name)) name = `mcp${tools.length}__${t.name}`
      seenNames.add(name)
      tools.push({
        name,
        title: t.title,
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        server: srv.name,
        remoteName: t.name,
      })
    }
  }
  const cat = { tools, failures }
  catalogCache = { at: Date.now(), cat }
  return cat
}

/** 远程执行自定义服务器工具（按装配名反查 server+remoteName） */
export async function callCustomTool(name: string, args: Record<string, unknown>, catalog?: McpCustomCatalog): Promise<{ ok: boolean; text: string }> {
  const cat = catalog ?? (await listAllCustomTools())
  const tool = cat.tools.find((t) => t.name === name)
  if (!tool) return { ok: false, text: `未知自定义 MCP 工具：${name}` }
  const srv = enabledCustomServers().find((s) => s.name === tool.server)
  if (!srv) return { ok: false, text: `自定义 MCP 服务器已停用：${tool.server}` }
  try {
    const result = await rpc<any>(srv, 'tools/call', { name: tool.remoteName, arguments: args }, 60_000)
    const content = Array.isArray(result?.content) ? result.content.map((c: any) => c?.text ?? '').filter(Boolean).join('\n') : JSON.stringify(result ?? {})
    return { ok: !result?.isError, text: content || '（空结果）' }
  } catch (e: any) {
    return { ok: false, text: `自定义 MCP 执行失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** 提供商缓存路径（与 web-tools 无关，供 daemon 测试探测） */
export function providersCachePath(): string {
  return path.join(configDir(), 'providers-cache.json')
}

/** 清指定服务器会话（设置改动后失效旧会话） */
export function resetServerSession(serverName: string): void {
  sessions.delete(serverName)
  void fs
}

// ==================== #317.P2：自定义 MCP 工具描述质量门 ====================

/** 去 stopword 后的词集（相似度/零信息判定用） */
function _descTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]/g) ?? []))
}

/**
 * 劣质 description 检测+语义兜底（#317.P2，零 LLM）：
 * - 空 / 与 name 词集完全重合（零信息）/ 超长（>1500 字符）→ 视为劣质
 * - 兜底=拼装可用信号：`title（服务器：X）参数：a, b, c——原描述截段`；无任何信号→title/name 原样
 * - 超长截 head 1200（保 schema 预算）
 * 只在装配层调用（openaiTools 生成前）——原始 description 保留在 McpCustomTool 不动。
 */
export function ensureToolDescription(tool: {
  name: string
  title?: string
  description?: string
  server: string
  inputSchema: unknown
}): string {
  const raw = (tool.description ?? '').trim()
  const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…(截断)' : s)
  // 参数名提取（顶层 properties 键——比 description 更能暴露用途的信号）
  let params: string[] = []
  try {
    const sch = typeof tool.inputSchema === 'object' && tool.inputSchema !== null ? (tool.inputSchema as Record<string, any>) : {}
    params = Object.keys(sch.properties ?? {}).slice(0, 8)
  } catch { /* schema 非 object——忽略 */ }
  const fallback = (() => {
    const parts: string[] = []
    if (tool.title && tool.title !== tool.name) parts.push(tool.title)
    if (tool.server) parts.push(`（服务器：${tool.server}）`)
    if (params.length) parts.push(`参数：${params.join(', ')}`)
    return parts.join(' ') || tool.name
  })()
  // ①空/缺 → 兜底
  if (!raw) return head(fallback, 300)
  // ②超长 → 截断（描述本身有效，只是长）
  if (raw.length > 1500) return head(raw, 1200)
  // ③零信息（与 name 词集完全重合，且自身 <8 词）→ 兜底+原名
  const nameT = _descTokens(tool.name)
  const rawT = _descTokens(raw)
  if (rawT.size > 0 && rawT.size < 8 && [...rawT].every((w) => nameT.has(w))) {
    return head(`${raw}——${fallback}`, 300)
  }
  return raw
}
