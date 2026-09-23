import type { CommandOptions } from '../lib/runner'
import { loadConfig, defaultVaultRoot } from '../lib/config'
import { reindex, searchLocalAsync, indexStats } from '../lib/indexer'

function resolveRoot(options: CommandOptions): string {
  return (options.dir as string) ?? loadConfig().vault?.root ?? defaultVaultRoot()
}

/**
 * search：本地混合检索（#231 M2.5）——FTS5 关键词 + sqlite-vec 语义 RRF 融合。
 * 零流量：全查本地 .moonlybox/index.db（离线可用）；--reindex 强制全量重建索引。
 * 注：索引对账基于 manifest 对镜像区文件的比对，云端变更先用 `moonlybox sync` 下行。
 */
export async function cmdSearch(args: string[], options: CommandOptions): Promise<void> {
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim()
  const root = resolveRoot(options)
  if (!query) {
    console.error('用法: moonlybox search <问题>')
    process.exitCode = 1
    return
  }

  try {
    const report = await reindex(root)
    if (report.indexed > 0 || report.removed > 0) {
      console.log(`索引更新: +${report.indexed} 新增/更新, -${report.removed} 移除`)
    }
  } catch (e) {
    console.error(`索引失败: ${String(e)}`)
    process.exitCode = 1
    return
  }

  const stats = indexStats(root)
  if (stats.docs === 0) {
    console.log('索引为空：先运行 `moonlybox sync` 下载文档到镜像区。')
    return
  }

  const hits = await searchLocalAsync(root, query, 5)
  if (hits.length === 0) {
    console.log(`「${query}」在本地索引中没有找到相关内容。`)
    return
  }
  console.log(`— 本地检索「${query}」（索引 ${stats.docs} 篇）—`)
  for (const [i, h] of hits.entries()) {
    console.log(`${i + 1}. [${h.source}] ${h.title}  (score ${h.score.toFixed(4)})`)
  }
}
