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
      description: '用户要求批量整理云端收藏（打标签/补描述）时，先用本工具创建「云端整理」任务（任务页可见），再直通执行：search_bookmarks 圈定→organize_bookmarks {items, execute:true} 一次写入→local_task_update_cloud_organize(all=true) 收口。禁止逐条确认、禁止 update_bookmark 逐条打标/写描述、禁止中途停顿征询。参数 kind=tags（打标签）|descriptions（补描述）；total=本轮要处理的收藏条数（来自 search 结果数）。',
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
      title: '查询云端整理进度',
      description: '查询云端整理任务的实时进度。进度由系统按 organize_bookmarks 真实写入自动记账，不需要也不接受手动上报（完成写入后自动推进、全满自动收口）。',
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
      // #330：资源名称快照——items 记录文档名（去扩展名），任务详情直接显示名称不靠路径
      const job = createJob('compile', `知识整理 · ${paths.length} 篇`, (paths as string[]).slice(0, 500).map((p) => {
        const base = String(p).split(/[\\/]/).pop() ?? String(p)
        return { path: String(p), title: base.replace(/\.[^.]+$/, '').slice(0, 60) }
      }), label)
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
      // #329.17：任务详情显示整理所用模型——resolveCompileModel 取当前对话可用模型快照
      let modelLabel: string | undefined
      try {
        const { compileModelLabel } = await import('./compile-model')
        modelLabel = compileModelLabel() || undefined
      } catch { /* 快照失败不阻塞登记 */ }
      // items 用占位行（无本地路径——path 即云端收藏处理序号），进度条/清单照常工作
      const job = createJob('cloud_organize', label, Array.from({ length: total }, (_, i) => ({ path: `cloud:#${i + 1}` })), modelLabel)
      return JSON.stringify({
        ok: true,
        jobId: job.id,
        total,
        message: `云端整理任务已创建（${total} 条）：登记完成，**立即直通执行，不得逐条确认、不得展示 diff 征询、不得二次停顿**——直接调 organize_bookmarks {items:[{id, ${kind === 'tags' ? 'tagsAdd:["标签"]' : 'description:"一句描述"'}}, ...], execute:true} 一次写入（≤50 条/批，全批可一次提交）；写入完成调 local_task_update_cloud_organize（all=true）收口并用一两句中文汇报。产物在云端，任务页「产物」页帧显示无本地产物说明。`,
      })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `任务创建失败：${String(e?.message ?? e)}` })
    }
  }
  if (name === 'local_task_cloud_organize_preview') {
    // #329.12 重构：preview 只圈定清单（不含 organize 调用——标签方案必须由 LLM 生成，工具生成不了）。
    // 旧版内部调 organize_bookmarks({ids}) 无变更内容→API 422「未提供任何变更」=「预览失败」真因。
    try {
      const kind = args.kind === 'descriptions' ? 'descriptions' : 'tags'
      const { getJob, updateJob, allJobs } = await import('./tasks')
      let job = getJob(String(args.jobId ?? ''))
      if (!job || job.type !== 'cloud_organize') {
        job = allJobs().filter((j) => j.type === 'cloud_organize' && j.status !== 'completed' && j.status !== 'cancelled')
          .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
      }
      if (!job) return JSON.stringify({ ok: false, error: '没有进行中的云端整理任务，请先调 local_task_create_cloud_organize' })
      const { callTool } = await import('./moonlink')
      const sr = await callTool('search_bookmarks', kind === 'descriptions' ? { noDescription: true, limit: 200 } : { untagged: true, limit: 200 })
      const sText = sr?.content?.map((c: any) => c.text ?? '').join('') ?? ''
      let sData: any
      try { sData = JSON.parse(sText) } catch { return JSON.stringify({ ok: false, error: `清单获取失败：${sText.slice(0, 120)}` }) }
      const items: Array<any> = sData.bookmarks ?? []
      if (!items.length) return JSON.stringify({ ok: true, message: '没有符合条件的收藏', total: 0 })
      updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
      // #330：资源名称快照——把圈定到的收藏标题写进任务 items（任务详情直接显示名称，不靠 ID 关联）
      try {
        const { getJob: gJ, updateItem: uI } = await import('./tasks')
        const cur = gJ(job.id)!
        const pend = cur.items.filter((it) => it.status === 'pending')
        items.slice(0, pend.length).forEach((b: any, i: number) => {
          const t = String(b.title ?? '').trim()
          if (t && pend[i]) uI(job.id, pend[i].path, { title: t.slice(0, 60) })
        })
      } catch { /* 快照失败不阻塞清单返回 */ }
      const list = items.map((b: any, i: number) => `${i + 1}. id=${b.id} | ${String(b.title ?? '').slice(0, 50)} | ${String(b.description ?? b.note ?? '').slice(0, 60)}`)
      return JSON.stringify({
        ok: true,
        jobId: job.id,
        total: items.length,
        list,
        message: `清单已圈定（${items.length} 条）。**你现在逐条生成${kind === 'tags' ? '标签方案（tagsAdd）' : '描述方案（description，一句简洁中文说明用途）'}**，然后直接调 organize_bookmarks {items:[{id, ${kind === 'tags' ? 'tagsAdd:["..."]' : 'description:"..."'}}, ...], execute:true} **一次写入**（≤50 条/批）——禁止逐条确认、禁止展示 diff 征询、禁止等用户再说继续，写完收口汇报。`,
      })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `清单获取失败：${String(e?.message ?? e)}` })
    }
  }
  if (name === 'local_task_update_cloud_organize') {
    // #331.13：手动上报废武功——进度只认真实写入（organize_bookmarks 成功→agentLoop 自动推进 done，
    // 全满自动收口）。此前模型可凭空报 done=N/all=true 把 pending 推成 done（幻觉收口：详情显示完成、
    // 云端零写入——真机三轮实证）。本工具降级为只读进度查询，返回系统记账的真实进度。
    try {
      const { getJob } = await import('./tasks')
      const job = getJob(String(args.id ?? ''))
      if (!job || job.type !== 'cloud_organize') return JSON.stringify({ ok: false, error: '云端整理任务不存在' })
      const fresh = job
      const pending = fresh.items.filter((it) => it.status === 'pending').length
      return JSON.stringify({
        ok: true,
        finished: fresh.status === 'completed',
        progress: fresh.progress,
        remaining: pending,
        message: `进度由系统按真实写入自动记账（当前 ${fresh.progress.done}/${fresh.progress.total}，待处理 ${pending}）。无需也不接受手动上报——完成 organize_bookmarks 写入后系统会自动推进。`,
      })
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: `进度查询失败：${String(e?.message ?? e)}` })
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
