/**
 * MoonLink 远程 MCP 客户端（WBS 任务 4）：CLI 不 fork tools.ts（§5.13 单源纪律），
 * 工具定义与执行都在云端 —— 本模块只做 Streamable HTTP JSON-RPC 传输层：
 *   initialize → tools/list（单源清单消费）→ tools/call（远程执行）。
 * 认证：Bearer <OAuth access token>（device flow 取得，AuthenticateToken 已支持）。
 */
import { loadCredentials, saveCredentials } from './auth'
import { defaultBaseUrl } from './config'

const PROTOCOL_VERSION = '2025-03-26'
let sessionId: string | null = null
let nextId = 1

async function rpc<T = any>(method: string, params?: unknown, opts?: { baseUrl?: string }): Promise<T> {
  const creds = loadCredentials()
  if (!creds?.accessToken) {
    throw new Error('未登录：先运行 `moonlybox login`')
  }
  const base = opts?.baseUrl ?? defaultBaseUrl()
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${creds.accessToken}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  // 会话失效（重启后 session 丢）→ 重新 initialize 一次再重放
  if (res.status === 404 && sessionId && method !== 'initialize') {
    sessionId = null
    await initialize(opts)
    return rpc(method, params, opts)
  }
  const sid = res.headers.get('Mcp-Session-Id')
  if (sid) sessionId = sid
  const json = (await res.json()) as any
  if (json.error) {
    throw new Error(`MCP ${method} 失败 (${json.error.code}): ${json.error.message}`)
  }
  return json.result as T
}

export async function initialize(opts?: { baseUrl?: string }): Promise<void> {
  await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'moonlybox-cli', version: '0.1.0' },
  }, opts)
  // Streamable HTTP 初始化完成通知（协议要求）
  const creds = loadCredentials()
  const base = opts?.baseUrl ?? defaultBaseUrl()
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds?.accessToken ?? ''}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {})
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  inputSchema: unknown
}

/** tools/list：消费服务端 tools.ts 单源（29 工具），本地零复制 */
export async function listTools(opts?: { baseUrl?: string }): Promise<McpTool[]> {
  await initialize(opts)
  const result = await rpc<{ tools: McpTool[] }>('tools/list', {}, opts)
  return result.tools ?? []
}

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>
}

/** tools/call：远程执行（配额/权限校验全在服务端 Laravel 层） */
export async function callTool(name: string, args: Record<string, unknown>, opts?: { baseUrl?: string }): Promise<ToolCallResult> {
  await initialize(opts)
  return rpc<ToolCallResult>('tools/call', { name, arguments: args }, opts)
}

/** E2E/测试用：注入 token（避免依赖 login 状态） */
export function setTestToken(token: string, clientId: string): void {
  saveCredentials({ ...(loadCredentials() ?? { clientId }), accessToken: token })
}
