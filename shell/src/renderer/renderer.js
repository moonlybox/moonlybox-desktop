/** renderer：daemon RPC 版——过程行流式上屏（log 事件），done 汇总。 */
const $ = (id) => document.getElementById(id)
const log = (t) => { $('log').textContent += t + '\n'; $('log').scrollTop = $('log').scrollHeight }

// 订阅内核过程事件（必须在发请求前）
window.moonlybox.subscribe()
window.moonlybox.onKernelEvent((msg) => {
  if (msg.event === 'log') log(msg.payload)
  else if (msg.event === 'stderr') log('[stderr] ' + msg.payload)
})

// 内核探针：daemon ping
async function probe() {
  $('kernel').textContent = '连接中…'
  const r = await window.moonlybox.rpc('ping', {}, 10_000)
  $('kernel').textContent = r.event === 'done' ? `已连接（daemon pong）` : `连接失败：${r.message}`
}
probe()

// 小月单问：RPC 流式（过程行实时上屏）
async function ask() {
  const q = $('q').value.trim()
  if (!q) return
  $('q').value = ''
  $('btn-ask').disabled = true
  log(`\n你> ${q}`)
  const r = await window.moonlybox.rpc('xiaoyue', { q })
  $('btn-ask').disabled = false
  if (r.event === 'error') log(`[错误] ${r.message}`)
}

$('btn-ask').onclick = ask
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask() })

// 同步
$('btn-sync').onclick = async () => {
  log('\n[sync] 运行中…')
  const r = await window.moonlybox.rpc('sync', {})
  if (r.event === 'error') log(`[错误] ${r.message}`)
  else log('[sync] 完成')
}
