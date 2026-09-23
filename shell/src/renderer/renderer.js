/** renderer：T1 最小可用面——内核探针 + xiaoyue 单问（走 IPC→spawn 内核 CLI）。 */
const $ = (id) => document.getElementById(id)
const log = (t) => { $('log').textContent += t + '\n'; $('log').scrollTop = $('log').scrollHeight }

window.moonlybox.onKernelStdout((d) => log(d))
window.moonlybox.onKernelStderr((d) => log('[stderr] ' + d))

// 内核探针：tools list
async function probe() {
  $('kernel').textContent = '探针中…'
  const r = await window.moonlybox.kernelRun(['--help'])
  const ok = r.code === 0
  $('kernel').textContent = ok ? `已连接（CLI --help code=0）` : `探针失败 code=${r.code}`
  log(r.out || r.err)
}
probe()

// 小月单问：spawn `xiaoyue <问题>`（本地轨优先；云端轨需登录态）
async function ask() {
  const q = $('q').value.trim()
  if (!q) return
  $('q').value = ''
  log(`\n你> ${q}`)
  const r = await window.moonlybox.kernelRun(['xiaoyue', q])
  log((r.out || r.err || '').trim())
}
$('btn-ask').onclick = ask
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask() })

// 同步
$('btn-sync').onclick = async () => {
  log('\n[sync] 运行中…')
  const r = await window.moonlybox.kernelRun(['sync'])
  log((r.out || r.err || '').trim())
}
