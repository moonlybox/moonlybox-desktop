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
  // 打开页面即拉全量更新状态（不依赖手动点检查；修复=自动下载就绪后按钮永不出现）
  try {
    const st = await window.moonlybox.updateState()
    renderUpdateState(st)
  } catch {}
}
function renderUpdateState(st) {
  const btn = document.getElementById('update-install')
  if (st && st.available) {
    $('update-state').textContent = st.downloaded
      ? `新版本 v${st.version} 已就绪`
      : `新版本 v${st.version} 下载中${typeof st.progress === 'number' ? ` ${st.progress}%` : '…'}`
    if (btn) btn.style.display = st.downloaded ? 'inline-block' : 'none'
  } else if (st && st.error) {
    $('update-state').textContent = '检查失败（离线或网络受限）'
    if (btn) btn.style.display = 'none'
  } else {
    $('update-state').textContent = '已是最新版本'
    if (btn) btn.style.display = 'none'
  }
}
loadAbout()
// 主进程推送：下载就绪即时亮按钮（修复=推送无人监听）
if (window.moonlybox.onUpdateReady) {
  window.moonlybox.onUpdateReady((info) => renderUpdateState({ available: true, downloaded: true, version: info && info.version }))
}
// 下载进度节流刷新（10s 一次拉状态，避免高频 IPC）
setInterval(async () => {
  try { renderUpdateState(await window.moonlybox.updateState()) } catch {}
}, 10_000)

$('btn-check-update').onclick = async () => {
  $('update-state').textContent = '检查中…'
  await window.moonlybox.updateCheck().catch(() => {})
  // 竞态修复：checkForUpdates 的 await 返回早于 update-downloaded 事件（状态被重置）——
  // 稍候 1.5s 拉最终状态快照再渲染（缓存命中时 downloaded 已置回 true）
  setTimeout(async () => {
    try { renderUpdateState(await window.moonlybox.updateState()) } catch {}
  }, 1500)
}

// 同步
$('btn-sync').onclick = async () => {
  log('\n[sync] 运行中…')
  const r = await window.moonlybox.rpc('sync', {})
  if (r.event === 'error') log(`[错误] ${r.message}`)
  else log('[sync] 完成')
}
