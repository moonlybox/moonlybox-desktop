/** renderer：daemon RPC 版——过程行流式上屏（log 事件），done 汇总。 */
const $ = (id) => document.getElementById(id)
const log = (t) => { $('log').textContent += t + '\n'; $('log').scrollTop = $('log').scrollHeight }

// 订阅内核过程事件（必须在发请求前）
window.moonlybox.subscribe()
window.moonlybox.onKernelEvent((msg) => {
  if (msg.event === 'log') log(msg.payload)
  else if (msg.event === 'stderr') log('[stderr] ' + msg.payload)
  else if (msg.event === 'confirm_request') renderConfirmBar(msg.id, msg.payload)
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
  const tools = $('cb-tools') && $('cb-tools').checked
  const r = await window.moonlybox.rpc('xiaoyue', tools ? { q, tools: true } : { q }, 300_000)
  $('btn-ask').disabled = false
  if (r.event === 'error') log(`[错误] ${r.message}`)
}

// P2：确认条——写操作确认制在 UI 的承载（daemon confirm_request → 按钮 → confirm_response）
function renderConfirmBar(rpcId, payload) {
  const box = document.createElement('div')
  box.id = `confirm-${rpcId}`
  // 配色跟随主题：半透明琥珀叠底+继承主题文字色（硬编码浅底在深色模式下浅底浅字不可读——真机反馈）
  box.style.cssText = 'margin:6px 0;padding:8px 10px;border:1px solid rgba(245,158,11,.55);border-radius:6px;background:rgba(245,158,11,.12);color:inherit'
  const tool = payload && payload.tool ? payload.tool : '?'
  const args = payload && payload.args ? String(payload.args).slice(0, 160) : ''
  box.innerHTML = `<div style="font-size:12px;margin-bottom:6px">⚠ 小月请求执行 <b>${tool}</b>${args ? `：${args}` : ''}</div>`
  const row = document.createElement('div')
  const mk = (label, value, primary) => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    if (primary) b.style.background = '#f59e0b', b.style.borderColor = '#f59e0b'
    b.onclick = async () => {
      await window.moonlybox.confirmResponse(rpcId, value)
      box.remove()
      log(value ? `[已确认] 执行 ${tool}` : `[已取消] 跳过 ${tool}`)
    }
    return b
  }
  row.appendChild(mk('✓ 确认执行', true, true))
  row.appendChild(mk('✕ 取消', false, false))
  box.appendChild(row)
  const logEl = document.getElementById('log')
  if (logEl) logEl.appendChild(box)
  logEl && (logEl.scrollTop = logEl.scrollHeight)
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
  if (btn && !btn.dataset.bound) {
    // onclick 绑定只做一次；0.2.1 重构显示逻辑时曾把绑定弄丢=按钮可见但点击无反应（真机反馈实锤）
    btn.dataset.bound = '1'
    btn.onclick = () => window.moonlybox.updateInstall()
  }
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

// ==================== 图示工作台（#252 §8） ====================
// 三区：代码面板+实时预览（分栏，v1 不做折叠按钮——CSS flex 已分栏）+状态条
// 生命周期：保存草稿（云端 draft，不进书房）→ 存进书房（activate 跃迁）
let dgCurrentId = null
let dgRenderTimer = null
let dgLastError = null

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })

function dgExtractMermaid(src) {
  // 源码=唯一事实源（§8.1）：正文单个 mermaid 代码块；容错裸写 mermaid 语法
  const m = src.match(/```mermaid\n([\s\S]*?)```/)
  return (m ? m[1] : src).trim()
}

async function dgRender() {
  const err = $('dg-err')
  const box = $('dg-preview')
  const code = dgExtractMermaid($('dg-code').value)
  if (!code) { box.innerHTML = '<span style="opacity:.4;font-size:12px">左侧输入 mermaid 即时预览</span>'; err.style.display = 'none'; return }
  try {
    const { svg } = await mermaid.render('dg-svg-' + Date.now(), code)
    box.innerHTML = svg
    err.style.display = 'none'
  } catch (e) {
    // parse 校验错误行内联（§8.2）——错误回喂输入侧；暴露 AI 修复按钮（错误回喂重试闭环）
    dgLastError = String(e && e.message || e)
    err.textContent = '⚠ ' + dgLastError.slice(0, 300)
    err.style.display = 'block'
    $('dg-fix').style.display = 'inline-block'
    return
  }
  dgLastError = null
  $('dg-fix').style.display = 'none'
}

$('dg-code').addEventListener('input', () => {
  clearTimeout(dgRenderTimer)
  dgRenderTimer = setTimeout(dgRender, 400)
})

async function dgRefreshList() {
  const r = await window.moonlybox.rpc('diagram', { op: 'list' }, 30_000)
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = '列表加载失败'; return }
  try {
    const items = JSON.parse(r.text).data.diagrams || []
    const sel = $('dg-list')
    sel.innerHTML = '<option value="">— 草稿/书房图示 —</option>'
    for (const it of items) {
      const opt = document.createElement('option')
      opt.value = it.id
      opt.textContent = `${it.state === 'draft' ? '📝' : '📚'} ${it.title}`
      opt.dataset.state = it.state
      sel.appendChild(opt)
    }
  } catch { $('dg-state').textContent = '列表解析失败' }
}

$('dg-list').onchange = async () => {
  const id = $('dg-list').value
  if (!id) { dgCurrentId = null; return }
  const r = await window.moonlybox.rpc('diagram', { op: 'get', id }, 30_000)
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = '读取失败：' + r.text; return }
  try {
    const d = JSON.parse(r.text).data
    dgCurrentId = d.id
    $('dg-title').value = d.title
    $('dg-code').value = d.content
    $('dg-state').textContent = d.diagramState === 'draft' ? '📝 云端草稿（未进书房）' : '📚 已存书房'
    dgRender()
  } catch (e) { $('dg-state').textContent = '解析失败' }
}

$('dg-new').onclick = () => {
  dgCurrentId = null
  $('dg-title').value = ''
  $('dg-code').value = ''
  $('dg-state').textContent = '新草稿'
  $('dg-preview').innerHTML = ''
  $('dg-err').style.display = 'none'
}

$('dg-save').onclick = async () => {
  const title = $('dg-title').value.trim() || '未命名图示'
  const content = $('dg-code').value
  if (!content.trim()) { $('dg-state').textContent = '内容为空'; return }
  $('dg-save').disabled = true
  const r = await window.moonlybox.rpc('diagram', { op: 'save', id: dgCurrentId, title, content }, 60_000)
  $('dg-save').disabled = false
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = '保存失败：' + (r.text || r.message); return }
  try {
    const d = JSON.parse(r.text).data
    dgCurrentId = d.id
    $('dg-state').textContent = `✓ 已保存草稿 v${d.version}`
    dgRefreshList()
  } catch { $('dg-state').textContent = '保存响应异常' }
}

$('dg-activate').onclick = async () => {
  if (!dgCurrentId) { $('dg-state').textContent = '先保存草稿'; return }
  $('dg-activate').disabled = true
  const r = await window.moonlybox.rpc('diagram', { op: 'activate', id: dgCurrentId }, 60_000)
  $('dg-activate').disabled = false
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = '准入失败：' + (r.text || r.message); return }
  $('dg-state').textContent = '📚 已存进书房'
  dgRefreshList()
}

// T4：AI 生成（描述→源码）与 AI 修复（源码+错误→修好的源码）——错误回喂重试闭环 §8.2
$('dg-ai').onclick = async () => {
  const prompt = window.prompt('描述你要画的图（例：登录流程：输入账号密码→校验→成功进首页/失败提示错误）')
  if (!prompt || !prompt.trim()) return
  $('dg-ai').disabled = true
  $('dg-state').textContent = '✨ AI 生成中…'
  const r = await window.moonlybox.rpc('diagram', { op: 'ai', prompt }, 150_000)
  $('dg-ai').disabled = false
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = 'AI 生成失败：' + (r.text || r.message); return }
  try {
    const d = JSON.parse(r.text)
    $('dg-code').value = d.source
    $('dg-title').value = $('dg-title').value.trim() || prompt.slice(0, 30)
    dgCurrentId = null // 新生成=新草稿
    $('dg-state').textContent = '✓ AI 已生成（检查后保存草稿）'
    dgRender()
  } catch { $('dg-state').textContent = 'AI 响应解析失败' }
}

$('dg-fix').onclick = async () => {
  const src = $('dg-code').value
  if (!src.trim() || !dgLastError) return
  $('dg-fix').disabled = true
  $('dg-state').textContent = '✨ AI 修复中…'
  const r = await window.moonlybox.rpc('diagram', { op: 'fix', prompt: src, error: dgLastError }, 150_000)
  $('dg-fix').disabled = false
  if (r.event !== 'done' || r.code !== 0) { $('dg-state').textContent = 'AI 修复失败：' + (r.text || r.message); return }
  try {
    const d = JSON.parse(r.text)
    $('dg-code').value = d.source
    $('dg-state').textContent = '✓ AI 已修复（检查预览）'
    dgRender() // 修好后预览若仍错会再次亮出 fix 按钮——闭环
  } catch { $('dg-state').textContent = 'AI 响应解析失败' }
}

// tab 切换（小月 / 图示）
function switchTab(name) {
  const chat = name === 'chat'
  $('view-chat').style.display = chat ? 'flex' : 'none'
  $('view-diagram').style.display = chat ? 'none' : 'flex'
  $('tab-chat').style.color = chat ? '#4f46e5' : 'inherit'
  $('tab-chat').style.opacity = chat ? 1 : .55
  $('tab-diagram').style.color = chat ? 'inherit' : '#4f46e5'
  $('tab-diagram').style.opacity = chat ? .55 : 1
  if (!chat) { dgRefreshList(); dgRender() }
}
$('tab-chat').onclick = () => switchTab('chat')
$('tab-diagram').onclick = () => switchTab('diagram')
