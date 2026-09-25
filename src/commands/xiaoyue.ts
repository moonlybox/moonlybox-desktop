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
): Promise<{ answer: string; toolCalls: Array<{ name: string; ok: boolean }> }> {
  const system =
    `你是「小月」，用户个人知识库（魔力宝盒）的操作助理。你可以调用 MoonLink 工具帮用户：\n` +
    `收藏网页（add_bookmark）、记便签（add_sticky）、记待办（add_todo/complete_todo）、\n` +
    `保存记忆（add_memory）、查询书房（search_library/search_bookmarks/search_memory）等。\n` +
    `纪律：1. 用户意图涉及「记录/收藏/保存/查询」时主动调工具，不要只口头答应；\n` +
    `2. 参数从用户话里提取，缺关键参数先问；3. 操作完成后用一句话汇报结果；\n` +
    `4. 语气亲切简洁，中文回答。`
  const result = await agentLoop({
    system,
    question,
    ready: true,
    chat: byokChatMessages,
    confirm,
    say: (line) => console.log(line),
  })
  if (result.answer) console.log(`小月：${result.answer}`)
  if (result.toolCalls.length) {
    const ok = result.toolCalls.filter((t) => t.ok).length
    console.log(`（工具调用 ${ok}/${result.toolCalls.length} 成功）`)
  }
  return result
}

const CONFIRM_SET = new Set(['y', 'Y', 'yes', 'Yes', '是', '好'])
