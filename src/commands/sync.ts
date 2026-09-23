import type { CommandOptions } from '../lib/runner'
import { loadConfig, defaultVaultRoot } from '../lib/config'
import { initVault, syncDown, syncInbox, loadManifest, type SyncReport } from '../lib/sync'
import * as fs from 'node:fs'
import * as path from 'node:path'

function resolveRoot(options: CommandOptions): string {
  return (options.dir as string) ?? loadConfig().vault?.root ?? defaultVaultRoot()
}

/** vault 双向同步引擎（WBS 任务 5，§5.10）：init / sync / status */
export async function cmdSync(args: string[], options: CommandOptions): Promise<void> {
  const sub = args[0] ?? 'sync'
  const root = resolveRoot(options)

  if (sub === 'init') {
    initVault(root)
    console.log(`✓ Vault initialized at ${root}`)
    console.log(`  ${MIRROR_HINT}`)
    return
  }

  if (sub === 'status') {
    if (!fs.existsSync(root)) {
      console.error(`Vault not found: ${root}（先运行 moonlybox sync init）`)
      process.exitCode = 1
      return
    }
    const manifest = loadManifest(root)
    console.log(`Vault: ${root}`)
    console.log(`Tracked docs: ${Object.keys(manifest).length}`)
    const inboxDir = path.join(root, '收集箱')
    const pending = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.toLowerCase().endsWith('.md')) : []
    console.log(`收集箱待上传: ${pending.length}${pending.length ? ' → ' + pending.join(', ') : ''}`)
    return
  }

  // sync（默认）：下行对账 + 收集箱上行
  initVault(root)
  const report: SyncReport = { downloaded: [], updated: [], uploaded: [], inboxFiled: [], conflicts: [], skipped: [] }
  await syncInbox(root, report) // 收集箱先行（新文件先上云，产物随下行回流）
  await syncDown(root, report)

  console.log(`— sync ${root} —`)
  if (report.uploaded.length) console.log(`↑ 上传: ${report.uploaded.join(', ')}`)
  if (report.inboxFiled.length) for (const f of report.inboxFiled) console.log(`  归位: ${f}`)
  if (report.downloaded.length) console.log(`↓ 新下载 ${report.downloaded.length} 个文件`)
  if (report.updated.length) console.log(`↻ 更新 ${report.updated.length} 个文件`)
  if (report.skipped.length) for (const s of report.skipped) console.log(`- ${s}`)
  if (report.conflicts.length) {
    console.log(`⚠ 分歧 ${report.conflicts.length} 项（不自动覆盖，请处理）：`)
    for (const c of report.conflicts) console.log(`  ${c.path} — ${c.reason}`)
    process.exitCode = 2
  }
  if (!report.uploaded.length && !report.downloaded.length && !report.updated.length && !report.conflicts.length && !report.skipped.length) {
    console.log('✓ 已是最新（镜像区=云端，收集箱为空）')
  }
}

const MIRROR_HINT = '文档/、知识页/ = 云端镜像；收集箱/ = 上传入口'
