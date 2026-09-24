#!/usr/bin/env bun
/**
 * moonlybox — MoonlyBox desktop CLI（M1 骨架）
 *
 * 命令规划（§5.16.3 WBS）：
 *   login        OAuth Device Flow 授权（任务 3）
 *   sync         vault 双向同步引擎（任务 5，M1 最大块）
 *   inbox watch  收集箱监听（任务 5 一部分）
 *   compile      本地 LLM 整理（M2，--local 预留）
 *   xiaoyue      对话（任务 6 最小版）
 *
 * 本文件只做命令路由；各命令实现在 src/commands/*，骨架阶段输出「未实现」。
 */
import { defineCommand, runCli } from './lib/runner'
import { loadConfig, configPath } from './lib/config'
import { loadCredentials } from './lib/auth'
import { cmdLogin } from './commands/login'
import { cmdSync } from './commands/sync'
import { cmdInbox } from './commands/inbox'
import { cmdCompile } from './commands/compile'
import { cmdXiaoyue } from './commands/xiaoyue'
import { cmdTools } from './commands/tools'
import { cmdWhoami } from './commands/whoami'
import { cmdSearch } from './commands/search'
import { cmdMemory } from './commands/memory'
import { runDaemon } from './commands/daemon'
import { ensureNativeOrt, lockNativeDir } from './lib/native-bootstrap'

/** 入口：ORT 原生层不可用时解压+exec 自身（#246）；daemon 模式跑在 shell node_modules 环境无需引导 */
// 引导后的子进程先锁定内嵌版 DLL（Windows LoadLibraryExW 预加载，须在 import ORT 之前）
if (process.env.MOONLYBOX_NATIVE_BOOTSTRAP === '1') lockNativeDir()
if (process.argv[2] !== 'daemon' && (await ensureNativeOrt())) {
  process.exit(process.exitCode ?? 0)
}

const cli = defineCommand({
  name: 'moonlybox',
  version: '0.1.0',
  description: 'MoonlyBox desktop client (M1 CLI)',
  subcommands: {
    login: {
      description: 'Authorize this device via OAuth Device Flow',
      run: cmdLogin,
    },
    whoami: {
      description: 'Show current account and quota status',
      run: cmdWhoami,
    },
    search: {
      description: 'Local hybrid search (FTS5 + sqlite-vec, offline)',
      options: {
        dir: { type: 'string', description: 'Vault root directory (default: config or ./MyMoonVault)' },
      },
      run: cmdSearch,
    },
    memory: {
      description: 'Memory panel via remote MCP (search/add/list)',
      options: {
        baseUrl: { type: 'string', description: 'API base URL override' },
      },
      run: cmdMemory,
    },
    sync: {
      description: 'Two-way sync between local vault and cloud',
      options: {
        dir: { type: 'string', description: 'Vault root directory (default: config or ./MyMoonVault)' },
        once: { type: 'boolean', description: 'Run one reconcile pass and exit' },
      },
      run: cmdSync,
    },
    inbox: {
      description: 'Collect-box pipeline (watch for new files)',
      subcommands: {
        watch: { description: 'Watch inbox directory and upload new files', run: cmdInbox },
      },
      run: cmdInbox,
    },
    compile: {
      description: 'Organize documents into knowledge pages',
      options: {
        local: { type: 'boolean', description: 'Use local LLM endpoint (M2)' },
      },
      run: cmdCompile,
    },
    xiaoyue: {
      description: 'Chat with Xiaoyue (minimal terminal chat)',
      run: cmdXiaoyue,
    },
    tools: {
      description: 'List/call MoonLink MCP tools (remote execution)',
      run: cmdTools,
    },
    daemon: {
      description: 'JSONL RPC daemon for the desktop shell (stdio)',
      run: () => runDaemon(),
    },
  },
  run: () => {
    const cfg = loadConfig()
    const creds = loadCredentials()
    console.log(`moonlybox v0.1.0`)
    console.log(`  config: ${configPath()}`)
    console.log(`  account: ${creds?.accountEmail ?? '(not logged in — run `moonlybox login`)'}`)
    console.log('')
    console.log('Use --help to see commands.')
  },
})

runCli(cli)
