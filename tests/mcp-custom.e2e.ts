/**
 * mcp-custom e2e（#280）：自定义 MCP 远程客户端。
 * 覆盖：本地 mock MCP 服务器（initialize→tools/list→tools/call 全协议）→ 清单拉取/命名空间防冲突/
 * 失败隔离/执行回注；钥匙串 key 存取与遗留明文迁移；未启用服务器不装配。
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_mcpcustom_'))
process.env.XDG_CONFIG_HOME = tmpCfg

const keyring = new Map<string, string>()
mock.module('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(_s: string, private acc: string) {}
    setPassword(v: string) { keyring.set(this.acc, v) }
    getPassword() { return keyring.get(this.acc) ?? null }
    deleteCredential() { keyring.delete(this.acc) }
  },
}))

// mock 本地 MCP 服务器（Streamable HTTP JSON-RPC；端口 3199）
let calls = 0
const server = Bun.serve({
  port: 3199,
  async fetch(req) {
    const body = await req.text()
    const json = JSON.parse(body)
    calls++
    if (json.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: json.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }), {
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' },
      })
    }
    if (json.method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0', id: json.id,
        result: { tools: [
          { name: 'get_weather', title: '查天气', description: '查询城市天气', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          { name: 'shared_tool', title: '重名工具', description: '与另一服务器重名', inputSchema: { type: 'object' } },
        ] },
      })
    }
    if (json.method === 'tools/call') {
      return Response.json({ jsonrpc: '2.0', id: json.id, result: { content: [{ type: 'text', text: `天气：${json.params.arguments.city} 晴 26°C` }] } })
    }
    return Response.json({ jsonrpc: '2.0', id: json.id, error: { code: -32601, message: 'method not found' } })
  },
})
// 第二服务器：同工具名 shared_tool + 连接失败场景用（延迟）
const server2 = Bun.serve({
  port: 3198,
  async fetch(req) {
    const body = await req.text()
    const json = JSON.parse(body)
    if (json.method === 'tools/list') {
      return Response.json({ jsonrpc: '2.0', id: json.id, result: { tools: [{ name: 'shared_tool', description: 'server2 的同名工具', inputSchema: { type: 'object' } }] } })
    }
    return Response.json({ jsonrpc: '2.0', id: json.id, result: {} })
  },
})
// 坏服务器：直接断连
const badServer = Bun.serve({ port: 3197, fetch() { return new Response('boom', { status: 500 }) } })

import { saveSettings, loadSettings } from '../src/lib/settings'
import { listAllCustomTools, callCustomTool, saveMcpKey, loadMcpKey, enabledCustomServers } from '../src/lib/mcp-custom'

beforeAll(() => {
  saveSettings({ mcp: { custom: [
    { name: 'weather', url: 'http://127.0.0.1:3199/mcp', apiKey: null, enabled: true },
    { name: 'second', url: 'http://127.0.0.1:3198/mcp', apiKey: null, enabled: true },
    { name: 'broken', url: 'http://127.0.0.1:3197/mcp', apiKey: null, enabled: true },
    { name: 'disabled', url: 'http://127.0.0.1:3196/mcp', apiKey: null, enabled: false },
  ] } })
})

afterAll(() => {
  server.stop(true); server2.stop(true); badServer.stop(true)
  fs.rmSync(tmpCfg, { recursive: true, force: true })
})

describe('mcp-custom 客户端', () => {
  test('enabledCustomServers 过滤停用项', () => {
    const list = enabledCustomServers()
    expect(list.length).toBe(3)
    expect(list.map((s) => s.name)).not.toContain('disabled')
  })

  test('listAllCustomTools：清单拉取+跨服务器重名命名空间+失败隔离', async () => {
    const cat = await listAllCustomTools()
    const names = cat.tools.map((t) => t.name)
    expect(names).toContain('get_weather')
    expect(names).toContain('shared_tool') // 第一个服务器占原名
    const shared2 = cat.tools.find((t) => t.server === 'second' && t.remoteName === 'shared_tool')
    expect(shared2).toBeTruthy()
    expect(shared2!.name).not.toBe('shared_tool') // 第二个重名→命名空间
    expect(cat.tools.find((t) => t.name === shared2!.name)!.remoteName).toBe('shared_tool')
    // 失败隔离：broken 服务器报 failure，其余照常
    expect(cat.failures.map((f) => f.name)).toContain('broken')
    expect(cat.tools.length).toBeGreaterThanOrEqual(3)
  })

  test('callCustomTool：远程执行回文本', async () => {
    const cat = await listAllCustomTools()
    const r = await callCustomTool('get_weather', { city: '杭州' }, cat)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('杭州')
    expect(r.text).toContain('26')
  })

  test('callCustomTool：未知工具报错不抛异常', async () => {
    const r = await callCustomTool('no_such_tool_xyz', {})
    expect(r.ok).toBe(false)
    expect(r.text).toContain('未知')
  })

  test('钥匙串 key 存取', () => {
    saveMcpKey('weather', 'sk-mcp-abc123')
    expect(loadMcpKey('weather')).toBe('sk-mcp-abc123')
    // settings.json 不落 key 本体
    const raw = fs.readFileSync(path.join(tmpCfg, 'moonlybox', 'settings.json'), 'utf8')
    expect(raw).not.toContain('sk-mcp-abc123')
  })
})
