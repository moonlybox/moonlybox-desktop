/**
 * 本地文件记忆层（#278）：「内置书房记忆库」档——Hermes 内置范式落地。
 * 存储：vault/.moonlybox/memory/MEMORY.md（事实/偏好条目）+ USER.md（用户画像行），
 * 明文 Markdown、随 vault 备份、数据不出本机（区别于月忆云端 memory_entities）。
 * 注入截断护栏照抄 Hermes：单次注入上限 6000 字符（head 4000 + tail 1500）。
 * 写入侧由 agent-loop localTools 劫持 add_memory/search_memory 调用，不经远程 tools/call。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** 默认注入上限（#281：settings.memory.injectLimit 可配，默认 5000） */
export const DEFAULT_INJECT_LIMIT = 5_000
const TRUNCATION_MARKER = '\n…[记忆过长已截断]…\n'

function memoryDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.moonlybox', 'memory')
}

function ensureFiles(vaultRoot: string): { memFile: string; userFile: string } {
  const dir = memoryDir(vaultRoot)
  fs.mkdirSync(dir, { recursive: true })
  const memFile = path.join(dir, 'MEMORY.md')
  const userFile = path.join(dir, 'USER.md')
  if (!fs.existsSync(memFile)) {
    fs.writeFileSync(memFile, '# 记忆\n\n<!-- 本机记忆层：小月静默沉淀的客观事实与偏好。明文可编辑，随书房备份。 -->\n\n', 'utf8')
  }
  if (!fs.existsSync(userFile)) {
    fs.writeFileSync(userFile, '# 用户画像\n\n<!-- 小月对用户的长期画像（职业/城市/项目/偏好等）。明文可编辑。 -->\n\n', 'utf8')
  }
  return { memFile, userFile }
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 画像行启发式：以「我」开头的第一人称稳定陈述（我在/我叫/我是/我喜欢/我在做…）进 USER.md，其余进 MEMORY.md */
function isProfileLine(text: string): boolean {
  const t = text.trim()
  return /^(我|本人)(在|叫|是|喜欢|偏好|从事|就职|住|用|在做|在做|的)/.test(t) && t.length <= 120
}

/** add_memory：静默沉淀一条记忆（Hermes 式直接落文件；去重=同文本行已存在则跳过） */
export function localMemoryAdd(vaultRoot: string, text: string): { ok: boolean; duplicated: boolean; profile: boolean } {
  const t = text.trim().replace(/\s+/g, ' ').slice(0, 500)
  if (!t) return { ok: false, duplicated: false, profile: false }
  const { memFile, userFile } = ensureFiles(vaultRoot)
  const profile = isProfileLine(t)
  const file = profile ? userFile : memFile
  const existing = fs.readFileSync(file, 'utf8')
  if (existing.includes(` ${t}\n`) || existing.includes(` ${t}$`) || existing.split('\n').some((l) => l.replace(/^[-*\s]+/, '').replace(/<!--.*?-->/g, '').trim() === t)) {
    return { ok: true, duplicated: true, profile }
  }
  const line = `- ${t} <!-- ${nowStamp()} -->\n`
  fs.appendFileSync(file, line, 'utf8')
  return { ok: true, duplicated: false, profile }
}

/** search_memory：行级关键词匹配（MEMORY.md+USER.md），命中去掉时间注释输出 */
export function localMemorySearch(vaultRoot: string, query: string, limit = 10): Array<{ source: 'memory' | 'profile'; text: string }> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const { memFile, userFile } = ensureFiles(vaultRoot)
  const out: Array<{ source: 'memory' | 'profile'; text: string }> = []
  const scan = (file: string, source: 'memory' | 'profile') => {
    if (!fs.existsSync(file)) return
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('-')) continue
      const text = line.replace(/^[-*\s]+/, '').replace(/<!--.*?-->\s*$/, '').trim()
      if (text.toLowerCase().includes(q)) {
        out.push({ source, text })
        if (out.length >= limit) return
      }
    }
  }
  scan(memFile, 'memory')
  if (out.length < limit) scan(userFile, 'profile')
  return out.slice(0, limit)
}

/**
 * 注入上下文：MEMORY.md+USER.md 合并、injectLimit 字符护栏（head 2/3 + tail 1/3 截断，Hermes 式）。
 * #281：上限由设置注入上限控制（默认 5000，最小 500）。
 */
export function localMemoryContext(vaultRoot: string, injectLimit = DEFAULT_INJECT_LIMIT): string {
  const { memFile, userFile } = ensureFiles(vaultRoot)
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  const mem = read(memFile)
  const user = read(userFile)
  let body = `## 用户画像\n${user}\n## 长期记忆\n${mem}`.trim()
  const limit = Math.max(500, injectLimit || DEFAULT_INJECT_LIMIT)
  if (body.length > limit) {
    const head = Math.floor(limit * 2 / 3)
    body = body.slice(0, head) + TRUNCATION_MARKER + body.slice(-(limit - head))
  }
  return body
}

/** 记忆统计（设置页展示用） */
export function localMemoryStats(vaultRoot: string): { memoryEntries: number; profileEntries: number } {
  const { memFile, userFile } = ensureFiles(vaultRoot)
  const count = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().startsWith('-')).length : 0)
  return { memoryEntries: count(memFile), profileEntries: count(userFile) }
}

// ==================== #317.④ 记忆检索化（轻量评分，D7 零依赖） ====================

/** 简易分词： latin 词元（≥2 字符）+ CJK 2-gram——检索锚足够，无分词库依赖 */
function tokenize(q: string): string[] {
  const out: string[] = []
  for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9-_.]*/g) ?? []) if (w.length >= 2) out.push(w)
  const cjk = q.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1])
  return [...new Set(out)]
}

export interface MemoryHit { source: 'memory' | 'profile'; text: string; score: number }

/**
 * 按问题检索记忆（#317.④）：分词×行命中评分 + 新近微加权；top-N 注入替代全文灌窗。
 * query=用户问题（调用方拼入最近一轮对话要点更佳）。零命中返回 []（调用方省略该段）。
 */
export function localMemoryRetrieve(vaultRoot: string, query: string, opts?: { topN?: number; maxChars?: number }): MemoryHit[] {
  const topN = opts?.topN ?? 8
  const maxChars = opts?.maxChars ?? 1200
  const toks = tokenize(query)
  if (!toks.length) return []
  const { memFile, userFile } = ensureFiles(vaultRoot)
  const hits: MemoryHit[] = []
  const scan = (file: string, source: 'memory' | 'profile', weight: number) => {
    if (!fs.existsSync(file)) return
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('-')) continue
      const text = line.replace(/^[-*\s]+/, '').replace(/<!--.*?-->\s*$/, '').trim()
      if (!text) continue
      const low = text.toLowerCase()
      let score = 0
      for (const tk of toks) if (low.includes(tk)) score += tk.length >= 3 ? 2 : 1
      if (score <= 0) continue
      score *= weight
      // 新近微加权（同分新条目靠前——注释日期 2026-09-30 越大加成越多）
      const dm = line.match(/(\d{4}-\d{2}-\d{2})/)
      if (dm) score += Math.min(1, Math.max(0, (Date.now() - new Date(dm[1]).getTime()) / (86400_000 * 90)) * -0.5 + 0.5) * 0.3
      hits.push({ source, text, score })
    }
  }
  scan(memFile, 'memory', 1)
  scan(userFile, 'profile', 1.5) // 画像=身份层，同分优先
  hits.sort((a, b) => b.score - a.score)
  // top-N + 字符护栏（从高分往后装，装不下截断该条）
  const out: MemoryHit[] = []
  let used = 0
  for (const h of hits) {
    if (out.length >= topN || used + h.text.length > maxChars) break
    out.push(h); used += h.text.length
  }
  return out
}

/** 检索结果→注入段（空命中返回 ''——调用方省略「长期记忆」小节） */
export function localMemoryRetrieveBlock(vaultRoot: string, query: string, opts?: { topN?: number; maxChars?: number }): string {
  const hits = localMemoryRetrieve(vaultRoot, query, opts)
  if (!hits.length) return ''
  return hits.map((h) => `- ${h.text}${h.source === 'profile' ? '（画像）' : ''}`).join('\n')
}
