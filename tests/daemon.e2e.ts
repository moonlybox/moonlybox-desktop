/**
 * daemon JSONL RPC E2E（M4 T2）：spawn `bun run src/cli.ts daemon`，断言协议全程。
 * 依赖：本地索引 vault（MOONLYBOX_VAULT 环境变量，须已有 index.db）；不依赖壳/云端。
 */
const assert = (name: string, cond: unknown, extra = '') => {
  results.push({ name, ok: !!cond, extra })
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failed++
}
const results: Array<{ name: string; ok: boolean; extra?: string }> = []
let failed = 0

const VAULT = process.env.MOONLYBOX_VAULT || '/tmp/e2e_m25_vault'
const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'daemon'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, MOONLYBOX_VAULT: VAULT },
})

const reader = (async function* () {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const lineStr = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (lineStr) yield JSON.parse(lineStr)
    }
  }
})()

async function rpc(cmd: string, args: Record<string, unknown>, collectMs = 4000): Promise<Array<Record<string, unknown>>> {
  proc.stdin.write(JSON.stringify({ id: Math.floor(Math.random() * 1e9), cmd, args }) + '\n')
  await proc.stdin.flush()
  const msgs: Array<Record<string, unknown>> = []
  const deadline = Date.now() + collectMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.next()
    if (done) break
    msgs.push(value)
    if (value.event === 'done' || value.event === 'error') break
  }
  return msgs
}

// ready 帧
const first = await reader.next()
assert('ready 帧', first.value?.event === 'ready', JSON.stringify(first.value))

// ping
const ping = await rpc('ping', {})
assert('ping→pong', ping.at(-1)?.text === 'pong')

// search：本地索引命中
const search = await rpc('search', { q: '血小板输注' }, 30_000)
const doneS = search.at(-1)
console.log('SEARCH_MSGS:', JSON.stringify(search).slice(0, 400))
assert('search done', doneS?.event === 'done' && doneS?.code === 0)
assert('search 命中本地轨', String(doneS?.text ?? '').includes('血小板输注实践指南'))
assert('search log 事件流', search.filter((m) => m.event === 'log').length > 0)

// xiaoyue：本地轨判定 + BYOK 未配降级
const xy = await rpc('xiaoyue', { q: '血小板输注有什么讲究' }, 60_000)
const doneX = xy.at(-1)
assert('xiaoyue done', doneX?.event === 'done' && doneX?.code === 0)
const xyText = String(doneX?.text ?? '')
assert('xiaoyue 本地轨命中', xyText.includes('本地轨：命中'))
assert('xiaoyue 无 BYOK 降级来源列表', xyText.includes('配置 BYOK'))

// 坏 JSON 容错
proc.stdin.write('not-json\n')
const bad = await reader.next()
assert('坏 JSON 容错', bad.value?.event === 'error' && bad.value?.id === -1)

// 并发 id 不串
const [a, b] = await Promise.all([rpc('ping', {}), rpc('ping', {})])
assert('并发请求各自 done', a.at(-1)?.text === 'pong' && b.at(-1)?.text === 'pong')

// P2：xiaoyue tools:true——BYOK 未配路径（XDG 隔离环境无 BYOK，断言错误文案而非 usage 死路）
const xyTools = await rpc('xiaoyue', { q: '测试', tools: true }, 30_000)
const doneT = xyTools.at(-1)
assert('xiaoyue tools done/error 终止', doneT?.event === 'done' || doneT?.event === 'error', JSON.stringify(doneT)?.slice(0, 120))
assert('xiaoyue tools BYOK 引导', String(doneT?.text ?? doneT?.message ?? '').includes('BYOK'))

// P2：confirm_response 孤儿行不崩（无挂起确认时静默忽略）
proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'confirm_response', args: { value: true } }) + '\n')
await proc.stdin.flush()
const pingAfter = await rpc('ping', {})
assert('孤儿 confirm_response 后 daemon 存活', pingAfter.at(-1)?.text === 'pong')

// #252 图示 RPC：未登录环境 diagram list 优雅报错（code=1，不崩 daemon），坏 op 拒绝
const dgBad = await rpc('diagram', { op: 'nope' })
assert('diagram 未知 op 拒绝', dgBad.at(-1)?.event === 'done' && dgBad.at(-1)?.code === 2)
const dgList = await rpc('diagram', { op: 'list' }, 15_000)
const dgDone = dgList.at(-1)
assert('diagram list 终止（done，未登录则为 code=1 引导）', dgDone?.event === 'done', JSON.stringify(dgDone)?.slice(0, 100))
const pingDg = await rpc('ping', {})
assert('diagram 调用后 daemon 存活', pingDg.at(-1)?.text === 'pong')

// #252 T4：AI 生成未配 BYOK → 引导文案（与 xiaoyue tools 同款语义）
const dgAi = await rpc('diagram', { op: 'ai', prompt: '登录流程图' }, 30_000)
const dgAiDone = dgAi.at(-1)
assert('diagram ai BYOK 引导', dgAiDone?.event === 'done' && String(dgAiDone?.text ?? '').includes('BYOK'), JSON.stringify(dgAiDone)?.slice(0, 120))
const pingAi = await rpc('ping', {})
assert('diagram ai 调用后 daemon 存活', pingAi.at(-1)?.text === 'pong')

proc.kill()
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
