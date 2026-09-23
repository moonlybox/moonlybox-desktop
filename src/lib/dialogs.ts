/**
 * 对话持久化（#232 M3，#227 对话内存态顺路解决）：
 * `.moonlybox/dialogs/YYYY-MM-DD.jsonl`——每行一条 {ts, role, content, track}。
 * track=local（本地轨，BYOK，内容不出本机）| cloud（云端轨，服务端照常记录）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { vaultDirs } from './sync'

export type Track = 'local' | 'cloud'

export interface DialogEntry {
  ts: string
  role: 'user' | 'assistant'
  content: string
  track: Track
  meta?: Record<string, unknown>
}

function dialogsDir(root: string): string {
  return path.join(vaultDirs(root).meta, 'dialogs')
}

function todayFile(root: string): string {
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = dialogsDir(root)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${day}.jsonl`)
}

export function appendDialog(root: string, entry: DialogEntry): void {
  fs.appendFileSync(todayFile(root), JSON.stringify(entry) + '\n')
}

/** 最近 N 条对话（跨日倒序扫描，供 REPL 上下文/回看） */
export function recentDialogs(root: string, n = 20): DialogEntry[] {
  const dir = dialogsDir(root)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  const out: DialogEntry[] = []
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trimEnd().split('\n').filter(Boolean)
    for (const line of lines.reverse()) {
      try {
        out.push(JSON.parse(line) as DialogEntry)
        if (out.length >= n) return out
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return out
}
