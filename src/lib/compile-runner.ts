/**
 * 本地编译执行器（#316 第四批骨架下发版）：
 * - 流水线：runJob 开始时批量拉云端骨架（规则引擎零 token；失败/未登录/开关关=回退旧单页链路，零风险降级）
 *   →每篇：本地分析轮（按 analysisSpec 纯 JSON 产 genre/topics）→逐页生成（structure+预算硬数字+关键词锚）
 *   →落 vault/知识页/<名>.md→item done→回传 external 带 skeleton 摘要（服务端骨架符合性复算）
 * - **聪明层纪律（用户定案）**：骨架/analysisSpec 仅内存消费，禁止落盘（含 .moonlybox 缓存）；产物 md 照常落
 * - 模型解析：执行期按文档粒度实时读（#316.7）；断点/取消/恢复语义不变（#316.5）
 * - 回传失败不阻断本地（#284 语义）；cloudWikiId 写 item 防重复回传
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultVaultRoot } from './config'
import { getJob, updateJob, updateItem } from './tasks'
import { resolveCompileModel } from './compile-model'
import { byokChatMessages } from './llm'
import { loadSettings } from './settings'
import { loadManifest } from './sync'
import { apiCall } from './api'

/** 骨架类型（云端 SkeletonService 下发；仅内存，禁落盘——#316 第四批聪明层纪律） */
interface Skeleton {
  docId: string
  genre: string
  genreGuess?: string | null
  template: string
  structure: string
  tier: string
  topics: number
  knowledgePages: number
  tags: number
  budgetChars: number
  per_page_chars: number
  aggregate: boolean
  matrixVersion: number
  sourceChars: number
  sourceVersionAtCompile: number
  analysisSpec: { genreEnum: string[]; topicsMax: number; topicTitleMax: number; topicSummaryMax: number; entitiesMax: number; tagsMax?: number }
  keywords: string[]
  pages: Array<{ unitKey: string; pageIndex: number; pageOf: number; sections: string[] | null; maxChars: number }>
}

/** 批量拉骨架（规则引擎，云端零 token）。失败→null=整任务降级旧单页链路 */
async function fetchSkeletons(cloudIds: string[]): Promise<Map<string, Skeleton> | null> {
  try {
    const { loadCredentials } = await import('./auth')
    if (!loadCredentials()?.accessToken) return null
    if (cloudIds.length === 0) return null
    const res = await apiCall<{ ok: boolean; data?: { skeletons?: Skeleton[] }; message?: string }>(
      'GET',
      `/api/library/compile-multipage/skeleton?ids=${encodeURIComponent(cloudIds.join(','))}`,
      undefined,
      { token: loadCredentials()?.accessToken, timeoutMs: 30_000 },
    )
    const list = res.data?.data?.skeletons
    if (!res.ok || !Array.isArray(list)) return null
    return new Map(list.map((sk) => [sk.docId, sk]))
  } catch {
    return null
  }
}

/** 本地分析轮（按 analysisSpec 产 genre/topics 纯 JSON——分析算力本地出，云端零 token） */
async function analyzeDoc(model: NonNullable<ReturnType<typeof resolveCompileModel>>, srcPath: string, srcText: string, spec: Skeleton['analysisSpec']): Promise<{ topics: Array<{ title: string; summary: string }>; tags: string[] } | null> {
  const tagsMax = spec.tagsMax ?? 4
  const sys =
    '你是文档分析引擎。只输出一行紧凑 JSON（无缩进、无 markdown 代码块、无解释、无多余字段）。' +
    `对给定文档完成：\n` +
    `1. genre：从这些枚举里选一个（只能选其一）：${spec.genreEnum.join('、')}；\n` +
    `2. topics：知识主题清单，按重要性降序，最多 ${spec.topicsMax} 个，每个 title ≤${spec.topicTitleMax} 字、summary ≤${spec.topicSummaryMax} 字；实际有几个写几个，不要凑数；\n` +
    `3. tags：3-${tagsMax} 个内容主题词（词组，≤12 字，反映文档核心领域，供书房标签筛选）。\n` +
    `严格输出该结构（字段名不得改动，不得增删字段）：{"genre":"","topics":[{"title":"","summary":""}],"tags":[""]}`
  const r = await byokChatMessages(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `文档名：${path.basename(srcPath)}\n\n文档内容：\n${srcText.slice(0, 24_000)}` },
    ],
    undefined,
    240_000,
    { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey },
    4_000,
  )
  if (!r.ok || !r.text) return null
  try {
    const m = r.text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    const topics = Array.isArray(j.topics) ? j.topics.filter((t: any) => t && typeof t.title === 'string' && t.title.trim()) : []
    const tags = Array.isArray(j.tags) ? j.tags.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 12)) : []
    return topics.length ? { topics, tags } : null
  } catch {
    return null
  }
}

/** 单页生成（骨架约束：structure 章节+页预算+关键词锚） */
async function compileOnePage(model: NonNullable<ReturnType<typeof resolveCompileModel>>, srcPath: string, srcText: string, sk: Skeleton, page: Skeleton['pages'][number], topicTitle: string, topicSummary: string): Promise<string> {
  const kwHint = sk.keywords.length ? `\n标题与小节命名必须自然融入这些关键词中的至少一个：${sk.keywords.join('、')}` : ''
  const secHint = page.sections ? `\n本页只覆盖这些章节内容：${page.sections.join('、')}` : ''
  const sys =
    '你是知识编译助手。针对给定主题，从原文中提取相关内容，编译为一张结构化知识页（Markdown）。\n' +
    `必须包含且仅包含以下章节（Markdown 二级标题）：\n${sk.structure}\n` +
    '要求：只使用原文信息，不编造；关键结论可溯源；原文不足以支撑某章节时写「（原文未涉及）」；语言与原文一致；' +
    `篇幅 ≤${page.maxChars} 字（压缩提炼，禁止逐段复述原文）。只输出 Markdown 正文。${kwHint}${secHint}`
  const r = await byokChatMessages(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `本页主题：${topicTitle}\n主题简介：${topicSummary}\n\n原文全文：\n${srcText.slice(0, 24_000)}` },
    ],
    undefined,
    480_000,
    { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey },
    16_000,
  )
  if (!r.ok || !r.text) throw new Error(r.error ?? '模型返回空内容')
  return r.text
}

/** 旧单页链路（降级：未登录/开关关/拉骨架失败）——#316 第一批行为不变 */
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
    480_000, // #310.19：长生成超时配 16000 tokens 余量（约 50 tok/s 云端 × 8min）
    { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey },
    16_000, // #310.19：知识页长文生成余量（4000 会截断产物）
  )
  if (!r.ok || !r.text) throw new Error(r.error ?? '模型返回空内容')
  return r.text
}

/** 知识页落盘：vault/知识页/<源名>.md（同名加序号）；meta=YAML frontmatter（#310.30 tags/topics 上云+本地可读） */
function writeOut(srcPath: string, md: string, meta?: { tags?: string[]; genre?: string; topics?: string[] }): string {
  const dir = path.join(defaultVaultRoot(), '知识页')
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(srcPath).replace(/\.[^.]+$/, '') || '未命名'
  let out = path.join(dir, `${base}.md`)
  let n = 2
  while (fs.existsSync(out)) out = path.join(dir, `${base}-${n++}.md`)
    // #310.22：头注日期用本地时区（UTC slice 在 0-8 点会差一天）
  const nowD = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const localDate = `${nowD.getFullYear()}-${p2(nowD.getMonth() + 1)}-${p2(nowD.getDate())}`
  const header = `> 知识页 · 本地整理 · 源：${path.basename(srcPath)} · ${localDate}\n\n`
  let fm = ''
  if (meta && (meta.tags?.length || meta.genre || meta.topics?.length)) {
    const lines = ['---']
    if (meta.tags?.length) lines.push(`tags: [${meta.tags.map((t) => t.replace(/"/g, '')).join(', ')}]`)
    if (meta.genre) lines.push(`genre: ${meta.genre}`)
    if (meta.topics?.length) lines.push(`topics: [${meta.topics.map((t) => t.replace(/"/g, '')).join(', ')}]`)
    lines.push('---', '')
    fm = lines.join('\n')
  }
  fs.writeFileSync(out, fm + header + md + '\n', 'utf8')
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
 * 回传单产物云端（#316 第二批）。失败静默记 item.error 尾注（不阻断本地、不重试阻塞流水线）。
 * 源文档云端 ID 从 sync manifest 反查（path→docId）；未同步过的源（不在 manifest）跳过回传——
 * 云端归属校验（②步）要求 sourceDocId 是本用户书房文档。
 */
async function pushToMoon(jobId: string, itemPath: string, srcHash: string | undefined, md: string, sk?: Skeleton, titles?: string[], tags?: string[]): Promise<void> {
  try {
    const g = loadSettings()
    // #310.38：静默跳过留痕（用户问「云端为何没有待准入」无从排查——三处 return 全部写 item 尾注）
    if (g?.model?.syncToMoon === false) { updateItem(jobId, itemPath, { error: '本地完成；云端回传已关闭（设置→模型→同步到云端）' }); return }
    const { loadCredentials } = await import('./auth')
    if (!loadCredentials()?.accessToken) { updateItem(jobId, itemPath, { error: '本地完成；未登录云端，未回传' }); return }
    const root = defaultVaultRoot()
    const manifest = loadManifest(root)
    let cloudId = ''
    for (const [docId, ent] of Object.entries(manifest)) {
      if (ent.path && path.join(root, ent.path) === path.resolve(itemPath)) { cloudId = docId; break }
    }
    if (!cloudId) { updateItem(jobId, itemPath, { error: '本地完成；源文档未同步到云端（纯本地文档），不回传' }); return } // 源未在云端书房（本地新建未上行）
    const { loadCredentials: lc } = await import('./auth')
    const res = await apiCall<{ ok: boolean; message?: string; code?: string; data?: { wikiId?: string } }>(
      'POST',
      '/api/library/compile-multipage/external',
      {
        sourceDocId: cloudId,
        sourceVersionAtCompile: 0, // manifest 不带版本；云端以归属+硬闸校验为准（version 对账升级项挂账）
        title: path.basename(itemPath).replace(/\.[^.]+$/, ''),
        content: md,
        matrixVersion: sk?.matrixVersion ?? 1, // 骨架批=骨架版本；降级链=v1（版本升级云端 409 会带 currentMatrixVersion）
        model: resolveCompileModel()?.model ?? '',
        localItemId: path.basename(itemPath),
        srcHash: srcHash ?? undefined, // #316 第三批：ledger 双向（云端 KbWikiSource.src_hash）
        // #316 第四批：骨架符合性对账摘要（服务端按同源重算骨架对表——规则引擎确定性）
        ...(sk ? {
          sourceVersionAtCompile: sk.sourceVersionAtCompile,
          matrixVersion: sk.matrixVersion,
          skeleton: {
            unitKeys: sk.pages.map((pg) => pg.unitKey),
            titles: titles ?? [],
          },
        } : {}),
        // #310.30：分析轮顺产 tags/topics 上云（云端 frontmatter.tags 同构落库→书房标签筛选可读）
        ...(tags?.length ? { tags } : {}),
        ...(sk && titles?.length ? { topics: titles } : {}),
      },
      { token: lc()?.accessToken, timeoutMs: 20_000 },
    )
    const body = res.data
    if (res.ok && body?.ok && body.data?.wikiId) {
      updateItem(jobId, itemPath, { cloudWikiId: body.data.wikiId })
    } else {
      const reason = body?.message || body?.code || `HTTP ${res.status}`
      updateItem(jobId, itemPath, { error: `本地完成；云端回传：${String(reason).slice(0, 120)}` })
    }
  } catch (e: any) {
    // #284 语义：回传失败不影响本地产物
    try { updateItem(jobId, itemPath, { error: `本地完成；云端回传失败：${String(e?.message ?? e).slice(0, 120)}` }) } catch {}
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
  // #316 第四批：批量拉骨架（一次下发）。未登录/未同步源/失败→null=降级旧单页链路（零风险回退）
  const root0 = defaultVaultRoot()
  const manifest0 = loadManifest(root0)
  const pathToCloud = new Map<string, string>()
  for (const [docId, ent] of Object.entries(manifest0)) {
    if (ent.path) pathToCloud.set(path.join(root0, ent.path), docId)
  }
  const cloudIds = [...new Set(job.items.map((it) => pathToCloud.get(it.path)).filter(Boolean))] as string[]
  const skeletons = await fetchSkeletons(cloudIds)
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
      const model = resolveCompileModel()
      if (!model) throw new Error('无可用模型——先在 设置→模型→本地部署 接入本地模型，或在 设置→平台API 配置云端模型')
      const cloudId = pathToCloud.get(item.path)
      const sk = skeletons?.get(cloudId ?? '') ?? null
      let md = ''
      let titles: string[] | undefined
      let tags: string[] | undefined
      if (sk) {
        // #316 第四批骨架链：分析轮（本地算力）→逐页生成（structure+预算+关键词锚）
        const an = await analyzeDoc(model, item.path, text, sk.analysisSpec)
        tags = an?.tags
        const topics = an?.topics ?? []
        if (topics.length === 0) throw new Error('分析轮失败：主题清单为空（模型返回不可解析）')
        const pageCount = Math.max(1, Math.min(sk.knowledgePages, topics.length))
        const pages = sk.pages.slice(0, pageCount).map((pg, i) => ({ ...pg, pageOf: pageCount }))
        const parts: string[] = []
        titles = []
        for (let i = 0; i < pages.length; i++) {
          // 取消自查（页粒度）
          const cur2 = getJob(jobId)
          if (!cur2 || cur2.status === 'cancelled') return
          const tp = topics[Math.min(i * Math.ceil(topics.length / pageCount), topics.length - 1)]
          const body = await compileOnePage(model, item.path, text, sk, pages[i], tp.title, tp.summary ?? '')
          titles.push(tp.title)
          parts.push(body.trim())
        }
        // #310.33：每页开头显式主题名（## 主题）——产物可见主题层（Obsidian 大纲可用），替代渲染不可见的 HTML 注释
        md = parts.length === 1 ? parts[0] : parts.map((b, i) => `## ${titles![i]}\n\n${b}`).join('\n\n')
      } else {
        // 降级链：旧单页（#316 第一批行为）
        md = await compileOneDoc(item.path, text)
      }
      const outPath = writeOut(item.path, md, sk ? { tags, genre: sk.genre, topics: titles ?? [] } : undefined)
      updateItem(jobId, item.path, { status: 'done', outPath })
      await pushToMoon(jobId, item.path, item.srcHash, md, sk ?? undefined, titles, tags)
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
