import type { CommandOptions } from '../lib/runner'
import { loadConfig } from '../lib/config'

/** 文档整理为知识页（M2；--local 预留）（WBS 任务 6，骨架占位） */
export async function cmdCompile(args: string[], options: CommandOptions): Promise<void> {{
    // TODO(M2): 本地 LLM 编译管线（产物同 schema 云端准入）
    console.log(`compile: not implemented yet (M2) — local=${options.local === true}`)}}
