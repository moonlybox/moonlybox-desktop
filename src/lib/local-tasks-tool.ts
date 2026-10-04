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
      name: 'local_task_create_cloud_organize',
      // #326：云端整理任务登记——产物在云端，「任务」页可见进度；小月在对话内逐条执行 MCP 工具并上报进度
      title: '创建云端整理任务（收藏打标签/补描述）',
      description: '用户要求批量整理云端收藏（打标签/补描述）时，先用本工具创建「云端整理」任务（任务页可见），再在对话中逐条执行 search_bookmarks→organize_bookmarks/update_bookmark，每完成一条用 local_task_update_cloud_organize 上报进度。参数 kind=tags（打标签）|descriptions（补描述）；total=本轮要处理的收藏条数（来自 search 结果数）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['tags', 'descriptions'], description: '整理类型' },
          total: { type: 'number', description: '本轮待处理条数' },
        },
        required: ['kind', 'total'],
      },
    },
    {
      name: 'local_task_update_cloud_organize',
      title: '上报云端整理进度',
      description: '云端整理任务每完成一条（或失败一条）调用本工具上报；all=true 表示全部完成（任务收口）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（创建时返回）' },
          done: { type: 'number', description: '本次新增完成条数' },
          failed: { type: 'number', description: '本次新增失败条数（可省）' },
          all: { type: 'boolean', description: 'true=全部处理完毕，任务收口' },
        },
        required: ['id', 'done'],
      },
    },
    {
      name: 'local_task_cloud_organize_preview',
      title: '生成收藏整理预览',
      // #329.7：登记+圈定+预览一步化——GLM 5.2 对多步纪律遵从差，压缩模型调用点
      description: '【整理链第二步，紧跟 local_task_create_cloud_organize 调用】一步完成：按 kind 圈定未打标签/无描述收藏清单→调用 organize_bookmarks 生成变更预览 diff→自动登记进度。返回 diff 摘要（含每条收藏建议标签）与执行所需信息。调用后把 diff 摘要展示给用户，等用户确认后调 organize_bookmarks（带 confirmToken）执行写入。',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: '任务 ID（local_task_create_cloud_organize 返回）' },
          kind: { type: 'string', enum: ['tags', 'descriptions'], description: '整理类型' },
        },
        required: ['jobId', 'kind'],
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
      if (!isCompiled(contentHash(text), root)) uncompiled.push(p)
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
  if (name === 'local_task_create_cloud_organize') {
    // #326：云端整理任务——登记进「任务」页（产物在云端，无本地产物）；执行体=小月对话内的 MCP 工具循环
    try {
      const kind = args.kind === 'descriptions' ? 'descriptions' : 'tags'
      const total = Math.max(1, Math.min(50, Number(args.total ?? 0) || 0))
      const { createJob } = await import('./tasks')
      const label = kind === 'tags' ? '云端整理 · 收藏打标签' : '云端整理 · 收藏补描述'
      // items 用占位行（无本地路径——path 即云端收藏处理序号），进度条/清单照常工作
      const job = createJob('cloud_organize', label, Array.from({ length: total }, (_, i) => ({ path: `cloud:#${i + 1}` })), undefined)
      return JSON.stringify({
        ok: true,
        jobId: job.id,
        total,
        message: `云端整理任务已创建（${total} 条）：登记完成，**立即开始逐批执行**（不要停下来等用户再说「继续」）——${kind === 'tags' ? 'organize_bookmarks 两段式：先调（不带 confirmToken）拿 diff 预览，同轮把 diff 摘要给用户确认后带 confirmToken 执行' : 'update_bookmark 逐条执行'}；每完成一条用 local_task_update_cloud_organize 上报进度（done=1），全部完成后 all=true 收口。注意：不得跳过登记，也不得在登记后二次征询。产物在云端，任务页「产物」页帧显示无本地产物说明。`,
      })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `任务创建失败：${String(e?.message ?? e)}` })
    }
  }
  if (name === 'local_task_cloud_organize_preview') {
    // #329.7：一步化预览——圈定+organize 预览（token 原样返回给模型，下一步带它执行=UI 确认条）
    try {
      const kind = args.kind === 'descriptions' ? 'descriptions' : 'tags'
      const { getJob, updateJob } = await import('./tasks')
      const job = getJob(String(args.jobId ?? ''))
      if (!job || job.type !== 'cloud_organize') return JSON.stringify({ ok: false, error: '任务不存在，请先调 local_task_create_cloud_organize' })
      const { callTool } = await import('./moonlink')
      const sr = await callTool('search_bookmarks', kind === 'descriptions' ? { noDescription: true, limit: 200 } : { untagged: true, limit: 200 })
      const sText = sr?.content?.map((c: any) => c.text ?? '').join('') ?? ''
      let sData: any
      try { sData = JSON.parse(sText) } catch { return JSON.stringify({ ok: false, error: `清单获取失败：${sText.slice(0, 120)}` }) }
      const items: Array<any> = sData.bookmarks ?? []
      if (!items.length) return JSON.stringify({ ok: true, message: '没有符合条件的收藏', total: 0 })
      const ids = items.map((b: any) => b.id)
      const org = await callTool('organize_bookmarks', kind === 'descriptions' ? { ids, description: '（待定）' } : { ids })
      const oText = org?.content?.map((c: any) => c.text ?? '').join('') ?? ''
      let oData: any
      try { oData = JSON.parse(oText) } catch { return JSON.stringify({ ok: false, error: `预览失败：${oText.slice(0, 120)}` }) }
      if (oData.ok === false) return JSON.stringify({ ok: false, error: oData.message ?? '预览失败' })
      updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
      const diffs: Array<any> = oData.diff ?? []
      const lines = diffs.slice(0, 50).map((d: any) => {
        const title = String(d.title ?? d.id ?? '').slice(0, 40)
        const add = (d.tagsAdd ?? d.attach ?? []).join('、')
        return `· ${title} → ${add || '（无标签变更）'}`
      })
      return JSON.stringify({
        ok: true,
        jobId: job.id,
        total: items.length,
        changed: oData.changed ?? diffs.length,
        diffSummary: lines,
        confirmToken: oData.confirmToken ?? null,
        message: `预览已生成（${items.length} 条）。把 diffSummary 展示给用户；用户确认后调 organize_bookmarks {ids 摘要见下, confirmToken} 执行（UI 会弹确认条）。token 30 分钟有效。`,
        ids,
      })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `预览失败：${String(e?.message ?? e)}` })
    }
  }
  if (name === 'local_task_update_cloud_organize') {
    try {
      const { getJob, updateJob, updateItem } = await import('./tasks')
      const job = getJob(String(args.id ?? ''))
      if (!job || job.type !== 'cloud_organize') return JSON.stringify({ ok: false, error: '云端整理任务不存在' })
      if (job.status === 'completed' || job.status === 'cancelled') return JSON.stringify({ ok: false, error: `任务已结束（${job.status}）` })
      if (job.status === 'queued') updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
      const done = Math.max(0, Number(args.done ?? 0) || 0)
      const failed = Math.max(0, Number(args.failed ?? 0) || 0)
      // 推进指针：把最早的 pending 项标记 done/failed（占位行按序消费）
      let d = done, f = failed
      for (const it of job.items) {
        if (it.status !== 'pending') continue
        if (d > 0) { updateItem(job.id, it.path, { status: 'done' }); d-- }
        else if (f > 0) { updateItem(job.id, it.path, { status: 'failed', error: '云端写入失败' }); f-- }
        else break
      }
      const fresh = getJob(job.id)!
      const pending = fresh.items.filter((it) => it.status === 'pending').length
      if (args.all === true || pending === 0) {
        updateJob(fresh.id, { status: 'completed', finishedAt: new Date().toISOString() })
        return JSON.stringify({ ok: true, finished: true, progress: fresh.progress, message: `任务完成：${fresh.progress.done}/${fresh.progress.total} 条已整理（产物在云端收藏中）` })
      }
      return JSON.stringify({ ok: true, finished: false, progress: fresh.progress, remaining: pending })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `进度上报失败：${String(e?.message ?? e)}` })
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
