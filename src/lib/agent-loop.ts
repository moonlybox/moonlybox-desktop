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
  /** #328.5：对话历史（不含主 system/当前 question 的既往轮次；可含 [CONTEXT_SUMMARY] 压缩摘要）——缺省=单轮无上下文（此前多轮对话失忆根因） */
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
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

/** #317.P5a 工具名自愈（Hermes 式）：大小写/分隔符归一→剥 _tool 后缀→前缀/包含匹配→编辑距离模糊匹配 */
function repairToolName(bad: string, valid: string[]): string | null {
  if (!bad) return null
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  const camel = (s: string) => s.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
  const stripSuffix = (s: string): string | null => {
    const lc = s.toLowerCase()
    for (const sfx of ['_tool', '-tool', 'tool']) {
      if (lc.endsWith(sfx)) return s.slice(0, -sfx.length).replace(/[_-]+$/, '')
    }
    return null
  }
  // 快路径：
  if (valid.includes(bad)) return bad
  const cands = new Set<string>([bad, bad.toLowerCase(), norm(bad), camel(bad)])
  for (let i = 0; i < 2; i++) {
    for (const c of [...cands]) {
      const st = stripSuffix(c)
      if (st) { cands.add(st); cands.add(norm(st)); cands.add(camel(st)) }
    }
  }
  for (const c of cands) if (c && valid.includes(c)) return c
  // 前缀/包含（小模型常见漏字/复数错：list_todo→list_todos）：
  const lb = bad.toLowerCase()
  const pref = valid.find((v) => v.toLowerCase().startsWith(lb) || lb.startsWith(v.toLowerCase()) || v.toLowerCase().includes(lb) && lb.length >= 4)
  if (pref) return pref
  // 编辑距离 ≤2 模糊（levenshtein 简版）：
  const dist = (a: string, b: string): number => {
    const m = a.length, n = b.length
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]) as number[][]
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i2 = 1; i2 <= m; i2++) for (let j = 1; j <= n; j++)
      dp[i2][j] = Math.min(dp[i2 - 1][j] + 1, dp[i2][j - 1] + 1, dp[i2 - 1][j - 1] + (a[i2 - 1] === b[j - 1] ? 0 : 1))
    return dp[m][n]
  }
  let best: { v: string; d: number } | null = null
  for (const v of valid) {
    const d = dist(lb, v.toLowerCase())
    if (d <= 2 && (!best || d < best.d)) best = { v, d }
  }
  return best?.v ?? null
}

/** #317.P5a 坏参 JSON 自愈（Hermes 式）：控制字符/尾逗号/未闭合结构/Python None */
function repairArgsJson(raw: string): string {
  const s0 = (raw ?? '').trim()
  if (!s0) return '{}'
  if (s0 === 'None' || s0 === 'null') return '{}'
  // Pass0：宽松 parse（控制字符内嵌——本地模型最常见）重序列化：
  try { return JSON.stringify(JSON.parse(s0)) } catch { /* 继续 */ }
  let fixed = s0.replace(/[\u0000-\u001f]+/g, ' ')
  try { return JSON.stringify(JSON.parse(fixed)) } catch { /* 继续 */ }
  // Pass1-3：尾逗号/闭合括号补齐：
  fixed = fixed.replace(/,\s*([}\]])/g, '$1')
  const opens = (fixed.match(/\{/g) ?? []).length - (fixed.match(/\}/g) ?? []).length
  const brackets = (fixed.match(/\[/g) ?? []).length - (fixed.match(/\]/g) ?? []).length
  fixed += '}'.repeat(Math.max(0, opens)) + ']'.repeat(Math.max(0, brackets))
  try { return JSON.stringify(JSON.parse(fixed)) } catch { return '{}' }
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
  say(`（已接入工具 ${tools.length} 个${builtinNames.size ? `，含内置 ${builtinNames.size} 个` : ''}：${tools.map((t) => t.name).slice(0, 12).join('、')}${tools.length > 12 ? ` 等` : ''}）`)

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
    ? `\n【当前可用工具】\n${caps.map((c) => '- ' + c).join('\n')}\n用户问题只要可能由上述某工具回答（尤其是「列出/查看/有多少/我的…」类查询），先调工具再回答；不确定就选最接近的一个试，不要凭空说「没有该功能」。上述工具同时通过 API 的 tools 参数提供——一律可用，禁止向用户复述工具清单、禁止声称「某工具未在工具列表中定义/不存在」。工具返回空结果（0 条/空列表）就如实回答没有，不要转为创建/修改等写操作——用户没要求新建就不要新建。`
    : ''

  // #317.F12：回复纪律常驻——4B 级模型关思考后会把内部分析/草稿直接写进回复（真机：自我介绍输出整段
  // 「好的，用户让我…首先我需要…可能的回复是…」）——system 层先压一遍
  const answerDiscipline = `\n【回复纪律】你的回复会原样展示给用户：只输出给用户看的最终中文回答本身。禁止把内部分析、计划、草稿对照（如「首先我需要…」「可能的回复是…」「Wait…」）、英文思考写进回复。`
  const messages: import('../lib/llm').ChatMessage[] = [
    { role: 'system', content: system + toolGuide + answerDiscipline },
    ...(deps.history ?? []).map((h) => ({ role: h.role, content: h.content })), // #328.5：历史注入
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
      let text = res.text ?? ''
      // #317.F12：推理泄漏检测+一次自纠——system 纪律失守时兜底（判窄不判宽，避免误伤正常长答）
      // #317.F14：自纠循环（上限 2 次）——首版修正令 200 字被 4B 模型当新题目展开分析（真机：重写回复本身
      // 又是 2000 字「检查是否符合…草拟…」），改极短硬令+多轮兜底
      for (let fixRound = 0; fixRound < 2 && isLeakyAnswer(text); fixRound++) {
        say(`（回复夹带了分析过程，正在自动重写 ${fixRound + 1}/2——最终回答以重写后的干净版为准）`)
        const fix = await chat([...messages, { role: 'assistant', content: text }, { role: 'user', content: '不要分析。直接输出最终中文回答本身。' }], undefined)
        if (fix.ok && fix.text && fix.text.trim()) text = fix.text
      }
      return { answer: text, toolCalls: used }
    }

    // assistant(tool_calls) 必须原样回注
    messages.push({ role: 'assistant', content: res.text ?? null, tool_calls: res.toolCalls })

    // #317.P3：分桶并发——连续的「并发安全」工具打包 Promise.all；其余（本地覆写/未知/确认类）保持原序串行。
    // 输出顺序不变：执行完成后按 tc 原顺序回注 messages/used（tool_call_id 对齐）。
    type ExecOutcome = { id: string; name: string; content: string; ok: boolean }
    const execOne = async (tc0: { id: string; function: { name: string; arguments?: string } }): Promise<ExecOutcome> => {
      // #317.P5a 工具名自愈：编造/变形名先修复再找 meta（修好当轮成功，不留失败）
      const tc = { ...tc0, function: { ...tc0.function } }
      let meta = tools.find((t) => t.name === tc.function.name)
      const validNames = [...tools.map((t) => t.name), ...Object.keys(deps.localTools ?? {})]
      if (!meta && !deps.localTools?.[tc.function.name] && tc.function.name) {
        const repaired = repairToolName(tc.function.name, validNames)
        if (repaired) {
          say(`  🔧 工具名自愈：${tc.function.name} → ${repaired}`)
          tc.function.name = repaired
          meta = tools.find((t) => t.name === repaired)
        }
      }
      // #317.P5a 坏参自愈：控制字符/尾逗号/未闭合/None 修复后再 parse
      const argsFixed = repairArgsJson(tc.function.arguments || '{}')
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(argsFixed) } catch { args = {} }
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
      // #317.P5a：分桶前同样自愈（修好的只读工具可进并发桶；execOne 内会再次自愈=幂等）
      if (!tools.some((t) => t.name === tc.function.name) && !deps.localTools?.[tc.function.name] && tc.function.name) {
        const rep = repairToolName(tc.function.name, [...tools.map((t) => t.name), ...Object.keys(deps.localTools ?? {})])
        if (rep) {
          say(`  🔧 工具名自愈：${tc.function.name} → ${rep}`)
          tc.function.name = rep
        }
      }
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
    // #317.F11：终答轮收尾指令——qwen3 关思考后会把模板指令/对话当「题目」分析、英文推理链泄进正文
    // （真机：list_todos 返回空后输出 500 字英文 "Wait, let's see..."）。紧贴工具结果下指令压住：
    messages.push({ role: 'system', content: '工具结果已返回（上面最后一条 tool 消息）。现在直接给用户写最终回答：一两句话、中文、面向用户；如果结果是空列表就明确说没有。禁止：分析这轮对话本身、复述任何指令文本、输出推理过程（"Wait/首先/需要确认"式文字）、提出调用更多工具。' })
  }
  // #317.2：预算/轮数判停——不再丢一句占位话，改为一次无工具 LLM 调用汇总已有结果
  try {
    messages.push({ role: 'system', content: '工具调用阶段结束（上下文预算或轮次已到）。请基于以上已获得的工具结果，直接给出面向用户的最终回答；未完成的部分如实说明。' })
    const fin = await chat(messages, undefined)
    if (fin.ok && fin.text) return { answer: fin.text, toolCalls: used }
  } catch { /* 汇总失败回落占位 */ }
  return { answer: '（工具调用轮次达到上限，以上是已执行的结果）', toolCalls: used }
}

/** #317.F12：终答推理泄漏判定——4B 级模型关思考后内部分析/英文思维链泄进正文（自纠重试用，判窄不判宽） */
function isLeakyAnswer(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  // 泄漏开头特征（真机样本：「好的，用户让我…」「首先，我需要…」「Wait, let's see…」）
  const heads = ['好的，用户', '首先，用户', '用户让我', '用户问', '首先，我需要', '首先我需要', 'Wait,', "Wait '", '让我分析', '我需要看看', '我需要检查', '可能的回复是', "Okay, let's", 'Okay, the user', '草拟', '检查是否符合', '回顾我的上一条回复', '关键点：用户']
  if (heads.some((h) => t.startsWith(h))) return true
  // 中文语境里成段英文思维链（≥2 段 40+ 连续英文字符）
  const englishRuns = t.match(/[A-Za-z][A-Za-z',. ]{39,}/g)
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (englishRuns && englishRuns.length >= 2 && cjk < englishRuns.join('').length) return true
  // #317.F13：纯中文分析腔泄漏（真机：2000 字「不过，…但根据…可能需要…」反复论证工具列表）——
  // 分析连接词高频+直接引用 tools JSON 字面（"type": "function"）任一命中
  if ((t.match(/不过，/g) ?? []).length >= 3) return true
  if ((t.match(/但根据/g) ?? []).length >= 3) return true
  if (t.includes('"type": "function"') || t.includes('"type":"function"')) return true
  return false
}
