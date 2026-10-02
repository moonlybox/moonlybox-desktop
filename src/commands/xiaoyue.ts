import type { CommandOptions } from '../lib/runner'
import { loadCredentials } from '../lib/auth'
import { defaultBaseUrl } from '../lib/config'
import { apiCall } from '../lib/api'
import { searchLocalAsync } from '../lib/indexer'
import { byokReady, byokChat, loadByokMeta, saveByokMeta, saveByokKey, ByokConfig } from '../lib/llm'
import { appendDialog, recentDialogs } from '../lib/dialogs'
import { loadConfig } from '../lib/config'
import * as readline from 'node:readline'

/**
 * 小月终端对话（M3 重构 #232）：双轨制（§5.9.4）——
 *   本地轨：问句先查本地混合索引（M2.5），top 命中且 BYOK 配好 → 本地 LLM 直连作答
 *          （零流量零配额，key 永不出本机）；BYOK 未配 → 来源列表+摘要（不调 LLM）
 *   云端轨：本地空/用户 --cloud → POST /api/ai/xiaoyue/ask（云端检索注入+配额）
 * 对话持久化：.moonlybox/dialogs/ JSONL（#227 内存态顺路解决）。
 */

interface AskResult {
  ok: boolean
  message?: string
  data?: { answer: string; sources: Array<{ id: string; title: string; kind: string }>; remaining?: number }
}

interface LocalHitLite {
  docId: string
  title: string
  score: number
  source: string
}

async function askCloud(question: string): Promise<AskResult> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const res = await apiCall<AskResult>('POST', '/api/ai/xiaoyue/ask', { question }, {
    token: creds.accessToken,
    baseUrl: defaultBaseUrl(),
    timeoutMs: 60_000,
  })
  return res.data ?? { ok: false, message: `HTTP ${res.status}` }
}

const LOCAL_SCORE_GATE = 0.016 // RRF 融合分阈值：单路 rank1=1/61≈0.0164 过闸（关键词精确命中也算本地可答），两路 rank1≈0.0328

async function askOnce(root: string, question: string, opts: { forceCloud?: boolean } = {}): Promise<void> {
  // —— 本地轨 ——
  if (!opts.forceCloud) {
    let hits: LocalHitLite[] = []
    try {
      hits = await searchLocalAsync(root, question, 3)
    } catch {
      /* 索引缺失走云端 */
    }
    const top = hits[0]
    if (top && top.score >= LOCAL_SCORE_GATE) {
      console.log(`（本地轨：命中《${top.title}》${top.source === 'both' ? '，关键词+语义双确认' : ''}）`)
      if (byokReady()) {
        const meta = loadByokMeta()!
        const system = `你是「小月」，用户本地知识库（书房镜像）的轻问答助理。回答纪律：\n` +
          `1. 只依据下方材料回答；材料不足就如实说没找到，绝不编造；\n` +
          `2. 引用时注明「来自你的书房《标题》」；\n` +
          `3. 语气亲切简洁，中文回答，不超过 300 字；不要使用 Markdown 标题。\n\n` +
          `【本地书房材料】\n` +
          hits.map((h, i) => `${i + 1}. 《${h.title}》`).join('\n')
        const r = await byokChat(system, question)
        if (r.ok && r.text) {
          console.log(`小月：${r.text}`)
          console.log(`  来源：${hits.slice(0, 3).map((h) => `《${h.title}》`).join('、')}（本地，离线可用）`)
          appendDialog(root, { ts: new Date().toISOString(), role: 'user', content: question, track: 'local' })
          appendDialog(root, { ts: new Date().toISOString(), role: 'assistant', content: r.text, track: 'local' })
          return
        }
        console.log(`（本地 LLM 调用失败：${r.error}——转云端轨）`)
      } else {
        // BYOK 未配置：来源列表+摘要，不调 LLM，不耗配额
        console.log(`小月：我在你的本地书房找到这些相关内容：`)
        for (const [i, h] of hits.entries()) {
          console.log(`  ${i + 1}. 《${h.title}》`)
        }
        console.log(`  （配置 BYOK 后可在本地直接生成回答：moonlybox xiaoyue --setup）`)
        appendDialog(root, { ts: new Date().toISOString(), role: 'user', content: question, track: 'local' })
        appendDialog(root, { ts: new Date().toISOString(), role: 'assistant', content: `本地命中 ${hits.length} 条来源（未配置 BYOK）`, track: 'local' })
        return
      }
    }
  }

  // —— 云端轨 ——
  const r = await askCloud(question)
  if (r.ok) {
    console.log(`小月：${r.data?.answer}`)
    const sources = r.data?.sources ?? []
    if (sources.length) {
      console.log(`  来源：${sources.map((s) => `《${s.title}》`).join('、')}（云端）`)
    }
    if (typeof r.data?.remaining === 'number') {
      console.log(`  （今日 AI 额度余 ${r.data.remaining}）`)
    }
    appendDialog(root, { ts: new Date().toISOString(), role: 'user', content: question, track: 'cloud' })
    appendDialog(root, { ts: new Date().toISOString(), role: 'assistant', content: r.data?.answer ?? '', track: 'cloud', meta: { sources: sources.map((s) => s.title) } })
  } else {
    console.log(`小月：${r.message ?? '（未知错误）'}`)
  }
}

async function setupByok(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res))
  console.log('BYOK 直连设置（key 只存本机钥匙串，永不上传）：')
  const baseUrl = (await ask('  API BaseUrl（如 https://api.bigmodel.cn/api/paas/v4 或 http://127.0.0.1:11434/v1）: ')).trim()
  const model = (await ask('  模型名（如 glm-4.7-flash / qwen2.5:7b）: ')).trim()
  const apiKey = (await ask('  API Key（Ollama/LM Studio 本地端点可留空）: ')).trim()
  rl.close()
  if (!baseUrl || !model) {
    console.error('BaseUrl 与模型名必填。')
    process.exitCode = 1
    return
  }
  const cfg: ByokConfig = { baseUrl, model }
  saveByokMeta(cfg)
  if (apiKey) saveByokKey(apiKey)
  console.log(`✓ BYOK 已配置（${model} @ ${baseUrl}）${apiKey ? '，key 入钥匙串' : '（无 key，本地端点模式）'}`)
}

export async function cmdXiaoyue(args: string[], options: CommandOptions): Promise<void> {
  const root = (options.dir as string) ?? loadConfig().vault?.root ?? `${process.env.HOME ?? '.'}/MyMoonVault`

  // BYOK 设置（runner 把 --flag 解析进 options）
  if (args.includes('--setup') || options['setup']) {
    await setupByok()
    return
  }
  if (args.includes('--byok-status') || options['byok-status']) {
    const meta = loadByokMeta()
    console.log(meta ? `BYOK: ${meta.model} @ ${meta.baseUrl}（key ${byokReady() ? '已存' : '未存'}）` : 'BYOK 未配置（moonlybox xiaoyue --setup）')
    return
  }
  if (args.includes('--history') || options['history']) {
    for (const d of recentDialogs(root, 20)) {
      console.log(`[${d.track}] ${d.role === 'user' ? '问' : '答'}: ${d.content.slice(0, 80)}`)
    }
    return
  }

  // Agent 工具模式：moonlybox xiaoyue --tools "问题"（D9 装配：LLM+moonlink 工具循环）
  // 真机验收 bug（2026-09-25）：runner.parseArgs 对 --tools 吞下一个 token 当值（options['tools']=问题文本，
  // args 里不再有它）→ questionArgs 恒空 → usage 死路。兜底：options['tools'] 为字符串时即问题文本。
  const questionArgs = args.filter((a) => !a.startsWith('--'))
  if (args.includes('--tools') || options['tools']) {
    const q = questionArgs.length
      ? questionArgs.join(' ')
      : typeof options['tools'] === 'string'
        ? options['tools']
        : ''
    if (!q) {
      console.error('usage: moonlybox xiaoyue --tools "问题"')
      return
    }
    console.log(`问：${q}`)
    await askWithTools(q)
    return
  }

  // 单问模式：moonlybox xiaoyue "问题" [--cloud]
  if (questionArgs.length) {
    const question = questionArgs.join(' ')
    console.log(`问：${question}`)
    await askOnce(root, question, { forceCloud: args.includes('--cloud') || !!options['cloud'] })
    return
  }

  // REPL：每行一问，exit 退出
  console.log('小月 REPL（exit 退出；--cloud 前缀强制云端轨）')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' })
  rl.prompt()
  rl.on('line', async (line) => {
    const q = line.trim()
    if (!q) {
      rl.prompt()
      return
    }
    if (q === 'exit' || q === 'quit') {
      rl.close()
      return
    }
    if (q.startsWith('--cloud ')) {
      await askOnce(root, q.slice(7).trim(), { forceCloud: true }).catch((e) => console.error(String(e)))
    } else {
      await askOnce(root, q).catch((e) => console.error(String(e)))
    }
    rl.prompt()
  })
  rl.on('close', () => {
    console.log('回见～')
    process.exit(0)
  })
}

import * as nodeReadline from 'node:readline'
import { agentLoop } from '../lib/agent-loop'
import { byokChatMessages, byokReady as byokReady2 } from '../lib/llm'
import { buildMessages, appendTurn, summarizeDropped, chatWithRetry } from '../lib/chat-context'
import { loadSettings } from '../lib/settings'
import { localMemoryAdd, localMemorySearch, localMemoryContext, localMemoryRetrieveBlock } from '../lib/memory-local'
import { skillToolDefs, skillsIndex, viewSkill } from '../lib/skills'
import { webToolDefs, runWebTool } from '../lib/web-tools'
import { docToolDefs, runDocTool } from '../lib/doc-tools'
import { listAllCustomTools, callCustomTool, enabledCustomServers } from '../lib/mcp-custom'
import { getWorkspace, loadChat, appendTurn as wsAppendTurn, isUnderDirs, chatTurnsForContext, primaryDir } from '../lib/workspaces'
import { localTaskToolDefs, runLocalTaskTool } from '../lib/local-tasks-tool'
import { readToolResult } from '../lib/tool-result-store'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultVaultRoot } from '../lib/config'

/** --tools 模式：Agent 循环（D9 装配）——LLM 可调 moonlink 29 工具（写操作确认制） */
async function askWithTools(question: string): Promise<void> {
  if (!byokReady()) {
    console.error('工具模式需要 BYOK：先运行 `moonlybox xiaoyue --setup`')
    return
  }
  // CLI 确认通道：stdin readline（P2 起桌面壳走 IPC 确认，见 daemon.ts confirm_request/confirm_response）
  const rl = nodeReadline.createInterface({ input: process.stdin, output: process.stdout })
  const confirm = (toolName: string, argsJson: string) =>
    new Promise<boolean>((resolve) => {
      rl.question(`  执行 ${toolName} ${argsJson.slice(0, 160)}？(y/N) `, (ans) => {
        resolve(CONFIRM_SET.has(ans.trim()))
      })
    })
  try {
    await runAgentTools(question, confirm)
  } catch (e) {
    console.error(`工具模式失败：${String((e as Error).message ?? e)}`)
  } finally {
    rl.close()
  }
}

/** Agent 工具循环核心（CLI 与 daemon 单源）：confirm 由调用方注入（CLI=stdin / daemon=IPC 双向）。 */
export async function runAgentTools(
  question: string,
  confirm: (toolName: string, argsJson: string) => Promise<boolean>,
  opts: { sessionId?: string; chatId?: string; workspaceId?: string | null } = {},
): Promise<{ answer: string; toolCalls: Array<{ name: string; ok: boolean }> }> {
  // #278：记忆设置接线——enabled=false 记忆指引不进 system+记忆工具不装配；provider=builtin 走本地文件记忆
  // #282 工作空间：有 workspaceId→挂载目录读取+fs 工具装配；chatId→会话持久化+恢复
  const wsRec = opts.workspaceId ? getWorkspace(opts.workspaceId) : null
  const wsDirs = wsRec?.dirs ?? []
  const wsMain = wsRec ? primaryDir(wsRec) : undefined
  if (opts.chatId) {
    // 恢复历史（daemon 重启后 chat-context 内存会话丢——从盘回灌）
    const turns = chatTurnsForContext(opts.chatId)
    if (turns.length) {
      const { getSession, clearSession } = await import('../lib/chat-context')
      clearSession(opts.chatId)
      for (const t of turns) getSession(opts.chatId).push({ role: t.role, content: t.content })
    }
    wsAppendTurn(opts.chatId, 'user', question)
  }
  // #281：记忆模式唯一（本机内置+月忆增强）——provider 判定退役，本机记忆层恒在（enabled 控制注入与工具）
  const memCfg = loadSettings().memory ?? { enabled: true, injectLimit: 5000 }
  const memOn = memCfg.enabled !== false
  const memLocal = true
  // #285 技能系统：书房 .moonlybox/skills/ 只读消费（渐进披露——system 只注入索引，skill_view 拉全文）
  const skillsOn = (loadSettings().skills ?? { enabled: true }).enabled !== false
  const skillDefs = skillsOn ? skillToolDefs() : []
  // #279 内置网络工具定义（web_search 仅在配置了搜索服务商时装配；fetch_url 恒装配）
  const wDefs = webToolDefs()
  // #287 文档处理：doc_read 恒装配（本地档零网络可用；provider 档按设置分发）
  const dDefs = docToolDefs()
  // #280 自定义 MCP：启用中的服务器工具并列装配（失败隔离——失败服务器只报告不阻塞）
  const customCat = await listAllCustomTools()
  const customDefs = customCat.tools
  // #316.5：local_task 工具组（任务机制能力——创建/查询/取消走后台任务，不在对话内联执行）
  const ltDefs = localTaskToolDefs()
  const system =
    `你是「小月」，用户个人知识库（魔力宝盒）的操作助理，通过工具完成收藏/便签/待办/记忆/书房查询/联网等操作——具体可用工具以本轮「当前可用工具」清单为准（未列出的不要臆造）。\n` +
    `批量知识整理：用户想把文档「整理成知识页」时，先 local_task_list_uncompiled 扫描未整理清单（只报数量，不要把整个路径清单念给用户），经确认后 local_task_create_compile 创建后台任务——整理全部时不传 paths（自动全量），只整理部分才传路径数组；不要在对话里逐篇处理；任务进度在「任务」页可见，用户问进度用 local_task_status。工具返回 ok:false 时必须如实告知失败原因，不得编造成功。\n` +
    `纪律：1. 用户意图涉及「记录/收藏/保存/查询」时主动调工具，不要只口头答应；\n` +
    `2. 参数从用户话里提取，缺关键参数先问；3. 操作完成后用一句话汇报结果；\n` +
    (memOn && memLocal ? `3.5. 用户陈述的长期事实/偏好会由记忆层静默沉淀（无需口头确认）；\n` : ``) +
    `4. 语气亲切简洁，中文回答。\n` +
    `5. 查询类工具返回空结果（0 条/空列表）时，如实回答「没有找到」即可——不要自作主张转为创建/修改等写操作；用户没要求新建就不要新建。\n` +
    (skillsOn ? `\n6. 用户书房有自定义技能（skill_list 可列出）；任务命中技能描述时先 skill_view 读取全文、按其中的流程与规范执行。` : ``) +
    (wsDirs.length ? `\n5. 当前工作空间「${wsRec!.name}」已挂载目录：${wsDirs.join('、')}（主目录：${wsMain}）。fs_list/fs_read/fs_write 工具仅可操作这些目录内的文件（相对路径基于主目录 ${wsMain}，其余目录传绝对路径）；超出范围的路径会被拒绝或需用户批准，不要尝试绕过。` : ``)
  // #256.3：上下文管理（设置可关）——buildMessages 组装历史/压缩，appendTurn 落账
  const sessionId = opts.sessionId ?? 'default'
  const built = buildMessages(sessionId, system, question)
  // 压缩发生时：真调 LLM 生成摘要回填占位（#317.3——此前硬编码一句空话=失忆根因）
  if (built.compressed && built.dropped.length > 0) {
    const summaryMsg = built.messages.find((m) => m.role === 'system' && String(m.content).startsWith('[CONTEXT_SUMMARY]'))
    if (summaryMsg) {
      try {
        const real = await summarizeDropped((msgs) => chatWithRetry(() => byokChatMessages(msgs, undefined)), built.dropped)
        summaryMsg.content = `[对话摘要] ${real}`
        console.log(`（上下文已压缩：${built.dropped.length} 轮 → 摘要 ${real.length} 字）`)
      } catch (e: any) {
        // 摘要生成失败：保底把被压缩轮次的「用户侧要点」逐条带上（不丢主干事实）
        const fallback = built.dropped.filter((t) => t.role === 'user').map((t) => '- ' + t.content.slice(0, 80)).join('\n')
        summaryMsg.content = `[对话摘要] 摘要生成失败，以下是更早对话中用户提出过的要求：\n${fallback}`
        console.log(`（上下文已压缩：摘要生成失败，回落要点 ${fallback.length} 字）`)
      }
    }
  }
  // agentLoop.chat 签名=byokChatMessages——注入重试包装（#256.3 模型重试次数设置生效点）
  // #278 builtin 档=本地文件记忆层：add_memory/search_memory 本地劫持（数据不出本机）；
  // moonrecall 档=现远程 MoonLink 工具（云端 memory_entities 单源+确认制）
  const localToolsW: Record<string, (args: Record<string, unknown>) => Promise<string>> = {}
  for (const d of wDefs) localToolsW[d.name] = (args) => runWebTool(d.name, args)
  for (const d of dDefs) localToolsW[d.name] = (args) => runDocTool(d.name, args)
  // #285 技能工具执行器（只读：索引/全文/关联文件；vault 内数据不出本机）
  if (skillsOn) {
    const vr = defaultVaultRoot()
    localToolsW['skill_list'] = async () => {
      const idx = skillsIndex(vr)
      return JSON.stringify({ ok: true, count: idx ? idx.split('\n').length : 0, skills: idx || '（书房暂无技能——把含 SKILL.md 的技能目录放进 书房/.moonlybox/skills/ 即生效）' })
    }
    localToolsW['skill_view'] = async (args) => {
      const r = viewSkill(vr, String(args.name ?? ''))
      return JSON.stringify(r.ok ? { ok: true, content: r.content.slice(0, 12_000) } : { ok: false, error: r.error })
    }
    localToolsW['skill_file'] = async (args) => {
      const r = viewSkill(vr, String(args.name ?? ''), String(args.file ?? ''))
      return JSON.stringify(r.ok ? { ok: true, path: r.path, content: r.content.slice(0, 12_000) } : { ok: false, error: r.error })
    }
  }
  // #280 自定义 MCP 工具执行器（catalog 闭包随本轮装配）
  for (const d of customDefs) localToolsW[d.name] = (args) => callCustomTool(d.name, args, customCat).then((r) => JSON.stringify({ ok: r.ok, content: r.text }))
  // #316.5：local_task 工具执行器（后台任务单源——创建后立即返回 jobId，不在对话内联执行）
  for (const d of ltDefs) localToolsW[d.name] = (args) => runLocalTaskTool(d.name, args)
   // #317.1：工具结果全文读取（落盘引用注入配套——大结果存 .moonlybox/cache，LLM 按引用拉全文）
   localToolsW['tool_result_read'] = async (args) => {
     const r = readToolResult(defaultVaultRoot(), String(args.path ?? ''))
     return JSON.stringify(r)
   }
  // #282 工作空间 fs 工具（仅工作空间对话装配）：路径必须落在挂载目录内——越界返回 needs_approval 交 confirm 批准
  const fsTools: Array<{ name: string; title?: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema: unknown }> = []
  if (wsDirs.length) {
    const guard = (abs: string) => isUnderDirs(abs, wsDirs)
    fsTools.push(
      {
        name: 'fs_list',
        title: '列出工作目录',
        description: `列出工作空间挂载目录（${wsDirs.join('、')}）下的文件与子目录。相对路径基于主目录（${wsMain}）解析，也可传绝对路径（须在挂载目录内）。`,
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { dir: { type: 'string', description: '可选，子目录相对路径或绝对路径；缺省=挂载目录根' } } },
      },
      {
        name: 'fs_read',
        title: '读取工作文件',
        description: `读取工作空间挂载目录内的文本文件内容（≤32KB 截断）。相对路径基于主目录解析。`,
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件相对路径或绝对路径（须在挂载目录内）' } }, required: ['path'] },
      },
      {
        name: 'fs_write',
        title: '写入工作文件',
        description: `写入/创建工作空间挂载目录内的文本文件（覆盖须谨慎）。相对路径基于主目录解析。写操作需用户确认。`,
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件相对路径或绝对路径（须在挂载目录内）' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] },
      },
    )
    const resolveIn = (p: string): string => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(wsMain ?? wsDirs[0]!, p))
    localToolsW.fs_list = async (args) => {
      const dir = resolveIn(String(args.dir ?? '.'))
      if (!guard(dir)) return JSON.stringify({ ok: false, needsApproval: true, error: '路径超出工作空间挂载目录范围' })
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((e) => ({ name: e.name, dir: e.isDirectory() }))
        return JSON.stringify({ ok: true, dir, items })
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: String(e?.message ?? e) })
      }
    }
    localToolsW.fs_read = async (args) => {
      const f = resolveIn(String(args.path ?? ''))
      if (!guard(f)) return JSON.stringify({ ok: false, needsApproval: true, error: '路径超出工作空间挂载目录范围' })
      try {
        const content = fs.readFileSync(f, 'utf8')
        return JSON.stringify({ ok: true, path: f, truncated: content.length > 32_000, content: content.slice(0, 32_000) })
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: String(e?.message ?? e) })
      }
    }
    localToolsW.fs_write = async (args) => {
      const f = resolveIn(String(args.path ?? ''))
      if (!guard(f)) return JSON.stringify({ ok: false, needsApproval: true, error: '路径超出工作空间挂载目录范围——需用户批准' })
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, String(args.content ?? ''), 'utf8')
        return JSON.stringify({ ok: true, path: f, bytes: Buffer.byteLength(String(args.content ?? '')) })
      } catch (e: any) {
        return JSON.stringify({ ok: false, error: String(e?.message ?? e) })
      }
    }
  }
  const baseLocalTools: Record<string, (args: Record<string, unknown>) => Promise<string>> = memOn && memLocal
    ? {
        add_memory: async (args: Record<string, unknown>) => {
          const r = localMemoryAdd(defaultVaultRoot(), String(args.text ?? ''))
          if (!r.ok) return JSON.stringify({ ok: false, message: '空文本' })
          // #284：同步到月忆——本机沉淀成功（非重复）且开关开启时，同文上行云端 quick-capture 候选池。
          // 确认制：云端候选池用户确认后才进正式记忆；上行失败不阻断本机记忆（静默，仅活动流一行）。
          let moonNote = ''
          if (!r.duplicated && memCfg.syncToMoon) {
            try {
              const { apiPost } = await import('../lib/api')
              await apiPost('/memory/quick-capture', { text: String(args.text ?? '').trim().slice(0, 1000) })
              moonNote = '；已同步到月忆候选池'
            } catch (e: any) {
              moonNote = '；月忆同步失败（不影响本机记忆）'
              console.log(`⚠ 月忆同步失败：${String(e?.message ?? e)}`)
            }
          }
          return JSON.stringify({ ok: true, duplicated: r.duplicated, layer: 'local', message: r.duplicated ? '已存在，跳过' : `已沉淀到本机记忆${moonNote}` })
        },
        search_memory: async (args: Record<string, unknown>) => {
          const hits = localMemorySearch(defaultVaultRoot(), String(args.query ?? ''))
          return JSON.stringify({ ok: true, count: hits.length, memories: hits })
        },
      }
    : {}
  let localTools: Record<string, (args: Record<string, unknown>) => Promise<string>> = { ...baseLocalTools, ...localToolsW }
  // #317.⑥ 子任务隔离（D8 用户定案：仅设置里手动开启——默认不装配）
  // #317.6b 三层判定：总闸开 且 实例覆盖≠false 且（覆盖=true 或 auto 按部署形态判定——云端开/本地参数量判定/未知关）
  const stNow = loadSettings()
  const mrefNow = stNow.model?.default ?? ''
  const findInst = () => {
    if (!mrefNow) return null
    const p = (stNow.model?.providers ?? []).find((x) => `platform:${x.id}` === mrefNow)
    if (p) return p as { subAgentOverride?: boolean | 'auto' }
    const c = (stNow.model?.custom ?? []).find((x) => `custom:${x.id}` === mrefNow)
    if (c) return c as { subAgentOverride?: boolean | 'auto' }
    const l = (stNow.model?.local ?? []).find((x) => `local:${x.id}` === mrefNow)
    return l ? (l as { subAgentOverride?: boolean | 'auto' }) : null
  }
  const ovNow = findInst()?.subAgentOverride ?? 'auto'
  let subAgentAllow = false
  if (stNow.agent?.subAgent === true && ovNow !== false) {
    if (ovNow === true) subAgentAllow = true
    else {
      const { subAgentVerdict } = await import('../lib/sub-agent-policy')
      subAgentAllow = subAgentVerdict(mrefNow).allow
    }
  }
  if (subAgentAllow) {
    localTools = {
      ...localTools,
      sub_agent: async (args: Record<string, unknown>) => {
        const goal = String(args.goal ?? '').trim()
        if (!goal) return JSON.stringify({ ok: false, error: 'goal 不能为空' })
        const context = String(args.context ?? '').trim()
        console.log(`（小月派出子任务：${goal.slice(0, 40)}）`)
        // D5：子过程静默——子 say 收集进缓冲（不进活动流），结束只回一行
        const childBuf: string[] = []
        // D6：精简 system——不带记忆/技能注入；D1：子 builtinTools 不含 sub_agent（禁套娃靠「子任务走本闭包外独立装配」实现——
        // 子 agentLoop 的 localTools 不含 sub_agent、builtinTools 由本装配排除）
        const childSys = `你是小月派出的专注子任务助理。只完成委托给你的任务，不要询问委托方以外的问题。完成或受阻时输出结论性回答（含关键事实/决定/未完成事项，500 字内）。`
        try {
          const r = await agentLoop({
            system: childSys,
            question: context ? `${goal}\n\n背景：${context}` : goal,
            ready: true,
            excludeTools: ['add_memory', 'search_memory', 'sub_agent'],
            localTools: { ...localTools, sub_agent: undefined } as never,
            builtinTools: subAgentBuiltinTools(),
            vaultRoot: defaultVaultRoot(),
            chat: childChat,
            confirm, // D4：确认透传主会话
            say: (l: string) => { childBuf.push(l) },
          })
          console.log(`（子任务完成：${r.answer.slice(0, 60)}…）`)
          return JSON.stringify({ ok: true, answer: r.answer, toolCalls: r.toolCalls.length, log: childBuf.slice(-20) })
        } catch (e: any) {
          return JSON.stringify({ ok: false, error: String(e?.message ?? e) })
        }
      },
    }
  }
  // builtin 档：本地记忆上下文注入 system（Hermes 式 6000 字符护栏在 lib 内）
  // #285 技能索引渐进披露：只注入名称+描述清单；小月按需 skill_view 拉全文照做
  const skillIdx = skillsOn ? skillsIndex(defaultVaultRoot()) : ''
  const skillBlock = skillIdx
    ? `

可用技能（用户书房自定义，回答前先对照是否有适用技能；有则先 skill_view 拉全文、照其中的流程执行）：
${skillIdx}`
    : ''
  // #317.④ 记忆检索化：画像（USER.md）常驻+长期记忆（MEMORY.md）按问题检索 top-N——替代全文灌窗+截断
  const memQuery = [question, ...built.messages.filter((m) => m.role === 'user').slice(-2).map((m) => String(m.content))].join(' ')
  const memBlock = memOn && memLocal ? localMemoryRetrieveBlock(defaultVaultRoot(), memQuery, { topN: 8, maxChars: Math.min(1200, memCfg.injectLimit ?? 5000) }) : ''
  // #317.P4：云端模型优化缓存命中（cacheOptimize 默认开，仅云端 API 模型生效）——
  // prompt cache 是前缀匹配：memBlock 每轮随问题变，留在 system 会打碎整个前缀。云端=动态块挪到本轮问题尾部（前缀全静态）；
  // 本地部署无 cache 计费，效率优先维持 memBlock 前置 system（模型对 system 内记忆权重感更高）。
  const cloudModel = await (async () => {
    try {
      const st = loadSettings()
      if (!st.model?.default) return false
      const { pickModelInstance } = await import('../lib/model-registry')
      const inst = pickModelInstance(st.model.default)
      return !!inst && inst.kind !== 'local'
    } catch { return false }
  })()
  const cacheOptimizeOn = cloudModel && loadSettings().chat?.cacheOptimize !== false
  const profileBlock = memOn && memLocal
    ? `

以下是已知的用户画像（本机记忆层，常驻），回答时自然运用，不要逐条复述：
${localMemoryContext(defaultVaultRoot(), 1200)}`
    : ''
  const memTail = memOn && memLocal && memBlock
    ? `

[本机长期记忆·检索命中（与当前问题相关，按需引用）]
${memBlock}`
    : ''
  const systemWithMemory = cacheOptimizeOn
    ? system + profileBlock + skillBlock
    : (memOn && memLocal
        ? `${system}${profileBlock}${memBlock ? `

以下是与你当前问题相关的长期记忆（检索命中，按需引用）：
${memBlock}` : ''}${skillBlock}`
        : system + skillBlock)
  // 云端优化开：memTail 注入本轮问题尾部（agentLoop deps.question）；关：空
  const questionFinal = cacheOptimizeOn ? `${built.messages.filter((m) => m.role === 'user').at(-1)?.content ?? question}${memTail}` : (built.messages.filter((m) => m.role === 'user').at(-1)?.content ?? question)
  for (const f of customCat.failures) console.log(`（自定义 MCP ${f.name} 连接失败：${f.error}）`)
  // #317.⑥ LLM 调用单源（主/子共用；子任务 withThinking=false——D6 精简）
  const makeChatFn = (withThinking: boolean): typeof import('../lib/llm').byokChatMessages => async (messages, tools) => {
    // #283：对话走模型注册表（设置-对话默认模型；空/失效回落旧 byok）
    const { resolveActiveModel } = await import('../lib/model-registry')
    const active = resolveActiveModel()
    // #317.4：思考模式档位（主会话每次调用现读——切档即刻生效；子任务不读，D6 精简）
    const thinking = withThinking && loadSettings().chat?.thinking === 'on' ? ('on' as const) : ('off' as const)
    // #317.F7：本地小模型降档——qwen3:4b 级 ~8 tok/s，16000 上限=最长 32 分钟生成窗口（假死根源）；
    // 对话场景 4096 封顶（300 字回答纪律+工具循环短决策；编译链路独立不受影响），云端维持 16000
    const { isLocalEndpoint } = await import('../lib/llm')
    const localCap = active && isLocalEndpoint(active.baseUrl) ? 4_096 : 16_000
    const r = await chatWithRetry(
      // #310.19：max_tokens 16000——思考型模型 tools 协议下 reasoning 吃掉 4000 全额的余量
      () => byokChatMessages(messages, tools as never, 90_000, active ? { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey } : undefined, localCap, thinking),
      (attempt, total, err) => console.log(`（LLM 调用失败，重试 ${attempt}/${total}：${err.slice(0, 80)}）`),
    )
    // #280.3.2：【真根因修复】toolCalls 必须透传——原 `{ ok, text }` 把 tool_calls 静默丢弃，
    // LLM 请求调工具被无视→循环空转 6 轮→空回答（deepwiki 三轮「无后续输出」的真正根因）
    if (!r.ok) return { ok: false as const, error: r.error }
    const rr = r as { text?: string; toolCalls?: import('../lib/llm').ToolCallRequest[] }
    return { ok: true, text: rr.text, toolCalls: rr.toolCalls }
  }
  const mainChatFn = makeChatFn(true)
  const childChat = makeChatFn(false)
  // ⑥ 子任务工具装配单源：与主会话同款减 sub_agent 自身（D1 禁套娃由「子装配天然不含 sub_agent」保证）
  const subAgentBuiltinTools = () => [
    ...wDefs.map((d) => ({ ...d, annotations: { readOnlyHint: true } })),
    ...customDefs.map((d) => ({ ...d })),
    ...fsTools,
    ...skillDefs,
    ...ltDefs,
    {
      name: 'tool_result_read',
      title: '读取工具结果全文',
      description: '读取此前工具调用被截断保存的完整结果文件（传入引用路径）。',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: '工具结果引用路径' } }, required: ['path'] },
    },
  ]
  const result = await agentLoop({
    system: systemWithMemory,
    question: questionFinal,
    ready: true,
    excludeTools: memOn ? [] : ['add_memory', 'search_memory'],
    localTools,
    builtinTools: [
      ...wDefs.map((d) => ({ ...d, annotations: { readOnlyHint: true } })),
      ...customDefs.map((d) => ({ ...d })),
      ...fsTools,
      ...skillDefs,
      ...ltDefs, // #316.5：local_task 工具组
      { // #317.1：工具结果全文读取（只读）
        name: 'tool_result_read',
        title: '读取工具结果全文',
        description: '读取此前工具调用被截断保存的完整结果文件（传入引用路径）。',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: '工具结果引用路径' } }, required: ['path'] },
      },
    ],
    vaultRoot: defaultVaultRoot(),
    chat: mainChatFn,
    confirm,
    say: (line) => console.log(line),
  })
  if (result.answer) {
    console.log(`小月：${result.answer}`)
    appendTurn(sessionId, question, result.answer)
    if (opts.chatId) wsAppendTurn(opts.chatId, 'assistant', result.answer)
  } else if (!result.toolCalls.length) {
    // #280.3：LLM 链路整体成功但零输出——给可见引导行，绝不让小月静默
    console.log('（小月这次没有返回内容——请重试；若反复出现，检查模型是否兼容工具调用，或联系反馈）')
  }
  if (result.toolCalls.length) {
    const ok = result.toolCalls.filter((t) => t.ok).length
    console.log(`（工具调用 ${ok}/${result.toolCalls.length} 成功）`)
  }
  // #317.⑤ 技能自沉淀：后台轻评估（fire-and-forget；节流=同会话距上次 ≥10 轮且每次会话最多触发 3 次）
  void maybeSelfImprove(sessionId, built.messages, result).catch(() => {})
  return result
}

// --- #317.⑤ 自我改进（静默+回执，不询问——用户定案） ---
const _siState = new Map<string, { turns: number; runs: number }>()

async function maybeSelfImprove(sessionId: string, messages: Array<{ role: string; content?: unknown }>, result: { answer?: string }): Promise<void> {
  const st = _siState.get(sessionId) ?? { turns: 0, runs: 0 }
  st.turns++
  // 节流：≥10 轮且每会话 ≤3 次；有最终回答才评估（纯工具轮无对话内容）
  if (st.turns < 10 || st.runs >= 3 || !result.answer) { _siState.set(sessionId, st); return }
  st.turns = 0
  st.runs++
  _siState.set(sessionId, st)
  const vaultRoot = defaultVaultRoot()
  const skillsOn = (loadSettings().skills ?? { enabled: true }).enabled !== false
  const digest = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '用户' : '小月'}：${String(m.content).slice(0, 200)}`)
    .join('\n')
    .slice(-6000)
  const skillIdx = skillsOn ? (skillsIndex(vaultRoot) || '（暂无技能）') : '（技能系统关闭）'
  const evalSystem =
    `你是后台自我改进评估器。根据本轮对话摘要，判断是否值得沉淀为「技能」（可复用的流程/规范，而非事实）或「记忆」（用户长期事实/偏好）。\n` +
    `对话多为一次性问答/闲聊/查询时必须输出 NO。宁可漏掉不可编造。\n` +
    `已有技能索引（防重复）：\n${skillIdx}\n\n本轮对话摘要：\n${digest}\n\n` +
    `输出严格 JSON（无其他文本）：\n` +
    `{"skill":{"name":"简短中文名","description":"一句话用途","body":"SKILL.md 正文（步骤化，150 字内）"} 或 null,"memory":"一条记忆文本" 或 null}`
  const { resolveActiveModel } = await import('../lib/model-registry')
  const active = resolveActiveModel()
  const er = await byokChatMessages([{ role: 'user', content: evalSystem }], undefined, 60_000, active ? { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey} : undefined, 2_000)
  if (!er.ok || !er.text) return
  const jm = er.text.match(/\{[\s\S]*\}/)
  if (!jm) return
  let verdict: { skill?: { name: string; description: string; body: string } | null; memory?: string | null } | null = null
  try { verdict = JSON.parse(jm[0]) } catch { return }
  const maxCount = loadSettings().skills?.maxCount ?? 20
  if (skillsOn && verdict?.skill?.name && verdict.skill.body) {
    const { skillAutoWrite, skillFingerprint } = await import('../lib/skills')
    const wr = skillAutoWrite(vaultRoot, verdict.skill, { maxCount })
    if (wr.ok) {
      const fp = skillFingerprint(wr.name, verdict.skill.description)
      // 回执模板（用户定案文案）：静默完成后报账
      console.log(`（小月正在从历史对话中自我改进：技能「${wr.name}」·${wr.action === 'created' ? '新建' : '更新'}·${fp}）`)
    } else if (wr.reason) {
      console.log(`（自我改进跳过：${wr.reason}）`)
    }
  }
  if (verdict?.memory) {
    const { localMemoryAdd } = await import('../lib/memory-local')
    const mr = localMemoryAdd(vaultRoot, String(verdict.memory).slice(0, 500))
    if (mr.ok && !mr.duplicated) {
      // 记忆标识=条目短指纹（memory-local 无 ID——用内容 hash 前 8 位）
      const h = require('node:crypto') as typeof import('node:crypto')
      const fp = h.createHash('sha256').update(String(verdict.memory)).digest('hex').slice(0, 8)
      console.log(`（小月正在从历史对话中沉淀记忆：${fp}）`)
    }
  }
}

const CONFIRM_SET = new Set(['y', 'Y', 'yes', 'Yes', '是', '好'])
