#!/usr/bin/env bun
/**
 * 增量同步 E2E（#230 M2②）：本地 API 8098 + 临时 vault。
 * 链路：设备流登录（E2E 捷径审批）→ init → 首轮全量（2 文档）→ 云端改 1 删 1 →
 * 二轮增量（只回 1 changed + 1 deleted）→ cursor 幂等（三轮 0 变更）。
 * 跑法：BASE=http://127.0.0.1:8098 bun tests/changes.e2e.ts
 */
import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8098'
const VAULT = '/tmp/e2e_vault_230'
const API_DIR = '/www/repos-work/myfavorite/myfavorite-api'
const DB_ENV = { ...process.env, DB_CONNECTION: 'sqlite', DB_DATABASE: '/tmp/e2e_cli.sqlite' }

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

function php(script: string): string {
  fs.writeFileSync('/tmp/e2e230_tmp.php', script.startsWith('<?php') ? script : `<?php\n${script}`)
  const r = spawnSync('php', ['/tmp/e2e230_tmp.php'], { cwd: API_DIR, env: DB_ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`php helper failed: ${r.stderr || r.stdout}`)
  console.log(`  [php] DB=${DB_ENV.DB_DATABASE} out=${r.stdout.trim().slice(0, 60)}`)
  return r.stdout
}

async function main(): Promise<void> {
  fs.rmSync(VAULT, { recursive: true, force: true })
  fs.mkdirSync(VAULT, { recursive: true })

  // —— 1. 设备流登录（复用 task3 配方：DCR → device code → seed 审批 → token）——
  const dcr = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'MoonlyBox CLI (e2e-changes)', client_type: 'desktop' }),
  })
  const clientId = ((await dcr.json()) as any).client_id
  const dc = await fetch(`${BASE}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: 'moonlink' }),
  })
  const dcBody = await dc.json() as any
  ok(dc.status === 200 && !!dcBody.user_code, `device code ${dcBody.user_code}`)
  await new Promise((r) => setTimeout(r, (dcBody.interval ?? 5) * 1000))
  execSync(`php /tmp/seed_device_user.php ${dcBody.user_code}`, { cwd: API_DIR, env: DB_ENV, stdio: 'pipe' })
  const poll = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: dcBody.device_code,
    }),
  })
  const token = ((await poll.json()) as any).access_token
  ok(!!token, 'token acquired')
  // 凭据与配置落盘（HOME 隔离：XDG_CONFIG_HOME 指临时目录）
  const cfgHome = '/tmp/e2e_cfg_230'
  fs.rmSync(cfgHome, { recursive: true, force: true })
  fs.mkdirSync(path.join(cfgHome, 'moonlybox'), { recursive: true })
  fs.writeFileSync(path.join(cfgHome, 'moonlybox', 'config.json'), JSON.stringify({ api: { baseUrl: BASE } }))
  fs.writeFileSync(path.join(cfgHome, 'moonlybox', 'credentials.json'), JSON.stringify({ clientId, accessToken: token }))
  fs.chmodSync(path.join(cfgHome, 'moonlybox', 'credentials.json'), 0o600)

  // —— 2. init + 云端造 2 文档 ——
  execSync('bun run dev sync init --dir ' + VAULT, { cwd: '/www/repos-work/moonlybox-desktop', env: { ...process.env, XDG_CONFIG_HOME: cfgHome }, stdio: 'pipe' })
  php(fs.readFileSync('/tmp/e2e_seed230.php', 'utf8'))
  ok(true, 'seeded 2 docs')

  // —— 3. 第一轮 sync（全量）——
  const s1 = execSync('bun run dev sync --dir ' + VAULT, { cwd: '/www/repos-work/moonlybox-desktop', env: { ...process.env, XDG_CONFIG_HOME: cfgHome }, stdio: 'pipe' }).toString()
  ok(s1.includes('新下载 2'), `sync#1 全量下载 2（out: ${s1.replace(/\n/g, ' | ').slice(0, 120)}）`)
  ok(fs.existsSync(path.join(VAULT, '文档', 'E2E 文档A.md')) && fs.existsSync(path.join(VAULT, '文档', 'E2E 文档B.md')), 'A/B 落盘')

  // —— 4. 云端改 A（version bump）删 B（软删）——
  php(fs.readFileSync('/tmp/e2e_mutate230.php', 'utf8'))

  // —— 5. 第二轮 sync（增量）——
  const s2 = execSync('bun run dev sync --dir ' + VAULT, { cwd: '/www/repos-work/moonlybox-desktop', env: { ...process.env, XDG_CONFIG_HOME: cfgHome }, stdio: 'pipe' }).toString()
  const a2 = fs.readFileSync(path.join(VAULT, '文档', 'E2E 文档A.md'), 'utf8')
  ok(a2.includes('alpha 内容 v2'), 'sync#2 增量：A 内容更新到 v2')
  ok(!fs.existsSync(path.join(VAULT, '文档', 'E2E 文档B.md')), 'sync#2 增量：B 已移除（云端软删）')
  ok(s2.includes('更新 1') && !s2.includes('新下载'), `sync#2 增量只更新 1（out: ${s2.replace(/\n/g, ' | ').slice(0, 120)}）`)

  // —— 6. 第三轮 sync（幂等）——
  const s3 = execSync('bun run dev sync --dir ' + VAULT, { cwd: '/www/repos-work/moonlybox-desktop', env: { ...process.env, XDG_CONFIG_HOME: cfgHome }, stdio: 'pipe' }).toString()
  ok(s3.includes('已是最新'), `sync#3 幂等零变更（out: ${s3.replace(/\n/g, ' | ').slice(0, 120)}）`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

await main()
