/**
 * memory-local e2e（#278）：「内置书房记忆库（本机）」档——本地文件记忆层。
 * 覆盖：add 去重/画像分流、search 关键词命中、context 注入截断护栏、stats 统计、
 * agent-loop localTools 劫持（builtin 不经远程）/excludeTools（记忆关=工具不装配）。
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { localMemoryAdd, localMemorySearch, localMemoryContext, localMemoryStats } from '../src/lib/memory-local'
import { agentLoop } from '../src/lib/agent-loop'
import type { ChatMessage, ChatWithToolsResult } from '../src/lib/llm'

// mock listTools/callTool（同 agent-loop.e2e 范式；工具列表含记忆工具以验证剔除）
mock.module('../src/lib/moonlink', () => ({
  listTools: async () => [
    { name: 'search_library', title: '搜索书房', description: '搜索书房文档', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'add_memory', title: '静默记忆', description: '静默记忆', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'search_memory', title: '检索记忆', description: '检索记忆', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ],
  callTool: async (name: string, args: Record<string, unknown>) => ({ ok: true, content: `mock:${name}:${JSON.stringify(args)}` }),
}))

let vault: string

beforeAll(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_memlocal_'))
})

afterAll(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('memory-local 本地文件记忆层', () => {
  test('add 落盘 MEMORY.md；第二遍同文本去重', () => {
    const r1 = localMemoryAdd(vault, '用户的主力开发机是 Windows 桌面')
    expect(r1.ok).toBe(true)
    expect(r1.duplicated).toBe(false)
    const memFile = path.join(vault, '.moonlybox', 'memory', 'MEMORY.md')
    expect(fs.existsSync(memFile)).toBe(true)
    expect(fs.readFileSync(memFile, 'utf8')).toContain('主力开发机')
    const r2 = localMemoryAdd(vault, '用户的主力开发机是 Windows 桌面')
    expect(r2.ok).toBe(true)
    expect(r2.duplicated).toBe(true)
  })

  test('画像行分流 USER.md（我开头的稳定陈述）', () => {
    const r = localMemoryAdd(vault, '我在杭州做独立产品')
    expect(r.ok).toBe(true)
    expect(r.profile).toBe(true)
    const userFile = path.join(vault, '.moonlybox', 'memory', 'USER.md')
    expect(fs.readFileSync(userFile, 'utf8')).toContain('在杭州做独立产品')
  })

  test('search 关键词命中 MEMORY+USER 两层', () => {
    const hits = localMemorySearch(vault, '开发机')
    expect(hits.length).toBe(1)
    expect(hits[0]!.source).toBe('memory')
    const hits2 = localMemorySearch(vault, '杭州')
    expect(hits2.length).toBe(1)
    expect(hits2[0]!.source).toBe('profile')
    expect(localMemorySearch(vault, '不存在的词xyzq').length).toBe(0)
  })

  test('context 注入含两层+截断护栏（默认 5000，#281 参数化）', () => {
    for (let i = 0; i < 300; i++) localMemoryAdd(vault, `填充记忆条目第${i}条内容足够长一些以撑爆上限${'x'.repeat(40)}`)
    const ctx = localMemoryContext(vault)
    expect(ctx).toContain('用户画像')
    expect(ctx).toContain('长期记忆')
    expect(ctx.length).toBeLessThanOrEqual(5100)
    expect(ctx).toContain('已截断')
    // #281：注入上限可配（2000 上限→更短；低于 500 钳到 500）
    const ctx2 = localMemoryContext(vault, 2000)
    expect(ctx2.length).toBeLessThanOrEqual(2100)
    expect(ctx2.length).toBeLessThan(ctx.length)
    expect(localMemoryContext(vault, 100).length).toBeLessThanOrEqual(600)
    // 不传参=默认 5000
    expect(localMemoryContext(vault, undefined as any).length).toBeLessThanOrEqual(5100)
  })

  test('stats 统计条目数', () => {
    const s = localMemoryStats(vault)
    expect(s.memoryEntries).toBeGreaterThan(300)
    expect(s.profileEntries).toBe(1)
  })
})

describe('agent-loop 记忆开关接线', () => {
  let scripted: ChatWithToolsResult[] = []
  const mockChat = async (_messages: ChatMessage[]): Promise<ChatWithToolsResult> => {
    return scripted.shift() ?? { ok: true, text: 'fallback' }
  }
  const baseDeps = {
    question: 'q',
    ready: true,
    chat: mockChat as typeof import('../src/lib/llm').byokChatMessages,
    confirm: async () => true,
    say: () => {},
  }

  test('excludeTools：记忆关=工具列表剔除 add_memory/search_memory', async () => {
    let seen: string[] = []
    scripted = [{
      ok: true,
      text: 'done',
      toolCalls: undefined,
    }]
    const deps = {
      ...baseDeps,
      chat: (async (messages: ChatMessage[], tools?: unknown[]) => {
        seen = ((tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)
        return scripted.shift() ?? { ok: true, text: 'fallback' }
      }) as typeof import('../src/lib/llm').byokChatMessages,
    }
    await agentLoop({ ...deps, system: 's', excludeTools: ['add_memory', 'search_memory'] })
    expect(seen).toContain('search_library')
    expect(seen).not.toContain('add_memory')
    expect(seen).not.toContain('search_memory')
  })

  test('localTools：builtin 档 add_memory 本地劫持不经远程', async () => {
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_memlocal2_'))
    const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })
    scripted = [
      { ok: true, text: '', toolCalls: [toolCall('t1', 'add_memory', { text: '测试本地劫持的记忆' })] },
      { ok: true, text: 'ok' },
    ]
    const res = await agentLoop({
      ...baseDeps,
      system: 's',
      localTools: {
        add_memory: async (args) => {
          const r = localMemoryAdd(tmpVault, String(args.text ?? ''))
          return JSON.stringify({ ok: r.ok, layer: 'local' })
        },
      },
    })
    expect(res.answer).toBe('ok')
    expect(res.toolCalls).toEqual([{ name: 'add_memory', ok: true }])
    const memFile = path.join(tmpVault, '.moonlybox', 'memory', 'MEMORY.md')
    expect(fs.readFileSync(memFile, 'utf8')).toContain('测试本地劫持的记忆')
    fs.rmSync(tmpVault, { recursive: true, force: true })
  })
})
