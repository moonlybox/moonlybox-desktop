import type { CommandOptions } from '../lib/runner'
import { loadCredentials } from '../lib/auth'

/** 账号与额度状态（login 后可用） */
export async function cmdWhoami(args: string[], options: CommandOptions): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) {
    console.log('Not logged in. Run `moonlybox login` first.')
    return
  }
  console.log(`account: ${creds.accountEmail ?? creds.userId ?? '(unknown)'}`)
  if (creds.accessTokenExpiresAt) {
    const exp = new Date(creds.accessTokenExpiresAt)
    const mins = Math.round((exp.getTime() - Date.now()) / 60000)
    console.log(`access token: ${mins > 0 ? `expires in ${mins} min` : 'EXPIRED (auto-refresh on next API call)'}`)
  }
  console.log('quota: run `moonlybox tools call get_quota_status` for live quota')
}
