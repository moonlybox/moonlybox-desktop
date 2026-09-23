import type { CommandOptions } from '../lib/runner'
import { loadConfig, defaultVaultRoot } from '../lib/config'
import { initVault, syncInbox, loadManifest, vaultDirs } from '../lib/sync'
import { watch } from 'node:fs'

/** 收集箱监听（§5.10.2 步骤1）：新文件 → 立即上传归位。对账仍是权威（D10），监听只是加速器 */
export async function cmdInbox(args: string[], options: CommandOptions): Promise<void> {
  const root = (options.dir as string) ?? loadConfig().vault?.root ?? defaultVaultRoot()
  initVault(root)
  const d = vaultDirs(root)
  console.log(`收集箱监听中: ${d.inbox}（Ctrl-C 退出）`)
  // 启动即清一次积压
  const report = { downloaded: [], updated: [], uploaded: [], inboxFiled: [], conflicts: [], skipped: [] }
  await syncInbox(root, report)
  if (report.uploaded.length) console.log(`↑ 启动清积压: ${report.uploaded.join(', ')}`)

  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingFiles = new Set<string>()
  const flush = async () => {
    timer = null
    const files = [...pendingFiles]
    pendingFiles = new Set()
    const r: import('../lib/sync').SyncReport = { downloaded: [], updated: [], uploaded: [], inboxFiled: [], conflicts: [], skipped: [] }
    try {
      await syncInbox(root, r)
      for (const f of r.uploaded) console.log(`↑ ${f} 已上传归位`)
      for (const c of r.conflicts) console.log(`⚠ ${c.path} — ${c.reason}`)
    } catch (e: any) {
      console.error(`inbox sync 失败: ${e.message}`)
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 2000) // 防抖 2s（§5.10.4 防抖合并）
  }
  watch(d.inbox, { recursive: false }, (_ev, file) => {
    if (file && file.toLowerCase().endsWith('.md') && !file.startsWith('.')) {
      pendingFiles.add(file)
      schedule()
    }
  })
  // 常驻
  await new Promise(() => {})
}
