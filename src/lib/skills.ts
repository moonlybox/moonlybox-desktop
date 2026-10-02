/**
 * 技能系统（#285）：Hermes SKILL 范式 TS 轻量版。
 * 存储：vault/.moonlybox/skills/<name>/SKILL.md（YAML frontmatter: name/description）+ 可选 references/ scripts/
 *   ——vault 内=随书房备份、明文可编辑、数据不出本机（与记忆层同域）；用户手工放目录即生效（v1 只读消费）。
 * 渐进披露（Hermes 核心）：对话装配只注入索引（name+description），小月按需 skill_view 拉全文/skill_file 拉关联文件。
 * 防注入边界：SKILL.md 是用户本机文件=与文档库同级信任源；skill_file 只允许读技能目录内部的关联文件（防逃逸）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface SkillMeta {
  name: string
  description: string
  /** #317.⑤b：'auto'=小月自沉淀写入；undefined=用户手工技能（自沉淀 patch 不可改写） */
  source?: string
  dir: string
  /** SKILL.md 全文（view 用，装配时只消费 name/description） */
  size: number
  files: string[] // 关联文件（references/scripts/assets 相对路径）
}

function skillsRoot(vaultRoot: string): string {
  return path.join(vaultRoot, '.moonlybox', 'skills')
}

/** 解析 SKILL.md frontmatter（极简 YAML：仅 name/description 两键，够用不引依赖） */
export function parseFrontmatter(raw: string): { name: string; description: string; source?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) return { name: '', description: '' }
  const out = { name: '', description: '', source: undefined as string | undefined }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim())
    if (!kv) continue
    if (kv[1] === 'name') out.name = kv[2].trim().replace(/^["']|["']$/g, '')
    if (kv[1] === 'description') out.description = kv[2].trim().replace(/^["']|["']$/g, '')
    // #317.⑤b：source: auto=小月自沉淀写入——无此标记=用户手工技能（自沉淀 patch 不可改写）
    if (kv[1] === 'source') out.source = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const ALLOWED_SUBDIRS = ['references', 'scripts', 'assets']

/** 扫描技能目录：每个含 SKILL.md 的一级子目录=一个技能 */
export function listSkills(vaultRoot: string): SkillMeta[] {
  const root = skillsRoot(vaultRoot)
  if (!fs.existsSync(root)) return []
  const out: SkillMeta[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const dir = path.join(root, ent.name)
    const md = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(md)) continue
    let raw = ''
    try {
      raw = fs.readFileSync(md, 'utf8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(raw)
    const files: string[] = []
    for (const sub of ALLOWED_SUBDIRS) {
      const sd = path.join(dir, sub)
      if (!fs.existsSync(sd)) continue
      for (const f of fs.readdirSync(sd, { withFileTypes: true })) {
        if (f.isFile()) files.push(`${sub}/${f.name}`)
      }
    }
    out.push({
      name: fm.name || ent.name,
      description: fm.description,
      source: fm.source,
      dir,
      size: Buffer.byteLength(raw),
      files,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 装配用索引文本：注入 system 的一行式清单（渐进披露——不载全文） */
export function skillsIndex(vaultRoot: string): string {
  const skills = listSkills(vaultRoot)
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name}：${s.description || '（无描述）'}`)
  return lines.join('\n')
}

export type SkillViewResult =
  | { ok: true; kind: 'skill' | 'file'; name: string; path: string; content: string }
  | { ok: false; error: string }

/** skill_view：拉单个技能全文；file 参数拉关联文件（只允许 references/scripts/assets 内、防路径逃逸） */
export function viewSkill(vaultRoot: string, name: string, file?: string): SkillViewResult {
  const skills = listSkills(vaultRoot)
  const s = skills.find((x) => x.name === name.trim())
  if (!s) return { ok: false, error: `未找到技能「${name}」；可用：${skills.map((x) => x.name).join('、') || '（无）'}` }
  if (!file) {
    const raw = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')
    const fileList = s.files.length ? `\n\n关联文件：${s.files.join('、')}（用 skill_file 工具读取）` : ''
    return { ok: true, kind: 'skill', name: s.name, path: 'SKILL.md', content: raw + fileList }
  }
  const rel = file.trim().replace(/^\/+/, '')
  const seg = rel.split('/')
  if (seg.length < 2 || !ALLOWED_SUBDIRS.includes(seg[0])) {
    return { ok: false, error: `file 参数须为 ${ALLOWED_SUBDIRS.join('/')} 内的相对路径（如 references/api.md）` }
  }
  if (!s.files.includes(rel)) return { ok: false, error: `技能「${s.name}」无关联文件 ${rel}；可用：${s.files.join('、') || '（无）'}` }
  const abs = path.join(s.dir, ...seg)
  // 防逃逸终检：解析后必须仍在技能目录内
  if (!path.resolve(abs).startsWith(path.resolve(s.dir) + path.sep)) return { ok: false, error: '路径越界' }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: `文件不存在：${rel}` }
  return { ok: true, kind: 'file', name: s.name, path: rel, content: fs.readFileSync(abs, 'utf8') }
}

/** 内置工具定义（agentLoop builtinTools 形态；全只读） */
export function skillToolDefs(): Array<{ name: string; title?: string; description?: string; annotations: { readOnlyHint: boolean }; inputSchema: unknown }> {
  return [
    {
      name: 'skill_list',
      title: '列出技能',
      description: '列出用户书房里的全部技能（名称+描述索引）。回答「你有哪些技能/你会不会 X」类问题时先调它。',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'skill_view',
      title: '查看技能',
      description: '读取某个技能的完整 SKILL.md 内容（照着执行其中的流程/规范）。参数：name（技能名，来自 skill_list）。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名' } },
        required: ['name'],
      },
    },
    {
      name: 'skill_file',
      title: '读取技能关联文件',
      description: '读取技能目录下的关联文件（references/scripts/assets 内），如 references/api.md。参数：name（技能名）、file（相对路径）。',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名' }, file: { type: 'string', description: '相对路径，如 references/api.md' } },
        required: ['name', 'file'],
      },
    },
  ]
}

// ==================== #317.⑤ 技能自沉淀（写入侧） ====================

function safeName(name: string): string {
  const n = name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
  return n || 'unnamed-skill'
}

/** 条目标识（回执用）：name+description 的短 hash */
export function skillFingerprint(name: string, description: string): string {
  const h = require('node:crypto') as typeof import('node:crypto')
  return h.createHash('sha256').update(`${name}|${description}`).digest('hex').slice(0, 8)
}

/** 轻量相似度：分词重合率（0~1）——防同项目重复沉淀 */
function textOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]/g) ?? []))
  const A = tok(a), B = tok(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / Math.min(A.size, B.size)
}

export interface SkillWriteResult { ok: boolean; action: 'created' | 'updated' | 'skipped'; name: string; reason?: string }

/**
 * 自沉淀写入（静默，不确认——#317.⑤ 用户定案）：
 * - 同名技能已存在 → patch（更新 description/SKILL.md 正文）
 * - description 与既有技能相似度 ≥0.6 → patch 最相近的（防同项目堆积）
 * - 技能数达 maxCount 上限 → 强制 patch 模式（不新增；仍无相近对象则 skip）
 */
export function skillAutoWrite(
  vaultRoot: string,
  input: { name: string; description: string; body: string },
  opts?: { maxCount?: number },
): SkillWriteResult {
  const name = safeName(input.name)
  const desc = input.description.trim().slice(0, 200)
  const body = input.body.trim()
  if (!name || !body) return { ok: false, action: 'skipped', name, reason: '名称或正文为空' }
  const root = skillsRoot(vaultRoot)
  const existing = listSkills(vaultRoot)
  // #317.⑤b：手工技能（无 source: auto）不可被自沉淀改写——同名/相似命中一律视为「不存在」，走新建/跳过
  const autos = existing.filter((s) => s.source === 'auto')
  // 同名 → 更新（仅限 auto 技能）
  const same = autos.find((s) => s.name === name)
  if (same) return writeSkillDir(vaultRoot, name, desc, body, 'updated')
  // 同名但对象是手工技能 → 拒绝改写（目录冲突不可新建，skip）
  if (existing.some((s) => s.name === name)) return { ok: false, action: 'skipped', name, reason: '同名用户手工技能不可自动改写' }
  // 相似 → 更新最相近（仅限 auto 技能；用户手工技能防改写）
  let best: { skill: SkillMeta; score: number } | null = null
  for (const s of autos) {
    const score = textOverlap(desc, s.description)
    if (score >= 0.6 && (!best || score > best.score)) best = { skill: s, score }
  }
  if (best) return writeSkillDir(vaultRoot, best.skill.name, desc, body, 'updated')
  // 上限
  const maxCount = opts?.maxCount ?? 20
  if (existing.length >= maxCount) return { ok: false, action: 'skipped', name, reason: `已达技能数量上限 ${maxCount}（不新增；改进既有技能请用自然语言让小月更新对应技能）` }
  return writeSkillDir(vaultRoot, name, desc, body, 'created')
}

function writeSkillDir(vaultRoot: string, name: string, desc: string, body: string, action: 'created' | 'updated'): SkillWriteResult {
  const dir = path.join(skillsRoot(vaultRoot), name)
  fs.mkdirSync(dir, { recursive: true })
  const fm = `---\nname: ${name}\ndescription: ${desc.replace(/\n/g, ' ')}\nsource: auto\n---\n\n`
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + body + '\n', 'utf8')
  return { ok: true, action, name }
}
