/**
 * 工作空间与对话持久化（#282）：
 * - 工作空间：{id, name, dirs[]}——挂载多个本地工作目录；建立时必选至少一个目录。
 * - 对话：{id, workspaceId|null, title, turns[]}——workspaceId=null=「无工作空间」对话（无本地目录访问，只能用文档库/MCP/技能）。
 * - 全部落 ~/.config/moonlybox/（workspaces.json + chats/<id>.json），0600。
 * - 访问边界：工作空间对话的 fs 工具路径必须落在挂载目录内；越界走 confirm 批准（agent-loop 确认制）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'

export interface Workspace {
  id: string
  name: string
  dirs: string[]
  /** 主目录下标（默认 0）——fs 工具相对路径的解析基准；删除主目录时自动回退 */
  primaryIndex?: number
  createdAt: string
}

export interface ChatMeta {
  id: string
  workspaceId: string | null
  title: string
  createdAt: string
  updatedAt: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRecord extends ChatMeta {
  turns: ChatTurn[]
}

function workspacesFile(): string {
  return path.join(configDir(), 'workspaces.json')
}

function chatsDir(): string {
  return path.join(configDir(), 'chats')
}

function chatFile(id: string): string {
  return path.join(chatsDir(), `${id}.json`)
}

function genId(prefix: string): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${t}${r}`
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 })
}

/* ============================== 工作空间 ============================== */

export function listWorkspaces(): Workspace[] {
  const list = readJson<Workspace[]>(workspacesFile(), [])
  return Array.isArray(list) ? list : []
}

export function getWorkspace(id: string): Workspace | null {
  return listWorkspaces().find((w) => w.id === id) ?? null
}

export function createWorkspace(name: string, dirs: string[], primaryIndex = 0): Workspace {
  const list = listWorkspaces()
  const resolved = dirs.map((d) => path.resolve(d))
  const ws: Workspace = {
    id: genId('ws'),
    name: name.trim() || '未命名工作空间',
    dirs: resolved,
    primaryIndex: primaryIndex > 0 && primaryIndex < resolved.length ? primaryIndex : 0,
    createdAt: new Date().toISOString(),
  }
  list.push(ws)
  writeJson(workspacesFile(), list)
  return ws
}

/** 修改工作空间（改名/增删目录——dirs 全量替换） */
export function updateWorkspace(
  id: string,
  patch: { name?: string; addDir?: string; removeDir?: string; setPrimary?: number },
): Workspace | null {
  const list = listWorkspaces()
  const ws = list.find((w) => w.id === id)
  if (!ws) return null
  if (patch.name !== undefined && patch.name.trim()) ws.name = patch.name.trim()
  if (patch.addDir) {
    const d = path.resolve(patch.addDir)
    if (!ws.dirs.includes(d)) ws.dirs.push(d)
  }
  if (patch.removeDir) {
    const d = path.resolve(patch.removeDir)
    const idx = ws.dirs.indexOf(d)
    ws.dirs = ws.dirs.filter((x) => x !== d)
    // 删除的正是主目录或其下标前移——主目录下标修正（空目录时清掉）
    if (idx >= 0) {
      if (ws.dirs.length === 0) delete ws.primaryIndex
      else if ((ws.primaryIndex ?? 0) === idx) ws.primaryIndex = 0
      else if ((ws.primaryIndex ?? 0) > idx) ws.primaryIndex = (ws.primaryIndex ?? 0) - 1
    }
  }
  if (patch.setPrimary !== undefined) {
    const i = Math.floor(patch.setPrimary)
    if (i >= 0 && i < ws.dirs.length) ws.primaryIndex = i
  }
  writeJson(workspacesFile(), list)
  return ws
}

/** 主目录（fs 相对路径解析基准）：primaryIndex 越界/缺省回退首目录 */
export function primaryDir(ws: Workspace): string | undefined {
  return ws.dirs[ws.primaryIndex ?? 0] ?? ws.dirs[0]
}

export function deleteWorkspace(id: string): boolean {
  const list = listWorkspaces()
  const next = list.filter((w) => w.id !== id)
  if (next.length === list.length) return false
  writeJson(workspacesFile(), next)
  // 该工作空间下对话不删——workspaceId 置 null（降级为无工作空间对话，历史保留）
  for (const c of listChats()) {
    if (c.workspaceId === id) {
      const rec = loadChat(c.id)
      if (rec) saveChat({ ...rec, workspaceId: null })
    }
  }
  return true
}

/** 目录是否在某工作空间的挂载范围内（含子路径） */
export function isUnderDirs(absPath: string, dirs: string[]): boolean {
  const p = path.resolve(absPath)
  return dirs.some((d) => {
    const rel = path.relative(path.resolve(d), p)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/* ============================== 对话 ============================== */

export function listChats(): ChatMeta[] {
  try {
    const dir = chatsDir()
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const rec = readJson<ChatRecord | null>(path.join(dir, f), null)
        return rec ? { id: rec.id, workspaceId: rec.workspaceId, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt } : null
      })
      .filter((x): x is ChatMeta => x !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  } catch {
    return []
  }
}

export function listChatsByWorkspace(workspaceId: string | null): ChatMeta[] {
  return listChats().filter((c) => c.workspaceId === workspaceId)
}

export function loadChat(id: string): ChatRecord | null {
  const rec = readJson<ChatRecord | null>(chatFile(id), null)
  if (!rec || rec.id !== id) return null
  return rec
}

export function saveChat(rec: ChatRecord): ChatRecord {
  const clean: ChatRecord = {
    id: rec.id,
    workspaceId: rec.workspaceId ?? null,
    title: rec.title || '未命名对话',
    createdAt: rec.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: (rec.turns ?? []).slice(-200).map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: String(t.content) })),
  }
  writeJson(chatFile(clean.id), clean)
  return clean
}

export function createChat(workspaceId: string | null, title?: string): ChatRecord {
  const rec: ChatRecord = {
    id: genId('chat'),
    workspaceId,
    title: title?.trim() || '新对话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
  }
  return saveChat(rec)
}

export function appendTurn(id: string, role: 'user' | 'assistant', content: string): ChatRecord | null {
  const rec = loadChat(id)
  if (!rec) return null
  rec.turns.push({ role, content })
  if (rec.title === '新对话' && role === 'user') rec.title = content.slice(0, 24) || rec.title
  return saveChat(rec)
}

export function deleteChat(id: string): boolean {
  try {
    fs.unlinkSync(chatFile(id))
    return true
  } catch {
    return false
  }
}

/** 对话恢复到内存会话仓库（daemon 重启后从盘恢复上下文） */
export function chatTurnsForContext(id: string): ChatTurn[] {
  return loadChat(id)?.turns ?? []
}

// #331.36（P4.5 会话回灌压缩闸，对照 Hermes turn_context_compaction「压缩作用于会话持久层、跨轮生效」；
// chat-context 的 [CONTEXT_SUMMARY] 只服务 CLI 非工具模式——工具模式回灌此前全量无压缩，
// 旧清单/旧方案文本跨轮累积=「常用指令用旧查询结果」的数据源残留）。
// 有意偏离（与 P4 同款登记）：dropped 轮不调 LLM 生成式摘要——确定性提取每轮首行+字数，
// 零成本零方差；[CONTEXT_SUMMARY] 前缀通道 xiaoyue history 过滤已预留。
const CTX_BUDGET_TOKENS = 6000
const COMPRESS_TRIGGER_RATIO = 0.9
const COMPRESS_KEEP_RATIO = 0.4
export function compressTurnsForContext(turns: ChatTurn[]): ChatTurn[] {
  const approxTokens = (t: ChatTurn) => Math.ceil(t.content.length / 3)
  const total = turns.reduce((a, t) => a + approxTokens(t), 0)
  if (turns.length < 4 || total < COMPRESS_TRIGGER_RATIO * CTX_BUDGET_TOKENS) return turns
  const keepBudget = COMPRESS_KEEP_RATIO * CTX_BUDGET_TOKENS
  const kept: ChatTurn[] = []
  let keptTokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const tk = approxTokens(turns[i])
    if (keptTokens + tk > keepBudget) break
    kept.unshift(turns[i])
    keptTokens += tk
  }
  const dropped = turns.slice(0, turns.length - kept.length)
  if (dropped.length < 2) return turns
  const digest = dropped.map((t) => `- ${t.role === 'user' ? '问' : '答'}：${t.content.split('\n')[0].slice(0, 80)}${t.content.length > 80 ? `…（${t.content.length} 字）` : ''}`).join('\n')
  const summary: ChatTurn = { role: 'assistant', content: `［历史摘要］此前 ${dropped.length} 轮对话已压缩：\n${digest}\n（以上为要点提取；当前云端实际状态以工具实时查询为准）` }
  return [summary, ...kept]
}
