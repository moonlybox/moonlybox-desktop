import type { CommandOptions } from '../lib/runner'
import { loadCredentials } from '../lib/auth'
import { defaultBaseUrl } from '../lib/config'
import { apiCall } from '../lib/api'
import * as readline from 'node:readline'

/**
 * 小月终端对话（WBS 任务 6）：POST /api/ai/xiaoyue/ask 单轮问答（#227 服务端已含
 * 检索注入+答案纪律+配额）。CLI 提供 REPL：每行一问，`exit` 退出；来源列表随答显示。
 */
interface AskResult {
  ok: boolean
  message?: string
  data?: { answer: string; sources: Array<{ id: string; title: string; kind: string }>; remaining?: number }
}

async function askOnce(question: string): Promise<AskResult> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录：先运行 `moonlybox login`')
  const res = await apiCall<AskResult>('POST', '/api/ai/xiaoyue/ask', { question }, {
    token: creds.accessToken,
    baseUrl: defaultBaseUrl(),
    timeoutMs: 60_000,
  })
  return res.data ?? { ok: false, message: `HTTP ${res.status}` }
}

function printAnswer(r: AskResult): void {
  if (!r.ok) {
    console.log(`小月：${r.message ?? '（未知错误）'}`)
    return
  }
  console.log(`小月：${r.data?.answer}`)
  const sources = r.data?.sources ?? []
  if (sources.length) {
    console.log(`  来源：${sources.map(s => `《${s.title}》`).join('、')}`)
  }
  if (typeof r.data?.remaining === 'number') {
    console.log(`  （今日 AI 额度余 ${r.data.remaining}）`)
  }
}

export async function cmdXiaoyue(args: string[], options: CommandOptions): Promise<void> {
  // 单问模式：moonlybox xiaoyue "问题"
  if (args.length) {
    const question = args.join(' ')
    const r = await askOnce(question)
    console.log(`问：${question}`)
    printAnswer(r)
    return
  }

  // REPL 模式
  const creds = loadCredentials()
  if (!creds?.accessToken) {
    console.error('Not logged in. Run `moonlybox login` first.')
    process.exitCode = 1
    return
  }
  console.log('小月终端已连接（输入问题回车发送，exit 退出）')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你：' })
  rl.prompt()
  rl.on('line', async (line: string) => {
    const q = line.trim()
    if (!q) { rl.prompt(); return }
    if (q === 'exit' || q === 'quit') { rl.close(); return }
    try {
      const r = await askOnce(q)
      printAnswer(r)
    } catch (e: any) {
      console.log(`小月：连接失败（${e.message}）`)
    }
    rl.prompt()
  })
  rl.on('close', () => {
    console.log('再见～')
    process.exit(0)
  })
}
