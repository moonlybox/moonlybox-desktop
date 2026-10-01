/**
 * #317.1 工具结果落盘+引用注入（Hermes 式：磁盘=仓库，上下文=工作台）。
 * - 大结果（> INJECT_THRESHOLD 字符）写 vault/.moonlybox/cache/tool-results/，messages 只放 head+tail+全文路径引用
 * - 小结果原样回注（零开销）
 * - tool_result_read 工具（readOnly）供 LLM 按引用路径拉全文
 * 目录纪律：.moonlybox=同步元数据区（不进编译扫描/下行镜像/书房 UI）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const INJECT_THRESHOLD = 2400
const HEAD = 1600
const TAIL = 500
const MAX_CACHE_FILES = 200

/** 落盘大结果，返回引用注入文本；小结果原样返回。 */
export function injectToolResult(vaultRoot: string, toolName: string, text: string): string {
  if (text.length <= INJECT_THRESHOLD) return text
  if (!vaultRoot) return text.slice(0, HEAD) + `\n…（结果 ${text.length} 字符，已截断）`
  const dir = path.join(vaultRoot, '.moonlybox', 'cache', 'tool-results')
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 清理旧文件（保 200 个——cache 防膨胀）
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()
    while (old.length >= MAX_CACHE_FILES) fs.unlinkSync(path.join(dir, old.shift()!))
    const name = `${Date.now()}-${toolName.replace(/[^\w.-]/g, '_')}.txt`
    const file = path.join(dir, name)
    fs.writeFileSync(file, text, 'utf8')
    const head = text.slice(0, HEAD)
    const tail = text.length > HEAD + TAIL ? `\n…（中段略）\n${text.slice(-TAIL)}` : ''
    return `${head}${tail}\n[工具结果共 ${text.length} 字符，已截断。全文路径：${file}（用 tool_result_read 工具读取）]`
  } catch {
    // 落盘失败=退回截断（至少不灌爆窗口）
    return text.slice(0, HEAD) + `\n…（结果 ${text.length} 字符，落盘失败仅保留前段）`
  }
}

/** tool_result_read：按引用路径读全文（只允许 cache 目录内）。 */
export function readToolResult(vaultRoot: string, p: string): { ok: boolean; content?: string; error?: string } {
  const dir = path.join(vaultRoot, '.moonlybox', 'cache', 'tool-results')
  const f = path.isAbsolute(p) ? path.resolve(p) : path.resolve(dir, p)
  if (!f.startsWith(path.resolve(dir))) return { ok: false, error: '路径超出工具结果缓存目录' }
  try {
    return { ok: true, content: fs.readFileSync(f, 'utf8') }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
