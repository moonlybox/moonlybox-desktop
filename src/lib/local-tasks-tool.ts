/**
 * local_task 工具组（#316.5）：小月的任务机制能力接线。
 * - 工具单源=本文件；执行走 daemon tasks op（renderer/CLI/MCP 多入口同协议）。
 * - 纪律：小月只创建/查询/取消，不内联执行编译（任务不走对话——#316.4 用户定调）。
 * - 「未整理」判定（#316.6）：vault 文档全集 − ledger（jobs.json 已 done 的 srcHash）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultVaultRoot } from './config'
import { contentHash, isCompiled } from './tasks'
import { compileModelLabel } from './compile-model'

const DOC_EXTS = new Set(['.md', '.txt', '.markdown'])

/** 工具定义（xiaoyue.ts builtinTools 装配） */
export function localTaskToolDefs(): Array<{ name: string; title?: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema: unknown }> {
  return [
    {
      name: 'local_task_list_uncompiled',
      title: '统计未整理文档',
      description: '扫描书房（本地 vault）中的 markdown/txt 文档，统计哪些还没有整理成知识页（按内容指纹判定，改过内容的文档会重新视为未整理）。返回未整理文档路径清单。用只读扫描，不创建任务。',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'local_task_create_compile',
      title: '创建知识整理任务',
      description: '创建一个本地后台任务：把文档逐篇用模型整理成知识页（产物存到书房「知识页」目录）。用户要整理全部未整理文档时不传 paths（自动全量）；只整理部分时传 paths 数组。任务后台执行，创建后立即可继续对话，进度在「任务」页查看。',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, description: '要整理的文档绝对路径数组；不传=自动整理全部未整理文档' } },
      },
    },
    {
      name: 'local_task_status',
      title: '查询任务',
      description: '查询本地任务状态与进度。参数 id=任务 ID（local_task_create_compile 返回）；不传 id=列出最近任务（用户问「任务进度/之前那个任务」时用它）。',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '任务 ID，可选' } } },
    },
    {
      name: 'local_task_cancel',
      title: '取消任务',
      description: '取消一个正在排队/执行中的本地任务（已完成的文档不会重做）。参数 id=任务 ID。',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '任务 ID' } }, required: ['id'] },
    },
  ]
}

/** 未整理扫描：vault 递归 .md/.txt，排除系统目录与已整理（hash 命中） */
export function listUncompiled(): { total: number; uncompiled: string[]; truncated: boolean } {
  const root = defaultVaultRoot()
  const SKIP = new Set(['.moonlybox', 'node_modules', '.git', '.obsidian', 'index.db'])
  const all: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(p, depth + 1)
      } else if (DOC_EXTS.has(path.extname(e.name).toLowerCase())) {
        // #310.31：书房根 README.md=目录使用说明（initVault 自建/用户维护），非知识源——排除编译范围
        if (dir === root && e.name.toLowerCase() === 'readme.md') continue
        all.push(p)
      }
    }
  }
  walk(root, 0)
  const uncompiled: string[] = []
  for (const p of all.slice(0, 2000)) {
    try {
      const text = fs.readFileSync(p, 'utf8')
      if (!text.trim()) continue
      if (!isCompiled(contentHash(text))) uncompiled.push(p)
    } catch {}
  }
  return { total: all.length, uncompiled: uncompiled.slice(0, 200), truncated: uncompiled.length > 200 }
}

/** 工具执行器（xiaoyue.ts localTools 覆写键——走 daemon 同款 lib 单源） */
export async function runLocalTaskTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'local_task_list_uncompiled') {
    const r = listUncompiled()
    const label = compileModelLabel()
    return JSON.stringify({
      ok: true,
      scanned: r.total,
      uncompiled: r.uncompiled.length,
      truncated: r.truncated,
      paths: r.uncompiled,
      model: label ?? null,
      hint: label ? undefined : '无可用模型——提示用户先在 设置→模型 接入本地模型或配置云端模型',
    })
  }
  if (name === 'local_task_create_compile') {
    // #310.21：全链 try/catch——失败必须如实返回（agent-loop 会把失败结果给 LLM；LLM 不得编造成功）
    try {
      // #310.21：支持不传 paths=自动取全部未整理（「整理全部」场景 LLM 无需抄大清单——根治参数截断+省 token）
      let paths = args.paths as string[] | undefined
      if (!Array.isArray(paths) || paths.length === 0) {
        const scan = listUncompiled()
        if (!scan.uncompiled.length) return JSON.stringify({ ok: false, error: '没有未整理的文档（或书房为空）' })
        paths = scan.uncompiled
      }
      const { createJob } = await import('./tasks')
      const { runJob } = await import('./compile-runner')
      const label = compileModelLabel() ?? undefined
      const job = createJob('compile', `知识整理 · ${paths.length} 篇`, (paths as string[]).slice(0, 500).map((p) => ({ path: String(p) })), label)
      void runJob(job.id).catch(() => {})
      return JSON.stringify({ ok: true, jobId: job.id, total: Math.min(paths.length, 500), model: label ?? null, message: `任务已创建（${Math.min(paths.length, 500)} 篇），后台执行中——进度可在「任务」页查看` })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `任务创建失败：${String(e?.message ?? e)}` })
    }
  }
  if (name === 'local_task_status') {
    // #310.22：时间戳附带本地显示串（账本存 UTC ISO——LLM 直接念 UTC 会差时区；*Local 才是给人看的）
    const { listJobs, getJob, fmtLocal } = await import('./tasks')
    const withLocal = (j: any) => ({
      ...j,
      createdAtLocal: fmtLocal(j.createdAt),
      startedAtLocal: fmtLocal(j.startedAt),
      finishedAtLocal: fmtLocal(j.finishedAt),
    })
    const id = String(args.id ?? '')
    if (id) {
      const j = getJob(id)
      if (!j) return JSON.stringify({ ok: false, error: '任务不存在' })
      return JSON.stringify({ ok: true, job: withLocal(j), hint: '向用户报告时间一律用 *Local 字段（用户本地时区），不要念 createdAt/startedAt 原始 UTC 值' })
    }
    return JSON.stringify({ ok: true, jobs: listJobs().slice(0, 10).map(withLocal), hint: '向用户报告时间一律用 *Local 字段（用户本地时区）' })
  }
  if (name === 'local_task_cancel') {
    const { cancelJob } = await import('./tasks')
    const j = cancelJob(String(args.id ?? ''))
    if (!j) return JSON.stringify({ ok: false, error: '任务不存在' })
    return JSON.stringify({ ok: true, job: j, message: j.status === 'cancelled' ? '已取消（已完成的文档保留）' : `任务已是终态（${j.status}）` })
  }
  return JSON.stringify({ ok: false, error: `未知 local_task 工具：${name}` })
}
