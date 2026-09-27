/**
 * 技能系统 e2e（#285）：XDG 隔离 + 临时 vault 造技能目录 →
 * frontmatter 解析/索引/视图/防逃逸/工具定义 断言。
 * bun:test 格式 → bun test ./tests/skills.e2e.ts
 */
import { afterAll, test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_skills_'))
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_skills_vault_'))
process.env.XDG_CONFIG_HOME = tmpCfg

const { parseFrontmatter, listSkills, skillsIndex, viewSkill, skillToolDefs } = await import('../src/lib/skills')

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
  fs.rmSync(tmpVault, { recursive: true, force: true })
})

// 夹具：两个技能（其一含 references/）
const skillA = path.join(tmpVault, '.moonlybox', 'skills', 'deploy-notes')
fs.mkdirSync(skillA, { recursive: true })
fs.writeFileSync(
  path.join(skillA, 'SKILL.md'),
  '---\nname: deploy-notes\ndescription: 发布前检查清单与部署流程\n---\n\n# 部署\n\n1. 跑测试\n2. 打 tag\n',
  'utf8',
)
fs.mkdirSync(path.join(skillA, 'references'), { recursive: true })
fs.writeFileSync(path.join(skillA, 'references', 'checklist.md'), '- 备份 ✓\n- 回滚预案 ✓', 'utf8')

const skillB = path.join(tmpVault, '.moonlybox', 'skills', 'writing-style')
fs.mkdirSync(skillB, { recursive: true })
fs.writeFileSync(
  path.join(skillB, 'SKILL.md'),
  '---\nname: writing-style\ndescription: 用户偏好的行文风格规范\n---\n\n结论先行。\n',
  'utf8',
)

test('frontmatter 解析：name/description 提取与缺省', () => {
  expect(parseFrontmatter('---\nname: x\ndescription: y\n---\nbody')).toEqual({ name: 'x', description: 'y' })
  expect(parseFrontmatter('no frontmatter')).toEqual({ name: '', description: '' })
  expect(parseFrontmatter('---\nname: "quoted"\n---\n')).toEqual({ name: 'quoted', description: '' })
})

test('listSkills：扫描目录+关联文件清单+排序', () => {
  const all = listSkills(tmpVault)
  expect(all.map((s) => s.name)).toEqual(['deploy-notes', 'writing-style'])
  const a = all[0]!
  expect(a.description).toBe('发布前检查清单与部署流程')
  expect(a.files).toEqual(['references/checklist.md'])
})

test('skillsIndex：一行式索引（渐进披露只含 name+description）', () => {
  const idx = skillsIndex(tmpVault)
  expect(idx).toContain('deploy-notes：发布前检查清单与部署流程')
  expect(idx).toContain('writing-style：用户偏好的行文风格规范')
  expect(idx).not.toContain('跑测试') // 全文不进索引
  expect(skillsIndex(path.join(tmpVault, 'nonexist'))).toBe('')
})

test('viewSkill：全文+关联文件+未知名报错', () => {
  const full = viewSkill(tmpVault, 'deploy-notes')
  expect(full.ok).toBe(true)
  if (full.ok) {
    expect(full.kind).toBe('skill')
    expect(full.content).toContain('1. 跑测试')
    expect(full.content).toContain('references/checklist.md') // 关联文件提示
  }
  const f = viewSkill(tmpVault, 'deploy-notes', 'references/checklist.md')
  expect(f.ok).toBe(true)
  if (f.ok) {
    expect(f.kind).toBe('file')
    expect(f.content).toContain('回滚预案')
  }
  const bad = viewSkill(tmpVault, 'nope')
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.error).toContain('未找到技能')
})

test('viewSkill 防逃逸：非白名单子目录/跨目录路径拒绝', () => {
  const outside = viewSkill(tmpVault, 'deploy-notes', '../../settings.json')
  expect(outside.ok).toBe(false)
  if (!outside.ok) expect(outside.error).toContain('references/scripts/assets')
  const missing = viewSkill(tmpVault, 'deploy-notes', 'references/nope.md')
  expect(missing.ok).toBe(false)
})

test('skillToolDefs：三工具全只读+schema 必填', () => {
  const defs = skillToolDefs()
  expect(defs.map((d) => d.name)).toEqual(['skill_list', 'skill_view', 'skill_file'])
  for (const d of defs) {
    expect(d.annotations.readOnlyHint).toBe(true)
    // skill_list 无参数（无 required）；带参数工具必须声明 required
    const req = (d.inputSchema as { required?: string[]; properties?: Record<string, unknown> }).required
    const hasProps = Object.keys((d.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).length
    if (hasProps) expect(req).toBeTruthy()
    else expect(req).toBeUndefined()
  }
})
