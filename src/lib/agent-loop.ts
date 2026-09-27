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
  /** #278 记忆开关：不装配的工具名（如 add_memory/search_memory） */
  excludeTools?: string[]
  /** #278 本地工具覆写：同名工具优先本地执行（如 builtin 记忆=本地文件层，不出域） */
  localTools?: Record<string, (args: Record<string, unknown>) => Promise<string>>
  /** #279 内置工具定义（web_search/fetch_url 等，与 MoonLink 远程工具并列装配；执行走 localTools 同名键） */
  builtinTools?: Array<{ name: string; title?: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema: unknown }>
}

export interface AgentLoopResult {
  answer: string
  toolCalls: Array<{ name: string; ok: boolean }>
}

/**
 * #280.2 JSON Schema LLM 兼容清洗（递归）：
 * - anyOf/oneOf/allOf：拍平为分支合并（属性并集；type 取各分支 type 的并集字符串/数组）
 * - 剥离非标/供应商不识别关键字：$schema/$id/outputs/outputSchema/x-* 前缀、format 保留（主流支持）
 * - 未知类型字段落回落 object
 */
export function sanitizeJsonSchema(node: unknown, depth = 0): Record<string, unknown> {
  const MAX_DEPTH = 8
  if (depth > MAX_DEPTH || typeof node !== 'object' || node === null) return { type: 'object', properties: {} }
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // description/enum/default 直接透传
  if (typeof src.description === 'string') out.description = src.description
  if (src.enum) out.enum = src.enum
  if (src.default !== undefined) out.default = src.default
  // 组合关键字拍平：合并各分支属性与 required
  const combo = (src.anyOf ?? src.oneOf ?? src.allOf) as Array<Record<string, unknown>> | undefined
  if (Array.isArray(combo)) {
    const merged: Record<string, unknown> = {}
    const req = new Set<string>()
    const types = new Set<string>()
    for (const branch of combo) {
      const b = sanitizeJsonSchema(branch, depth + 1)
      if (typeof b.type === 'string') types.add(b.type)
      if (b.items !== undefined && !merged.items) merged.items = b.items
      if (b.properties && typeof b.properties === 'object') Object.assign(merged, b.properties)
      if (Array.isArray(b.required)) b.required.forEach((k) => req.add(String(k)))
    }
    if (merged.properties !== undefined) out.properties = merged.properties
    if (req.size) out.required = [...req]
    // 多类型分支：优先第一分支类型（保语义顺序）；但 array 分支在前且有更简类型时选简类型（LLM 传单值远稳于数组）
    const branchTypes = combo.map((b) => (typeof (b as any).type === 'string' ? (b as any).type : '')).filter(Boolean)
    let picked = branchTypes[0] ?? 'string'
    if (picked === 'array' && branchTypes.includes('string')) picked = 'string'
    out.type = picked
    if (picked === 'array' && merged.items !== undefined) out.items = merged.items
    return out
  }
  // type 缺省回落 object
  out.type = typeof src.type === 'string' ? src.type : Array.isArray(src.type) ? src.type[0] : 'object'
  if (out.type === 'object' && src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) {
      props[k] = sanitizeJsonSchema(v, depth + 1)
    }
    out.properties = props
    if (Array.isArray(src.required)) out.required = src.required
  }
  if (out.type === 'array' && src.items !== undefined) {
    out.items = sanitizeJsonSchema(src.items, depth + 1)
  }
  return out
}

/** Agent 主循环：chat → (tool_calls? → confirm → callTool → 回注 → chat)* → 最终回答 */
export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const { system, question, ready, chat, confirm, say } = deps
  if (!ready) throw new Error('BYOK 未配置')

  const remote = await listTools()
  const exclude = new Set(deps.excludeTools ?? [])
  const remoteFiltered = exclude.size ? remote.filter((t) => !exclude.has(t.name)) : remote
  // #279 内置工具并列装配（重名时内置优先、远程同名剔除）
  const builtinNames = new Set((deps.builtinTools ?? []).map((t) => t.name))
  const tools = [...remoteFiltered.filter((t) => !builtinNames.has(t.name)), ...(deps.builtinTools ?? [])]
  // #280.2：schema LLM 兼容清洗——部分 OpenAI 兼容端点（国产中转类）对 anyOf/oneOf/allOf、$schema 等进阶
  // JSON Schema 关键字支持差（请求 400/挂起，表现为小月首轮无响应）。装配层拍平为最大兼容形态。
  const openaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description ?? t.title ?? t.name, parameters: sanitizeJsonSchema(t.inputSchema) },
  }))
  say(`（已接入工具 ${tools.length} 个${builtinNames.size ? `，含内置 ${builtinNames.size} 个` : ''}）`)

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

      const localFn = deps.localTools?.[tc.function.name]
      if (localFn) {
        // #278 本地覆写（builtin 记忆=本地文件层）：不经远程 tools/call
        let out: string
        try { out = await localFn(args) } catch (e: any) { out = `本地执行失败：${String(e?.message ?? e)}` }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out })
        used.push({ name: tc.function.name, ok: !out.startsWith('本地执行失败') })
        continue
      }
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
