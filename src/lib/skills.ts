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
  dir: string
  /** SKILL.md 全文（view 用，装配时只消费 name/description） */
  size: number
  files: string[] // 关联文件（references/scripts/assets 相对路径）
}

function skillsRoot(vaultRoot: string): string {
  return path.join(vaultRoot, '.moonlybox', 'skills')
}

/** 解析 SKILL.md frontmatter（极简 YAML：仅 name/description 两键，够用不引依赖） */
export function parseFrontmatter(raw: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) return { name: '', description: '' }
  const out = { name: '', description: '' }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim())
    if (!kv) continue
    if (kv[1] === 'name') out.name = kv[2].trim().replace(/^["']|["']$/g, '')
    if (kv[1] === 'description') out.description = kv[2].trim().replace(/^["']|["']$/g, '')
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
