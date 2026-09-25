import { listTools, callTool, McpTool } from './moonlink'

/**
 * 小月 Agent 循环（D9 装配）：LLM + moonlink MCP 工具。
 * 纪律：
 *  - 工具单源=远程 moonlink（29 工具 tools/list 消费，本地零复制，原则⑤同轨配额）
 *  - 写操作确认制：destructiveHint 或非 readOnly 的工具执行前需用户 Y 确认（read/list/search 自动过）
 *  - 循环上限 6 轮（防失控）；每轮工具调用打活动流（⚙ 前缀）
 */

const MAX_TOOL_ROUNDS = 6
const CONFIRM_Y = new Set(['y', 'Y', 'yes', 'Yes', '是', '好'])

function needsConfirm(tool: McpTool): boolean {
  const ann = tool.annotations
  if (ann?.readOnlyHint === true && ann?.destructiveHint !== true) return false
  return true // 无注解或含写操作 → 确认
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n').trim() || '(工具无输出)'
}

export interface AgentLoopDeps {
  system: string
  question: string
  /** 就绪态（BYOK 已配置） */
  ready: boolean
  /** 单轮 LLM 调用（byokChatMessages 的包装，测试可注入） */
  chat: typeof import('../lib/llm').byokChatMessages
  /** 用户确认回调（CLI=stdin；测试可注入） */
  confirm: (toolName: string, argsJson: string) => Promise<boolean>
  /** 活动流输出 */
  say: (line: string) => void
}

export interface AgentLoopResult {
  answer: string
  toolCalls: Array<{ name: string; ok: boolean }>
}

/** Agent 主循环：chat → (tool_calls? → confirm → callTool → 回注 → chat)* → 最终回答 */
export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const { system, question, ready, chat, confirm, say } = deps
  if (!ready) throw new Error('BYOK 未配置')

  const tools = await listTools()
  const openaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description ?? t.title ?? t.name, parameters: t.inputSchema },
  }))
  say(`（已接入 MoonLink 工具 ${tools.length} 个）`)

  const messages: import('../lib/llm').ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ]
  const used: Array<{ name: string; ok: boolean }> = []

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await chat(messages, openaiTools)
    if (!res.ok) throw new Error(res.error ?? 'LLM 调用失败')

    if (!res.toolCalls || res.toolCalls.length === 0) {
      return { answer: res.text ?? '', toolCalls: used }
    }

    // assistant(tool_calls) 必须原样回注
    messages.push({ role: 'assistant', content: res.text ?? null, tool_calls: res.toolCalls })

    for (const tc of res.toolCalls) {
      const meta = tools.find((t) => t.name === tc.function.name)
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* 空/坏参按空对象 */ }
      const argsJson = JSON.stringify(args)

      if (!meta) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `未知工具：${tc.function.name}` })
        used.push({ name: tc.function.name, ok: false })
        continue
      }

      say(`⚙ ${meta.title ?? meta.name} ${argsJson.slice(0, 120)}`)
      if (needsConfirm(meta)) {
        say(`  （写操作，确认执行？y/N）`)
        const ok = await confirm(meta.name, argsJson)
        if (!ok) {
          say(`  ✗ 已跳过（用户取消）`)
          messages.push({ role: 'tool', tool_call_id: tc.id, content: '用户取消了该操作' })
          used.push({ name: meta.name, ok: false })
          continue
        }
      }

      try {
        const result = await callTool(meta.name, args)
        const text = toolResultText(result)
        say(`  → ${text.slice(0, 160)}`)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: text })
        used.push({ name: meta.name, ok: true })
      } catch (e) {
        const err = String((e as Error).message ?? e)
        say(`  → 失败：${err.slice(0, 120)}`)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `工具执行失败：${err}` })
        used.push({ name: meta.name, ok: false })
      }
    }
  }
  return { answer: '（工具调用轮次达到上限，以上是已执行的结果）', toolCalls: used }
}
