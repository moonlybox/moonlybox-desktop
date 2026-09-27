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
import { localMemoryAdd, localMemorySearch, localMemoryContext } from '../lib/memory-local'
import { skillToolDefs, skillsIndex, viewSkill } from '../lib/skills'
import { webToolDefs, runWebTool } from '../lib/web-tools'
import { listAllCustomTools, callCustomTool, enabledCustomServers } from '../lib/mcp-custom'
import { getWorkspace, loadChat, appendTurn as wsAppendTurn, isUnderDirs, chatTurnsForContext, primaryDir } from '../lib/workspaces'
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
  // #280 自定义 MCP：启用中的服务器工具并列装配（失败隔离——失败服务器只报告不阻塞）
  const customCat = await listAllCustomTools()
  const customDefs = customCat.tools
  const system =
    `你是「小月」，用户个人知识库（魔力宝盒）的操作助理。你可以调用 MoonLink 工具帮用户：\n` +
    `收藏网页（add_bookmark）、记便签（add_sticky）、记待办（add_todo/complete_todo）、` +
    (memOn ? `保存记忆（add_memory）、` : ``) +
    `查询书房（search_library/search_bookmarks${memOn ? '/search_memory' : ''}）${wDefs.length ? '，并可联网：web_search 网络搜索、fetch_url 读取网页' : ''}${customDefs.length ? `，以及自定义 MCP 服务器工具（${enabledCustomServers().map((s) => s.name).join('、')}）` : ''}等。\n` +
    `纪律：1. 用户意图涉及「记录/收藏/保存/查询」时主动调工具，不要只口头答应；\n` +
    `2. 参数从用户话里提取，缺关键参数先问；3. 操作完成后用一句话汇报结果；\n` +
    (memOn && memLocal ? `3.5. 用户陈述的长期事实/偏好会由记忆层静默沉淀（无需口头确认）；\n` : ``) +
    `4. 语气亲切简洁，中文回答。` +
    (skillsOn ? `\n6. 用户书房有自定义技能（skill_list 可列出）；任务命中技能描述时先 skill_view 读取全文、按其中的流程与规范执行。` : ``) +
    (wsDirs.length ? `\n5. 当前工作空间「${wsRec!.name}」已挂载目录：${wsDirs.join('、')}（主目录：${wsMain}）。fs_list/fs_read/fs_write 工具仅可操作这些目录内的文件（相对路径基于主目录 ${wsMain}，其余目录传绝对路径）；超出范围的路径会被拒绝或需用户批准，不要尝试绕过。` : ``)
  // #256.3：上下文管理（设置可关）——buildMessages 组装历史/压缩，appendTurn 落账
  const sessionId = opts.sessionId ?? 'default'
  const built = buildMessages(sessionId, system, question)
  // 压缩发生时：先把摘要占位换成本次生成的真摘要（一次性，落本轮 messages）
  if (built.compressed) {
    const summaryMsg = built.messages.find((m) => m.role === 'system' && String(m.content).startsWith('[CONTEXT_SUMMARY]'))
    if (summaryMsg) {
        summaryMsg.content = '[对话摘要] 更早对话已压缩为要点'
      console.log('（上下文已压缩）')
    }
  }
  // agentLoop.chat 签名=byokChatMessages——注入重试包装（#256.3 模型重试次数设置生效点）
  // #278 builtin 档=本地文件记忆层：add_memory/search_memory 本地劫持（数据不出本机）；
  // moonrecall 档=现远程 MoonLink 工具（云端 memory_entities 单源+确认制）
  const localToolsW: Record<string, (args: Record<string, unknown>) => Promise<string>> = {}
  for (const d of wDefs) localToolsW[d.name] = (args) => runWebTool(d.name, args)
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
  const localTools = { ...baseLocalTools, ...localToolsW }
  // builtin 档：本地记忆上下文注入 system（Hermes 式 6000 字符护栏在 lib 内）
  // #285 技能索引渐进披露：只注入名称+描述清单；小月按需 skill_view 拉全文照做
  const skillIdx = skillsOn ? skillsIndex(defaultVaultRoot()) : ''
  const skillBlock = skillIdx
    ? `

可用技能（用户书房自定义，回答前先对照是否有适用技能；有则先 skill_view 拉全文、照其中的流程执行）：
${skillIdx}`
    : ''
  const systemWithMemory =
    memOn && memLocal
      ? `${system}

以下是已知的用户画像与长期记忆（本机记忆层），回答时自然运用，不要逐条复述：
${localMemoryContext(defaultVaultRoot(), memCfg.injectLimit ?? 5000)}${skillBlock}`
      : system + skillBlock
  for (const f of customCat.failures) console.log(`（自定义 MCP ${f.name} 连接失败：${f.error}）`)
  const result = await agentLoop({
    system: systemWithMemory,
    question: built.messages.filter((m) => m.role === 'user').at(-1)?.content ?? question,
    ready: true,
    excludeTools: memOn ? [] : ['add_memory', 'search_memory'],
    localTools,
    builtinTools: [
      ...wDefs.map((d) => ({ ...d, annotations: { readOnlyHint: true } })),
      ...customDefs.map((d) => ({ ...d })),
      ...fsTools,
      ...skillDefs,
    ],
    chat: async (messages, tools) => {
      // #283：对话走模型注册表（设置-对话默认模型；空/失效回落旧 byok）
      const { resolveActiveModel } = await import('../lib/model-registry')
      const active = resolveActiveModel()
      const r = await chatWithRetry(
        () => byokChatMessages(messages, tools as never, 90_000, active ? { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey } : undefined),
        (attempt, total, err) => console.log(`（LLM 调用失败，重试 ${attempt}/${total}：${err.slice(0, 80)}）`),
      )
      // #280.3.2：【真根因修复】toolCalls 必须透传——原 `{ ok, text }` 把 tool_calls 静默丢弃，
      // LLM 请求调工具被无视→循环空转 6 轮→空回答（deepwiki 三轮「无后续输出」的真正根因）
      if (!r.ok) return { ok: false as const, error: r.error }
      const rr = r as { text?: string; toolCalls?: import('../lib/llm').ToolCallRequest[] }
      return { ok: true, text: rr.text, toolCalls: rr.toolCalls }
    },
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
  return result
}

const CONFIRM_SET = new Set(['y', 'Y', 'yes', 'Yes', '是', '好'])
