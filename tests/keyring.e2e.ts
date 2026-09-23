#!/usr/bin/env bun
/** 钥匙串层 E2E（#230 M2③）：save→load 往返（token 在钥匙串/文件回落都覆盖）+ 旧全量文件迁移 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

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

const cfgHome = '/tmp/e2e_keyring_cfg'
process.env.XDG_CONFIG_HOME = cfgHome
fs.rmSync(cfgHome, { recursive: true, force: true })

const { loadCredentials, saveCredentials, clearCredentials } = await import('../src/lib/auth')

// 1. save→load 往返
saveCredentials({
  clientId: 'cid_123',
  accessToken: 'at_abc',
  refreshToken: 'rt_xyz',
  accountEmail: 'e2e@test',
})
const c1 = loadCredentials()
ok(c1?.accessToken === 'at_abc' && c1?.refreshToken === 'rt_xyz', 'save→load 往返（钥匙串或文件回落）')
ok(c1?.accountEmail === 'e2e@test', '元数据保留')

// 2. 文件里 token 是否已剥离（钥匙串可用时）
const file = JSON.parse(fs.readFileSync(path.join(cfgHome, 'moonlybox', 'credentials.json'), 'utf8')) as any
const keyringWorks = file.accessToken === undefined
ok(keyringWorks || file.accessToken === 'at_abc', `token 位置符合分层设计（${keyringWorks ? '钥匙串' : '文件回落'}）`)
if (keyringWorks) {
  const { Entry } = await import('@napi-rs/keyring')
  const blob = JSON.parse(new Entry('moonlybox', 'tokens').getPassword()!)
  ok(blob.accessToken === 'at_abc', '钥匙串内 blob 含 token')
  ok(!('accountEmail' in blob), '钥匙串不存元数据（只存 token）')
}

// 3. 旧全量文件迁移（模拟 M1 老用户）
clearCredentials()
fs.mkdirSync(path.join(cfgHome, 'moonlybox'), { recursive: true })
fs.writeFileSync(
  path.join(cfgHome, 'moonlybox', 'credentials.json'),
  JSON.stringify({ clientId: 'old_cid', accessToken: 'legacy_at', refreshToken: 'legacy_rt', accountEmail: 'old@test' },
),
)
const c2 = loadCredentials()
ok(c2?.accessToken === 'legacy_at' && c2?.refreshToken === 'legacy_rt', '旧全量文件可读（迁移透传）')
const file2 = JSON.parse(fs.readFileSync(path.join(cfgHome, 'moonlybox', 'credentials.json'), 'utf8')) as any
if (keyringWorks) {
  ok(!file2.accessToken && !file2.refreshToken, '迁移后文件已剥离 token')
  const { Entry } = await import('@napi-rs/keyring')
  const blob2 = JSON.parse(new Entry('moonlybox', 'tokens').getPassword()!)
  ok(blob2.accessToken === 'legacy_at', '迁移后 token 入钥匙串')
} else {
  ok(!!file2.accessToken, '无钥匙串环境：旧文件保持原样')
}

// 4. clear 双清
clearCredentials()
ok(loadCredentials() === null, 'clear 后 load=null')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
