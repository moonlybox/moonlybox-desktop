import type { CommandOptions } from '../lib/runner'
import { loadConfig } from '../lib/config'
import { ensureClient, requestDeviceCode, pollToken } from '../lib/device-flow'
import { loadCredentials, saveCredentials, type Credentials } from '../lib/auth'

/** login：OAuth Device Flow（WBS 任务 3）——DCR → device code → 浏览器审批 → 轮询 → 凭据落盘 */
export async function cmdLogin(args: string[], options: CommandOptions): Promise<void> {
  const cfg = loadConfig()
  const baseUrl = (options.baseUrl as string) ?? cfg.api?.baseUrl
  const creds: Credentials = loadCredentials() ?? { clientId: '' }

  // 1) DCR（复用已有 clientId 免重复注册）
  let clientId = creds.clientId
  if (!clientId) {
    process.stdout.write('Registering device…\n')
    clientId = await ensureClient(baseUrl)
  }

  // 2) device code
  const dc = await requestDeviceCode(clientId, baseUrl)
  console.log(`\nOpen this link in any browser (phone works too) to approve:\n`)
  console.log(`  ${dc.verification_uri_complete ?? `${dc.verification_uri ?? `${baseUrl ?? 'https://moonlybox.cn'}/oauth/device`}?user_code=${dc.user_code}`}\n`)
  console.log(`Or enter code manually at ${dc.verification_uri ?? `${baseUrl ?? 'https://moonlybox.cn'}/oauth/device`}: ${dc.user_code}`)
  console.log(`Waiting for approval (expires in ${Math.round(dc.expires_in / 60)} min)…\n`)

  // 3) 轮询（RFC 8628：interval 起，slow_down +5s；total ≤ expires_in）
  let interval = (dc.interval ?? 5) * 1000
  const deadline = Date.now() + dc.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    const result = await pollToken(clientId, dc.device_code, baseUrl)
    if (result.status === 'pending') continue
    if (result.status === 'slow_down') {
      interval += 5000
      continue
    }
    if (result.status === 'denied') {
      console.error('Denied on the web page. Nothing changed.')
      process.exitCode = 1
      return
    }
    if (result.status === 'expired') {
      console.error('Device code expired. Run `moonlybox login` again.')
      process.exitCode = 1
      return
    }
    // done
    if (result.status !== 'done') continue
    const tokens = result.tokens
    const me = await fetch(`${baseUrl ?? cfg.api?.baseUrl ?? 'https://moonlybox.cn'}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const meBody = (await me.json().catch(() => null)) as any
    const email = meBody?.data?.user?.email ?? meBody?.data?.email
    const userId = meBody?.data?.user?.id ?? meBody?.data?.id
    saveCredentials({
      clientId,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      refreshToken: tokens.refresh_token,
      accountEmail: email,
      userId,
    })
    console.log(`✓ Logged in as ${email ?? userId ?? 'user'}`)
    console.log('  Credentials stored locally (keychain integration lands before M2).')
    return
  }
  console.error('Timed out waiting for approval.')
  process.exitCode = 1
}
