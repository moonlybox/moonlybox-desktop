import type { CommandOptions } from '../lib/runner'
import { loadCredentials } from '../lib/auth'
import { listTools, callTool } from '../lib/moonlink'

/** tools：列出 MoonLink 工具单源（tools/list）+ 可选远程调用（任务 4 验收面） */
export async function cmdTools(args: string[], options: CommandOptions): Promise<void> {
  const creds = loadCredentials()
  if (!creds?.accessToken) {
    console.error('Not logged in. Run `moonlybox login` first.')
    process.exitCode = 1
    return
  }

  const tools = await listTools()
  if (args[0] === 'call') {
    const name = args[1]
    if (!name) {
      console.error('usage: moonlybox tools call <tool-name> \'{"json":"args"}\'')
      process.exitCode = 1
      return
    }
    const toolArgs = args[2] ? (JSON.parse(args[2]) as Record<string, unknown>) : {}
    const result = await callTool(name, toolArgs)
    for (const c of result.content ?? []) {
      if (c.type === 'text' && c.text) console.log(c.text)
    }
    return
  }

  console.log(`MoonLink tools (${tools.length}, 单源=服务端 tools.ts):\n`)
  for (const t of tools) {
    const ro = t.annotations?.readOnlyHint === true ? 'read-only' : 'write'
    console.log(`  ${t.name.padEnd(24)} [${ro}] ${t.title ?? ''} — ${t.description?.slice(0, 60) ?? ''}…`)
  }
}
