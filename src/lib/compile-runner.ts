/**
 * 本地编译执行器（#316.5/#316.6 第一批：本地编译→产物落书房，不回传）：
 * - 流水线：取源文档→（文档粒度）resolveCompileModel→单轮长文本生成知识页→落 vault/知识页/<名>.md→item done
 * - 模型解析：执行期按文档粒度实时读（#316.7 定案——设置即生效，单文档内一致）
 * - 断点：items 逐份状态（done 不重做）；取消=cancelJob 置 items cancelled+执行器自查中止
 * - 回传云端：第二批（§5.16.4 对接），本版产物只落本地
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultVaultRoot } from './config'
import { getJob, updateJob, updateItem } from './tasks'
import { resolveCompileModel } from './compile-model'
import { byokChatMessages } from './llm'

/** 单文档知识页生成：源文本 → markdown 知识页（单轮，无工具——小模型胜任线之上的体力活） */
async function compileOneDoc(srcPath: string, srcText: string): Promise<string> {
  // #316.7：文档粒度解析——每篇新文档开始时读一次设置
  const model = resolveCompileModel()
  if (!model) throw new Error('无可用模型——先在 设置→模型→本地部署 接入本地模型，或在 设置→平台API 配置云端模型')
  const fileName = path.basename(srcPath)
  const sys =
    '你是知识整理助手。把给定的文档整理成一篇结构化知识页（Markdown）。\n' +
    '要求：\n' +
    '1. 开头写一句「概述」概括文档核心；\n' +
    '2. 用「## 小节标题」组织要点，保留关键事实、数据、结论，不虚构原文没有的内容；\n' +
    '3. 结尾给「## 要点回顾」3-5 条短句；\n' +
    '4. 直接输出 Markdown 正文，不要解释。'
  const r = await byokChatMessages(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `文档名：${fileName}\n\n文档内容：\n${srcText.slice(0, 24_000)}` },
    ],
    undefined,
    180_000,
    { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey },
  )
  if (!r.ok || !r.text) throw new Error(r.error ?? '模型返回空内容')
  return r.text
}

/** 知识页落盘：vault/知识页/<源名>.md（同名加序号） */
function writeOut(srcPath: string, md: string): string {
  const dir = path.join(defaultVaultRoot(), '知识页')
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(srcPath).replace(/\.[^.]+$/, '') || '未命名'
  let out = path.join(dir, `${base}.md`)
  let n = 2
  while (fs.existsSync(out)) out = path.join(dir, `${base}-${n++}.md`)
  const header = `> 知识页 · 本地整理 · 源：${path.basename(srcPath)} · ${new Date().toISOString().slice(0, 10)}\n\n`
  fs.writeFileSync(out, header + md + '\n', 'utf8')
  return out
}

/** 读源文本（md/txt 直读；其他扩展名先按文本尝试，二进制特征则跳过） */
function readSource(p: string): string | null {
  try {
    const buf = fs.readFileSync(p)
    const sample = buf.subarray(0, 4096)
    // 二进制特征：NUL 字节占比
    let nulls = 0
    for (const b of sample) if (b === 0) nulls++
    if (nulls > 8) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 执行 job（fire-and-forget：daemon tasks op 触发后异步跑，进度经 jobs.json 回写、任务页轮询读）。
 * 取消语义：每份 item 开始前查一次 job.status——cancelled 即止。
 */
export async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId)
  if (!job) return
  updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() })
  for (const item of job.items) {
    // 取消自查（#316.5：cancelJob 已把 pending 置 cancelled——running 检查兜底）
    const cur = getJob(jobId)
    if (!cur || cur.status === 'cancelled') return
    if (item.status !== 'pending') continue // 断点：done/failed/skipped 不重做
    updateItem(jobId, item.path, { status: 'running' })
    try {
      const text = readSource(item.path)
      if (text === null || !text.trim()) {
        updateItem(jobId, item.path, { status: 'skipped', error: '无法读取（二进制或空文件）' })
        continue
      }
      const md = await compileOneDoc(item.path, text)
      const outPath = writeOut(item.path, md)
      updateItem(jobId, item.path, { status: 'done', outPath })
    } catch (e: any) {
      updateItem(jobId, item.path, { status: 'failed', error: String(e?.message ?? e).slice(0, 300) })
    }
  }
  const fin = getJob(jobId)
  if (!fin || fin.status === 'cancelled') return
  const failed = fin.items.filter((it) => it.status === 'failed').length
  const done = fin.items.filter((it) => it.status === 'done').length
  updateJob(jobId, {
    status: failed && !done ? 'failed' : 'completed',
    finishedAt: new Date().toISOString(),
    ...(failed ? { error: `${failed} 项失败` } : {}),
  })
}
