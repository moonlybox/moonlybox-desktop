import type { CommandOptions } from '../lib/runner'
import { loadConfig } from '../lib/config'

/** 账号与额度状态（login 后可用）（WBS 任务 3，骨架占位） */
export async function cmdWhoami(args: string[], options: CommandOptions): Promise<void> {{
    const cfg = loadConfig()
    if (!cfg.auth?.userId) {
        console.log('Not logged in. Run `moonlybox login` first.')
        return
    }
    console.log(`account: ${cfg.auth.accountEmail ?? cfg.auth.userId}`)
    console.log('quota: (M1 task 3 将接入 /ai/quota 查询)')}}
