#!/usr/bin/env bun
/**
 * E2E：Device Flow 全链（DCR → device/code → poll → 用户审批 → token）
 * 跑法：bun tests/device-flow.e2e.ts
 */
export {}

const BASE = process.env.BASE ?? 'http://127.0.0.1:8098'
let pass = 0, fail = 0
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }

async function main() {
  // 1) DCR 注册 desktop 客户端
  const dcr = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'MoonlyBox CLI (e2e)', client_type: 'desktop' }),
  })
  const dcrBody = await dcr.json() as any
  ok(dcr.status === 201, `DCR 201 (got ${dcr.status})`)
  ok(Array.isArray(dcrBody.grant_types) && dcrBody.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code'), 'device_code grant 已授权')
  const clientId = dcrBody.client_id
  ok(!!clientId, `client_id=${String(clientId).slice(0, 8)}…`)

  // 2) 申请 device code（RFC 8628 §3.1）
  const dc = await fetch(`${BASE}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: 'moonlink' }),
  })
  const dcBody = await dc.json() as any
  ok(dc.status === 200, `device/code 200 (got ${dc.status})`)
  ok(!!dcBody.device_code && !!dcBody.user_code, `user_code=${dcBody.user_code} interval=${dcBody.interval}`)

  // 3) 未审批时 poll → authorization_pending
  await new Promise((r) => setTimeout(r, (dcBody.interval ?? 5) * 1000))
  const poll1 = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: dcBody.device_code,
    }),
  })
  const p1 = await poll1.json() as any
  ok(p1.error === 'authorization_pending', `poll→authorization_pending (got ${p1.error ?? 'token?!'})`)

  console.log(`\n[manual] 浏览器打开 ${BASE}/oauth/device?user_code=${dcBody.user_code} 并登录审批 —— 跳过：直接建测试用户并改库审批（E2E）`)

  // 4) E2E 捷径：seed 脚本建测试用户 + device code 标记 approved（模拟用户浏览器审批）
  const { execSync } = await import('node:child_process')
  execSync(`php /tmp/seed_device_user.php ${dcBody.user_code}`, {
    cwd: '/www/repos-work/myfavorite/myfavorite-api',
    env: { ...process.env, DB_CONNECTION: 'sqlite', DB_DATABASE: '/tmp/e2e_cli.sqlite' },
    stdio: 'pipe',
  })
  ok(true, 'device code approved（seed 脚本）')

  // 5) 再 poll → access_token + refresh_token
  const poll2 = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: dcBody.device_code,
    }),
  })
  const p2 = await poll2.json() as any
  ok(poll2.status === 200 && !!p2.access_token, `poll→token 200 (got ${poll2.status} ${p2.error ?? ''})`)
  ok(!!p2.refresh_token, 'refresh_token 下发')
  ok(p2.token_type === 'Bearer', `token_type=${p2.token_type}`)

  // 6) token 可用：调一个真实接口（whoami 用途）
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${p2.access_token}` } })
  ok(me.status === 200, `/api/auth/me 200 with device-flow token (got ${me.status})`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

await main()
