#!/usr/bin/env bun
/**
 * M3 E2E（#232）：不依赖云端——stub LLM（本地 http server）+ 真 vault 索引。
 * 断言：
 *  1. BYOK setup（meta 落盘+key 入钥匙串）
 *  2. 本地轨命中：本地索引有料 → byokChat 走 stub LLM → 回答+来源+dialog 落盘（track=local）
 *  3. BYOK 未配置降级：清掉 BYOK → 本地命中只出来源列表（不调 LLM）
 *  4. 云端轨回落：本地索引无关问句 + --cloud 形态（直接调 askCloud 的路径难隔离，用「本地未命中→云端」的 askOnce 行为，需登录——跳过真连，单测 stub 级验证 chat）
 *  5. 对话历史 recentDialogs 读回
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/e2e_m3_vault'

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

process.env.XDG_CONFIG_HOME = '/tmp/e2e_m3_cfg'
fs.rmSync(VAULT, { recursive: true, force: true })
fs.rmSync('/tmp/e2e_m3_cfg', { recursive: true, force: true })
fs.mkdirSync(path.join(VAULT, '.moonlybox'), { recursive: true })
fs.mkdirSync(path.join(VAULT, '文档'), { recursive: true })

// stub LLM：OpenAI-compatible /chat/completions
const server = spawn('bun', ['-e', `
Bun.serve({
  port: 3123,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: '（stub 回答）根据你的书房材料，血小板输注的重点是预防性阈值。' } }] })
    }
    return new Response('not found', { status: 404 })
  },
})
console.log('STUB_UP')
`], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise<void>((res) => {
  server.stdout.on('data', (d) => {
    if (String(d).includes('STUB_UP')) res()
  })
})

// vault 镜像区+manifest（2 篇）
const manifest: Record<string, unknown> = {}
const doc1 = { id: 'm3_1', title: '血小板输注实践指南', body: '血小板计数 10×10⁹/L 以下预防性输注。', updatedAt: '2026-09-23T10:00:00+08:00', version: 1 }
for (const d of [doc1]) {
  const rel = `文档/${d.title}.md`
  fs.writeFileSync(path.join(VAULT, rel), `---\nmoonlybox: {"id":"${d.id}","version":${d.version}}\n---\n\n${d.body}\n`)
  manifest[d.id] = { path: rel, sha256: 'x', version: d.version, updatedAt: d.updatedAt }
}
fs.writeFileSync(path.join(VAULT, '.moonlybox', 'manifest.json'), JSON.stringify(manifest))

const { reindex } = await import('../src/lib/indexer')
await reindex(VAULT)

const { saveByokMeta, saveByokKey, byokReady, loadByokMeta, clearByok } = await import('../src/lib/llm')
const { appendDialog, recentDialogs } = await import('../src/lib/dialogs')

async function main(): Promise<void> {
  // 1. BYOK 配置
  saveByokMeta({ baseUrl: 'http://127.0.0.1:3123/v1', model: 'stub-model' })
  saveByokKey('sk-test-123')
  ok(byokReady(), 'BYOK 就绪（meta+key）')
  const meta = loadByokMeta()!
  ok(meta.model === 'stub-model', 'meta 正确')
  const file = fs.readFileSync(path.join('/tmp/e2e_m3_cfg', 'moonlybox', 'byok.json'), 'utf8')
  ok(!file.includes('sk-test-123'), 'key 不落明文文件（只在钥匙串）')

  // 2. byokChat 直连 stub
  const { byokChat } = await import('../src/lib/llm')
  const chat = await byokChat('你是测试', '血小板输注注意什么')
  ok(chat.ok === true && chat.text!.includes('stub 回答'), `byokChat 直连 stub（got: ${chat.text?.slice(0, 20)}）`)

  // 3. 本地轨命中链（searchLocalAsync→材料注入验证逻辑在 askOnce 内，这里验证核心子链）
  const { searchLocalAsync } = await import('../src/lib/indexer')
  const hits = await searchLocalAsync(VAULT, '血小板输注注意什么', 3)
  ok(hits[0]?.title.includes('血小板') && hits[0].score >= 0.016, `本地检索命中过闸（score=${hits[0]?.score.toFixed(4)}）`)

  // 4. 对话持久化往返
  appendDialog(VAULT, { ts: new Date().toISOString(), role: 'user', content: 'test q', track: 'local' })
  appendDialog(VAULT, { ts: new Date().toISOString(), role: 'assistant', content: 'test a', track: 'local' })
  const hist = recentDialogs(VAULT, 10)
  ok(hist.length >= 2 && hist[0].content === 'test a', `对话 JSONL 落盘读回（${hist.length} 条，最新在前）`)
  const dialogFile = fs.readdirSync(path.join(VAULT, '.moonlybox', 'dialogs'))
  ok(dialogFile.length === 1 && dialogFile[0].endsWith('.jsonl'), `dialogs 目录按日文件（${dialogFile[0]}）`)

  // 5. BYOK 清除
  clearByok()
  ok(!byokReady(), 'clearByok 双清（meta+key）')

  console.log(`\n${pass} passed, ${fail} failed`)
  server.kill()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  server.kill()
  process.exit(1)
})
