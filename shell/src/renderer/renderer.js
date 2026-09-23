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

// 剪贴板监听开关（持久化到 localStorage）
$('cb-watch').checked = localStorage.getItem('clipWatch') === '1'
$('cb-watch').onchange = async (e) => {
  const on = await window.moonlybox.setClipboardWatch(e.target.checked)
  localStorage.setItem('clipWatch', on ? '1' : '0')
  log(on ? '[剪贴板监听] 已开启（新内容自动入收集箱）' : '[剪贴板监听] 已关闭')
}
if ($('cb-watch').checked) window.moonlybox.setClipboardWatch(true)

// 协议状态显示
window.moonlybox.protocolState().then((st) => {
  if (st.isDefault) log('[moonlybox://] 协议已接管')
})

// 关于：版本双轨 + 更新
async function loadAbout() {
  const v = await window.moonlybox.versions()
  $('about').textContent = `壳 v${v.shellVersion} · 内核 v${v.kernelVersion}`
}
loadAbout()

$('btn-check-update').onclick = async () => {
  $('update-state').textContent = '检查中…'
  const st = await window.moonlybox.updateCheck()
  if (st.available) $('update-state').textContent = `新版本 v${st.version}（下载中/已就绪，重启生效）`
  else if (st.error) $('update-state').textContent = `检查失败（离线或网络受限）`
  else $('update-state').textContent = '已是最新版本'
}

// 同步
$('btn-sync').onclick = async () => {
  log('\n[sync] 运行中…')
  const r = await window.moonlybox.rpc('sync', {})
  if (r.event === 'error') log(`[错误] ${r.message}`)
  else log('[sync] 完成')
}
