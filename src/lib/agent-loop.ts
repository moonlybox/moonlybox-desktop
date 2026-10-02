import { injectToolResult } from './tool-result-store'
import { listTools, callTool, McpTool } from './moonlink'
import { ensureToolDescription } from './mcp-custom'

/**
 * 小月 Agent 循环（D9 装配）：LLM + moonlink MCP 工具。
 * 纪律：
 *  - 工具单源=远程 moonlink（29 工具 tools/list 消费，本地零复制，原则⑤同轨配额）
 *  - 写操作确认制：destructiveHint 或非 readOnly 的工具执行前需用户 Y 确认（read/list/search 自动过）
 *  - 循环上限 6 轮（防失控）；每轮工具调用打活动流（⚙ 前缀）
 */

const MAX_TOOL_ROUNDS = 12 // #317.2：硬顶防失控（轮数不再是最小预算——判停主力=token 预算制）
/** #317.2：上下文预算（与 chat-context BUDGET 同基准）：messages 近似 token 超 85%→引导收尾；超 100%→强制汇总 */
const CTX_BUDGET_DEFAULT = 6000
const ctxTokens = (messages: import('../lib/llm').ChatMessage[]): number =>
  messages.reduce((a, m) => a + Math.ceil(String(m.content ?? '').length / 3) + (Array.isArray(m.tool_calls) ? 120 : 0), 0)
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
  /** #317.1 书房根（工具结果落盘引用注入；缺省=跳过落盘直接截断） */
  vaultRoot?: string
  /** #317.2 上下文预算（token 近似；缺省 6000 与 chat-context 同基准；测试可调小验证判停） */
  ctxBudget?: number
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

// ==================== #317.P3：只读工具并发执行 ====================

/**
 * 并发安全白名单（静态，只收紧不放宽——Hermes _PARALLEL_SAFE_TOOLS 同款纪律）：
 * 纯只读、无共享可变状态、网络/本地 IO 慢工具（并发放大收益）。写操作/确认类/交互类一律不并发。
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'web_search', 'fetch_url', 'search_library', 'search_bookmarks', 'search_topics',
  'search_memory', 'list_todos', 'list_stickies', 'list_goals', 'list_library_index',
  'list_bookmarks', 'list_conflicts', 'skill_list', 'skill_view', 'skill_file',
  'tool_result_read', 'local_task_status', 'fs_list', 'fs_read', 'doc_read',
])

/** 单工具是否可进并发桶：静态白名单 且 非确认（写）类 */
function isParallelSafe(meta: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } } | undefined, name: string): boolean {
  if (!PARALLEL_SAFE_TOOLS.has(name)) return false
  if (!meta) return false
  if (meta.annotations?.destructiveHint) return false
  return true
}

/** Agent 主循环：chat → (tool_calls? → confirm → callTool → 回注 → chat)* → 最终回答 */
export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const { system, question, ready, chat, confirm, say } = deps
  if (!ready) throw new Error('BYOK 未配置')

  // #283.4：MoonLink 远程工具失败隔离——未登录/网络断只报告，循环继续（内置/fs/自定义工具照常装配）
  let remote: McpTool[] = []
  try {
    remote = await listTools()
  } catch (e: any) {
    say(`（MoonLink 工具不可用：${String(e?.message ?? e).slice(0, 80)}——继续使用内置工具）`)
  }
  const exclude = new Set(deps.excludeTools ?? [])
  const remoteFiltered = exclude.size ? remote.filter((t) => !exclude.has(t.name)) : remote
  // #279 内置工具并列装配（重名时内置优先、远程同名剔除）
  const builtinNames = new Set((deps.builtinTools ?? []).map((t) => t.name))
  const tools = [...remoteFiltered.filter((t) => !builtinNames.has(t.name)), ...(deps.builtinTools ?? [])]
  // #280.2：schema LLM 兼容清洗——部分 OpenAI 兼容端点（国产中转类）对 anyOf/oneOf/allOf、$schema 等进阶
  // JSON Schema 关键字支持差（请求 400/挂起，表现为小月首轮无响应）。装配层拍平为最大兼容形态。
  const openaiTools = tools.map((t) => {
    // #317.P2：自定义 MCP 工具描述质量门——劣质 description（空/零信息/超长）拼装兜底；内置/远程工具原样
    const isCustom = 'server' in (t as unknown as Record<string, unknown>)
    const desc = isCustom
      ? ensureToolDescription(t as never)
      : (t.description ?? t.title ?? t.name)
    return {
      type: 'function' as const,
      function: { name: t.name, description: desc, parameters: sanitizeJsonSchema(t.inputSchema) },
    }
  })
  say(`（已接入工具 ${tools.length} 个${builtinNames.size ? `，含内置 ${builtinNames.size} 个` : ''}）`)

  // #317.9：工具感知引导（Hermes 同款 tool-aware）——按**实际装配**的工具生成能力清单追加为第二条 system。
  // 根治：xiaoyue.ts 旧 system 硬编码工具清单（漏 list_todos 等）误导小模型「没有列出待办的功能」。
  // 分类规则：名称语义分桶（列出/查询类显式点名——小模型最易漏）；无工具则不注入（零幻觉引导）。
  const has = (n: string) => tools.some((t) => t.name === n)
  const caps: string[] = []
  const pick = (...names: string[]) => names.filter(has).join('/')
  if (has('add_todo') || has('list_todos')) caps.push(`待办：记待办 ${pick('add_todo')}、查待办 ${pick('list_todos')}（含按状态过滤）、完成/改/删 ${pick('complete_todo', 'update_todo', 'delete_todo')}、转便签 ${pick('convert_todo_to_sticky')}`)
  if (has('add_sticky') || has('list_stickies')) caps.push(`便签：记便签 ${pick('add_sticky')}、看便签 ${pick('list_stickies')}、改/删 ${pick('update_sticky', 'delete_sticky')}`)
  if (has('add_bookmark')) caps.push(`收藏：收藏网页 ${pick('add_bookmark')}、查收藏 ${pick('search_bookmarks')}、整理 ${pick('organize_bookmarks', 'update_bookmark')}`)
  if (has('add_memory') || has('search_memory')) caps.push(`记忆：存 ${pick('add_memory')}、查 ${pick('search_memory')}`)
  if (has('search_library')) caps.push(`书房：查文档 ${pick('search_library')}、看索引 ${pick('list_library_index')}、主题 ${pick('search_topics')}`)
  if (has('web_search')) caps.push(`联网：搜索 web_search、读网页 ${pick('fetch_url')}`)
  if (has('local_task_create_compile')) caps.push(`知识整理：local_task_list_uncompiled 扫描→确认→local_task_create_compile 后台任务；进度 local_task_status`)
  if (has('skill_list')) caps.push(`技能：skill_list 列出、skill_view 读全文`)
  // #317.P2b：易混工具对分工表（小模型路由高频混淆点——一行分工，只有对应工具在装配里才注入）
  if (has('search_library') && has('search_topics') && has('search_memory'))
    caps.push(`检索分工：search_library=查文档原文、search_topics=查主题跨文档关联、search_memory=查你的画像/已知事实`)
  if (has('add_sticky') && has('save_note') && has('extract_archive'))
    caps.push(`保存分工：add_sticky=记一条短想法、save_note=存成段内容为文档、extract_archive=把网页存进书房`)
  if (has('search_library') && has('raw_get'))
    caps.push(`溯源：search_library 命中后要看某篇全文/历史版本用 raw_get`)
  const customs = tools.filter((t) => t.name.startsWith('mcp_') || t.name.includes('__')) as unknown as Array<{ name: string; description?: string; title?: string; server?: string }>
  if (customs.length) {
    // #317.P2：引导行带短描述（与 openaiTools 同源兜底）——路由链双层有信息
    const items = customs.map((t) => {
      const d = (t.description ?? t.title ?? '').trim()
      return d ? `${t.name}（${d.slice(0, 40)}）` : t.name
    })
    caps.push(`自定义 MCP：${items.slice(0, 6).join('、')}${items.length > 6 ? ` 等 ${items.length} 个` : ''}`)
  }
  const toolGuide = caps.length
    ? `\n【当前可用工具】\n${caps.map((c) => '- ' + c).join('\n')}\n用户问题只要可能由上述某工具回答（尤其是「列出/查看/有多少/我的…」类查询），先调工具再回答；不确定就选最接近的一个试，不要凭空说「没有该功能」。`
    : ''

  const messages: import('../lib/llm').ChatMessage[] = [
    { role: 'system', content: system + toolGuide },
    { role: 'user', content: question },
  ]
  const used: Array<{ name: string; ok: boolean }> = []

  let budgetWarned = false
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // #317.2：token 预算制判停（轮数硬顶只是兜底）——85% 注入「收尾」指令；100% 强制出最终回答
    const CTX_BUDGET = deps.ctxBudget ?? CTX_BUDGET_DEFAULT
    const tk = ctxTokens(messages)
    if (tk >= CTX_BUDGET) {
      say(`（上下文预算将尽：${tk}/${CTX_BUDGET} token——汇总已有结果作答）`)
      break
    }
    if (tk >= CTX_BUDGET * 0.85 && !budgetWarned) {
      budgetWarned = true
      say(`（上下文预算 85%：${tk}/${CTX_BUDGET}——请尽快收尾）`)
      messages.push({ role: 'system', content: '上下文预算即将用尽：请在本轮决定后直接给出最终回答，不要再发起新的工具调用（除非绝对必要）。' })
    }
    const res = await chat(messages, openaiTools)
    if (!res.ok) throw new Error(res.error ?? 'LLM 调用失败')

    if (!res.toolCalls || res.toolCalls.length === 0) {
      return { answer: res.text ?? '', toolCalls: used }
    }

    // assistant(tool_calls) 必须原样回注
    messages.push({ role: 'assistant', content: res.text ?? null, tool_calls: res.toolCalls })

    // #317.P3：分桶并发——连续的「并发安全」工具打包 Promise.all；其余（本地覆写/未知/确认类）保持原序串行。
    // 输出顺序不变：执行完成后按 tc 原顺序回注 messages/used（tool_call_id 对齐）。
    type ExecOutcome = { id: string; name: string; content: string; ok: boolean }
    const execOne = async (tc: { id: string; function: { name: string; arguments?: string } }): Promise<ExecOutcome> => {
      const meta = tools.find((t) => t.name === tc.function.name)
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* 空/坏参按空对象 */ }
      const argsJson = JSON.stringify(args)

      const localFn = deps.localTools?.[tc.function.name]
      if (localFn) {
        say(`⚙ ${tc.function.name} ${argsJson.slice(0, 120)}`)
        let out = '本地执行失败'
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) say(`  ↻ 重试一次…`)
            out = await localFn(args)
            break
          } catch (e: any) {
            if (attempt === 1) out = `本地执行失败：${String(e?.message ?? e)}`
          }
        }
        return { id: tc.id, name: tc.function.name, content: injectToolResult(deps.vaultRoot ?? '', tc.function.name, out), ok: !out.startsWith('本地执行失败') }
      }
      if (!meta) return { id: tc.id, name: tc.function.name, content: `未知工具：${tc.function.name}`, ok: false }

      say(`⚙ ${meta.title ?? meta.name} ${argsJson.slice(0, 120)}`)
      if (needsConfirm(meta)) {
        say(`  （写操作，确认执行？y/N）`)
        const ok = await confirm(meta.name, argsJson)
        if (!ok) {
          say(`  ✗ 已跳过（用户取消）`)
          return { id: tc.id, name: meta.name, content: '用户取消了该操作', ok: false }
        }
      }
      try {
        let lastErr: unknown = null
        let result: Awaited<ReturnType<typeof callTool>> | null = null
        for (let attempt = 0; attempt < (needsConfirm(meta) ? 1 : 2); attempt++) {
          try {
            if (attempt > 0) say(`  ↻ 重试一次…`)
            result = await callTool(meta.name, args)
            break
          } catch (e) { lastErr = e }
        }
        if (!result) throw lastErr ?? new Error('工具执行失败')
        const text = toolResultText(result)
        say(`  → ${text.slice(0, 160)}`)
        return { id: tc.id, name: meta.name, content: injectToolResult(deps.vaultRoot ?? '', meta.name, text), ok: true }
      } catch (e) {
        const err = String((e as Error).message ?? e)
        say(`  → 失败：${err.slice(0, 120)}`)
        return { id: tc.id, name: meta.name, content: `工具执行失败：${err}`, ok: false }
      }
    }
    // 分桶：连续 safe 段并发，unsafe 单发（保持原顺序语义）
    const tcs = res.toolCalls
    const outcomes: ExecOutcome[] = new Array(tcs.length)
    let i = 0
    while (i < tcs.length) {
      const tc = tcs[i]
      const meta = tools.find((t) => t.name === tc.function.name)
      const localHere = !!deps.localTools?.[tc.function.name]
      if (localHere || !isParallelSafe(meta, tc.function.name)) {
        outcomes[i] = await execOne(tc)
        i++
        continue
      }
      let j = i
      while (j < tcs.length) {
        const m2 = tools.find((t) => t.name === tcs[j].function.name)
        if (!isParallelSafe(m2, tcs[j].function.name) || deps.localTools?.[tcs[j].function.name]) break
        j++
      }
      const batch = tcs.slice(i, j)
      if (batch.length === 1) {
        outcomes[i] = await execOne(tc)
      } else {
        say(`（⚡ 并发执行 ${batch.length} 个只读工具）`)
        const rs = await Promise.all(batch.map((t) => execOne(t).catch((e: any) => ({ id: t.id, name: t.function.name, content: `工具执行失败：${String(e?.message ?? e)}`, ok: false }))))
        for (let k = 0; k < batch.length; k++) outcomes[i + k] = rs[k]
      }
      i = j
    }
    for (const oc of outcomes) {
      messages.push({ role: 'tool', tool_call_id: oc.id, content: oc.content })
      used.push({ name: oc.name, ok: oc.ok })
    }
  }
  // #317.2：预算/轮数判停——不再丢一句占位话，改为一次无工具 LLM 调用汇总已有结果
  try {
    messages.push({ role: 'system', content: '工具调用阶段结束（上下文预算或轮次已到）。请基于以上已获得的工具结果，直接给出面向用户的最终回答；未完成的部分如实说明。' })
    const fin = await chat(messages, undefined)
    if (fin.ok && fin.text) return { answer: fin.text, toolCalls: used }
  } catch { /* 汇总失败回落占位 */ }
  return { answer: '（工具调用轮次达到上限，以上是已执行的结果）', toolCalls: used }
}
