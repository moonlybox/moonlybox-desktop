/** renderer：#253 壳层重构——3 列布局（图标栏/功能列表/工作台）+ 标题栏 MDI 页帧 + 设置弹窗。 */
const $ = (id) => document.getElementById(id)

// renderer 全局错误可见化（UI 瘫痪时不再靠猜——错误横幅直接显示）
window.addEventListener('error', (e) => {
  try {
    let bar = document.getElementById('renderer-error')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'renderer-error'
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;font:12px/1.5 monospace;padding:6px 10px;max-height:120px;overflow:auto'
      document.body.appendChild(bar)
    }
    bar.textContent += `[renderer] ${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}\n`
  } catch {}
})
window.addEventListener('unhandledrejection', (e) => {
  try {
    let bar = document.getElementById('renderer-error')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'renderer-error'
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;font:12px/1.5 monospace;padding:6px 10px;max-height:120px;overflow:auto'
      document.body.appendChild(bar)
    }
    bar.textContent += `[promise] ${e.reason?.message ?? e.reason}\n`
  } catch {}
})

// ---------- 窗口控制 ----------
$('win-min').onclick = () => window.moonlybox.winMin()
$('win-max').onclick = () => window.moonlybox.winMax()
// 最大化/还原图标随窗口状态切换（#253.28）
const ICON_MAX = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>'
const ICON_RESTORE = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>'
window.moonlybox.onWinState?.((st) => {
  const btn = $('win-max')
  btn.innerHTML = st?.maximized ? ICON_RESTORE : ICON_MAX
  btn.title = st?.maximized ? '还原' : '最大化'
})
$('win-close').onclick = () => window.moonlybox.winClose()

// ---------- MDI 页帧（标题栏 tab ↔ 图标栏联动） ----------
// 图标单一源：path 数据（lucide 风格描边）——rail/页帧 tab/云端列共用（index.html rail 由 JS 注入，杜绝两处漂移）
const ICON_PATHS = {
  vault: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  diagram: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  xiaoyue: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
}
const navIconSvg = (nav, size = 18) => `<svg viewBox="0 0 24 24" style="width:${size}px;height:${size}px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${ICON_PATHS[nav] ?? ''}</svg>`
const NAVS = {
  vault: { label: '书房（本地）' },
  cloud: { label: '云端' },
  diagram: { label: '图示' },
  xiaoyue: { label: '小月' },
  help: { label: '帮助' },
  settings: { label: '设置' },
};  // 对象字面量后接 IIFE 必须分号（ASI 陷阱 #253.20）
let currentNav = null
const openFrames = new Set();  // 下一 IIFE 以 ( 开头，无分号会被解析为跨行调用（ASI 陷阱 #253.20）

// ---- 第二列拖宽（#253.18：限幅 180-420px，持久化；防误操作比例失调） ----
(() => {
  const MIN = 180, MAX = 420
  const resizer = document.getElementById('col-resizer')
  const listcol = document.getElementById('listcol')
  const saved = Number(localStorage.getItem('mb.listw') || 0)
  if (saved >= MIN && saved <= MAX) document.documentElement.style.setProperty('--list-w', saved + 'px')
  let startX = 0, startW = 0
  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX
    startW = listcol.getBoundingClientRect().width
    resizer.classList.add('dragging')
    document.body.classList.add('col-resizing')
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!resizer.classList.contains('dragging')) return
    const w = Math.min(MAX, Math.max(MIN, Math.round(startW + (e.clientX - startX))))
    document.documentElement.style.setProperty('--list-w', w + 'px')
  })
  window.addEventListener('mouseup', () => {
    if (!resizer.classList.contains('dragging')) return
    resizer.classList.remove('dragging')
    document.body.classList.remove('col-resizing')
    const w = listcol.getBoundingClientRect().width
    localStorage.setItem('mb.listw', String(w))
  })
})()

// rail 图标注入（单一源——index.html 的按钮内容由此填充）
for (const b of document.querySelectorAll('#rail .rail-btn')) {
  const nav = b.dataset.nav
  if (nav && ICON_PATHS[nav]) b.innerHTML = navIconSvg(nav)
}

function renderFrameTabs() {
  const box = $('frame-tabs')
  box.innerHTML = ''
  for (const nav of openFrames) {
    const b = document.createElement('button')
    b.className = 'frame-tab' + (nav === currentNav ? ' active' : '')
    b.innerHTML = `${navIconSvg(nav, 13)}<span style="vertical-align:middle;margin-left:5px">${NAVS[nav].label}</span>`
    b.onclick = () => switchNav(nav)
    box.appendChild(b)
  }
}

function switchNav(nav) {
  currentNav = nav
  openFrames.add(nav)
  document.querySelectorAll('.rail-btn[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === nav))
  renderFrameTabs()
  renderList(nav)
  renderWork(nav)
  if (nav === 'settings') $('dlg-settings').showModal()
}

document.querySelectorAll('.rail-btn[data-nav]').forEach((el) => {
  el.onclick = () => switchNav(el.dataset.nav)
})

// ---------- 第二列渲染 ----------
// SVG 描边图标（lucide 风格 stroke=currentColor——与 rail/标题栏同一套，#253.16 用户需求 1）
const CLOUD_ICONS = {
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  sticky: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
  todo: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  entity: '<path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><path d="M9 21h6"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
}
const cloudIconSvg = (name) => `<svg class="cloud-ico" viewBox="0 0 24 24">${CLOUD_ICONS[name] ?? CLOUD_ICONS.box}</svg>`
// 云端隐藏项（服务端 manifest 与客户端白名单双保险；后续云端放开再删）
const CLOUD_HIDDEN = new Set(['moments', 'square'])

async function renderList(nav) {
  const head = $('list-head')
  const body = $('list-body')
  head.textContent = NAVS[nav].label
  body.innerHTML = ''

  if (nav === 'vault') {
    const v = await window.moonlybox.vaultGet()
    if (!v || !require_exists(v)) {
      body.innerHTML = '<div class="muted" style="padding:10px">未选择书房目录<br/>请到 设置 → Vault 目录 选择</div>'
      return
    }
    // 全展开/全收起（#253.29）
    head.innerHTML = `${NAVS[nav].label} <span id="tree-exp" style="float:right;font-weight:400;font-size:11px;color:var(--muted);cursor:pointer">全部展开</span>`
    $('tree-exp').onclick = async () => {
      const expanding = $('tree-exp').textContent === '全部展开'
      if (expanding) treeCollapsed.clear()
      else {
        // 收起全部：收集当前 DOM 里所有目录 rel（含子层——重渲染前抓全量）
        const collect = (box) => {
          box.querySelectorAll('.tree-item.dir').forEach((d) => { if (d.dataset.rel) treeCollapsed.add(d.dataset.rel) })
        }
        collect(body)
      }
      const label = $('tree-exp')
      await renderList('vault')
      // renderList 重建了 head——按目标态写文案
      const exp = $('tree-exp')
      if (exp) exp.textContent = expanding ? '全部收起' : '全部展开'
    }
    await renderTree(body, '', 0)
  } else if (nav === 'cloud') {
    // #254：云端功能=服务端下发 manifest（功能升级/新增零客户端发版）
    const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
    if (r.event !== 'done' || r.code !== 0) {
      body.innerHTML = '<div class="muted" style="padding:10px">导航加载失败：' + (r.text || r.message) + '</div>'
      return
    }
    try {
      const { nav: items } = JSON.parse(r.text).data
      for (const it of items) {
        if (CLOUD_HIDDEN.has(it.id)) continue // 云端隐藏的功能本地不同步出现
        const el = document.createElement('div')
        el.className = 'tree-item'
        el.style.display = 'flex'
        el.style.alignItems = 'center'
        el.style.gap = '8px'
        el.innerHTML = `${cloudIconSvg(it.icon)}<span>${it.label}</span>`
        el.onclick = () => renderWork('cloud', it)
        body.appendChild(el)
      }
    } catch {
      body.innerHTML = '<div class="muted" style="padding:10px">导航解析失败（登录后可用）</div>'
    }
  } else if (nav === 'diagram') {
    const r = await window.moonlybox.rpc('diagram', { op: 'list' }, 30_000)
    try {
      const items = JSON.parse(r.text).data.diagrams || []
      for (const it of items) {
        const el = document.createElement('div')
        el.className = 'tree-item'
        el.textContent = `${it.state === 'draft' ? '📝' : '📚'} ${it.title}`
        el.onclick = () => renderWork('diagram', it)
        body.appendChild(el)
      }
      if (!items.length) body.innerHTML = '<div class="muted" style="padding:10px">暂无图示</div>'
    } catch {
      body.innerHTML = '<div class="muted" style="padding:10px">列表加载失败（登录后可用）</div>'
    }
  } else if (nav === 'xiaoyue') {
    body.innerHTML = '<div class="muted" style="padding:10px">小月对话（会话列表规划中）</div>'
  } else if (nav === 'help') {
    for (const [label, fn] of [['🧠 内核状态', () => renderWork('help', 'kernel')], ['ℹ️ 关于', () => renderWork('help', 'about')]]) {
      const el = document.createElement('div')
      el.className = 'tree-item'
      el.textContent = label
      el.onclick = fn
      body.appendChild(el)
    }
  }
}

function require_exists(v) { return typeof v === 'string' && v.length > 0 }

// 书房树（#253.30 重写）：目录可展开/收起。结构不变式：目录行 el 的下一个兄弟=子容器 .tree-children（未折叠时存在）
const treeCollapsed = new Set() // 折叠目录 rel 集合（会话内记忆）

async function renderTree(container, rel, depth) {
  const r = await window.moonlybox.fsList(rel)
  if (!r.ok) { container.innerHTML = `<div class="muted" style="padding:10px">${r.message}</div>`; return }
  for (const item of r.items) {
    const relPath = rel ? `${rel}/${item.name}` : item.name
    const el = document.createElement('div')
    el.className = 'tree-item' + (item.dir ? ' dir' : '')
    el.style.paddingLeft = `${8 + depth * 14}px`
    el.dataset.rel = relPath
    if (item.dir) {
      const collapsed = treeCollapsed.has(relPath)
      el.innerHTML = `<span class="tw" style="display:inline-block;width:14px;cursor:pointer;text-align:center;color:var(--muted)">${collapsed ? '▸' : '▾'}</span><span style="margin-left:2px">${item.name}</span>`
      el.onclick = async () => {
        container.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
        el.classList.add('active')
        await renderWork('vault', { rel: relPath, dir: true })
      }
      // 手柄：切换折叠态——子容器存在性以 DOM 为准（el.nextElementSibling 是否 .tree-children）
      el.querySelector('.tw').onclick = async (e) => {
        e.stopPropagation()
        const existing = el.nextElementSibling
        if (existing && existing.classList.contains('tree-children')) {
          // 收起：删容器+记折叠
          treeCollapsed.add(relPath)
          existing.remove()
          el.querySelector('.tw').textContent = '▸'
        } else {
          // 展开：建容器+清折叠+递归渲染
          treeCollapsed.delete(relPath)
          const box = document.createElement('div')
          box.className = 'tree-children'
          el.after(box)
          el.querySelector('.tw').textContent = '▾'
          await renderTree(box, relPath, depth + 1)
        }
      }
      container.appendChild(el)
      // 默认展开一层（.moonlybox 跳过；用户已折叠的尊重折叠态）
      if (depth < 1 && item.name !== '.moonlybox' && !collapsed) {
        const box = document.createElement('div')
        box.className = 'tree-children'
        el.after(box)
        await renderTree(box, relPath, depth + 1)
      }
    } else {
      el.textContent = `📄 ${item.name}`
      el.onclick = async () => {
        container.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
        el.classList.add('active')
        await renderWork('vault', { rel: relPath, dir: false })
      }
      container.appendChild(el)
    }
  }
}

// ---------- 第三列渲染 ----------
async function renderWork(nav, arg, label2) {
  const w = $('work')
  if (nav === 'vault' && arg && !arg.dir) {
    // 文件工作台：编辑/预览分栏
    const r = await window.moonlybox.fsRead(arg.rel)
    w.innerHTML = `
      <div class="row" style="padding:10px 16px;border-bottom:1px solid var(--border)">
        <strong style="font-size:13px">${arg.rel}</strong>
        <span class="muted" style="font-size:11px;margin-left:auto" id="wf-state"></span>
      </div>
      <div style="flex:1;display:flex;min-height:0">
        <textarea id="wf-edit" spellcheck="false" style="flex:1;border:0;border-right:1px solid var(--border);padding:14px;font:12.5px/1.7 ui-monospace,monospace;resize:none;background:transparent;color:inherit;outline:none"></textarea>
        <div id="wf-view" style="flex:1;overflow:auto;padding:16px" class="mono"></div>
      </div>`
    if (!r.ok) { $('wf-state').textContent = r.message; return }
    $('wf-edit').value = r.content
    $('wf-view').textContent = '（预览：markdown 渲染接 v0.6）\n\n' + r.content.slice(0, 2000)
    $('wf-state').textContent = `${r.content.length} 字符 · 编辑后点保存`
    const save = document.createElement('button')
    save.className = 'btn'
    save.textContent = '保存'
    save.style.marginLeft = '8px'
    save.onclick = async () => {
      const wr = await window.moonlybox.fsWrite(arg.rel, $('wf-edit').value)
      $('wf-state').textContent = wr.ok ? '✓ 已保存（sync 后上云/对账）' : '保存失败：' + wr.message
    }
    $('wf-state').after(save)
    return
  }
  if (nav === 'vault' && arg?.dir) {
    w.innerHTML = `<div style="padding:20px" class="muted">📁 ${arg.rel}<br/><br/>目录操作（新建/移动）接 v0.6</div>`
    return
  }
  if (nav === 'cloud' && arg && typeof arg === 'object') {
    // #254：云端功能页=WebView 承载 web SPA（布局/交互/多视图=web 端现成；升级零客户端发版）
    w.innerHTML = `<webview id="cloud-wv" style="flex:1;width:100%;height:100%" src="about:blank"></webview>`
    const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
    if (r.event !== 'done' || r.code !== 0) { w.innerHTML = `<div style="padding:16px" class="muted">加载失败：${r.text ?? ''}</div>`; return }
    const parsed = JSON.parse(r.text)
    const webBase = parsed.data?.webBase ?? parsed.webBase ?? 'https://moonlybox.cn'  // webBase 在 data 里（daemon nav: {ok,data,token}），兜底官方域
    const token = parsed.token
    const wv = $('cloud-wv')
    const stateBar = document.createElement('div')
    stateBar.style.cssText = 'padding:4px 12px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)'
    stateBar.textContent = '云端加载中…'
    wv.before(stateBar)
    let injected = false
    wv.addEventListener('dom-ready', async () => {
      // 只处理目标域的首次 ready（about:blank 阶段不注入）
      if (injected) return
      const cur = wv.getURL() || ''
      if (!cur.startsWith(webBase)) return
      injected = true
      try {
        if (token) {
          await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`)
          // 回读验证（注入不可见失败太坑——253.33 用户实测营销页=注入没生效）
          const back = await wv.executeJavaScript(`localStorage.getItem('mf_token')?.slice(0,10) ?? 'NULL'`)
          stateBar.textContent = `登录态注入：${back === 'NULL' ? '失败' : 'ok（' + back + '…）'}`
        } else {
          stateBar.textContent = '无 token（未登录）——返回壳重新登录'
        }
      } catch (e) {
        await new Promise((r2) => setTimeout(r2, 600))
        try {
          if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`)
          stateBar.textContent = '登录态注入：ok（重试）'
        } catch (e2) {
          stateBar.textContent = '登录态注入失败：' + String(e2?.message ?? e2).slice(0, 80)
        }
      }
      // 路由跳转：优先 SPA 内 hash 跳（与应用内点击等价，same-document）；loadURL 对 hash-only
      // 差异可能被 Chromium 当 same-document 忽略导致停在落地页（#253.34 用户实测营销页）
      try {
        await wv.executeJavaScript(`location.hash = ${JSON.stringify(arg.url.startsWith('/#') ? arg.url.slice(1) : arg.url)}; location.hash`)
        stateBar.textContent = '路由跳转：' + (wv.getURL() || '')
      } catch {
        await wv.loadURL(webBase + arg.url)
        stateBar.textContent = '路由跳转（loadURL）：' + (wv.getURL() || '')
      }
    })
    wv.src = webBase + '/#/login' // 先加载域（localStorage 注入需同源），dom-ready 后跳目标路由
    return
  }
  if (nav === 'diagram') {
    // 图示工作台（沿用 #252 三区）
    w.innerHTML = `
      <div class="row" style="padding:10px 16px;border-bottom:1px solid var(--border)">
        <input id="dg-title" placeholder="图示标题" style="width:180px" />
        <button class="btn" id="dg-save" style="font-size:12px;padding:5px 10px">保存草稿</button>
        <button class="btn" id="dg-activate" style="background:var(--ok);font-size:12px;padding:5px 10px">存进书房</button>
        <button class="btn" id="dg-ai" style="background:#7c3aed;font-size:12px;padding:5px 10px">✨ AI 生成</button>
        <span id="dg-state" class="muted" style="font-size:11px;margin-left:auto"></span>
      </div>
      <div style="flex:1;display:flex;min-height:0">
        <textarea id="dg-code" spellcheck="false" style="flex:1;border:0;border-right:1px solid var(--border);padding:14px;font:12px/1.6 ui-monospace,monospace;resize:none;background:transparent;color:inherit;outline:none" placeholder="mermaid 代码（例：graph TD; A[开始] --> B[结束]）"></textarea>
        <div id="dg-preview" style="flex:1;overflow:auto;padding:16px"></div>
      </div>
      <div id="dg-err" style="display:none;padding:8px 16px;font-size:12px;color:var(--err);border-top:1px solid var(--border)"></div>`
    bindDiagramWorkbench(arg)
    return
  }
  if (nav === 'xiaoyue') {
    w.innerHTML = `
      <div id="log" class="mono" style="flex:1;overflow-y:auto;padding:16px;white-space:pre-wrap;user-select:text"></div>
      <div class="row" style="padding:12px 16px;border-top:1px solid var(--border)">
        <input id="q" placeholder="问小月（本地检索+直连回答）…" style="flex:1" />
        <button class="btn" id="btn-ask">发送</button>
      </div>`
    bindChat()
    return
  }
  if (nav === 'help' && arg === 'kernel') {
    const r = await window.moonlybox.rpc('ping', {}, 10_000)
    w.innerHTML = `<div style="padding:20px" class="mono">内核：${r.event === 'done' ? '✓ 已连接（daemon pong）' : '✗ ' + (r.message ?? '未连接')}<br/>vault：${await window.moonlybox.vaultGet() ?? '未选择'}</div>`
    return
  }
  if (nav === 'help' && arg === 'about') {
    const v = await window.moonlybox.versions()
    w.innerHTML = `<div style="padding:20px" class="mono">壳 v${v.shell} · 内核 v${v.kernel}<br/><br/><button class="btn ghost" id="btn-check2">检查更新</button></div>`
    $('btn-check2').onclick = () => window.moonlybox.updateCheck()
    return
  }
  w.innerHTML = `<div style="padding:20px" class="muted">选择左侧项目开始</div>`
}

// ---------- 图示工作台绑定（从旧 renderer 迁移，#252 逻辑保留） ----------
let dgCurrentId = null
let dgRenderTimer = null
let dgLastError = null

function bindDiagramWorkbench(existing) {
  dgCurrentId = existing?.id ?? null
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
  $('dg-code').value = existing?.content ?? ''
  $('dg-title').value = existing?.title ?? ''
  $('dg-state').textContent = existing?.state === 'draft' ? '📝 云端草稿' : existing?.state ? '📚 已存书房' : '新草稿'

  const render = async () => {
    const err = $('dg-err')
    const box = $('dg-preview')
    const src = $('dg-code').value
    const m = src.match(/```mermaid\n([\s\S]*?)```/)
    const code = (m ? m[1] : src).trim()
    if (!code) { box.innerHTML = '<span class="muted" style="font-size:12px">左侧输入 mermaid 即时预览</span>'; return }
    try {
      const { svg } = await mermaid.render('dg-' + Date.now(), code)
      box.innerHTML = svg
      err.style.display = 'none'
      dgLastError = null
    } catch (e) {
      dgLastError = String(e?.message ?? e)
      err.textContent = '⚠ ' + dgLastError.slice(0, 300)
      err.style.display = 'block'
    }
  }
  $('dg-code').addEventListener('input', () => { clearTimeout(dgRenderTimer); dgRenderTimer = setTimeout(render, 400) })
  render()

  $('dg-save').onclick = async () => {
    const title = $('dg-title').value.trim() || '未命名图示'
    const r = await window.moonlybox.rpc('diagram', { op: 'save', id: dgCurrentId, title, content: $('dg-code').value }, 60_000)
    if (r.event === 'done' && r.code === 0) {
      const d = JSON.parse(r.text).data
      dgCurrentId = d.id
      $('dg-state').textContent = `✓ 已保存草稿 v${d.version}`
    } else $('dg-state').textContent = '保存失败：' + (r.text || r.message)
  }
  $('dg-activate').onclick = async () => {
    if (!dgCurrentId) { $('dg-state').textContent = '先保存草稿'; return }
    const r = await window.moonlybox.rpc('diagram', { op: 'activate', id: dgCurrentId }, 60_000)
    if (r.event === 'done' && r.code === 0) $('dg-state').textContent = '📚 已存进书房'
    else $('dg-state').textContent = '准入失败：' + (r.text || r.message)
  }
  $('dg-ai').onclick = async () => {
    const prompt = window.prompt('描述你要画的图')
    if (!prompt?.trim()) return
    $('dg-ai').disabled = true
    $('dg-state').textContent = '✨ AI 生成中…'
    const r = await window.moonlybox.rpc('diagram', { op: 'ai', prompt }, 150_000)
    $('dg-ai').disabled = false
    if (r.event === 'done' && r.code === 0) {
      $('dg-code').value = JSON.parse(r.text).source
      dgCurrentId = null
      $('dg-state').textContent = '✓ AI 已生成'
      render()
    } else $('dg-state').textContent = 'AI 生成失败：' + (r.text || r.message)
  }
}

// ---------- 小月对话绑定（从旧 renderer 迁移） ----------
function bindChat() {
  const log = (t) => { $('log').textContent += t + '\n'; $('log').scrollTop = $('log').scrollHeight }
  window.moonlybox.subscribe()
  window.moonlybox.onKernelEvent((msg) => {
    if (msg.event === 'log') log(msg.payload)
    else if (msg.event === 'stderr') log('[stderr] ' + msg.payload)
    else if (msg.event === 'confirm_request') renderConfirmBar(msg.id, msg.payload)
  })
  async function ask() {
    const q = $('q').value.trim()
    if (!q) return
    $('q').value = ''
    $('btn-ask').disabled = true
    log(`\n你> ${q}`)
    const tools = $('set-tools')?.checked ?? true
    const r = await window.moonlybox.rpc('xiaoyue', tools ? { q, tools: true } : { q }, 300_000)
    $('btn-ask').disabled = false
    log(r.event === 'done' && r.code === 0 ? `小月> ${r.text}` : `⚠ ${r.message ?? r.text}`)
  }
  $('btn-ask').onclick = ask
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask() })
}

function renderConfirmBar(rpcId, payload) {
  const log = $('log')
  if (!log) return
  const bar = document.createElement('div')
  bar.style.cssText = 'background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.55);border-radius:8px;padding:8px;margin:6px 0'
  bar.textContent = `⚙ ${payload.tool} ${payload.argsJson}（写操作，确认执行？）`
  const yes = document.createElement('button')
  yes.className = 'btn'; yes.textContent = '确认'; yes.style.marginRight = '6px'
  const no = document.createElement('button')
  no.className = 'btn ghost'; no.textContent = '取消'
  yes.onclick = async () => { await window.moonlybox.confirmResponse(rpcId, true); bar.remove() }
  no.onclick = async () => { await window.moonlybox.confirmResponse(rpcId, false); bar.remove() }
  bar.append(yes, no)
  log.appendChild(bar)
}

// ---------- 设置弹窗（需求 5：集中设置） ----------
$('btn-avatar').onclick = async () => {
  const r = await window.moonlybox.rpc('auth', { op: 'whoami' }, 15_000)
  let d = null
  try { d = JSON.parse(r.text) } catch {}
  if (d?.loggedIn) {
    // 已登录：账号面板（个人信息+功能菜单；profile 拉全量资料，失败降级 whoami 字段）
    let p = null
    try { p = JSON.parse((await window.moonlybox.rpc('auth', { op: 'profile' }, 25_000)).text) } catch {}
    const nickname = p?.nickname || d.email || '用户'
    const signature = p?.signature || ''
    const avatarUrl = p?.avatar || ''
    const extSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.55"><path d="M7 17L17 7M9 7h8v8"/></svg>`
    const dlg = document.createElement('dialog')
    dlg.innerHTML = `
      <div class="dlg-body">
      <div style="display:flex;align-items:center;gap:14px">
        ${avatarUrl
          ? `<img src="${avatarUrl}" style="width:52px;height:52px;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer"/>`
          : `<div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px">${(nickname[0] ?? '?').toUpperCase()}</div>`}
        <div style="min-width:0">
          <div style="font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${nickname}</div>
          <div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${signature || (d.email ?? '')}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin:14px 0 6px"></div>
      <div id="ac-feedback" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px">问题反馈 ${extSvg}</div>
      <div id="ac-settings" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px">个人设置 ${extSvg}</div>
      <div id="ac-logout" style="display:flex;align-items:center;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px;color:#f87171">退出登录</div>
      </div>`
    document.body.appendChild(dlg)
    dlg.showModal()
    const rows = dlg.querySelectorAll('#ac-feedback,#ac-settings,#ac-logout')
    rows.forEach((el) => {
      el.onmouseenter = () => { el.style.background = 'var(--hover)' }
      el.onmouseleave = () => { el.style.background = 'transparent' }
    })
    dlg.querySelector('#ac-feedback').onclick = () => { dlg.close(); window.moonlybox.openExternal('https://moonlybox.cn/feedback') }
    dlg.querySelector('#ac-settings').onclick = () => { dlg.close(); window.moonlybox.openExternal('https://moonlybox.cn/settings') }
    dlg.addEventListener('close', () => dlg.remove())
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点击 backdrop 关闭
    dlg.querySelector('#ac-logout').onclick = async () => {
      await window.moonlybox.rpc('auth', { op: 'logout' }, 15_000)
      dlg.close()
      await refreshAvatar()
    }
  } else {
    showLoginDialog()
  }
}
document.querySelectorAll('.rail-btn[data-nav="settings"]')[0].onclick = async () => {
  const v = await window.moonlybox.vaultGet()
  $('set-vault').value = v ?? ''
  $('dlg-settings').showModal()
}
$('set-watch').addEventListener('change', (e) => window.moonlybox.setClipboardWatch(e.target.checked))
$('set-close').onclick = () => $('dlg-settings').close()
$('set-vault-pick').onclick = async () => {
  const r = await window.moonlybox.vaultPick()
  if (r.ok) {
    $('set-vault').value = r.root
    // 全链生效：daemon 用新 env 需重启（exit 后下轮自动 spawn 读新 env）
    $('set-vault').after(Object.assign(document.createElement('span'), { textContent: '✓ 已保存（内核重启后生效）', className: 'muted', style: 'font-size:11px' }))
  }
}
$('set-byok').onclick = () => {
  // BYOK 三步（setup 走 CLI 交互，壳端 v0.6 做 IPC 表单；此处引导）
  window.alert('在终端运行：moonlybox xiaoyue --setup（三项：BaseUrl/Model/Key，key 只存本机钥匙串）')
}

// ---------- 升级灯（需求 4：有更新=黄点；就绪=绿点闪烁；点击确认安装） ----------
function setUpgradeState(state, version) {
  const btn = $('btn-upgrade')
  const dot = btn.querySelector('.dot')
  const text = $('upgrade-text')
  if (state === 'available') {
    dot.style.display = 'block'; btn.classList.remove('ready'); btn.classList.add('active')
    text.textContent = '更新中'
    btn.title = `新版本 v${version} 后台下载中…`
  } else if (state === 'ready') {
    dot.style.display = 'block'; btn.classList.add('ready', 'active')
    text.textContent = '重启更新'
    btn.title = `v${version} 已就绪，点击安装并重启`
  } else {
    dot.style.display = 'none'; btn.classList.remove('ready', 'active')
    text.textContent = ''
    btn.title = '检查更新'
  }
}
window.moonlybox.onUpdateReady((msg) => setUpgradeState('ready', msg.version))
// 首屏恢复状态（重启后 downloaded/available 不丢）
;(async () => {
  try {
    const st = await window.moonlybox.updateState()
    if (st?.downloaded) setUpgradeState('ready', st.version)
    else if (st?.available) setUpgradeState('available', st.version)
  } catch {}
})()
$('btn-upgrade').onclick = async () => {
  const st = await window.moonlybox.updateState()
  if (st?.downloaded) {
    if (window.confirm(`v${st.version} 已就绪，安装并重启？`)) window.moonlybox.updateInstall()
    return
  }
  setUpgradeState('available', st?.version ?? '')
  $('upgrade-text').textContent = '检查中…'
  const after = await window.moonlybox.updateCheck()
  if (after?.downloaded) setUpgradeState('ready', after.version)
  else if (after?.available) setUpgradeState('available', after.version)
  else {
    setUpgradeState('none', '')
    $('upgrade-text').textContent = '最新'
    setTimeout(() => { if (!$('btn-upgrade').classList.contains('active')) $('upgrade-text').textContent = '' }, 3000)
  }
}

// ---------- 账号（头像点击=登录/账号面板） ----------
let loginPolling = false

async function refreshAvatar() {
  const r = await window.moonlybox.rpc('auth', { op: 'whoami' }, 15_000)
  try {
    const d = JSON.parse(r.text)
    if (d.loggedIn && d.email) {
      // 登录后 rail 顶=用户头像（拉 profile 取 avatar URL；失败降级首字母）
      let avatarUrl = ''
      try {
        const pr = await window.moonlybox.rpc('auth', { op: 'profile' }, 25_000)
        avatarUrl = JSON.parse(pr.text).avatar || ''
      } catch {}
      const btn = $('btn-avatar')
      if (avatarUrl) {
        btn.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer"/>`
      } else {
        btn.textContent = (d.email[0] ?? '?').toUpperCase()
      }
      btn.title = `已登录：${d.email}`
    } else {
      $('btn-avatar').textContent = '未'
      $('btn-avatar').title = '未登录（点击登录）'
    }
  } catch {}
}

async function showLoginDialog() {
  if (loginPolling) return // start 在途/轮询中：不重复发起（防多弹窗+RPC 堆积）
  const dlg = document.createElement('dialog')
  dlg.style.cssText = 'border:1px solid var(--border);border-radius:12px;background:var(--bg2);color:var(--fg);padding:24px;min-width:460px'
  dlg.innerHTML = `
    <strong style="font-size:15px">登录魔力宝盒</strong>
    <p class="muted" style="font-size:12.5px;margin:10px 0">1. 点击下方按钮在浏览器打开授权页（手机也可以）<br/>2. 输入用户码确认 → 回到本窗口等待</p>
    <div class="mono" style="background:var(--hover);border-radius:8px;padding:10px;font-size:18px;letter-spacing:2px;text-align:center;margin:10px 0" id="lg-code">获取中…</div>
    <div class="row" style="justify-content:center;gap:8px">
      <button class="btn" id="lg-open">打开授权页</button>
      <button class="btn ghost" id="lg-cancel">取消</button>
    </div>
    <p class="muted mono" id="lg-status" style="margin-top:10px;font-size:12px">等待授权…</p>`
  document.body.appendChild(dlg)
  dlg.showModal()
  const r = await window.moonlybox.rpc('auth', { op: 'start' }, 30_000)
  if (r.event !== 'done' || r.code !== 0) {
    $('lg-status').textContent = '发起失败：' + (r.text || r.message)
    return
  }
  const d = JSON.parse(r.text)
  $('lg-code').textContent = d.userCode
  // 授权页双通道：按钮打开+链接兜底（IPC openExternal 偶发无效时可右键复制/手动打开）
  const url = d.url || `https://moonlybox.cn/oauth/device?user_code=${d.userCode}`
  $('lg-open').onclick = async () => {
    try { await window.moonlybox.openExternal(url) } catch (e) { $('lg-status').textContent = '打开失败，请手动访问：' + url }
  }
  $('lg-cancel').onclick = () => { closed = true; dlg.close(); dlg.remove() }
  dlg.addEventListener('close', () => { closed = true })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点击 backdrop 关闭
  // 手动复制兜底（IPC 打开失败/浏览器未响应时）
  const det = document.createElement('details')
  det.style.cssText = 'margin-top:6px'
  det.innerHTML = `<summary class="muted" style="font-size:11px;cursor:pointer">手动复制授权链接</summary><div class="mono" style="font-size:11px;user-select:all;word-break:break-all">${url}</div>`
  dlg.appendChild(det)
  // 轮询授权结果（5s 间隔，快调用不阻塞 daemon worker）
  loginPolling = true
  try {
  const deadline = Date.now() + (d.expiresIn ?? 900) * 1000
  while (!closed && Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 5000))
    if (closed) break
    try {
      const pr = await window.moonlybox.rpc('auth', { op: 'poll', deviceCode: d.deviceCode, clientId: d.clientId }, 30_000)
      if (pr.event !== 'done') continue
      const pd = JSON.parse(pr.text)
      if (pd.status === 'done') {
        $('lg-status').textContent = `✓ 已登录：${pd.email}`
        await refreshAvatar()
        setTimeout(() => { closed = true; dlg.close(); dlg.remove(); if (currentNav === 'cloud') renderList('cloud') }, 1200)
        return
      }
      if (pd.status === 'pending' || pd.status === 'slow_down') $('lg-status').textContent = '等待你在浏览器/手机确认…'
      if (pd.status === 'denied') { $('lg-status').textContent = '已在网页拒绝'; break }
      if (pd.status === 'expired') { $('lg-status').textContent = '用户码过期，重新点击头像'; break }
      // pending/slow_down → 继续等
    } catch {}
  }
  } finally { loginPolling = false }
}

// ---------- 版本显示 + 首屏 ----------
(async () => {
  const v = await window.moonlybox.versions()
  await refreshAvatar()
  // 首屏：未选 vault → 引导；否则进书房
  const vault = await window.moonlybox.vaultGet()
  if (!vault) {
    switchNav('settings')
    $('dlg-settings').showModal()
  } else {
    switchNav('vault')
  }
})()
