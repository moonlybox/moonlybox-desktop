import type { CommandOptions } from '../lib/runner'
import { loadConfig } from '../lib/config'

/** vault 双向同步（任务 5，M1 最大块）（WBS 任务 5，骨架占位） */
export async function cmdSync(args: string[], options: CommandOptions): Promise<void> {{
    // TODO(任务5): init 建档/增量下发/收集箱上行/对账/断点续传
    const { defaultVaultRoot } = await import('../lib/config')
    const root = (options.dir as string) ?? loadConfig().vault?.root ?? defaultVaultRoot()
    console.log(`sync: not implemented yet (WBS task 5) — vault root: ${root}`)}}
