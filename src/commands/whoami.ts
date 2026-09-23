import type { CommandOptions } from '../lib/runner'
import { loadCredentials } from '../lib/auth'
import { apiGet } from '../lib/api'

interface Quotas {
  isPremium?: boolean
  bookmarkRemaining?: number
  bookmarkLimit?: number
  stickyRemaining?: number
  stickyLimit?: number
  todoRemaining?: number
  todoLimit?: number
  kbRemaining?: number
  kbLimit?: number
}

/** 账号与额度状态（login 后可用）：账号 + token 有效期 + 实时配额（GET /api/profile/quotas） */
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

  // 实时配额（#244：whoami 直接查 /api/profile/quotas；失败降级为提示，不致命）
  try {
    const res = await apiGet<{ data?: { quotas?: Quotas } }>('/profile/quotas', { baseUrl: (options.baseUrl as string) })
    const q = res?.data?.quotas
    if (q) {
      console.log(`plan: ${q.isPremium ? 'premium' : 'free'}`)
      console.log(`bookmarks: ${q.bookmarkRemaining ?? '?'}/${q.bookmarkLimit ?? '?'} remaining`)
      console.log(`stickies: ${q.stickyRemaining ?? '?'}/${q.stickyLimit ?? '?'} remaining`)
      console.log(`todos: ${q.todoRemaining ?? '?'}/${q.todoLimit ?? '?'} remaining`)
      console.log(`kb pages: ${q.kbRemaining ?? '?'}/${q.kbLimit ?? '?'} remaining`)
    }
  } catch {
    console.log('quota: (unavailable — token may be expired, re-run `moonlybox login` if commands fail)')
  }
}
