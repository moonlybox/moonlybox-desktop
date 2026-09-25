/**
 * agent-loop E2E（mock 注入：不依赖真实 BYOK/生产 MCP）
 * 场景：①纯文本直答（无工具）②工具调用全链（listTools mock→confirm→callTool→回注→终答）
 *       ③写操作确认拒绝（confirm=false→跳过）④未知工具容错
 */
import { agentLoop } from '../src/lib/agent-loop'
import type { ChatMessage, ChatWithToolsResult, ToolCallRequest } from '../src/lib/llm'

const MOCK_TOOLS = [
  { name: 'search_library', title: '搜索书房', description: '搜索书房文档', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'add_sticky', title: '记便签', description: '新建便签', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { content: { type: 'string' } } } },
]

let mockToolsCallCount = 0
// mock listTools/callTool（bun test 模块 mock）
import { mock } from 'bun:test'
mock.module('../src/lib/moonlink', () => ({
  listTools: async () => {
    mockToolsCallCount++
    return MOCK_TOOLS
  },
  callTool: async (name: string, args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: `mock-${name}:${JSON.stringify(args)}` }],
  }),
}))

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

let scripted: ChatWithToolsResult[] = []
let chatCalls = 0
const mockChat = async (messages: ChatMessage[]): Promise<ChatWithToolsResult> => {
  chatCalls++
  return scripted.shift() ?? { ok: true, text: 'fallback' }
}

const baseDeps = (confirmResult: boolean) => ({
  system: 'test-system',
  question: 'test-question',
  ready: true,
  chat: mockChat as typeof import('../src/lib/llm').byokChatMessages,
  confirm: async () => confirmResult,
  say: () => {},
})

async function testDirectAnswer() {
  scripted = [{ ok: true, text: '直接回答' }]
  const r = await agentLoop(baseDeps(true))
  if (r.answer !== '直接回答' || r.toolCalls.length !== 0) throw new Error('场景1失败')
  if (mockToolsCallCount < 1) throw new Error('未消费 tools/list 单源')
  console.log('✓ 场景1：纯文本直答（无工具）')
}

async function testToolCallFlow() {
  chatCalls = 0
  scripted = [
    { ok: true, toolCalls: [toolCall('t1', 'search_library', { q: '输血' })] },
    { ok: true, text: '书房里有 2 篇输血相关文档' },
  ]
  const r = await agentLoop(baseDeps(true))
  if (!r.answer.includes('输血')) throw new Error('场景2 终答缺失')
  if (r.toolCalls.length !== 1 || !r.toolCalls[0].ok) throw new Error('场景2 工具调用记录错')
  if (chatCalls !== 2) throw new Error(`场景2 循环轮数错（${chatCalls}）`)
  console.log('✓ 场景2：只读工具自动执行+结果回注+终答')
}

async function testConfirmReject() {
  scripted = [
    { ok: true, toolCalls: [toolCall('t2', 'add_sticky', { content: '买牛奶' })] },
    { ok: true, text: '已按你的要求跳过' },
  ]
  const r = await agentLoop(baseDeps(false))
  if (r.toolCalls[0].ok !== false) throw new Error('场景3 拒绝未记录')
  console.log('✓ 场景3：写操作确认拒绝→跳过+回注取消信息')
}

async function testConfirmAccept() {
  scripted = [
    { ok: true, toolCalls: [toolCall('t3', 'add_sticky', { content: '买牛奶' })] },
    { ok: true, text: '便签已创建' },
  ]
  const r = await agentLoop(baseDeps(true))
  if (r.toolCalls[0].ok !== true) throw new Error('场景4 确认后未执行')
  console.log('✓ 场景4：写操作确认通过→callTool 执行')
}

async function testUnknownTool() {
  scripted = [
    { ok: true, toolCalls: [toolCall('t4', 'nonexistent_tool', {})] },
    { ok: true, text: '该工具不存在' },
  ]
  const r = await agentLoop(baseDeps(true))
  if (r.toolCalls[0].ok !== false) throw new Error('场景5 未知工具容错失败')
  console.log('✓ 场景5：未知工具容错（不崩，回注错误信息）')
}

await testDirectAnswer()
await testToolCallFlow()
await testConfirmReject()
await testConfirmAccept()
await testUnknownTool()
console.log('agent-loop E2E 5/5 通过')
