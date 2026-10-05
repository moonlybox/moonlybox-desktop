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

function needsConfirm(tool: McpTool, args?: Record<string, unknown>): boolean {
  // #329.4：organize_bookmarks 两段式——预览（不带 confirmToken）不弹确认条（dry_run 无副作用）；
  // 带 confirmToken=真实写入=确认制。避免「预览也弹」造成双重确认疲劳。
  if (tool.name === 'organize_bookmarks') return Boolean(args && args.confirmToken)
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
      // #329.5/#329.7：整理链轮末编排兜底——GLM 5.2 实证会「登记后停下等继续」/「读取结果后直接终答」。
      // 本轮或此前轮次已登记 cloud_organize 任务但从未调过 organize_bookmarks 且模型停下 → 注入推进指令。
      const didOrganize = used.some((u) => u.name === 'organize_bookmarks')
      const didCreateOrganize = used.some((u) => u.name === 'local_task_create_cloud_organize')
        || messages.some((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((tc: any) => tc?.function?.name === 'local_task_create_cloud_organize'))
      // #331.12：幻觉执行拦截——模型没调 organize 却给出「执行结果话术」（0 条变更/没生效/已写入）：
      // 生产取证（access.log+DB）实证这是编造。命中→不采信 answer，强制注入要求输出 items JSON（托管真执行）。
      const hallucinatedExec = !didOrganize && /0 条变更|没有生效|没生效|写入没|未生效|变更条数为? ?0/i.test(res.text ?? '')
      if (didCreateOrganize && !didOrganize && round < MAX_TOOL_ROUNDS - 1) {
        // #329.14：终局编排——模型绕圈（读清单/翻页/复读）不给 items 方案时，收走工具、要求纯 JSON 输出
        //（分类决策=LLM 强项；机械调用=系统托管）。下一轮 finish=stop 的 text 若是 items JSON 就地执行（见 return 前拦截）。
        const askedJson = messages.some((m: any) => m.role === 'user' && String(m.content ?? '').includes('只输出 items JSON'))
        if (!askedJson) {
          messages.push({
            role: 'user',
            content: hallucinatedExec
              ? '（系统）检测到你报告了执行结果，但本轮并没有真正调用 organize_bookmarks 工具——那是编造的。不要再调用任何工具。基于上方清单（local_task_cloud_organize_preview 或 search 结果），**只输出 items JSON 数组**：[{"id":"收藏id","description":"一句描述","tagsAdd":["标签1"]}, ...]，覆盖全部待整理条目。不要输出任何其他文字、解释或 Markdown 代码块标记。'
              : '（系统）不要再调用任何工具。基于上方清单（local_task_cloud_organize_preview 或 search 结果），**只输出 items JSON 数组**：[{"id":"收藏id","tagsAdd":["标签1","标签2"]}, ...]，覆盖全部待整理条目，每条 1~2 个标签。不要输出任何其他文字、解释或 Markdown 代码块标记。',
          })
          continue
        }
      }
      // #331.12：注入后模型仍不输出合法 JSON→兜底改写在 let text 声明后做（见下 let text 后 hallucinatedExec 分支）
      let text = res.text ?? ''
      // #331.12：注入后模型仍不输出合法 JSON→兜底改写 answer，不让幻觉话术上屏
      if (hallucinatedExec) {
        text = '如实说明：本轮批量写入实际没有执行（写入工具未被真正调用，此前报告的「变更结果」不可信）。你的收藏数据没有变化。回复「继续」，我立刻真实执行一次写入。'
      }
      // #329.21：items JSON 优先于泄漏自纠——JSON 方案是合法终答（即使带工具名前缀），
      // 先 parse；命中则直接托管执行，绝不能进 isLeakyAnswer 自纠（自纠重写会破坏 JSON=托管被吞）
      const prePlan = parseItemsPlan(text)
      if (prePlan) {
        const exec = await runItemsPlan(prePlan, say, used, chat)
        return { answer: exec, toolCalls: used }
      }
      // #317.F12：推理泄漏检测+一次自纠——system 纪律失守时兜底（判窄不判宽，避免误伤正常长答）
      // #317.F14：自纠循环（上限 2 次）——首版修正令 200 字被 4B 模型当新题目展开分析（真机：重写回复本身
      // 又是 2000 字「检查是否符合…草拟…」），改极短硬令+多轮兜底
      for (let fixRound = 0; fixRound < 2 && isLeakyAnswer(text); fixRound++) {
        say(`（回复夹带了分析过程，正在自动重写 ${fixRound + 1}/2——最终回答以重写后的干净版为准）`)
        // #329.13：整理链进行中（已登记未收口）→自纠令改为「继续干活」而非「重写文字」——
        // GLM 5.2 实证会把工具调用写成正文然后停；此时正确动作是回工具链，不是重说一遍
        const midOrganize = used.some((u) => u.name === 'local_task_create_cloud_organize' || u.name === 'local_task_cloud_organize_preview')
          && !used.some((u) => u.name === 'local_task_update_cloud_organize')
        const fixPrompt = midOrganize
          ? '不要把工具调用写成文字。继续调用工具完成云端整理：调 organize_bookmarks {items:[{id, tagsAdd/description...}], execute:true} 一次写入（不要预览、不要等确认、不要二次征询），完成后调 local_task_update_cloud_organize 上报并用一句中文汇报结果。'
          : '不要分析，不要复述此前的方案/分类清单。直接输出最终中文回答本身（若是进度汇报，只说当前进度与下一步）。'
        const fix = await chat([...messages, { role: 'assistant', content: text }, { role: 'user', content: fixPrompt }], undefined)
        if (fix.ok && fix.text && fix.text.trim()) text = fix.text
      }
      // #329.14：items JSON 就地执行——编排轮收到的纯 JSON 方案，系统托管完成 预览→token→执行→收口
      const jsonPlan = parseItemsPlan(text)
      if (jsonPlan) {
        const exec = await runItemsPlan(jsonPlan, say, used, chat)
        return { answer: exec, toolCalls: used }
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
        // #329.17：tool_result_read 的结果免落盘截断——它本身就是「读全文」工具，再截断=永远读不到全文
        const content = tc.function.name === 'tool_result_read' ? out : injectToolResult(deps.vaultRoot ?? '', tc.function.name, out)
        return { id: tc.id, name: tc.function.name, content, ok: !out.startsWith('本地执行失败') }
      }
      if (!meta) return { id: tc.id, name: tc.function.name, content: `未知工具：${tc.function.name}`, ok: false }

      say(`⚙ ${meta.title ?? meta.name} ${argsJson.slice(0, 120)}`)
      if (needsConfirm(meta, args)) {
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
        for (let attempt = 0; attempt < (needsConfirm(meta, args) ? 1 : 2); attempt++) {
          try {
            if (attempt > 0) say(`  ↻ 重试一次…`)
            result = await callTool(meta.name, args)
            break
          } catch (e) { lastErr = e }
        }
        if (!result) throw lastErr ?? new Error('工具执行失败')
        const text = toolResultText(result)
        say(`  → ${text.slice(0, 160)}`)
        const content2 = meta.name === 'tool_result_read' ? text : injectToolResult(deps.vaultRoot ?? '', meta.name, text)
        // #329.19：云端整理进度自动上报——模型用 update_bookmark/organize_bookmarks 逐条写入成功时，
        // 系统自动推进最近 cloud_organize 任务进度（不依赖模型记得上报；失败/跳过不计）
        const execOk = !/\{?\s*\"ok\"\s*:\s*false/.test(text.slice(0, 80)) && !text.startsWith('工具执行失败')
        if (execOk && (meta.name === 'update_bookmark' || meta.name === 'organize_bookmarks')) {
          try {
            // #331.16：登记兜底（工具调用路径）——organize 成功但无未完结任务=模型跳过登记，
            // 系统按 args.items 自动补登记（任务页可见性硬保证，不依赖模型自觉）
            if (meta.name === 'organize_bookmarks') {
              const planItems = Array.isArray((args as any)?.items) ? (args as any).items : []
              await ensureCloudOrganizeJob(planItems).catch(() => {})
            }
            // #331.9：快照兜底（工具调用路径）——模型正常 tool_calls 直通执行时任务 items 仍是占位，
            // 按 args.items 顺序回填标题（此前只有文本化 runItemsPlan 路径有回填）
            if (meta.name === 'organize_bookmarks') {
              const planItems = Array.isArray((args as any)?.items) ? (args as any).items : []
              await snapshotJobTitlesFromPlan(planItems).catch(() => {})
            }
            const { allJobs, getJob, updateJob, updateItem } = await import('./tasks')
            const job = allJobs().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
              .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
            if (job) {
              if (job.status === 'queued') updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
              const fresh = getJob(job.id)!
              const pending = fresh.items.find((it) => it.status === 'pending')
              if (pending) updateItem(job.id, pending.path, { status: 'done' })
              const after = getJob(job.id)!
              if (after.items.every((it) => it.status !== 'pending')) {
                updateJob(job.id, { status: 'completed', finishedAt: new Date().toISOString() })
              }
            }
          } catch { /* 进度上报失败不影响主执行 */ }
        }
        return { id: tc.id, name: meta.name, content: content2, ok: true }
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

/** #329.14：解析 items 方案 JSON（宽容：剥 markdown 围栏/前后杂文） */
function parseItemsPlan(text: string): Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }> | null {
  const t = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const m = t.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!m) return null
  try {
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr) || !arr.length) return null
    const ok = arr.filter((x: any) => x && typeof x.id === 'string' && (Array.isArray(x.tagsAdd) || Array.isArray(x.tagsRemove) || typeof x.description === 'string'))
    return ok.length ? ok : null
  } catch { return null }
}

/** #329.14：items 方案系统托管执行——预览→token→执行→收口，返回汇报文本 */
/** #331.16：任务登记兜底（两路径共用）——模型跳过 local_task_create_cloud_organize 直接执行时，
 * 系统自动补登记（用户裁决：AI 整理必须在任务页可见可查，不登记不得执行）。已有未完结任务则复用。 */
async function ensureCloudOrganizeJob(plan: Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }>): Promise<void> {
  if (!plan.length) return
  const { allJobs, createJob } = await import('./tasks')
  const open = allJobs().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  if (open) return
  const kind = plan.some((p) => p.tagsAdd?.length || p.tagsRemove?.length) ? 'tags' : 'descriptions'
  const label = kind === 'tags' ? `收藏打标签 · ${plan.length} 条（自动登记）` : `收藏补描述 · ${plan.length} 条（自动登记）`
  createJob('cloud_organize', label, plan.map((p, i) => ({ path: `cloud:#${i + 1}` })), undefined)
}

/** #331.9：任务快照兜底（两路径共用）——items 仍有无 title 占位（cloud:#N）时按 plan 序回填标题（id 精确匹配） */
async function snapshotJobTitlesFromPlan(plan: Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }>): Promise<void> {
  if (!plan.length) return
  const { allJobs, updateItem } = await import('./tasks')
  const job = allJobs().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  if (!job || !job.items.some((it) => !it.title)) return
  const planIds = new Set(plan.map((p) => p.id))
  const { callTool } = await import('./moonlink')
  const sr = await callTool('search_bookmarks', { limit: 200 })
  const st = sr?.content?.map((c: any) => c.text ?? '').join('') ?? ''
  const sd = JSON.parse(st)
  const byId = new Map<string, string>()
  for (const b of sd.bookmarks ?? []) if (planIds.has(b.id)) byId.set(b.id, String(b.title ?? '').slice(0, 60))
  for (let i = 0; i < job.items.length; i++) {
    const it = job.items[i]
    if (it.title) continue
    const m = /^cloud:#(\d+)$/.exec(it.path)
    if (m) {
      const t = byId.get(plan[Number(m[1]) - 1]?.id ?? '')
      if (t) updateItem(job.id, it.path, { title: t })
    }
  }
}

/** #331：标签收敛轮——草稿标签全集 vs 既有标签（list_tags），LLM 输出映射（同名归一/下位→上位/同义合并/新标签限词），改写 items */
export async function convergeTags(
  plan: Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }>,
  say: (line: string) => void,
  chat: typeof import('../lib/llm').byokChatMessages,
): Promise<Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }>> {
  const draft = Array.from(new Set(plan.flatMap((p) => p.tagsAdd ?? [])))
  if (draft.length === 0) return plan
  const { callTool } = await import('./moonlink')
  const lt = await callTool('list_tags', {})
  const ltText = lt?.content?.map((c: any) => c.text ?? '').join('') ?? ''
  let existing: string[] = []
  try { existing = (JSON.parse(ltText)?.tags ?? []).map((t: any) => String(t.name ?? t)) } catch {}
  if (existing.length === 0) return plan
  const sys = [
    '你是标签体系收敛器。用户云端已有一套标签（existing），现在有一个新打标签方案的草稿标签（draft）。',
    '把 draft 中每个标签映射为最终标签，规则（按序判定）：',
    '1. 与 existing 中某标签语义相同（含大小写/中英/同义词）→ 映射为该既有标签（原文）；',
    '2. 是 existing 中某标签的下位概念（如「临床输血」⊂「输血医学」）或交叉概念 → 映射为概括性更高的既有标签（就高不就低）；',
    '3. draft 内部同义/包含 → 合并到更概括的那个（新造词统一到同一种表述）；',
    '4. existing 完全未覆盖的新主题 → 保留草稿标签，但规范化措辞（简洁名词，≤6 字优先）。',
    '每条收藏打 1~2 个标签，禁止为单个标签再细分出多个近义标签。',
    '只输出 JSON：{"map": {"草稿标签": "最终标签", ...}}，不要任何其他文字。',
  ].join('\n')
  const res = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `existing=${JSON.stringify(existing)}\n\ndraft=${JSON.stringify(draft)}` },
  ], undefined)
  const text = (res as any)?.choices?.[0]?.message?.content ?? (res as any)?.content ?? ''
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) return plan
  const map = JSON.parse(m[0])?.map as Record<string, string> | undefined
  if (!map || Object.keys(map).length === 0) return plan
  const out = plan.map((p) => ({
    ...p,
    tagsAdd: p.tagsAdd ? Array.from(new Set(p.tagsAdd.map((t) => (map[t] ?? t).trim()).filter(Boolean))) : undefined,
  }))
  say(`（标签收敛：${draft.length} 个草稿标签 → ${Array.from(new Set(out.flatMap((p) => p.tagsAdd ?? []))).length} 个最终标签，已对齐既有体系）`)
  return out
}

async function runItemsPlan(
  plan: Array<{ id: string; tagsAdd?: string[]; tagsRemove?: string[]; description?: string }>,
  say: (line: string) => void,
  used: Array<{ name: string; ok: boolean }>,
  chat?: typeof import('../lib/llm').byokChatMessages,
): Promise<string> {
  try {
    // #331.16：登记兜底——模型跳过 create 直接执行时系统自动补登记（任务页可见性硬保证）
    try { await ensureCloudOrganizeJob(plan) } catch { /* 登记失败不阻塞执行 */ }
    // #331：标签收敛轮（两轮编译式）——execute 前把草稿标签对齐既有体系（LLM 算力收敛）
    if (chat) {
      try {
        plan = await convergeTags(plan, say, chat)
      } catch { /* 收敛失败→按草稿执行（不阻塞） */ }
    }
    // #331.13：目标集合校验（机制层，补描述缺陷根治）——模型会从对话上文抄旧 items（id 属于旧批次），
    // 对已处理条目重复写入、真目标一条不碰。执行前实时查目标集合（cloud:#N 任务最近 job 的 kind
    // 对应 untagged/noDescription），plan.id 与目标集交集为 0 → 拒绝执行并抛出可诊断错误。
    try {
      const { allJobs: aJ2 } = await import('./tasks')
      const job2 = aJ2().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      if (job2) {
        const isDesc = job2.title.includes('描述')
        const { callTool: cT2 } = await import('./moonlink')
        const sr2 = await cT2('search_bookmarks', isDesc ? { noDescription: true, limit: 200 } : { untagged: true, limit: 200 })
        const st2 = sr2?.content?.map((c: any) => c.text ?? '').join('') ?? ''
        const sd2 = JSON.parse(st2)
        const targetIds = new Set<string>((sd2.bookmarks ?? []).map((b: any) => b.id))
        const valid = plan.filter((p) => targetIds.has(p.id))
        // #331.17：收紧——部分命中也拒绝（混入旧条目会导致任务详情与真实写入错位；强制重新圈定）
        // #331.18：拒绝时随附实时清单（id|标题）——下一步直接基于新鲜数据生成，不再吃旧缓存
        if (valid.length < plan.length) {
          const fresh = (sd2.bookmarks ?? []).map((b: any) => `${b.id} | ${String(b.title ?? '').slice(0, 40)}`)
          return `目标校验未通过：本次提交的 ${plan.length} 条中只有 ${valid.length} 条属于当前待整理清单（${isDesc ? '缺描述' : '未打标签'}），方案混入了旧对话条目。以下为当前实时待整理清单（${fresh.length} 条），请直接基于它重新生成 items：\n${fresh.join('\n')}`
        }
      }
    } catch { /* 校验失败不阻塞执行 */ }
    // #331.6/#331.9：快照兜底（文本化路径）——与工具调用路径共用 snapshotJobTitlesFromPlan
    try { await snapshotJobTitlesFromPlan(plan) } catch { /* 回填失败不阻塞执行 */ }
    say(`⚙ organize_bookmarks（items ×${plan.length}，直通执行）`)
    const { callTool } = await import('./moonlink')
    // #329.20：execute:true 直通（用户裁决取消两段式）——单次调用直接写入
    const ex = await callTool('organize_bookmarks', { items: plan, execute: true })
    const exText = ex?.content?.map((c: any) => c.text ?? '').join('') ?? ''
    let exData: any = {}
    try { exData = JSON.parse(exText) } catch {}
    if (exData?.ok === false) return `执行失败：${exData.message ?? exText.slice(0, 120)}`
    used.push({ name: 'organize_bookmarks', ok: true })
    // 收口：最近 cloud_organize 任务推满
    try {
      const { allJobs, updateJob, updateItem } = await import('./tasks')
      const job = allJobs().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      if (job) {
        if (job.status === 'queued') updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
        for (const it of job.items) {
          if (it.status === 'pending') updateItem(job.id, it.path, { status: 'done' })
        }
        updateJob(job.id, { status: 'completed', finishedAt: new Date().toISOString() })
      }
    } catch { /* 收口失败不影响主结果 */ }
    return `✅ 整理完成：${plan.length} 条收藏已按方案写入标签（云端已生效）。可在「任务」页查看记录，收藏页刷新即可看到新标签。`
  } catch (e: any) {
    return `托管执行失败：${String(e?.message ?? e)}`
  }
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
  // #329.7/#329.18：工具调用文本化（GLM 5.2 实证：tool_result_readpathC:\ / update_bookmarkid...tagsAdd[...]
  // / organize_bookmarksitems[...] ——工具名与参数无边界拼接，\b 失效，用直接拼接匹配）
  if (/\btool_[a-z_]+\s*path\s*[A-Za-z]:\\/.test(t)) return true
  if (/^\s*[a-z_]*bookmark[a-z_]*(id|path|\{|\[)/i.test(t)) return true
  if (/^\s*(tool_result_read|organize_bookmarks|search_bookmarks|add_bookmark|add_sticky|add_todo|[a-z_]*_task[a-z_]*)(path|id|ids|items|\{|\[)/i.test(t)) return true
  // #331.15：organize_bookmarksexecutetrue 粘连变体（工具名紧邻 execute，无边界）——
  // 注意判窄：仅工具名直接粘连 execute 时命中，避免误伤正常文本（误伤=自纠白烧两轮 LLM，e2e 假死教训）
  if (/^\s*organize_bookmarks\s*execute\s*:?\s*(true|false)/i.test(t)) return true
  return false
}
