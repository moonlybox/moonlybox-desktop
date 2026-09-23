import type { CommandOptions } from '../lib/runner'
import { callTool } from '../lib/moonlink'
import { defaultBaseUrl } from '../lib/config'

function field(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * memory：记忆面板（#232 M3）——远程 MCP 消费（search_memory 等，同轨配额，原则⑤）。
 * 子命令：
 *   moonlybox memory search <关键词>   语义/关键词搜记忆
 *   moonlybox memory add <内容>        静默记忆补充
 *   moonlybox memory list [limit]      最近记忆（search 空串不可用，用 export 语义的宽词）
 */
export async function cmdMemory(args: string[], options: CommandOptions): Promise<void> {
  const sub = args[0] ?? 'search'
  const baseUrl = (options.baseUrl as string) ?? defaultBaseUrl()

  try {
    if (sub === 'add') {
      const content = args.slice(1).join(' ').trim()
      if (!content) {
        console.error('用法: moonlybox memory add <内容>')
        process.exitCode = 1
        return
      }
      const res = await callTool('add_memory', { text: content }, { baseUrl })
      console.log(res.content?.map((c) => c.text ?? '').join('\n') || '已记录')
      return
    }

    if (sub === 'list') {
      // search_memory 无分页参数：宽词「的」探测（queryTerms 主路，中文停用词在工具侧无效）
      const res = await callTool('search_memory', { query: field(args, '--type') ? String(options['--type'] ?? '') || '的' : '的' }, { baseUrl })
      console.log(res.content?.map((c) => c.text ?? '').join('\n') || '（无记忆）')
      return
    }

    // 默认 search
    const query = args.slice(sub === 'search' ? 1 : 0).join(' ').trim()
    if (!query) {
      console.error('用法: moonlybox memory search <关键词> | memory add <内容> | memory list')
      process.exitCode = 1
      return
    }
    const res = await callTool('search_memory', { query }, { baseUrl })
    console.log(res.content?.map((c) => c.text ?? '').join('\n') || '（无命中）')
  } catch (e) {
    console.error(`记忆面板失败: ${String((e as Error).message ?? e)}`)
    process.exitCode = 1
  }
}
