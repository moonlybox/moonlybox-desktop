/**
 * 对话上下文管理（#256.3）：会话历史 + 压缩 + 模型重试。
 *
 * 纪律：
 * - 会话仅存内存（daemon 进程生命周期），不落盘——隐私默认；daemon 重启即清空；
 * - 压缩=把旧轮次交给 LLM 摘要成一条 system 摘要消息（compressTarget% 容量），阈值=触发线（%）；
 * - 重试=LLM 调用失败自动重试 maxRetries 次（指数退避 1s*2^n 封顶 30s），网络/限流场景自愈。
 * - settings（chat 节）运行时可变——每次进入会话时读最新值，改设置即刻生效。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings } from './settings'
import { configDir } from './config'
import type { ChatMessage } from './llm'

export interface SessionTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 会话仓库：key=会话 id（壳侧每轮对话传 sessionId；CLI 单会话） */
const sessions = new Map<string, SessionTurn[]>()

const MAX_TURNS = 200 // 硬上限（防内存膨胀）；超限先丢最老

// #327：默认会话盘镜像——「小月」tab 直发（无 chatId）此前纯内存，daemon 重启（RPC 超时自愈/热重载/崩溃）即失忆
// （真机复现：扫描 39 条征确认→daemon 重启→回「开始」小月打招呼）。chatId 链已有盘回灌（workspaces.ts），
// 这里给 default 链补一致性：内存空时从盘回灌，appendTurn 同步写盘（本机 0600，与 chat 记录同级隐私）。
function sessionFile(sessionId: string): string {
  return path.join(configDir(), `chat-session-${sessionId}.json`)
}

function loadSessionDisk(sessionId: string): SessionTurn[] {
  try {
    const arr = JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8'))
    // #329.15：回灌过滤垃圾 assistant（工具调用文本化）——盘上历史若已被污染，回灌时清洗（防模仿繁殖）
    return Array.isArray(arr)
      ? arr
          .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
          .filter((t: any) => t.role !== 'assistant' || !(/\btool_[a-z_]+\s*path\s*[A-Za-z]:\\/.test(t.content) || /^\s*(tool_result_read|organize_bookmarks|search_bookmarks|local_task_[a-z_]+)\s*(path|[\{\[])/i.test(t.content.trim())))
          .slice(-MAX_TURNS)
      : []
  } catch {
    return []
  }
}

function saveSessionDisk(sessionId: string, turns: SessionTurn[]): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(sessionFile(sessionId), JSON.stringify(turns.slice(-MAX_TURNS)), { mode: 0o600 })
  } catch {}
}

export function getSession(sessionId: string): SessionTurn[] {
  let s = sessions.get(sessionId)
  if (!s) {
    s = loadSessionDisk(sessionId) // #327：内存空→盘回灌（daemon 重启后恢复）
    sessions.set(sessionId, s)
  }
  return s
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
  try { fs.unlinkSync(sessionFile(sessionId)) } catch {}
}

/** 组装带上下文的 messages：system + （可选）摘要 + 历史 + 新问题 */
export function buildMessages(
  sessionId: string,
  system: string,
  question: string,
): { messages: ChatMessage[]; compressed: boolean; dropped: SessionTurn[] } {
  const st = loadSettings().chat
  const history = getSession(sessionId)
  const turns: SessionTurn[] = st.contextEnabled ? history.slice() : []

  // 压缩判定：历史轮数按 token 近似（4 字符≈1 token，中英混合粗估）换算容量占比
  let compressed = false
  const approxTokens = (t: SessionTurn) => Math.ceil(t.content.length / 3)
  const totalTokens = turns.reduce((a, t) => a + approxTokens(t), 0)
  // max_tokens 1500 输出 + 系统提示，输入预算按 ~6000 token 估——阈值/目标按此基准算百分比
  const BUDGET = 6000
  if (st.contextEnabled && st.autoCompress && turns.length >= 4 && totalTokens >= (st.compressThreshold / 100) * BUDGET) {
    // 压缩到 compressTarget%：保留最近几轮原文 + 更早内容摘要占位（摘要由调用方 LLM 生成后回填）
    const keepTokens = (st.compressTarget / 100) * BUDGET
    let kept: SessionTurn[] = []
    let keptTokens = 0
    for (let i = turns.length - 1; i >= 0; i--) {
      const tk = approxTokens(turns[i])
      if (keptTokens + tk > keepTokens) break
      kept.unshift(turns[i])
      keptTokens += tk
    }
    const dropped = turns.slice(0, turns.length - kept.length)
    if (dropped.length > 0) {
      // 摘要占位：具体文本由 chatWithRetry 调用方在首调前生成（此处先标 [CONTEXT_SUMMARY] 待回填）
      const summary: ChatMessage = { role: 'system', content: `[CONTEXT_SUMMARY]${dropped.length} 轮更早对话已压缩，摘要待生成` }
      turns.splice(0, turns.length, ...dropped.slice(0, 0), ...kept) // turns=kept（dropped 供摘要生成用）
      history.splice(0, history.length, ...kept) // 内存态同步收缩
      // #317.3：dropped 随返回值交给调用方——调用方真调 LLM 生成摘要后回填占位（此前占位从未回填=失忆根因）
      return { messages: [summary, ...toMessages(system, question, kept)], compressed: true, dropped }
    }
  }
  return { messages: toMessages(system, question, turns), compressed: false, dropped: [] }
}

function toMessages(system: string, question: string, turns: SessionTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]
  for (const t of turns) out.push({ role: t.role, content: t.content })
  out.push({ role: 'user', content: question })
  return out
}

/** 追加本轮问答到会话 */
export function appendTurn(sessionId: string, userQ: string, answer: string): void {
  const st = loadSettings().chat
  if (!st.contextEnabled) return
  const history = getSession(sessionId)
  history.push({ role: 'user', content: userQ })
  history.push({ role: 'assistant', content: answer })
  while (history.length > MAX_TURNS) history.shift()
  saveSessionDisk(sessionId, history) // #327：同步盘镜像
}

/** 压缩摘要生成（用同一 BYOK 通道把丢弃轮次摘要成一段话） */
export async function summarizeDropped(
  chat: (messages: ChatMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }>,
  dropped: SessionTurn[],
): Promise<string> {
  const st = loadSettings().chat
  const transcript = dropped.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n').slice(0, 8000)
  const res = await chat([
    { role: 'system', content: '把以下对话历史压缩成一段简洁摘要（保留关键事实/决定/未完成事项，第三人称，500 字内）：' },
    { role: 'user', content: transcript },
  ])
  if (res.ok && res.text) return res.text
  return `（历史 ${dropped.length} 轮，摘要生成失败：${res.error ?? '未知'}）`
}

/** 带重试的 LLM 调用（chat.maxRetries 次，指数退避） */
// #331.37（P2.5 Auto-Recovery Ladder，对照 Hermes turn_recovery_autorecover.py）：
// 重试耗尽后不立即失败——临时性错误（5xx/overloaded/timeout）+答案未送达→停驻倒计时重入重试；
// 永久类（auth/403/billing/格式）永不进梯（「deterministic for this request」）。
// 调度=jittered 15/30/60/60/60s（Retry-After 优先 cap 120s）；cycles 上限 5。
const LADDER_REASONS = /5\d\d|overloaded|529|timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i
const NON_LADDER_REASONS = /401|403|404|api key|unauthorized|billing|quota|余额|额度|invalid.*key|content policy|unsupported/i
const LADDER_BASE_S = 15
const LADDER_CAP_S = 60
const LADDER_CYCLES = 5
const RETRY_AFTER_CAP_S = 120
function ladderEligible(err: string): boolean {
  return LADDER_REASONS.test(err) && !NON_LADDER_REASONS.test(err)
}
function ladderWaitSeconds(cycle: number, err: string): number {
  const ra = err.match(/retry[- ]after[^\d]*(\d+)/i)
  if (ra) return Math.min(RETRY_AFTER_CAP_S, Number(ra[1]))
  const base = Math.min(LADDER_CAP_S, LADDER_BASE_S * Math.pow(2, cycle - 1))
  return Math.round(base * (0.85 + Math.random() * 0.3)) // ±15% jitter
}

export async function chatWithRetry(
  call: () => Promise<{ ok: boolean; error?: string }>,
  onRetry?: (attempt: number, total: number, error: string) => void,
  onLadder?: (cycle: number, total: number, waitS: number, error: string) => Promise<void> | void,
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  const cfg = loadSettings().chat
  if (cfg.retryEnabled === false) { const r1 = await call(); return { ...r1, attempts: 1 } } // #322：总开关关闭=只调一次
  const total = Math.max(1, cfg.maxRetries)
  let lastErr = ''
  for (let attempt = 1; attempt <= total; attempt++) {
    const res = await call()
    if (res.ok) return { ...res, attempts: attempt }
    lastErr = res.error ?? '未知错误'
    onRetry?.(attempt, total, lastErr)
    if (attempt < total) {
      const delay = Math.min(30_000, 1000 * Math.pow(2, attempt - 1))
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  // #331.37：P2.5 ladder——重试耗尽且临时性错误→停驻重入（「the turn parks with a visible
  // countdown instead of ending in API failed after N retries」）
  for (let cycle = 1; cycle <= LADDER_CYCLES && ladderEligible(lastErr); cycle++) {
    const waitS = ladderWaitSeconds(cycle, lastErr)
    await onLadder?.(cycle, LADDER_CYCLES, waitS, lastErr)
    await new Promise((r) => setTimeout(r, waitS * 1000))
    for (let attempt = 1; attempt <= total; attempt++) {
      const res = await call()
      if (res.ok) return { ...res, attempts: total + cycle }
      lastErr = res.error ?? '未知错误'
      onRetry?.(attempt, total, lastErr)
      if (attempt < total) await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * Math.pow(2, attempt - 1))))
    }
  }
  return { ok: false, error: `重试 ${total} 次仍失败：${lastErr}`, attempts: total }
}
