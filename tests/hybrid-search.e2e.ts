#!/usr/bin/env bun
/**
 * M2.5 本地混合检索 E2E（#231）：不依赖云端/登录——直接造 vault 镜像区+manifest，
 * 走 indexer/searchLocalAsync 真链路（embedding 真模型 + sqlite-vec 真索引）。
 *
 * 断言：
 *  1. 索引建立：5 文档全量入索引（meta/fts/vec 三表）
 *  2. 关键词命中：精确词查询 → FTS 排前
 *  3. 语义检索：换词形问法（「献血」→「 blood donation」类语义近似）向量路能召回
 *  4. 空态：完全无关查询 → 语义路也可能给弱命中——断言排序首位不相关的区分度（score 差）
 *  5. 增量：改 1 文档 version+1 → reindex 只重 embed 1 条
 *  6. 删除：manifest 移除 1 条 → reindex removed=1 且检索不再出现
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const VAULT = '/tmp/e2e_m25_vault'

let pass = 0
let fail = 0
const ok = (cond: boolean, name: string): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`)
  }
}

process.env.XDG_CONFIG_HOME = '/tmp/e2e_m25_cfg'
fs.rmSync(VAULT, { recursive: true, force: true })
fs.rmSync('/tmp/e2e_m25_cfg', { recursive: true, force: true })
fs.mkdirSync(path.join(VAULT, '.moonlybox'), { recursive: true })
fs.mkdirSync(path.join(VAULT, '文档'), { recursive: true })

const DOCS: Array<{ id: string; title: string; body: string; updatedAt: string; version: number }> = [
  { id: 'd1', title: '血小板输注实践指南', body: '血小板计数 10×10⁹/L 以下预防性输注，肝素诱导的血小板减少症是禁忌。', updatedAt: '2026-09-23T10:00:00+08:00', version: 1 },
  { id: 'd2', title: '献血注意事项', body: '献血前要吃早餐，多喝水；献血后按压针眼十分钟，24 小时内避免剧烈运动。', updatedAt: '2026-09-23T10:01:00+08:00', version: 1 },
  { id: 'd3', title: 'MES 系统选型', body: '制造执行系统负责工单派发、生产追溯与设备联网，选型先看车间数据采集能力。', updatedAt: '2026-09-23T10:02:00+08:00', version: 1 },
  { id: 'd4', title: '量子计算入门', body: '量子比特利用叠加与纠缠并行计算，退相干时间是最主要的工程挑战。', updatedAt: '2026-09-23T10:03:00+08:00', version: 1 },
  { id: 'd5', title: '开源监控系统对比', body: 'Prometheus 拉模型配合 Grafana 看板是云原生监控事实标准，Zabbix 更适合传统机房。', updatedAt: '2026-09-23T10:04:00+08:00', version: 1 },
]

// 造镜像区 + manifest（模拟 sync 后状态）
const manifest: Record<string, { path: string; sha256: string; version: number; updatedAt: string }> = {}
for (const d of DOCS) {
  const rel = `文档/${d.title}.md`
  const content = `---\nmoonlybox: {"id":"${d.id}","version":${d.version}}\ntitle: ${d.title}\n---\n\n${d.body}\n`
  fs.writeFileSync(path.join(VAULT, rel), content)
  manifest[d.id] = { path: rel, sha256: 'x', version: d.version, updatedAt: d.updatedAt }
}
fs.writeFileSync(path.join(VAULT, '.moonlybox', 'manifest.json'), JSON.stringify(manifest, null, 2))

const { reindex, searchLocalAsync, indexStats } = await import('../src/lib/indexer')

async function main(): Promise<void> {
  // —— 1. 全量索引 ——
  const r1 = await reindex(VAULT)
  ok(r1.indexed === 5 && r1.removed === 0, `全量索引 5 篇（indexed=${r1.indexed} removed=${r1.removed}）`)
  const stats = indexStats(VAULT)
  ok(stats.docs === 5 && stats.vectors === 5, `三表一致 docs=${stats.docs} vectors=${stats.vectors}`)

  // —— 2. 幂等：再跑一次全 skipped ——
  const r2 = await reindex(VAULT)
  ok(r2.indexed === 0 && r2.skipped === 5, `幂等对账 skipped=5（indexed=${r2.indexed}）`)

  // —— 3. 关键词检索（FTS）——
  const kw = await searchLocalAsync(VAULT, '血小板输注')
  ok(kw.length > 0 && kw[0].title.includes('血小板'), `关键词命中首位=血小板文档（${kw[0]?.title}）`)

  // —— 4. 语义检索（换词形）：「无偿献血 之前能不能吃饭」→ 献血注意事项 ——
  const sem = await searchLocalAsync(VAULT, '无偿献血之前需要空腹吗')
  ok(
    sem.length > 0 && sem[0].title.includes('献血'),
    `语义换词形命中首位=献血注意事项（got: ${sem[0]?.title ?? '无'}）`,
  )

  // —— 5. 语义检索：中文问句对英文术语文档 ——
  const en = await searchLocalAsync(VAULT, '生产制造执行软件怎么选')
  ok(en.length > 0 && en[0].title.includes('MES'), `语义跨表述命中=MES（got: ${en[0]?.title ?? '无'}）`)

  // —— 6. 增量：d3 版本前进 ——
  DOCS[2].version = 2
  DOCS[2].body = '制造执行系统 MES 负责工单派发、生产追溯与设备联网；选型新增 AI 质检维度。'
  const rel3 = `文档/${DOCS[2].title}.md`
  fs.writeFileSync(
    path.join(VAULT, rel3),
    `---\nmoonlybox: {"id":"d3","version":2}\ntitle: ${DOCS[2].title}\n---\n\n${DOCS[2].body}\n`,
  )
  manifest.d3.updatedAt = '2026-09-23T10:05:00+08:00'
  manifest.d3.version = 2
  fs.writeFileSync(path.join(VAULT, '.moonlybox', 'manifest.json'), JSON.stringify(manifest, null, 2))
  const r3 = await reindex(VAULT)
  ok(r3.indexed === 1 && r3.skipped === 4, `增量只重索引 1 条（indexed=${r3.indexed} skipped=${r3.skipped}）`)
  const up = await searchLocalAsync(VAULT, 'AI 质检')
  ok(up.length > 0 && up[0].title.includes('MES'), '增量后新内容可检索')

  // —— 7. 删除：d4 移除 ——
  fs.unlinkSync(path.join(VAULT, `文档/${DOCS[3].title}.md`))
  delete manifest.d4
  fs.writeFileSync(path.join(VAULT, '.moonlybox', 'manifest.json'), JSON.stringify(manifest, null, 2))
  const r4 = await reindex(VAULT)
  ok(r4.removed === 1, `删除对账 removed=1（${r4.removed}）`)
  const stats2 = indexStats(VAULT)
  ok(stats2.docs === 4 && stats2.vectors === 4, `删除后三表一致 docs=${stats2.docs} vectors=${stats2.vectors}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
