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
// 设置中心（#253.48）：设置走 3 列 UI（第二列=分类，第三列=面板），不用弹窗。
// 分类=用户定稿 11 项；v1 实现面板：通用/文档库/模型（平台API=BYOK 表单、本地模型）/外观；其余占位空态（后续迭代逐个点亮）。
const SETTINGS_CATS = [
  { id: 'general', label: '通用' },
  { id: 'appearance', label: '外观' },
  { id: 'library', label: '文档库' },
  { id: 'chat', label: '对话' },
  { id: 'model', label: '模型', subs: ['platform', 'local', 'custom'] },
  { id: 'messaging', label: '消息平台' },
  { id: 'mcp', label: 'MCP', subs: ['builtin', 'market', 'custom'] },
  { id: 'skills', label: '技能' },
  { id: 'websearch', label: '网络搜索' },
  { id: 'docproc', label: '文档处理' },
  { id: 'memory', label: '记忆' },
]
const SET_SUB_LABELS = { platform: '平台 API', local: '本地模型', custom: '自定义', builtin: '内置', market: '市场' }
let currentSetCat = 'general'
let currentSetSub = null
let toolsEnabled = true // 工具（管家模式）开关——原 set-tools checkbox 迁入通用面板
let clipboardWatch = false; // 剪贴板自动采集（启动默认关，与 T3 行为一致；面板开关即时生效）——分号必须：下行 IIFE 以 ( 开头（ASI 陷阱 #253.20）

// ---------- #256 设置中心运行态（daemon settings 通道单源；localStorage 只做快照缓存） ----------
let APP_SETTINGS = null // daemon get 的全量 settings（null=未加载）
let APP_PROVIDERS = null // 提供商清单 {platform,websearch,messaging,memory}
async function loadAppSettings() {
  if (APP_SETTINGS) return APP_SETTINGS
  try {
    const r = await window.moonlybox.rpc('settings', { op: 'get' }, 15_000)
    if (r.event === 'done' && r.code === 0) {
      const d = JSON.parse(r.text)
      APP_SETTINGS = d.settings
      APP_PROVIDERS = d.providers
    }
  } catch {}
  if (!APP_SETTINGS) APP_SETTINGS = { general: {}, appearance: {}, chat: {}, model: {}, messaging: { providers: {} }, mcp: {}, websearch: {}, urlextract: {}, docproc: {}, memory: {} }
  return APP_SETTINGS
}
async function saveAppSettings(patch) {
  const r = await window.moonlybox.rpc('settings', { op: 'save', patch }, 15_000)
  if (r.event === 'done' && r.code === 0) {
    APP_SETTINGS = JSON.parse(r.text).settings
    return { ok: true }
  }
  return { ok: false, error: r.message ?? r.text ?? '保存失败' }
}
function applyThemeSettings() {
  // #256.2 主题：dark/light 直接写 data-theme；system 移除（回退 media）；time=18:00-06:00 深色
  const ap = APP_SETTINGS?.appearance ?? {}
  const html = document.documentElement
  const mode = ap.theme ?? 'system'
  if (mode === 'dark') html.dataset.theme = 'dark'
  else if (mode === 'light') html.dataset.theme = 'light'
  else if (mode === 'time') html.dataset.theme = (new Date().getHours() >= 18 || new Date().getHours() < 6) ? 'dark' : 'light'
  else delete html.dataset.theme
  // 缩放：webFrame 不经 preload——用 body zoom（Chromium 支持 zoom CSS，全 UI 等比）
  const zoom = Math.min(200, Math.max(100, Number(ap.zoom ?? 100)))
  document.body.style.zoom = zoom / 100
}
// 跟随时间：每 10 分钟校一次主题（分号必须：下行 IIFE 以 ( 开头——ASI 陷阱 #253.20 同款）
setInterval(() => { if (APP_SETTINGS?.appearance?.theme === 'time') applyThemeSettings() }, 10 * 60 * 1000);

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
let currentCloudId = null // 云端列当前浏览项（active 高亮恢复用，#253.45）

async function renderList(nav) {
  const head = $('list-head')
  const body = $('list-body')

  // 设置中心：第二列=分类列表（#253.48）
  if (nav === 'settings') {
    head.textContent = '设置'
    body.innerHTML = ''
    for (const cat of SETTINGS_CATS) {
      const el = document.createElement('div')
      const active = cat.id === currentSetCat
      el.className = 'set-cat' + (active ? ' active' : '')
      const subText = cat.subs ? (currentSetSub ? (SET_SUB_LABELS[currentSetSub] ?? '') : '平台 API · 本地模型 · 自定义') : ''
      el.innerHTML = `<span>${cat.label}</span>${subText ? `<span class="sub">${subText}</span>` : ''}`
      el.onclick = () => {
        currentSetCat = cat.id
        currentSetSub = null
        renderList('settings')
        renderWork('settings')
      }
      body.appendChild(el)
    }
    return
  }
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
        el.className = 'tree-item' + (currentCloudId === it.id ? ' active' : '')
        el.dataset.cid = it.id
        el.innerHTML = `${cloudIconSvg(it.icon)}<span>${it.label}</span>`
        el.onclick = () => {
          body.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
          el.classList.add('active')
          currentCloudId = it.id
          renderWork('cloud', it)
        }
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
    // 文件工作台：阅读（默认，md 渲染+mermaid 出图）⇄ 编辑 双态切换（#253.49 用户：预览为默认，不固定分栏）
    const r = await window.moonlybox.fsRead(arg.rel)
    w.innerHTML = `
      <div class="row" style="padding:10px 16px;border-bottom:1px solid var(--border)">
        <strong style="font-size:13px">${arg.rel}</strong>
        <span class="muted" style="font-size:11px;margin-left:auto" id="wf-state"></span>
      </div>
      <div style="flex:1;display:flex;min-height:0">
        <textarea id="wf-edit" spellcheck="false" style="flex:1;border:0;padding:14px;font:12.5px/1.7 ui-monospace,monospace;resize:none;background:transparent;color:inherit;outline:none;display:none"></textarea>
        <div id="wf-view" style="flex:1;overflow:auto;padding:20px 28px" class="md-view"></div>
      </div>`
    if (!r.ok) { $('wf-state').textContent = r.message; return }
    const edit = $('wf-edit'), view = $('wf-view'), state = $('wf-state')
    edit.value = r.content
    // mermaid 围栏块先摘出（防 marked 当普通代码转义），渲染时按占位符回填出图
    const mermaidBlocks = []
    const mdToHtml = (src) => {
      const staged = src.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
        mermaidBlocks.push(code)
        return `\n<!--MBMERMAID${mermaidBlocks.length - 1}-->\n`
      })
      let html = window.marked ? window.marked.parse(staged, { breaks: true, gfm: true }) : '<pre>' + staged.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>'
      // 本地文档安全：去脚本/内联事件（marked 不做 sanitize）
      const tpl = document.createElement('template')
      tpl.innerHTML = html
      tpl.content.querySelectorAll('script,iframe,object,embed,link,meta').forEach((el) => el.remove())
      tpl.content.querySelectorAll('*').forEach((el) => {
        for (const attr of [...el.attributes]) {
          if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name)
        }
      })
      return tpl.innerHTML.replace(/<!--MBMERMAID(\d+)-->/g, (_m, i) => `<div class="mb-mermaid" data-mbcode="${encodeURIComponent(mermaidBlocks[Number(i)] ?? '')}"></div>`)
    }
    const renderMermaids = () => {
      view.querySelectorAll('.mb-mermaid').forEach(async (el) => {
        const code = decodeURIComponent(el.dataset.mbcode ?? '')
        if (!code || !window.mermaid) return
        try {
          const { svg } = await window.mermaid.render('wfmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), code)
          el.innerHTML = svg
        } catch (e) {
          el.innerHTML = '<pre style="color:var(--err)">⚠ mermaid 渲染失败：' + String(e?.message ?? e).slice(0, 200) + '</pre>'
        }
      })
    }
    const renderView = () => { view.innerHTML = mdToHtml(edit.value); renderMermaids() }
    let mode = 'read' // read | edit
    const mkBtn = (label, ghost) => { const b = document.createElement('button'); b.className = ghost ? 'btn ghost' : 'btn'; b.textContent = label; b.style.marginLeft = '8px'; return b }
    const btnToggle = mkBtn('编辑', true)
    const btnSave = mkBtn('保存', false)
    const applyMode = () => {
      if (mode === 'read') {
        edit.style.display = 'none'; view.style.display = ''
        renderView()
        btnToggle.textContent = '编辑'
        state.textContent = `${edit.value.length} 字符 · 阅读视图`
      } else {
        view.style.display = 'none'; edit.style.display = ''
        btnToggle.textContent = '预览'
        state.textContent = `${edit.value.length} 字符 · 编辑中（预览显示未保存内容）`
      }
    }
    btnToggle.onclick = () => { mode = mode === 'read' ? 'edit' : 'read'; applyMode() }
    btnSave.onclick = async () => {
      const wr = await window.moonlybox.fsWrite(arg.rel, edit.value)
      if (!wr.ok) { state.textContent = '保存失败：' + wr.message; return }
      state.textContent = '✓ 已保存 · 回传云端中…'
      // 保存即回传（#253.49）：镜像区文件直接走 /library/import/files 版本管道；本地文档提示走收集箱
      try {
        const rt = await window.moonlybox.rpc('syncreturn', { rel: arg.rel }, 120_000)
        state.textContent = rt.event === 'done' ? '✓ 已保存 · ' + (rt.text ?? '') : '✓ 已保存 · 回传失败：' + (rt.message ?? '未知错误')
      } catch (e) {
        state.textContent = '✓ 已保存 · 回传失败：' + String(e?.message ?? e)
      }
      if (mode === 'read') renderView()
    }
    state.after(btnToggle, btnSave)
    applyMode()
    return
  }
  if (nav === 'vault' && arg?.dir) {
    w.innerHTML = `<div style="padding:20px" class="muted">📁 ${arg.rel}</div>`
    return
  }
  // ---------- 设置中心：第三列面板（#253.48） ----------
  if (nav === 'settings') {
    const cat = SETTINGS_CATS.find((c) => c.id === currentSetCat) ?? SETTINGS_CATS[0]
    if (cat.subs && !currentSetSub) currentSetSub = cat.subs[0] // 有二级分类默认进第一个（模型→平台 API）
    const panel = (title, desc, inner) => {
      const tabs = cat.subs
        ? `<div class="set-row" style="gap:6px;margin:0 0 18px">${cat.subs.map((s) => `<button type="button" class="btn ${s === currentSetSub ? '' : 'ghost'}" data-setsub="${s}">${SET_SUB_LABELS[s] ?? s}</button>`).join('')}</div>`
        : ''
      w.innerHTML = `<div class="set-panel"><h3>${title}</h3><p class="set-desc">${desc}</p>${tabs}${inner}</div>`
      w.querySelectorAll('[data-setsub]').forEach((b) => {
        b.onclick = () => { currentSetSub = b.dataset.setsub; renderWork('settings') }
      })
    }
    if (cat.id === 'general') {
      const g = await loadAppSettings()
      const gv = g.general ?? {}
      const sw = (id, label, desc, checked) => `
        <label class="set-row" style="cursor:pointer;align-items:flex-start">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="margin-top:3px" />
          <span><div>${label}</div><div class="set-desc" style="margin:2px 0 0">${desc}</div></span>
        </label>`
      panel('通用', '基础行为设置。更改即时生效。', `
        ${sw('sp-launch', '开机启动', '登录系统后自动启动魔力宝盒（打包版生效）', !!gv.launchAtLogin)}
        ${sw('sp-min', '启动时最小化到托盘', '开机/启动后不弹主窗口，仅在托盘待命', !!gv.launchMinimized)}
        ${sw('sp-tray', '关闭时最小化到托盘', '点关闭按钮时隐藏到托盘而非退出（托盘图标可退出）', !!gv.closeToTray)}
        ${sw('sp-awake', '运行任务时保持电脑唤醒', '小月执行任务期间阻止系统休眠', !!gv.keepAwake)}
        ${sw('sp-tools', '工具（管家模式）', '小月可调用工具代你执行写操作（写操作仍需确认）', toolsEnabled)}
        ${sw('sp-watch', '剪贴板自动采集', '监听复制的文本/链接，存入收集箱', clipboardWatch)}
      `)
      const saveGeneral = async () => {
        const patch = {
          general: {
            launchAtLogin: $('sp-launch').checked,
            launchMinimized: $('sp-min').checked,
            closeToTray: $('sp-tray').checked,
            keepAwake: $('sp-awake').checked,
          },
        }
        const r = await saveAppSettings(patch)
        toolsEnabled = $('sp-tools').checked
        clipboardWatch = $('sp-watch').checked
        window.moonlybox.setClipboardWatch(clipboardWatch)
        // main 侧行为同步（托盘/唤醒/开机启动）
        try { await window.moonlybox.applyGeneral(patch.general) } catch {}
        return r
      }
      for (const id of ['sp-launch', 'sp-min', 'sp-tray', 'sp-awake']) $(id).onchange = saveGeneral
      $('sp-tools').onchange = (e) => { toolsEnabled = e.target.checked }
      $('sp-watch').onchange = (e) => { clipboardWatch = e.target.checked; window.moonlybox.setClipboardWatch(e.target.checked) }
    } else if (cat.id === 'appearance') {
      const g = await loadAppSettings()
      const av = g.appearance ?? {}
      panel('外观', '主题、语言与缩放。', `
        <div class="set-field"><label>色彩风格</label>
          <select id="sp-theme" style="width:220px">
            <option value="system" ${av.theme === 'system' || !av.theme ? 'selected' : ''}>跟随系统</option>
            <option value="light" ${av.theme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="dark" ${av.theme === 'dark' ? 'selected' : ''}>深色</option>
            <option value="time" ${av.theme === 'time' ? 'selected' : ''}>跟随时间（18:00-06:00 深色）</option>
          </select>
        </div>
        <div class="set-field"><label>语言 / Language</label>
          <select id="sp-lang" style="width:220px">
            <option value="zh-CN" ${av.lang === 'zh-CN' || !av.lang ? 'selected' : ''}>中文简体</option>
            <option value="en" ${av.lang === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>
        <div class="set-field"><label>缩放：<span id="sp-zoom-v">${av.zoom ?? 100}%</span></label>
          <input type="range" id="sp-zoom" min="100" max="200" step="10" value="${av.zoom ?? 100}" style="width:260px" />
        </div>
        <div class="set-status" id="sp-ap-status"></div>
      `)
      $('sp-theme').onchange = async (e) => {
        APP_SETTINGS.appearance = { ...(APP_SETTINGS.appearance ?? {}), theme: e.target.value }
        applyThemeSettings()
        await saveAppSettings({ appearance: { theme: e.target.value } })
      }
      $('sp-lang').onchange = async (e) => {
        APP_SETTINGS.appearance = { ...(APP_SETTINGS.appearance ?? {}), lang: e.target.value }
        await saveAppSettings({ appearance: { lang: e.target.value } })
        const st = $('sp-ap-status'); st.className = 'set-status ok'; st.textContent = '✓ 已保存（界面文案随下次刷新生效）'
      }
      $('sp-zoom').oninput = (e) => { $('sp-zoom-v').textContent = `${e.target.value}%` }
      $('sp-zoom').onchange = async (e) => {
        APP_SETTINGS.appearance = { ...(APP_SETTINGS.appearance ?? {}), zoom: Number(e.target.value) }
        applyThemeSettings()
        await saveAppSettings({ appearance: { zoom: Number(e.target.value) } })
      }
    } else if (cat.id === 'chat') {
      const g = await loadAppSettings()
      const cv = g.chat ?? {}
      panel('对话', '小月的上下文与重试行为。上下文仅存内存（本机），不落盘。', `
        <label class="set-row" style="cursor:pointer"><input type="checkbox" id="sp-ctx" ${cv.contextEnabled !== false ? 'checked' : ''} /> 启用上下文管理——小月记住本次会话中的对话</label>
        <label class="set-row" style="cursor:pointer"><input type="checkbox" id="sp-compress" ${cv.autoCompress !== false ? 'checked' : ''} ${cv.contextEnabled === false ? 'disabled' : ''} /> 上下文自动压缩——历史过长时自动摘要，节省 token</label>
        <div class="set-field"><label>压缩阈值（历史达到容量的比例时触发）：<span id="sp-ct-v">${cv.compressThreshold ?? 80}%</span></label>
          <input type="range" id="sp-ct" min="50" max="100" step="5" value="${cv.compressThreshold ?? 80}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-field"><label>压缩目标（压缩后保留的容量）：<span id="sp-cg-v">${cv.compressTarget ?? 20}%</span></label>
          <input type="range" id="sp-cg" min="10" max="30" step="5" value="${cv.compressTarget ?? 20}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-field"><label>模型重试次数（调用失败自动重试）</label>
          <input type="number" id="sp-retry" min="1" max="50" value="${cv.maxRetries ?? 10}" style="width:120px" /></div>
        <div class="set-status" id="sp-chat-status"></div>
      `)
      const syncDisabled = () => {
        const ctx = $('sp-ctx').checked, ac = $('sp-compress').checked
        $('sp-compress').disabled = !ctx
        $('sp-ct').disabled = !ctx || !ac
        $('sp-cg').disabled = !ctx || !ac
      }
      $('sp-ctx').onchange = syncDisabled
      $('sp-compress').onchange = syncDisabled
      $('sp-ct').oninput = (e) => { $('sp-ct-v').textContent = `${e.target.value}%` }
      $('sp-cg').oninput = (e) => { $('sp-cg-v').textContent = `${e.target.value}%` }
      const saveChat = async () => {
        const st = $('sp-chat-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const r = await saveAppSettings({ chat: {
          contextEnabled: $('sp-ctx').checked,
          autoCompress: $('sp-compress').checked,
          compressThreshold: Number($('sp-ct').value),
          compressTarget: Number($('sp-cg').value),
          maxRetries: Number($('sp-retry').value) || 10,
        } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存（即刻生效）' : (r.error ?? '保存失败')
      }
      for (const id of ['sp-ctx', 'sp-compress', 'sp-ct', 'sp-cg', 'sp-retry']) $(id).onchange = saveChat
    } else if (cat.id === 'library') {
      panel('文档库（书房）', '本地书房目录与同步内核。目录是同步、检索、小月的单一数据源。', `
        <div class="set-field">
          <label>书房目录（Vault）</label>
          <div class="set-row" style="margin:0"><input id="sp-vault" readonly placeholder="未选择" style="flex:1" /><button type="button" class="btn ghost" id="sp-vault-pick">选择…</button></div>
        </div>
        <div class="set-status" id="sp-vault-status"></div>
      `)
      $('sp-vault').value = (await window.moonlybox.vaultGet()) ?? ''
      $('sp-vault-pick').onclick = async () => {
        const r = await window.moonlybox.vaultPick()
        if (r.ok) {
          $('sp-vault').value = r.root
          $('sp-vault-status').className = 'set-status ok'
          $('sp-vault-status').textContent = '✓ 已保存（内核重启后生效）'
        }
      }
    } else if (cat.id === 'model' && currentSetSub === 'platform') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.platform ?? []
      const mp = g.model ?? {}
      const curUrl = mp.baseUrl ?? ''
      panel('模型 · 平台 API（BYOK）', '按平台提供商列出——选商、填 Key 即成。Key 只存本机钥匙串，永不上传、不落明文文件。', `
        <div class="set-field"><label>平台提供商</label>
          <select id="sp-prov" style="width:280px">
            <option value="">— 选择提供商 —</option>
            ${provs.map((p) => `<option value="${p.id}" ${mp.provider === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
          <div class="set-desc" style="margin-top:4px" id="sp-prov-docs"></div>
        </div>
        <div class="set-field"><label>模型名（选商后可从推荐列表选或手填）</label>
          <div class="set-row" style="margin:0 0 6px"><input id="sp-byok-model" placeholder="glm-4.5" style="flex:1" />
            <select id="sp-prov-models" style="width:220px"><option value="">— 推荐模型 —</option></select></div>
        </div>
        <div class="set-field"><label>API 地址（选商自动填）</label><input id="sp-byok-url" placeholder="https://api.bigmodel.cn/api/paas/v4" /></div>
        <div class="set-field"><label>模型名</label><input id="sp-byok-model" placeholder="glm-4.7-flash" /></div>
        <div class="set-field"><label>API Key（本地端点可留空；已配置时不回显）</label><input id="sp-byok-key" type="password" placeholder="sk-…" /></div>
        <div class="set-row">
          <button type="button" class="btn" id="sp-byok-save">保存</button>
          <button type="button" class="btn ghost" id="sp-byok-test">测试连接</button>
          <button type="button" class="btn ghost" id="sp-byok-clear">清除</button>
          <span class="set-status" id="sp-byok-status"></span>
        </div>
      `)
      try {
        const g = JSON.parse((await window.moonlybox.rpc('auth', { op: 'byok', sub: 'get' }, 10_000)).text)
        $('sp-byok-url').value = g.baseUrl || curUrl || ''
        $('sp-byok-model').value = g.model ?? ''
        $('sp-byok-status').textContent = g.hasKey ? 'Key 已入钥匙串' : ''
      } catch {}
      const provSync = () => {
        const pv = provs.find((x) => x.id === $('sp-prov').value)
        $('sp-prov-docs').innerHTML = pv ? `API Key 获取：<a href="#" data-ext="${pv.docs}">${pv.docs}</a>` : ''
        $('sp-prov-docs').querySelectorAll('[data-ext]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); window.moonlybox.openExternal(a.dataset.ext) } })
        const sel = $('sp-prov-models')
        sel.innerHTML = '<option value="">— 推荐模型 —</option>' + (pv ? pv.models.map((m) => `<option value="${m}">${m}</option>`).join('') : '')
        if (pv) $('sp-byok-url').value = pv.baseUrl
      }
      $('sp-prov').onchange = provSync
      $('sp-prov-models').onchange = () => { if ($('sp-prov-models').value) $('sp-byok-model').value = $('sp-prov-models').value }
      if (mp.provider) provSync()
      $('sp-byok-save').onclick = async () => {
        const st = $('sp-byok-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const apiKey = $('sp-byok-key').value
        // 双通道：settings save（provider 状态）+ 平台API 字段齐时由 daemon 同步 BYOK（meta+钥匙串）
        const r = await saveAppSettings({ model: {
          provider: $('sp-prov').value,
          baseUrl: $('sp-byok-url').value,
          model: $('sp-byok-model').value,
          ...(apiKey ? { apiKey } : {}),
        } })
        const byok = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'save', baseUrl: $('sp-byok-url').value, model: $('sp-byok-model').value, ...(apiKey ? { apiKey } : {}) }, 15_000)
        if (r.ok && byok.event === 'done' && byok.code === 0) {
          st.className = 'set-status ok'; st.textContent = '✓ 已保存'
          $('sp-byok-key').value = ''
        } else { st.className = 'set-status err'; st.textContent = byok.message ?? byok.text ?? r.error ?? '保存失败' }
      }
      $('sp-byok-test').onclick = async () => {
        const st = $('sp-byok-status')
        st.className = 'set-status'; st.textContent = '测试中…'
        const r = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'test' }, 30_000)
        if (r.event === 'done' && r.code === 0) { st.className = 'set-status ok'; st.textContent = '✓ 连接成功' }
        else { st.className = 'set-status err'; st.textContent = r.message ?? r.text ?? '连接失败' }
      }
      $('sp-byok-clear').onclick = async () => {
        await window.moonlybox.rpc('auth', { op: 'byok', sub: 'clear' }, 10_000)
        $('sp-byok-url').value = ''; $('sp-byok-model').value = ''; $('sp-byok-key').value = ''
        const st = $('sp-byok-status'); st.className = 'set-status ok'; st.textContent = '已清除'
      }
    } else if (cat.id === 'model' && currentSetSub === 'local') {
      panel('模型 · 本地模型', '本地推理端点（Ollama / LM Studio 等）。无需 API Key，只需端点地址与模型名。', `
        <div class="set-field"><label>端点地址</label><input id="sp-local-url" placeholder="http://127.0.0.1:11434/v1" /></div>
        <div class="set-field"><label>模型名</label><input id="sp-local-model" placeholder="qwen2.5:7b" /></div>
        <div class="set-row">
          <button type="button" class="btn" id="sp-local-save">保存</button>
          <button type="button" class="btn ghost" id="sp-local-test">测试连接</button>
          <span class="set-status" id="sp-local-status"></span>
        </div>
      `)
      try {
        const g = JSON.parse((await window.moonlybox.rpc('auth', { op: 'byok', sub: 'get' }, 10_000)).text)
        $('sp-local-url').value = g.baseUrl ?? ''
        $('sp-local-model').value = g.model ?? ''
        $('sp-local-status').textContent = g.hasKey ? '已配置（含 Key）' : '已配置（无 Key，本地端点模式）'
      } catch {}
      $('sp-local-save').onclick = async () => {
        const st = $('sp-local-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const r = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'save', baseUrl: $('sp-local-url').value, model: $('sp-local-model').value }, 15_000)
        if (r.event === 'done' && r.code === 0) { st.className = 'set-status ok'; st.textContent = '✓ 已保存' }
        else { st.className = 'set-status err'; st.textContent = r.message ?? r.text ?? '保存失败' }
      }
      $('sp-local-test').onclick = async () => {
        const st = $('sp-local-status')
        st.className = 'set-status'; st.textContent = '测试中…'
        const r = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'test' }, 30_000)
        if (r.event === 'done' && r.code === 0) { st.className = 'set-status ok'; st.textContent = '✓ 连接成功' }
        else { st.className = 'set-status err'; st.textContent = r.message ?? r.text ?? '连接失败' }
      }
    } else if (cat.id === 'model' && currentSetSub === 'custom') {
      const g = await loadAppSettings()
      const cu = g.model?.custom
      panel('模型 · 自定义', '自填 OpenAI 兼容 API 地址（vLLM / 中转站 / 私有部署等）。Key 只存本机钥匙串。', `
        <div class="set-field"><label>API 地址</label><input id="sp-cu-url" placeholder="https://your-endpoint.example.com/v1" value="${cu?.baseUrl ?? ''}" /></div>
        <div class="set-field"><label>模型名</label><input id="sp-cu-model" placeholder="your-model" value="${cu?.model ?? ''}" /></div>
        <div class="set-field"><label>API Key（本地端点可留空；已配置时不回显）</label><input id="sp-cu-key" type="password" placeholder="sk-…" /></div>
        <div class="set-row">
          <button type="button" class="btn" id="sp-cu-save">保存</button>
          <button type="button" class="btn ghost" id="sp-cu-test">测试连接</button>
          <span class="set-status" id="sp-cu-status"></span>
        </div>
      `)
      $('sp-cu-save').onclick = async () => {
        const st = $('sp-cu-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const apiKey = $('sp-cu-key').value
        const r = await saveAppSettings({ model: { custom: { baseUrl: $('sp-cu-url').value, model: $('sp-cu-model').value } } })
        const byok = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'save', baseUrl: $('sp-cu-url').value, model: $('sp-cu-model').value, ...(apiKey ? { apiKey } : {}) }, 15_000)
        st.className = r.ok && byok.code === 0 ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok && byok.code === 0 ? '✓ 已保存（自定义端点即当前对话模型）' : (byok.message ?? byok.text ?? r.error ?? '保存失败')
        if (r.ok && byok.code === 0) $('sp-cu-key').value = ''
      }
      $('sp-cu-test').onclick = async () => {
        const st = $('sp-cu-status'); st.className = 'set-status'; st.textContent = '测试中…'
        const r = await window.moonlybox.rpc('auth', { op: 'byok', sub: 'test' }, 30_000)
        st.className = r.code === 0 ? 'set-status ok' : 'set-status err'
        st.textContent = r.code === 0 ? '✓ 连接成功' : (r.message ?? r.text ?? '连接失败')
      }
    } else if (cat.id === 'messaging') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.messaging ?? []
      const enabled = g.messaging?.providers ?? {}
      panel('消息平台', '对接 IM 平台收发消息（参考 Hermes 多平台架构）。Secret/Token 只存本机钥匙串。', `
        ${provs.map((p) => {
          const cur = enabled[p.id] ?? { enabled: false }
          return `<div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:12px">
            <label class="set-row" style="cursor:pointer;margin:0 0 8px"><input type="checkbox" data-msg="${p.id}" ${cur.enabled ? 'checked' : ''} />
              <b>${p.label}</b><span class="set-desc" style="margin:0">${p.enabled ? '已连接' : ''}</span></label>
            <div data-msgcfg="${p.id}" style="display:${cur.enabled ? 'block' : 'none'}">
              ${p.needs.map((n) => `<div class="set-field"><label>${n.label}${n.secret ? '（只存钥匙串）' : ''}</label><input type="${n.secret ? 'password' : 'text'}" data-msgkey="${p.id}.${n.key}" value="${(cur.config ?? {})[n.key] && !n.secret ? (cur.config ?? {})[n.key] : ''}" placeholder="${n.secret ? '已配置时不回显' : ''}" /></div>`).join('')}
            </div>
          </div>`
        }).join('')}
        <div class="set-status" id="sp-msg-status"></div>
      `)
      w.querySelectorAll('[data-msg]').forEach((cb) => {
        cb.onchange = () => { const box = w.querySelector(`[data-msgcfg="${cb.dataset.msg}"]`); if (box) box.style.display = cb.checked ? 'block' : 'none' }
      })
      w.querySelectorAll('[data-msgkey]').forEach((inp) => { inp.onchange = saveMessaging })
      w.querySelectorAll('[data-msg]').forEach((cb) => { const old = cb.onchange; cb.onchange = async (e) => { old(e); await saveMessaging() } })
      async function saveMessaging() {
        const st = $('sp-msg-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const providers = {}
        for (const p of provs) {
          const cb = w.querySelector(`[data-msg="${p.id}"]`)
          const cfg = {}
          for (const n of p.needs) {
            const inp = w.querySelector(`[data-msgkey="${p.id}.${n.key}"]`)
            if (inp && inp.value) cfg[n.key] = n.secret ? `keychain:${p.id}.${n.key}` : inp.value // secret 占位标记（实际入钥匙串待接线）
            else if (!n.secret && (enabled[p.id]?.config ?? {})[n.key]) cfg[n.key] = (enabled[p.id]?.config ?? {})[n.key]
          }
          providers[p.id] = { enabled: cb?.checked ?? false, config: cfg }
        }
        const r = await saveAppSettings({ messaging: { providers } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存（通道连接在后续迭代点亮）' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'builtin') {
      const g = await loadAppSettings()
      panel('MCP · 内置', '内置 MoonLink MCP（即「工具/管家模式」）——小月工具调用的单一来源。', `
        <label class="set-row" style="cursor:pointer"><input type="checkbox" id="sp-mcp-builtin" ${g.mcp?.builtinEnabled !== false ? 'checked' : ''} /> 启用内置 MoonLink MCP（29 工具：收藏/便签/待办/书房检索/记忆）</label>
        <div class="set-status" id="sp-mcp-status"></div>
      `)
      $('sp-mcp-builtin').onchange = async (e) => {
        const r = await saveAppSettings({ mcp: { builtinEnabled: e.target.checked } })
        const st = $('sp-mcp-status'); st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'market') {
      panel('MCP · 市场', 'MCP 服务器市场暂未开放，敬请期待。', '<div class="set-status">市场接入后可一键安装社区 MCP 服务器。</div>')
    } else if (cat.id === 'mcp' && currentSetSub === 'custom') {
      const g = await loadAppSettings()
      const list = g.mcp?.custom ?? []
      panel('MCP · 自定义', '添加自己的 MCP 服务器（URL 流）。', `
        <div id="sp-mcp-list">${list.map((m, i) => `<div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-row" style="margin:0 0 6px"><b>${m.name || '未命名'}</b><span class="set-desc" style="margin:0">${m.enabled ? '已启用' : '已停用'}</span>
            <button type="button" class="btn ghost" data-mcpdel="${i}" style="margin-left:auto">删除</button></div>
          <div class="set-desc" style="margin:0">${m.url}</div></div>`).join('') || '<div class="set-status">暂无自定义 MCP 服务器。</div>'}</div>
        <div class="set-field" style="margin-top:14px"><label>名称</label><input id="sp-mcp-name" placeholder="my-mcp" /></div>
        <div class="set-field"><label>URL</label><input id="sp-mcp-url" placeholder="https://…/mcp" /></div>
        <div class="set-row"><button type="button" class="btn" id="sp-mcp-add">添加</button><span class="set-status" id="sp-mcp2-status"></span></div>
      `)
      w.querySelectorAll('[data-mcpdel]').forEach((b) => {
        b.onclick = async () => {
          const list2 = (APP_SETTINGS.mcp?.custom ?? []).filter((_, i) => i !== Number(b.dataset.mcpdel))
          await saveAppSettings({ mcp: { custom: list2 } })
          renderWork('settings')
        }
      })
      $('sp-mcp-add').onclick = async () => {
        const st = $('sp-mcp2-status')
        const name = $('sp-mcp-name').value.trim(), url = $('sp-mcp-url').value.trim()
        if (!name || !/^https?:\/\//.test(url)) { st.className = 'set-status err'; st.textContent = '名称与 http(s) URL 必填'; return }
        const list2 = [...(APP_SETTINGS.mcp?.custom ?? []), { name, url, apiKey: null, enabled: true }]
        const r = await saveAppSettings({ mcp: { custom: list2 } })
        if (r.ok) renderWork('settings')
        else { st.className = 'set-status err'; st.textContent = r.error ?? '保存失败' }
      }
    } else if (cat.id === 'skills') {
      panel('技能', '可组合的能力单元（后续逐步上架）。', `
        <div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:12px"><b>URL 提取</b><div class="set-desc" style="margin:4px 0 0">网页正文抓取→Markdown（在「网络搜索/文档处理」配套设置）</div></div>
        <div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:12px"><b>文档处理</b><div class="set-desc" style="margin:4px 0 0">PDF/Office 解析→文本（本地 OCR 或第三方，见「文档处理」）</div></div>
        <div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:12px"><b>PDF 处理</b><div class="set-desc" style="margin:4px 0 0">PDF 拆分/合并/提取（规划中）</div></div>
      `)
    } else if (cat.id === 'websearch') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.websearch ?? []
      const ws = g.websearch ?? {}
      panel('网络搜索', '给小月接上搜索能力（本质=搜索服务商暴露给 Agent 的工具）。', `
        <div class="set-field"><label>搜索服务商</label>
          <select id="sp-ws-prov" style="width:280px">
            <option value="">— 未启用 —</option>
            ${provs.map((p) => `<option value="${p.id}" ${ws.provider === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <div id="sp-ws-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ws-save">保存</button><span class="set-status" id="sp-ws-status"></span></div>
      `)
      const renderWsCfg = () => {
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const box = $('sp-ws-cfg')
        if (!pv) { box.innerHTML = ''; return }
        box.innerHTML = pv.needs.map((k) => `<div class="set-field"><label>${k === 'apiKey' ? 'API Key（只存钥匙串）' : k}</label><input type="${k === 'apiKey' ? 'password' : 'text'}" id="sp-ws-${k}" value="${k !== 'apiKey' ? (ws.config?.[k] ?? '') : ''}" placeholder="${k === 'apiKey' ? (ws.config?.[k] ? '已配置，不回显' : '') : ''}" /></div>`).join('')
      }
      $('sp-ws-prov').onchange = renderWsCfg
      renderWsCfg()
      $('sp-ws-save').onclick = async () => {
        const st = $('sp-ws-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const config = {}
        for (const k of pv?.needs ?? []) {
          const inp = $(`sp-ws-${k}`)
          if (inp && inp.value) config[k] = k === 'apiKey' ? 'keychain:websearch' : inp.value
        }
        const r = await saveAppSettings({ websearch: { provider: $('sp-ws-prov').value, config } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存（搜索工具接入 Agent 在后续迭代点亮）' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'urlextract') {
      const g = await loadAppSettings()
      const ue = g.urlextract ?? {}
      panel('URL 提取', '收藏网页时正文提取方式：本地提取（内置）或服务商 API。', `
        <div class="set-row"><label style="cursor:pointer"><input type="radio" name="sp-ue-mode" value="local" ${ue.mode !== 'provider' ? 'checked' : ''} /> 本地提取（内置 Readability，零成本）</label></div>
        <div class="set-row"><label style="cursor:pointer"><input type="radio" name="sp-ue-mode" value="provider" ${ue.mode === 'provider' ? 'checked' : ''} /> 服务商 API（质量更高，需 Key）</label></div>
        <div class="set-field"><label>服务商 API 地址</label><input id="sp-ue-url" value="${ue.config?.baseUrl ?? ''}" placeholder="https://…/extract" /></div>
        <div class="set-field"><label>API Key（只存钥匙串）</label><input id="sp-ue-key" type="password" placeholder="${ue.config?.apiKey ? '已配置，不回显' : ''}" /></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ue-save">保存</button><span class="set-status" id="sp-ue-status"></span></div>
      `)
      $('sp-ue-save').onclick = async () => {
        const st = $('sp-ue-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const mode = w.querySelector('input[name="sp-ue-mode"]:checked').value
        const config = { baseUrl: $('sp-ue-url').value }
        if ($('sp-ue-key').value) config.apiKey = 'keychain:urlextract'
        const r = await saveAppSettings({ urlextract: { mode, config } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'docproc') {
      const g = await loadAppSettings()
      const dp = g.docproc ?? {}
      panel('文档处理', 'PDF/Office 解析：本地处理（内置 OCR）或第三方服务。', `
        <div class="set-row"><label style="cursor:pointer"><input type="radio" name="sp-dp-mode" value="local" ${dp.mode !== 'provider' ? 'checked' : ''} /> 本地处理（内置解析/OCR）</label></div>
        <div class="set-row"><label style="cursor:pointer"><input type="radio" name="sp-dp-mode" value="provider" ${dp.mode === 'provider' ? 'checked' : ''} /> 第三方服务（参考 Cherry Studio：Doc2X / MinerU / Mathpix 等）</label></div>
        <div class="set-field"><label>服务商 API 地址</label><input id="sp-dp-url" value="${dp.config?.baseUrl ?? ''}" placeholder="https://…" /></div>
        <div class="set-field"><label>API Key（只存钥匙串）</label><input id="sp-dp-key" type="password" placeholder="${dp.config?.apiKey ? '已配置，不回显' : ''}" /></div>
        <div class="set-row"><button type="button" class="btn" id="sp-dp-save">保存</button><span class="set-status" id="sp-dp-status"></span></div>
      `)
      $('sp-dp-save').onclick = async () => {
        const st = $('sp-dp-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const mode = w.querySelector('input[name="sp-dp-mode"]:checked').value
        const config = { baseUrl: $('sp-dp-url').value }
        if ($('sp-dp-key').value) config.apiKey = 'keychain:docproc'
        const r = await saveAppSettings({ docproc: { mode, config } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'memory') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.memory ?? []
      const mm = g.memory ?? {}
      panel('记忆', '长期记忆：小月跨会话记住关键信息（参考 Hermes 记忆架构）。', `
        <label class="set-row" style="cursor:pointer"><input type="checkbox" id="sp-mm-on" ${mm.enabled !== false ? 'checked' : ''} /> 启用长期记忆——对话中的关键事实自动沉淀，跨会话可 recall</label>
        <div class="set-field"><label>记忆提供方</label>
          <select id="sp-mm-prov" style="width:280px">
            ${provs.map((p) => `<option value="${p.id}" ${(mm.provider ?? 'builtin') === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
          <div class="set-desc" style="margin-top:4px" id="sp-mm-note"></div>
        </div>
        <div class="set-row"><button type="button" class="btn" id="sp-mm-save">保存</button><span class="set-status" id="sp-mm-status"></span></div>
      `)
      const noteSync = () => {
        const pv = provs.find((x) => x.id === $('sp-mm-prov').value)
        $('sp-mm-note').textContent = pv?.note ?? ''
      }
      $('sp-mm-prov').onchange = noteSync
      noteSync()
      $('sp-mm-save').onclick = async () => {
        const st = $('sp-mm-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const r = await saveAppSettings({ memory: { enabled: $('sp-mm-on').checked, provider: $('sp-mm-prov').value } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else {
      const subLabel = currentSetSub ? ` · ${SET_SUB_LABELS[currentSetSub] ?? currentSetSub}` : ''
      panel(`${cat.label}${subLabel}`, '该分类的功能在后续迭代中逐步开放。', '')
    }
    return
  }
  if (nav === 'cloud' && !arg && currentCloudId) {
    // 切走再切回：恢复上次浏览的云端功能（高亮已恢复，工作台同步恢复——#253.47）
    try {
      const r0 = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
      if (r0.event === 'done' && r0.code === 0) {
        const items = (JSON.parse(r0.text).data?.nav ?? []).filter((x) => !CLOUD_HIDDEN.has(x.id))
        const it = items.find((x) => x.id === currentCloudId)
        if (it) return renderWork('cloud', it)
      }
    } catch {}
  }
  if (nav === 'cloud' && arg && typeof arg === 'object') {
    // #254：云端功能页=WebView 承载 web SPA（布局/交互/多视图=web 端现成；升级零客户端发版）
    // #253.41/#253.42：防闪烁+加载动画——webview 初始透明+spinner 覆盖层，目标页 did-finish-load 后淡入并移除 spinner（无调试文字）
    w.innerHTML = `<div style="flex:1;display:flex;position:relative;background:var(--bg)">
      <webview id="cloud-wv" style="flex:1;width:100%;height:100%;opacity:0;transition:opacity .25s" src="about:blank"></webview>
      <div id="cloud-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="width:34px;height:34px;border:3px solid color-mix(in srgb, var(--accent) 25%, transparent);border-top-color:var(--accent);border-radius:50%;animation:cloudspin .8s linear infinite"></div>
      </div>
    </div>`
    const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
    if (r.event !== 'done' || r.code !== 0) { w.innerHTML = `<div style="padding:16px" class="muted">加载失败：${r.text ?? ''}</div>`; return }
    const parsed = JSON.parse(r.text)
    const webBase = parsed.data?.webBase ?? parsed.webBase ?? 'https://moonlybox.cn'  // webBase 在 data 里（daemon nav: {ok,data,token}），兜底官方域
    const token = parsed.token
    const wv = $('cloud-wv')
    let injected = false
    wv.addEventListener('dom-ready', async () => {
      // 只处理目标域的首次 ready（about:blank 阶段不注入）
      if (injected) return
      const cur = wv.getURL() || ''
      if (!cur.startsWith(webBase)) return
      injected = true
      try {
        if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`)
      } catch {
        // 注入失败重试一次（guest 页偶发未就绪）
        await new Promise((r2) => setTimeout(r2, 600))
        try { if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`) } catch {}
      }
      // 路由跳转（#253.35）：web=BrowserRouter（path 路由）——manifest url 归一化去 '#'
      const path = arg.url.replace(/^\/#/, '/')
      // 目标页就绪后淡入（#253.41）：did-finish-load 后再延迟（用户 #253.43：SPA 内部路由
      // 跳转/首屏渲染需要一点时间——立即淡入会闪现中间页），spinner 多转一会
      const reveal = () => {
        wv.removeEventListener('did-finish-load', reveal)
        setTimeout(() => {
          wv.style.opacity = '1'
          $('cloud-loading')?.remove()
        }, 450)
      }
      wv.addEventListener('did-finish-load', reveal)
      await wv.loadURL(webBase + path)
    })
    wv.src = webBase + '/login' // 先加载域（localStorage 注入需同源），dom-ready 后跳目标路由
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
    const tools = toolsEnabled
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
// （#253.48：设置已迁 3 列 UI——rail settings 按钮走全局 switchNav 委托，旧弹窗逻辑移除）

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
  // #256：设置先行加载——主题/缩放/语言首屏生效
  await loadAppSettings()
  applyThemeSettings()
  await refreshAvatar()
  // 首屏：未选 vault → 引导；否则进书房
  const vault = await window.moonlybox.vaultGet()
  if (!vault) {
    // 未选书房：直接进设置中心（文档库面板）引导选择（#253.48：设置走 3 列 UI）
    currentSetCat = 'library'
    switchNav('settings')
  } else {
    switchNav('vault')
  }
})()
