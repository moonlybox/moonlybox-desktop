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
  btn.dataset.tip = st?.maximized ? '还原' : '最大化'
})
$('win-close').onclick = () => window.moonlybox.winClose()

// ---------- MDI 页帧（标题栏 tab ↔ 图标栏联动） ----------
// 图标单一源：path 数据（lucide 风格描边）——rail/页帧 tab/云端列共用（index.html rail 由 JS 注入，杜绝两处漂移）
const ICON_PATHS = {
  vault: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  backup: '<path d="M4 16.2A4.5 4.5 0 0 1 6.6 8a6 6 0 0 1 11.6 1.6A4 4 0 0 1 18 17.5"/><path d="M12 12v9"/><path d="m8 16 4-4 4 4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  diagram: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  xiaoyue: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
}
const navIconSvg = (nav, size = 18) => `<svg viewBox="0 0 24 24" style="width:${size}px;height:${size}px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${ICON_PATHS[nav] ?? ''}</svg>`
const NAVS = {
  vault: { label: '书房（本地）' },
  diagram: { label: '图示' },
  cloud: { label: '云端' },
  backup: { label: '备份' },
  xiaoyue: { label: '小月' },
  help: { label: '帮助' },
  settings: { label: '设置' },
};  // 对象字面量后接 IIFE 必须分号（ASI 陷阱 #253.20）
let currentNav = null
const openFrames = new Set();  // 下一 IIFE 以 ( 开头，无分号会被解析为跨行调用（ASI 陷阱 #253.20）
// 设置中心（#253.48）：设置走 3 列 UI（第二列=分类，第三列=面板），不用弹窗。
// 分类=用户定稿 11 项；v1 实现面板：通用/文档库/模型（平台API=BYOK 表单、本地模型）/外观；其余占位空态（后续迭代逐个点亮）。
// #256.1 分类图标（lucide 风格 stroke path，与 rail 同套）
const SET_ICONS = {
  general: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  appearance: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  model: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  messaging: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mcp: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  skills: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>',
  websearch: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  docproc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
  memory: '<path d="M6 21v-8"/><path d="M18 21v-8"/><path d="M6 13V8a6 6 0 0 1 12 0v5"/><path d="M3 13h18"/>',
}
const setIconSvg = (id, size = 15) => `<svg viewBox="0 0 24 24" style="width:${size}px;height:${size}px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${SET_ICONS[id] ?? SET_ICONS.general}</svg>`
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
let clipboardWatch = false; // 剪贴板自动采集（启动默认关，与 T3 行为一致；面板开关即时生效）——分号必须：下行 IIFE 以 ( 开头（ASI 陷阱 #253.20）

// ---------- #256 设置中心运行态（daemon settings 通道单源；localStorage 只做快照缓存） ----------
let APP_SETTINGS = null // daemon get 的全量 settings（null=未加载）
// #283 平台清单兜底（云端 providers 拉取失败时平台API 卡片仍可列出；与 settings.ts PLATFORM_PROVIDERS 同源同步）
const PLATFORM_PROVIDERS_FALLBACK = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], docs: 'https://platform.deepseek.com' },
  { id: 'moonshot', label: 'Moonshot AI（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'], docs: 'https://platform.moonshot.cn' },
  { id: 'zhipu', label: '智谱 AI（GLM）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'], docs: 'https://open.bigmodel.cn' },
  { id: 'dashscope', label: '阿里云百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], docs: 'https://bailian.console.aliyun.com' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], docs: 'https://platform.openai.com' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514'], docs: 'https://console.anthropic.com' },
]
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

// ---------- 自定义 tooltip（#256：data-tip 驱动单例浮层，替代原生 title 的延迟+不可控样式） ----------
(() => {
  const tip = document.getElementById('tooltip')
  let cur = null
  const show = (el) => {
    const text = el.getAttribute('data-tip')
    if (!text) return
    tip.textContent = text
    tip.classList.add('show')
    const r = el.getBoundingClientRect()
    const tw = tip.offsetWidth, th = tip.offsetHeight
    // #265：标题栏（顶部）元素 → 下方弹出水平居中；其余（rail 窄栏）右侧弹出、越界回退左侧
    if (el.closest('#titlebar')) {
      let x = r.left + r.width / 2 - tw / 2
      x = Math.max(8, Math.min(window.innerWidth - tw - 8, x))
      const y = r.bottom + 8
      tip.style.left = x + 'px'
      tip.style.top = y + 'px'
    } else {
      let x = r.right + 8, y = r.top + r.height / 2 - th / 2
      if (x + tw > window.innerWidth - 8) x = r.left - tw - 8
      y = Math.max(8, Math.min(window.innerHeight - th - 8, y))
      tip.style.left = x + 'px'
      tip.style.top = y + 'px'
    }
    cur = el
  }
  const hide = () => { tip.classList.remove('show'); cur = null }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]')
    if (el === cur) return
    if (el) show(el)
    else hide()
  })
  document.addEventListener('mousedown', hide)
  window.addEventListener('blur', hide)
})();  // 下行若接 IIFE/字面量须分号（ASI 纪律）

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
let currentBkId = null // 备份列当前选中项（#257）

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
      // #256 用户：第二列只留图标+名称，去掉右侧对齐的二级说明文字
      el.innerHTML = `${setIconSvg(cat.id)}<span>${cat.label}</span>`
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
  } else if (nav === 'backup') {
    // #257 备份：第二列=注册的备份目录列表
    head.innerHTML = `备份 <span id="bk-add" style="float:right;font-weight:400;font-size:12px;color:var(--accent);cursor:pointer">＋ 新建</span>`
    $('bk-add').onclick = () => renderWork('backup', { create: true })
    body.innerHTML = '<div class="muted" style="padding:10px">加载中…</div>'
    try {
      const r = await window.moonlybox.rpc('backup', { op: 'list' }, 10_000)
      const d = JSON.parse(r.text)
      if (!d.entries?.length) {
        body.innerHTML = '<div class="muted" style="padding:10px">还没有备份目录<br/>点右上「＋ 新建」注册一个本地目录，<br/>把它同步到云端书房的指定目录下。</div>'
        return
      }
      body.innerHTML = ''
      for (const e of d.entries) {
        const holdN = Object.values(e.files ?? {}).filter((f) => f.hold).length
        const el = document.createElement('div')
        el.className = 'tree-item' + (currentBkId === e.id ? ' active' : '')
        el.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${e.localPath.split(/[\\/]/).pop()}</span>
          <span class="muted" style="font-size:10.5px;flex:none">${e.enabled ? (holdN ? `${holdN} 项已停更` : '启用') : '停用'}</span>`
        el.onclick = () => { currentBkId = e.id; renderList('backup'); renderWork('backup', { id: e.id }) }
        body.appendChild(el)
      }
    } catch (e) {
      body.innerHTML = '<div class="muted" style="padding:10px">加载失败</div>'
    }
    return
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
    // #290：顶部「＋ 新建」→ renderWork('diagram', { __new: true }) 进空态（编辑器按钮隐藏，工作台内点「＋ 新建」走模板弹窗）
    const newBtn = document.createElement('div')
    newBtn.className = 'tree-item'
    newBtn.style.color = 'var(--accent)'
    newBtn.textContent = '＋ 新建图示'
    newBtn.onclick = () => renderWork('diagram', {})
    body.appendChild(newBtn)
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
      if (!items.length) body.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:10px">暂无图示</div>')
    } catch {
      body.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:10px">列表加载失败（登录后可用）</div>')
    }
  } else if (nav === 'xiaoyue') {
    // #282 会话列表：工作空间分组 + 对话（无工作空间）分类
    body.innerHTML = `
      <div style="padding:8px 8px 4px;display:flex;gap:6px">
        <button class="btn" id="xy-new-ws" style="flex:1;font-size:12px">＋ 工作空间</button>
        <button class="btn ghost" id="xy-new-chat" style="flex:1;font-size:12px" title="${xyActiveWorkspace ? '将在当前选中的工作空间下新建对话' : '将新建无工作空间对话（无本地文件访问）'}">＋ 对话</button>
      </div>
      <div id="xy-list" style="flex:1;overflow-y:auto;padding:4px 8px 12px"></div>`
    $('xy-new-ws').onclick = () => showWorkspaceDialog()
    $('xy-new-chat').onclick = async () => {
      const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: xyActiveWorkspace }, 15_000)
      if (r.event === 'done' && r.code === 0) {
        xyActiveChat = JSON.parse(r.text).chat.id
        xyActiveWorkspace = null // 新无工作空间对话
        await renderWork('xiaoyue')
        await renderWork('xiaoyue', { chat: xyActiveChat })
      }
    }
    await renderXiaoyueList()
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
      // #256.2：开关类=按钮开关（toggle）行卡片布局
      const card = (id, label, desc, on) => `
        <div class="set-card"><div class="sc-main"><div class="sc-title">${label}</div><div class="sc-desc">${desc}</div></div>
          <button type="button" class="toggle ${on ? 'on' : ''}" id="${id}" aria-label="${label}"></button></div>`
      panel('通用', '基础行为设置。更改即时生效。', `
        ${card('sp-launch', '开机启动', '登录系统后自动启动魔力宝盒（安装版生效）', !!gv.launchAtLogin)}
        ${card('sp-min', '启动时最小化到托盘', '开机/启动后不弹主窗口，仅在托盘待命', !!gv.launchMinimized)}
        ${card('sp-tray', '关闭时最小化到托盘', '点关闭按钮时隐藏到托盘而非退出（托盘图标可退出）', !!gv.closeToTray)}
        ${card('sp-awake', '运行任务时保持电脑唤醒', '小月执行任务期间阻止系统休眠', !!gv.keepAwake)}
        ${card('sp-watch', '剪贴板自动采集', '监听复制的文本/链接，存入收集箱；快捷键 Alt+Shift+C 可随时手动采集（不受此开关限制）', clipboardWatch)}
      `)
      const saveGeneral = async () => {
        const patch = {
          general: {
            launchAtLogin: $('sp-launch').classList.contains('on'),
            launchMinimized: $('sp-min').classList.contains('on'),
            closeToTray: $('sp-tray').classList.contains('on'),
            keepAwake: $('sp-awake').classList.contains('on'),
          },
        }
        const r = await saveAppSettings(patch)
        clipboardWatch = $('sp-watch').classList.contains('on')
        window.moonlybox.setClipboardWatch(clipboardWatch)
        // main 侧行为同步（托盘/唤醒/开机启动）
        try { await window.moonlybox.applyGeneral(patch.general) } catch {}
        return r
      }
      for (const id of ['sp-launch', 'sp-min', 'sp-tray', 'sp-awake', 'sp-watch']) {
        $(id).onclick = (e) => { e.currentTarget.classList.toggle('on'); saveGeneral() }
      }
    } else if (cat.id === 'appearance') {
      const g = await loadAppSettings()
      const av = g.appearance ?? {}
      panel('外观', '主题、语言与缩放。', `
        <div class="set-field" style="max-width:320px"><label>色彩风格</label>
          <select id="sp-theme" class="set-select">
            <option value="system" ${av.theme === 'system' || !av.theme ? 'selected' : ''}>跟随系统</option>
            <option value="light" ${av.theme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="dark" ${av.theme === 'dark' ? 'selected' : ''}>深色</option>
            <option value="time" ${av.theme === 'time' ? 'selected' : ''}>跟随时间（18:00-06:00 深色）</option>
          </select>
        </div>
        <div class="set-field" style="max-width:320px"><label>语言</label>
          <select id="sp-lang" class="set-select">
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
      // #283：默认模型下拉=平台API/自定义/本地部署（预留）所有已启用实例分组列出
      const mm = g.model ?? {}
      const modelOpts =
        `<optgroup label="平台 API">${(mm.providers ?? []).filter((x) => x.enabled).map((x) => {
          const pv = (APP_PROVIDERS?.platform ?? PLATFORM_PROVIDERS_FALLBACK).find((p) => p.id === x.providerId)
          return `<option value="platform:${x.id}" ${mm.default === `platform:${x.id}` ? 'selected' : ''}>${pv?.label ?? x.providerId} · ${x.model}</option>`
        }).join('')}</optgroup>` +
        `<optgroup label="自定义">${(mm.custom ?? []).filter((x) => x.enabled).map((x) => `<option value="custom:${x.id}" ${mm.default === `custom:${x.id}` ? 'selected' : ''}>${x.name} · ${x.model}</option>`).join('')}</optgroup>` +
        `<optgroup label="本地部署（预留）">${(mm.local ?? []).filter((x) => x.enabled).map((x) => `<option value="local:${x.id}" ${mm.default === `local:${x.id}` ? 'selected' : ''}>${x.name} · ${x.model}</option>`).join('')}</optgroup>`
      panel('对话', '小月的上下文与重试行为。上下文仅存内存（本机），不落盘。', `
        <div class="set-field" style="margin-bottom:14px"><label>默认模型（小月对话/图示 AI 使用）</label>
          <select id="sp-chat-model" class="set-select set-select-sm" style="max-width:420px">
            <option value="">— 未指定（回落已配置模型）—</option>
            ${modelOpts}
          </select>
          <div class="set-desc" style="margin-top:4px" id="sp-chat-model-hint"></div>
        </div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">启用上下文管理</div><div class="sc-desc">小月记住本次会话中的对话</div></div>
          <button type="button" class="toggle ${cv.contextEnabled !== false ? 'on' : ''}" id="sp-ctx"></button></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">上下文自动压缩</div><div class="sc-desc">历史过长时自动摘要，节省 token</div></div>
          <button type="button" class="toggle ${cv.autoCompress !== false ? 'on' : ''}" id="sp-compress" ${cv.contextEnabled === false ? 'disabled' : ''}></button></div>
        <div class="set-field"><label>压缩阈值（历史达到容量的比例时触发）：<span id="sp-ct-v">${cv.compressThreshold ?? 80}%</span></label>
          <input type="range" id="sp-ct" min="50" max="100" step="5" value="${cv.compressThreshold ?? 80}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-field"><label>压缩目标（压缩后保留的容量）：<span id="sp-cg-v">${cv.compressTarget ?? 20}%</span></label>
          <input type="range" id="sp-cg" min="10" max="30" step="5" value="${cv.compressTarget ?? 20}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-field"><label>模型重试次数（调用失败自动重试）</label>
          <input type="number" id="sp-retry" min="1" max="50" value="${cv.maxRetries ?? 10}" style="width:120px" /></div>
        <div class="set-status" id="sp-chat-status"></div>
      `)
      const syncDisabled = () => {
        const ctx = $('sp-ctx').classList.contains('on'), ac = $('sp-compress').classList.contains('on')
        $('sp-compress').disabled = !ctx
        $('sp-ct').disabled = !ctx || !ac
        $('sp-cg').disabled = !ctx || !ac
      }
      $('sp-chat-model').onchange = async (e) => {
        await saveAppSettings({ model: { default: e.target.value } })
        const hint = $('sp-chat-model-hint')
        hint.textContent = e.target.value ? '✓ 已设为默认模型' : '未指定——按已配置模型回落'
        setTimeout(() => { hint.textContent = '' }, 2500)
      }
      $('sp-ctx').onclick = (e) => { e.currentTarget.classList.toggle('on'); syncDisabled(); saveChat() }
      $('sp-compress').onclick = (e) => { e.currentTarget.classList.toggle('on'); saveChat() }
      $('sp-ct').oninput = (e) => { $('sp-ct-v').textContent = `${e.target.value}%` }
      $('sp-cg').oninput = (e) => { $('sp-cg-v').textContent = `${e.target.value}%` }
      const saveChat = async () => {
        const st = $('sp-chat-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const r = await saveAppSettings({ chat: {
          contextEnabled: $('sp-ctx').classList.contains('on'),
          autoCompress: $('sp-compress').classList.contains('on'),
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
      // #283：平台API=多服务商卡片列表——每实例单独配置 key/模型/启停，任一可设为对话默认
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.platform ?? PLATFORM_PROVIDERS_FALLBACK
      const mcfg = g.model ?? {}
      const insts = Array.isArray(mcfg.providers) ? mcfg.providers : []
      const isDefault = (id) => mcfg.default === `platform:${id}`
      const html = (defOpen) => panel('模型 · 平台 API', '每个平台可单独配置 API Key 与模型、单独启用/停用；任一实例可设为对话默认模型。Key 只存本机钥匙串，永不上传。', `
        <div id="sp-pv-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button type="button" class="btn ghost" id="sp-pv-add" style="margin-top:10px">＋ 添加平台</button>
        <div id="sp-pv-form" style="display:${defOpen ? 'block' : 'none'};margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-field"><label>平台提供商</label>
            <select id="sp-pv-prov" class="set-select set-select-sm">
              <option value="">— 选择提供商 —</option>
              ${provs.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
            </select>
            <div class="set-desc" style="margin-top:4px" id="sp-pv-docs"></div>
          </div>
          <div class="set-field"><label>模型名</label>
            <div class="set-row" style="margin:0"><input id="sp-pv-model" placeholder="glm-4.5" style="flex:1" />
              <select id="sp-pv-models" class="set-select set-select-sm"><option value="">— 推荐模型 —</option></select></div>
          </div>
          <div class="set-field"><label>API Key</label><input id="sp-pv-key" type="password" placeholder="sk-…" /></div>
          <div class="set-row">
            <button type="button" class="btn" id="sp-pv-save">保存</button>
            <button type="button" class="btn ghost" id="sp-pv-cancel">取消</button>
            <span class="set-status" id="sp-pv-status"></span>
          </div>
        </div>`)
      html(insts.length === 0)
      const renderList = () => {
        const box = $('sp-pv-list')
        box.innerHTML = ''
        if (!insts.length) { box.innerHTML = '<div class="set-desc">尚未添加平台——点「＋ 添加平台」接入第一个模型服务</div>'; return }
        for (const inst of insts) {
          const pv = provs.find((x) => x.id === inst.providerId)
          const card = document.createElement('div')
          card.className = 'set-card'
          card.innerHTML = `<div class="sc-main"><div class="sc-title">${pv?.label ?? inst.providerId}${isDefault(inst.id) ? ' <span style="color:var(--accent);font-size:11px">默认</span>' : ''}</div>
            <div class="sc-desc">${inst.model || '未设模型'}${inst.hasKey || inst.enabled ? '' : ' · 未配置 Key'}</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              ${isDefault(inst.id) ? '' : `<button type="button" class="btn ghost" data-act="default" style="padding:2px 8px;font-size:11px">设为默认</button>`}
              <button type="button" class="btn ghost" data-act="del" style="padding:2px 8px;font-size:11px">删除</button>
              <button type="button" class="toggle ${inst.enabled ? 'on' : ''}" data-act="toggle"></button>
            </div>`
          const defBtnP = card.querySelector('[data-act=default]')
          if (defBtnP) defBtnP.onclick = async () => {
            await saveAppSettings({ model: { default: `platform:${inst.id}` } })
            renderWork('settings')
          }
          card.querySelector('[data-act=toggle]').onclick = async (e) => {
            const next = !e.currentTarget.classList.contains('on')
            e.currentTarget.classList.toggle('on', next)
            const arr = insts.map((x) => (x.id === inst.id ? { ...x, enabled: next } : x))
            await saveAppSettings({ model: { providers: arr } })
          }
          card.querySelector('[data-act=del]').onclick = async () => {
            await window.moonlybox.rpc('settings', { op: 'deleteModelInst', kind: 'platform', id: inst.id }, 10_000)
            await saveAppSettings({ model: { providers: insts.filter((x) => x.id !== inst.id), ...(isDefault(inst.id) ? { default: '' } : {}) } })
            renderWork('settings')
          }
          box.appendChild(card)
        }
      }
      renderList()
      let provSync = () => {}
      $('sp-pv-add').onclick = () => { $('sp-pv-form').style.display = 'block' }
      $('sp-pv-cancel').onclick = () => { $('sp-pv-form').style.display = 'none' }
      $('sp-pv-prov').onchange = () => {
        const pv = provs.find((x) => x.id === $('sp-pv-prov').value)
        $('sp-pv-docs').innerHTML = pv ? `API Key 获取：<a href="#" data-ext="${pv.docs}">${pv.docs}</a>` : ''
        $('sp-pv-docs').querySelectorAll('[data-ext]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); window.moonlybox.openExternal(a.dataset.ext) } })
        $('sp-pv-models').innerHTML = '<option value="">— 推荐模型 —</option>' + (pv ? pv.models.map((m) => `<option value="${m}">${m}</option>`).join('') : '')
      }
      $('sp-pv-models').onchange = () => { if ($('sp-pv-models').value) $('sp-pv-model').value = $('sp-pv-models').value }
      $('sp-pv-save').onclick = async () => {
        const st = $('sp-pv-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const providerId = $('sp-pv-prov').value
        const model = $('sp-pv-model').value.trim()
        const apiKey = $('sp-pv-key').value.trim()
        if (!providerId || !model) { st.className = 'set-status err'; st.textContent = '提供商与模型名必填'; return }
        const inst = { id: `platform_${providerId}_${Date.now().toString(36)}`, providerId, enabled: true, model, ...(apiKey ? { apiKey } : {}) }
        const arr = [...insts, inst]
        const r = await saveAppSettings({ model: { providers: arr, ...(insts.length === 0 ? { default: `platform:${inst.id}` } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        if (r.ok) renderWork('settings')
        else st.textContent = r.error ?? '保存失败'
      }
    } else if (cat.id === 'model' && currentSetSub === 'local') {
      // #274：本地模型改为预留预告（真·本地部署：内置模型下载+本地推理，参考 Cherry Studio 模型列表）——端点式接入归自定义
      panel('模型 · 本地模型', '在本地设备下载并运行模型，数据不出本机。', `
        <div class="set-card"><div class="sc-main"><div class="sc-title">内置模型下载与本地部署</div>
          <div class="sc-desc">将提供模型列表（如 Qwen3 Embedding 0.6B · 约 614MB）一键下载与本地运行，无需 GPU 也可运行小型模型；下载后数据不出本机。</div></div></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">已有本地推理服务？</div>
          <div class="sc-desc">Ollama / LM Studio / vLLM 等本地端点请到「自定义」接入（API 地址填 http://127.0.0.1:11434/v1 这类端点即可）。</div></div></div>
      `)
    } else if (cat.id === 'model' && currentSetSub === 'custom') {
      // #283：自定义=多模型列表——每条单独启停/删除，任一可设为对话默认；key 走钥匙串
      const g = await loadAppSettings()
      const mcfg = g.model ?? {}
      const insts = Array.isArray(mcfg.custom) ? mcfg.custom : []
      const isDefault = (id) => mcfg.default === `custom:${id}`
      panel('模型 · 自定义', '添加多个 OpenAI 兼容端点（Ollama / LM Studio / vLLM / 中转站 / 私有部署），每条可单独启用/停用，任一可设为对话默认。本地端点 Key 可留空。', `
        <div id="sp-cu-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button type="button" class="btn ghost" id="sp-cu-add" style="margin-top:10px">＋ 添加自定义模型</button>
        <div id="sp-cu-form" style="display:${insts.length === 0 ? 'block' : 'none'};margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-field"><label>名称</label><input id="sp-cu-name" placeholder="例：本地 Ollama" /></div>
          <div class="set-field"><label>API 地址</label><input id="sp-cu-url" placeholder="http://127.0.0.1:11434/v1（Ollama）或 https://your-endpoint.example.com/v1" /></div>
          <div class="set-field"><label>模型名</label><input id="sp-cu-model" placeholder="your-model" /></div>
          <div class="set-field"><label>API Key（本地端点可留空）</label><input id="sp-cu-key" type="password" placeholder="sk-…" /></div>
          <div class="set-row">
            <button type="button" class="btn" id="sp-cu-save">保存</button>
            <button type="button" class="btn ghost" id="sp-cu-cancel">取消</button>
            <span class="set-status" id="sp-cu-status"></span>
          </div>
        </div>`)
      const renderList = () => {
        const box = $('sp-cu-list')
        box.innerHTML = ''
        if (!insts.length) { box.innerHTML = '<div class="set-desc">尚未添加自定义模型</div>'; return }
        for (const inst of insts) {
          const card = document.createElement('div')
          card.className = 'set-card'
          card.innerHTML = `<div class="sc-main"><div class="sc-title">${inst.name || '未命名'}${isDefault(inst.id) ? ' <span style="color:var(--accent);font-size:11px">默认</span>' : ''}</div>
            <div class="sc-desc">${inst.model} · ${inst.baseUrl}</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              ${isDefault(inst.id) ? '' : `<button type="button" class="btn ghost" data-act="default" style="padding:2px 8px;font-size:11px">设为默认</button>`}
              <button type="button" class="toggle ${inst.enabled ? 'on' : ''}" data-act="toggle"></button>
              <span data-act="del" style="color:var(--muted);cursor:pointer;padding:0 4px">×</span>
            </div>`
          // #283.1：默认实例无「设为默认」按钮——querySelector 判空再绑（null.onclick 报错源）
          const defBtn = card.querySelector('[data-act=default]')
          if (defBtn) defBtn.onclick = async () => {
            await saveAppSettings({ model: { default: `custom:${inst.id}` } })
            renderWork('settings')
          }
          card.querySelector('[data-act=toggle]').onclick = async (e) => {
            const next = !e.currentTarget.classList.contains('on')
            e.currentTarget.classList.toggle('on', next)
            await saveAppSettings({ model: { custom: insts.map((x) => (x.id === inst.id ? { ...x, enabled: next } : x)) } })
          }
          card.querySelector('[data-act=del]').onclick = async () => {
            await window.moonlybox.rpc('settings', { op: 'deleteModelInst', kind: 'custom', id: inst.id }, 10_000)
            await saveAppSettings({ model: { custom: insts.filter((x) => x.id !== inst.id), ...(isDefault(inst.id) ? { default: '' } : {}) } })
            renderWork('settings')
          }
          box.appendChild(card)
        }
      }
      renderList()
      $('sp-cu-add').onclick = () => { $('sp-cu-form').style.display = 'block' }
      $('sp-cu-cancel').onclick = () => { $('sp-cu-form').style.display = 'none' }
      $('sp-cu-save').onclick = async () => {
        const st = $('sp-cu-status')
        st.className = 'set-status'; st.textContent = '保存中…'
        const name = $('sp-cu-name').value.trim()
        const baseUrl = $('sp-cu-url').value.trim().replace(/\/+$/, '')
        const model = $('sp-cu-model').value.trim()
        const apiKey = $('sp-cu-key').value.trim()
        if (!baseUrl || !model) { st.className = 'set-status err'; st.textContent = 'API 地址与模型名必填'; return }
        if (!/^https?:\/\//.test(baseUrl)) { st.className = 'set-status err'; st.textContent = 'API 地址需以 http(s):// 开头'; return }
        const inst = { id: `custom_${Date.now().toString(36)}`, name: name || '自定义模型', baseUrl, model, enabled: true, ...(apiKey ? { apiKey } : {}) }
        const r = await saveAppSettings({ model: { custom: [...insts, inst], ...(insts.length === 0 ? { default: `custom:${inst.id}` } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        if (r.ok) renderWork('settings')
        else st.textContent = r.error ?? '保存失败'
      }

    } else if (cat.id === 'messaging') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.messaging ?? []
      const enabled = g.messaging?.providers ?? {}
      panel('消息平台', '对接 IM 平台，让你在小月里远程收发消息与操作。Token/Secret 只存本机钥匙串。已支持飞书、钉钉、QQ 机器人、Telegram、企业微信（AI 机器人）、Slack、Email（邮件收发）；个人微信走 iLink 机器人身份（扫码登录，多数账号单聊可用）。', `
        ${provs.map((p) => {
          const cur = enabled[p.id] ?? { enabled: false }
          return `<div class="set-card"><div class="sc-main"><div class="sc-title">${p.label}</div><div class="sc-desc">${cur.enabled ? '已开启' : '对接后可在此平台收发消息'}</div></div>
            <button type="button" class="toggle ${cur.enabled ? 'on' : ''}" data-msg="${p.id}"></button></div>
          <div data-msgcfg="${p.id}" style="display:${cur.enabled ? 'block' : 'none'};margin:0 0 10px">
            ${p.needs.map((n) => `<div class="set-field" style="max-width:340px"><label>${n.label}${n.secret ? '（只存钥匙串）' : ''}</label><input type="${n.secret ? 'password' : 'text'}" data-msgkey="${p.id}.${n.key}" value="${(cur.config ?? {})[n.key] && !n.secret ? (cur.config ?? {})[n.key] : ''}" placeholder="${n.secret ? '已配置时不回显' : ''}" /></div>`).join('')}
            ${p.id === 'weixin' ? `<div class="set-row" style="margin-top:8px"><button type="button" class="btn" id="sp-wx-login">扫码登录（获取 Token）</button><span class="set-desc" id="sp-wx-login-state"></span></div><div id="sp-wx-qr" style="margin-top:8px;max-width:200px"></div>` : ''}
          </div>`
        }).join('')}
        <div class="set-status" id="sp-msg-status"></div>
        <div class="set-row" style="margin-top:10px"><button type="button" class="btn" id="sp-msg-start">启动网关</button><span class="set-desc" id="sp-msg-run"></span></div>
      `)
      $('sp-msg-start').onclick = async () => {
        const run = $('sp-msg-run')
        run.textContent = '启动中…'
        const r = await window.moonlybox.rpc('messaging', { op: 'start' }, 30_000)
        if (r.event === 'done' && r.code === 0) {
          const statuses = JSON.parse(r.text).statuses ?? []
          const parts = statuses.map((s) => `${s.platform}：${s.running ? '✓ 运行中' : `✗ ${s.error ?? '未启动'}`}`)
          run.textContent = parts.join('  ') || '无已启用平台'
        } else run.textContent = `启动失败：${r.message ?? r.text}`
      }
      const wxLoginBtn = $('sp-wx-login')
      if (wxLoginBtn) {
        let wxTimer = null
        let wxQrcode = ''
        let wxBase = ''
        const stopWx = () => {
          if (wxTimer) clearInterval(wxTimer)
          wxTimer = null
        }
        const pollWx = async () => {
          const st = $('sp-wx-login-state')
          const r = await window.moonlybox.rpc('messaging', { op: 'wxLoginPoll', qrcode: wxQrcode, baseUrl: wxBase }, 40_000)
          if (r.event !== 'done' || r.code !== 0) {
            stopWx()
            st.textContent = `✗ ${r.message ?? r.text ?? '查询失败'}`
            return
          }
          const j = JSON.parse(r.text)
          if (j.status === 'wait') st.textContent = '等待扫码…'
          else if (j.status === 'scaned') st.textContent = '已扫码，请在微信里确认…'
          else if (j.status === 'scaned_but_redirect' && j.redirectHost) {
            wxBase = `https://${j.redirectHost}`
            st.textContent = '已扫码，请在微信里确认…'
          } else if (j.status === 'expired') {
            stopWx()
            st.textContent = '✗ 二维码已过期，请重新点击扫码登录'
          } else if (j.status === 'confirmed') {
            stopWx()
            st.textContent = `✓ 登录成功（账号 ${j.accountId}）——Token 已存钥匙串，可直接启动网关`
            const qr = $('sp-wx-qr')
            if (qr) qr.innerHTML = ''
            renderWork('settings')
          }
        }
        wxLoginBtn.onclick = async () => {
          stopWx()
          const st = $('sp-wx-login-state')
          const qrBox = $('sp-wx-qr')
          st.textContent = '获取二维码…'
          const r = await window.moonlybox.rpc('messaging', { op: 'wxLoginStart' }, 40_000)
          if (r.event !== 'done' || r.code !== 0) {
            st.textContent = `✗ ${r.message ?? r.text ?? '获取二维码失败'}`
            return
          }
          const j = JSON.parse(r.text)
          wxQrcode = j.qrcode
          wxBase = ''
          if (qrBox) qrBox.innerHTML = j.svg
          st.textContent = '请用微信扫描上方二维码（有效期约 5 分钟）…'
          stopWx()
          wxTimer = setInterval(pollWx, 3000)
          void pollWx()
        }
      }
      window.moonlybox.rpc('messaging', { op: 'status' }, 10_000).then((r) => {
        if (r.event === 'done' && r.code === 0) {
          const running = JSON.parse(r.text).running ?? []
          if (running.length) $('sp-msg-run').textContent = `运行中：${running.join('、')}`
        }
      })
      w.querySelectorAll('[data-msg]').forEach((tg) => {
        tg.onclick = () => { tg.classList.toggle('on'); const box = w.querySelector(`[data-msgcfg="${tg.dataset.msg}"]`); if (box) box.style.display = tg.classList.contains('on') ? 'block' : 'none'; saveMessaging() }
      })
      w.querySelectorAll('[data-msgkey]').forEach((inp) => { inp.onchange = saveMessaging })
      async function saveMessaging() {
        const st = $('sp-msg-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const providers = {}
        for (const p of provs) {
          const cb = w.querySelector(`[data-msg="${p.id}"]`)
          const on = cb?.classList.contains('on') ?? false
          const cfg = {}
          for (const n of p.needs) {
            const inp = w.querySelector(`[data-msgkey="${p.id}.${n.key}"]`)
            if (inp && inp.value) cfg[n.key] = inp.value // #286：secret 明文随 patch 发 daemon→剥离入钥匙串，settings 只落标记
            else if (!n.secret && (enabled[p.id]?.config ?? {})[n.key]) cfg[n.key] = (enabled[p.id]?.config ?? {})[n.key]
          }
          providers[p.id] = { enabled: on, config: cfg }
        }
        const r = await saveAppSettings({ messaging: { providers } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'builtin') {
      const g = await loadAppSettings()
      panel('MCP · 内置', 'Model Context Protocol 服务器——给小月接入外部工具与数据源的标准协议。内置服务器为魔力宝盒自带的 MoonLink（书房/收藏/便签/待办/记忆等 29 个工具）。', `
        <div class="set-card"><div class="sc-main"><div class="sc-title">工具（管家模式）· MoonLink（魔力宝盒内置）</div>
          <div class="sc-desc">小月能否调用工具代你执行任务（总闸）：关闭后小月纯对话，不装配 MoonLink 工具；开启后写操作仍逐一确认。原「通用」分类的此项已升格至此统一管理。</div></div>
          <button type="button" class="toggle ${g.mcp?.builtinEnabled !== false ? 'on' : ''}" id="sp-mcp-builtin"></button></div>
        <div class="set-status" id="sp-mcp-status"></div>
      `)
      $('sp-mcp-builtin').onclick = async (e) => {
        e.currentTarget.classList.toggle('on')
        const r = await saveAppSettings({ mcp: { builtinEnabled: $('sp-mcp-builtin').classList.contains('on') } })
        const st = $('sp-mcp-status'); st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'market') {
      panel('MCP · 市场', '发现并安装社区 MCP 服务器。', '<div class="set-status">市场目录由平台维护，当前目录为空。</div>')
} else if (cat.id === 'mcp' && currentSetSub === 'custom') {
      const g = await loadAppSettings()
      const list = g.mcp?.custom ?? []
      panel('MCP · 自定义', '添加自己的 MCP 服务器（Streamable HTTP）。启用后其工具与小月内置工具并列装配；API Key 只存本机钥匙串。', `
        <div id="sp-mcp-list">${list.map((m, i) => `<div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-row" style="margin:0 0 6px"><b>${m.name || '未命名'}</b><span class="set-desc" style="margin:0">${m.enabled !== false ? '已启用' : '已停用'}${m.keyStored ? ' · Key 已存钥匙串' : ''}</span>
            <button type="button" class="btn ghost" data-mcptoggle="${i}" style="margin-left:auto">${m.enabled !== false ? '停用' : '启用'}</button>
            <button type="button" class="btn ghost" data-mcpdel="${i}">删除</button></div>
          <div class="set-desc" style="margin:0">${m.url}</div></div>`).join('') || '<div class="set-status">暂无自定义 MCP 服务器。</div>'}</div>
        <div class="set-field" style="margin-top:14px"><label>名称</label><input id="sp-mcp-name" placeholder="my-mcp" /></div>
        <div class="set-field"><label>URL</label><input id="sp-mcp-url" placeholder="https://…/mcp" /></div>
        <div class="set-field"><label>API Key（可选，只存钥匙串）</label><input type="password" id="sp-mcp-key" placeholder="服务器要求鉴权时填写" /></div>
        <div class="set-row"><button type="button" class="btn" id="sp-mcp-add">添加</button><span class="set-status" id="sp-mcp2-status"></span></div>
      `)
      w.querySelectorAll('[data-mcpdel]').forEach((b) => {
        b.onclick = async () => {
          const list2 = (APP_SETTINGS.mcp?.custom ?? []).filter((_, i) => i !== Number(b.dataset.mcpdel))
          await saveAppSettings({ mcp: { custom: list2 } })
          renderWork('settings')
        }
      })
      w.querySelectorAll('[data-mcptoggle]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.mcptoggle)
          const list2 = (APP_SETTINGS.mcp?.custom ?? []).map((m, i) => (i === idx ? { ...m, enabled: m.enabled === false } : m))
          const r = await saveAppSettings({ mcp: { custom: list2 } })
          if (r.ok) renderWork('settings')
        }
      })
      $('sp-mcp-add').onclick = async () => {
        const st = $('sp-mcp2-status')
        const name = $('sp-mcp-name').value.trim(), url = $('sp-mcp-url').value.trim(), key = $('sp-mcp-key').value
        if (!name || !/^https?:\/\//.test(url)) { st.className = 'set-status err'; st.textContent = '名称与 http(s) URL 必填'; return }
        // #280：key 走条目顶层 apiKey→daemon 入钥匙串后剥离（settings.json 只落 keyStored 布尔）
        const entry = { name, url, apiKey: null, enabled: true, ...(key ? { apiKey: key } : {}) }
        const list2 = [...(APP_SETTINGS.mcp?.custom ?? []), entry]
        const r = await saveAppSettings({ mcp: { custom: list2 } })
        if (r.ok) renderWork('settings')
        else { st.className = 'set-status err'; st.textContent = r.error ?? '保存失败' }
      }
    } else if (cat.id === 'skills') {
      const gs = await loadAppSettings()
      const skOn = (gs.skills ?? { enabled: true }).enabled !== false
      let listHtml = ''
      let openState = skOn
      try {
        const lr = await window.moonlybox.rpc('skills', { op: 'list' }, 10_000)
        if (lr.event === 'done' && lr.code === 0) {
          const items = JSON.parse(lr.text).skills ?? []
          listHtml = items.length
            ? items.map((s) => `<div class="set-card"><div class="sc-main"><div class="sc-title">${s.name}</div><div class="sc-desc">${s.description || '（无描述）'}${s.files?.length ? ` · 关联文件 ${s.files.length}` : ''}</div></div></div>`).join('')
            : '<div class="set-desc">书房暂无技能——在书房目录打开 .moonlybox/skills/&lt;技能名&gt;/SKILL.md（含 name/description 头部）即生效，随书房备份。</div>'
        } else listHtml = '<div class="set-desc">技能清单读取失败。</div>'
      } catch { listHtml = '<div class="set-desc">技能清单读取失败。</div>' }
      panel('技能', '书房里的自定义技能：小月按需读取技能全文并照其中的流程执行。数据不出本机、随书房备份。', `
        <div class="set-card"><div class="sc-main"><div class="sc-title">启用技能</div><div class="sc-desc">关闭后小月不加载技能清单与技能工具</div></div>
          <button type="button" class="toggle ${openState ? 'on' : ''}" id="sp-sk-on"></button></div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px" id="sp-sk-list">${listHtml}</div>
      `)
      $('sp-sk-on').onclick = async (e) => {
        e.currentTarget.classList.toggle('on')
        await saveAppSettings({ skills: { enabled: e.currentTarget.classList.contains('on') } })
      }
    } else if (cat.id === 'websearch') {
      // #256.2 用户 5 点：URL 提取并入网络搜索分类（分组块）；选项类=自定义下拉
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.websearch ?? []
      const ws = g.websearch ?? {}
      const ue = g.urlextract ?? {}
      panel('网络搜索', '给小月接上搜索与网页提取能力（本质=服务商能力暴露给 Agent 的工具）。', `
        <div class="sc-title" style="font-size:13.5px;font-weight:600;margin:0 0 10px">搜索服务商</div>
        <div class="set-field" style="max-width:340px"><label>服务商</label>
          <select id="sp-ws-prov" class="set-select">
            <option value="">— 未启用 —</option>
            ${provs.filter((p) => p.id !== 'custom').map((p) => `<option value="${p.id}" ${ws.provider === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <div id="sp-ws-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ws-save">保存</button><span class="set-status" id="sp-ws-status"></span></div>
        <div class="sc-title" style="font-size:13.5px;font-weight:600;margin:26px 0 10px">URL 提取（收藏网页正文）</div>
        <div class="set-field" style="max-width:340px"><label>提取方式</label>
          <select id="sp-ue-mode" class="set-select">
            <option value="local" ${ue.mode !== 'provider' ? 'selected' : ''}>本地提取（内置 Readability，零成本）</option>
            <option value="provider" ${ue.mode === 'provider' ? 'selected' : ''}>服务商 API（质量更高）</option>
          </select>
        </div>
        <div id="sp-ue-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ue-save">保存</button><span class="set-status" id="sp-ue-status"></span></div>
      `)
      const renderWsCfg = () => {
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const box = $('sp-ws-cfg')
        if (!pv) { box.innerHTML = ''; return }
        if (pv.baseUrl) box.innerHTML = `<div class="set-field" style="max-width:340px"><label>API 地址（自动填入）</label><input id="sp-ws-baseUrl" value="${pv.baseUrl}" readonly /></div>`
        else box.innerHTML = `<div class="set-field" style="max-width:340px"><label>API 地址</label><input id="sp-ws-baseUrl" value="${ws.config?.baseUrl ?? ''}" placeholder="https://…" /></div>`
        box.innerHTML += `<div class="set-field" style="max-width:340px"><label>API Key（只存钥匙串）</label><input type="password" id="sp-ws-apiKey" placeholder="${ws.config?.apiKey ? '已配置，不回显' : ''}" /></div>`
      }
      $('sp-ws-prov').onchange = renderWsCfg
      renderWsCfg()
      $('sp-ws-save').onclick = async () => {
        const st = $('sp-ws-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const config = {}
        const b = $('sp-ws-baseUrl')
        if (b && b.value) config.baseUrl = b.value
        const k = $('sp-ws-apiKey')
        // #279：key 走节顶层 apiKey 字段→daemon 剥离入钥匙串（settings.json 不落 key 本体）
        const r = await saveAppSettings({ websearch: { provider: $('sp-ws-prov').value, config, ...(k && k.value ? { apiKey: k.value } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
      // URL 提取服务商（#276：云端清单优先——APP_PROVIDERS.urlextract；Jina 免 key，Firecrawl/自定义需 key）
      const UE_PROVIDERS = (APP_PROVIDERS?.urlextract ?? []).filter((x) => x.id !== 'local').map((x) => ({
        id: x.id,
        label: x.label,
        baseUrl: x.baseUrl ?? '',
        needsKey: (x.needs ?? []).includes('apiKey') || x.id === 'custom',
      }))
      const renderUeCfg = () => {
        const mode = $('sp-ue-mode').value
        const box = $('sp-ue-cfg')
        if (mode !== 'provider') { box.innerHTML = '<div class="set-desc" style="margin:0">本地提取：内置 Readability 算法在本机解析正文，零流量零成本。</div>'; return }
        const cur = UE_PROVIDERS.find((x) => x.id === (ue.provider ?? 'jina')) ?? UE_PROVIDERS[0]
        box.innerHTML = `
          <div class="set-field" style="max-width:340px"><label>服务商</label>
            <select id="sp-ue-prov" class="set-select">${UE_PROVIDERS.map((x) => `<option value="${x.id}" ${x.id === cur.id ? 'selected' : ''}>${x.label}</option>`).join('')}</select>
          </div>
          <div class="set-field" style="max-width:340px"><label>API 地址（选商自动填）</label><input id="sp-ue-url" value="${ue.config?.baseUrl ?? cur.baseUrl}" placeholder="https://…" /></div>
          <div class="set-field" style="max-width:340px"><label>API Key（只存钥匙串）</label><input type="password" id="sp-ue-key" placeholder="${ue.config?.apiKey ? '已配置，不回显' : ''}" /></div>`
        $('sp-ue-prov').onchange = () => {
          const pv = UE_PROVIDERS.find((x) => x.id === $('sp-ue-prov').value)
          $('sp-ue-url').value = pv.baseUrl
        }
      }
      $('sp-ue-mode').onchange = renderUeCfg
      renderUeCfg()
      $('sp-ue-save').onclick = async () => {
        const st = $('sp-ue-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const mode = $('sp-ue-mode').value
        let patch
        if (mode === 'provider') {
          const config = { baseUrl: $('sp-ue-url')?.value ?? '' }
          // #279：key 走节顶层 apiKey 字段→daemon 剥离入钥匙串
          patch = { urlextract: { mode, provider: $('sp-ue-prov')?.value ?? 'jina', config }, ...($('sp-ue-key')?.value ? { apiKey: $('sp-ue-key').value } : {}) }
        } else {
          patch = { urlextract: { mode, provider: '', config: {} } }
        }
        const r = await saveAppSettings(patch)
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
    } else if (cat.id === 'docproc') {
      // #256.2 用户 6 点：本地处理=具体服务商下拉（选商自动填 API 地址，不手填）
      const g = await loadAppSettings()
      const dp = g.docproc ?? {}
      const DP_PROVIDERS = [
        { id: 'builtin', label: '内置解析（纯文本/PDF 文本层，无需网络）', baseUrl: '', local: true, needsKey: false },
        { id: 'winocr', label: 'Windows OCR（系统自带，离线）', baseUrl: '', local: true, needsKey: false },
        { id: 'paddle', label: 'PaddleOCR（本地服务）', baseUrl: 'http://127.0.0.1:8866', local: true, needsKey: false },
        { id: 'doc2x', label: 'Doc2X', baseUrl: 'https://v2.doc2x.noedgeai.com', local: false, needsKey: true },
        { id: 'mineru', label: 'MinerU', baseUrl: 'https://mineru.net/api/v4', local: false, needsKey: true },
        { id: 'mathpix', label: 'Mathpix', baseUrl: 'https://api.mathpix.com', local: false, needsKey: true },
        { id: 'textin', label: 'TextIn（合合信息）', baseUrl: 'https://api.textin.com', local: false, needsKey: true },
      ]
      const cur = DP_PROVIDERS.find((x) => x.id === (dp.provider ?? 'builtin')) ?? DP_PROVIDERS[0]
      const mode = dp.mode ?? (cur.local ? 'local' : 'provider')
      panel('文档处理', 'PDF/Office/图片解析为文本：本地处理（离线引擎）或第三方云服务。', `
        <div class="set-field" style="max-width:400px"><label>处理方式与服务商</label>
          <select id="sp-dp-prov" class="set-select">
            <optgroup label="本地处理">${DP_PROVIDERS.filter((x) => x.local).map((x) => `<option value="${x.id}" ${cur.id === x.id ? 'selected' : ''}>${x.label}</option>`).join('')}</optgroup>
            <optgroup label="第三方服务">${DP_PROVIDERS.filter((x) => !x.local).map((x) => `<option value="${x.id}" ${cur.id === x.id ? 'selected' : ''}>${x.label}</option>`).join('')}</optgroup>
          </select>
        </div>
        <div id="sp-dp-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-dp-save">保存</button><span class="set-status" id="sp-dp-status"></span></div>
      `)
      const renderDpCfg = () => {
        const pv = DP_PROVIDERS.find((x) => x.id === $('sp-dp-prov').value)
        const box = $('sp-dp-cfg')
        if (!pv) { box.innerHTML = ''; return }
        let html = ''
        if (pv.baseUrl) html += `<div class="set-field" style="max-width:400px"><label>API 地址（选商自动填）</label><input id="sp-dp-url" value="${pv.baseUrl}" ${pv.local ? 'readonly' : ''} /></div>`
        else html += `<div class="set-field" style="max-width:400px"><label>API 地址</label><input id="sp-dp-url" value="${dp.config?.baseUrl && dp.provider === pv.id ? dp.config.baseUrl : ''}" placeholder="本地引擎无需地址" ${pv.local && !pv.baseUrl ? 'readonly' : ''} /></div>`
        if (pv.needsKey) html += `<div class="set-field" style="max-width:400px"><label>API Key（只存钥匙串）</label><input type="password" id="sp-dp-key" placeholder="${dp.config?.keyStored ? '已配置，不回显' : ''}" /></div>`
        box.innerHTML = html
      }
      $('sp-dp-prov').onchange = renderDpCfg
      renderDpCfg()
      $('sp-dp-save').onclick = async () => {
        const st = $('sp-dp-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const pv = DP_PROVIDERS.find((x) => x.id === $('sp-dp-prov').value)
        const config = {}
        const b = $('sp-dp-url')
        if (b && b.value) config.baseUrl = b.value
        const k = $('sp-dp-key')
        if (k && k.value) config.apiKey = k.value // #287：真 key 发 daemon→剥离入钥匙串 docproc-key（哨兵形态进不了钥匙串）
        else if (dp.config?.keyStored && dp.provider === pv.id) config.keyStored = true
        const r = await saveAppSettings({ docproc: { mode: pv.local ? 'local' : 'provider', provider: pv.id, config } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
} else if (cat.id === 'memory') {
      const g = await loadAppSettings()
      const mm = g.memory ?? {}
      panel('记忆', '长期记忆：小月跨会话记住关键信息。模式为本机内置+月忆（MoonRecall）增强——记忆沉淀在书房目录（明文可编辑、随书房备份），月忆作为云端增强逐步生效。', `
        <div class="set-card"><div class="sc-main"><div class="sc-title">启用长期记忆</div><div class="sc-desc">对话中的关键事实自动沉淀到本机记忆层，跨会话可 recall</div></div>
          <button type="button" class="toggle ${mm.enabled !== false ? 'on' : ''}" id="sp-mm-on"></button></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">同步到月忆</div><div class="sc-desc">本机沉淀的记忆条目同时上行到云端月忆候选池，你确认后才进入云端正式记忆（跨设备可用）</div></div>
          <button type="button" class="toggle ${mm.syncToMoon !== false ? 'on' : ''}" id="sp-mm-sync"></button></div>
        <div class="set-field"><label>记忆模式</label>
          <select id="sp-mm-mode" class="set-select set-select-sm">
            <option value="builtin_moonrecall" selected>本机内置 + 月忆（MoonRecall）增强</option>
          </select>
          <div class="set-desc" style="margin-top:4px">本机记忆层恒在（MEMORY.md/USER.md，明文可编辑、不出本机），月忆作为云端增强跨设备可用。</div>
        </div>
        <div class="set-field"><label>记忆注入上限（字符）</label>
          <input id="sp-mm-limit" type="number" min="500" step="100" value="${mm.injectLimit ?? 5000}" style="max-width:180px" />
          <div class="set-desc" style="margin-top:4px">每次对话注入小月的记忆上下文上限，超出按新旧保留截断。默认 5000。</div>
        </div>
        <div class="set-row"><button type="button" class="btn" id="sp-mm-save">保存</button><span class="set-status" id="sp-mm-status"></span></div>
        <div style="border-top:1px solid var(--border);margin:14px 0 10px"></div>
        <div class="sc-title" style="margin-bottom:2px">云端候选池</div>
        <div class="set-desc" style="margin-bottom:8px">对话沉淀的候选记忆（含重复命中的合并建议）在此确认后进入云端正式记忆；未登录或未开启同步时为空。</div>
        <div class="set-status" id="sp-mm-cand-state"></div>
        <div id="sp-mm-cand-body" style="display:flex;flex-direction:column;gap:8px;margin-top:6px"></div>
      `)
      $('sp-mm-on').onclick = (e) => { e.currentTarget.classList.toggle('on'); $('sp-mm-save').click() }
      $('sp-mm-sync').onclick = (e) => { e.currentTarget.classList.toggle('on'); $('sp-mm-save').click() }
      $('sp-mm-save').onclick = async () => {
        const st = $('sp-mm-status'); st.className = 'set-status'; st.textContent = '保存中…'
        const limit = Math.max(500, Math.floor(Number($('sp-mm-limit').value) || 5000))
        const r = await saveAppSettings({ memory: { enabled: $('sp-mm-on').classList.contains('on'), mode: $('sp-mm-mode').value, injectLimit: limit, syncToMoon: $('sp-mm-sync').classList.contains('on') } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? '✓ 已保存' : (r.error ?? '保存失败')
      }
      // #289 云端候选池：candidate 态实体列表+确认/丢弃（登录态经 daemon apiGet/apiPost；未登录自然报未登录错误）
      const mmBox = $('sp-mm-cand-body')
      const mmState = $('sp-mm-cand-state')
      const TYPE_LABELS = { fact: '事实', opinion: '观点', preference: '偏好', goal: '目标', project: '项目', person: '人物', action: '行动' }
      const loadCandidates = async () => {
        if (!mmBox) return
        mmState.textContent = '加载中…'
        const r = await window.moonlybox.rpc('candidates', { op: 'list' }, 20_000)
        if (!(r.event === 'done' && r.code === 0)) {
          mmState.textContent = `✗ ${r.message ?? r.text ?? '加载失败'}`
          mmBox.innerHTML = ''
          return
        }
        const items = JSON.parse(r.text).items ?? []
        if (!items.length) {
          mmState.textContent = '候选池为空——对话中沉淀的候选记忆会出现在这里，确认后进入云端正式记忆。'
          mmBox.innerHTML = ''
          return
        }
        mmState.textContent = `${items.length} 条待确认`
        mmBox.innerHTML = items.map((it) => {
          const sugg = (() => { try { return (JSON.parse(it.attributes ?? '{}')?.suggested ?? []) } catch { return [] } })()
          const suggHtml = sugg.length ? `<div class="set-desc" style="margin:3px 0 0 26px">合并建议：${sugg.map((s) => `「${String(s).slice(0, 40)}」`).join('、')}</div>` : ''
          return `<div class="set-card" data-mmid="${it.id}" style="flex-direction:column;align-items:stretch"><div style="display:flex;align-items:center;gap:8px">
            <span class="set-desc" style="flex:0 0 auto">${TYPE_LABELS[it.type] ?? it.type ?? '—'}</span>
            <span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(it.subject ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>
            <button type="button" class="btn" style="font-size:11.5px;padding:3px 10px" data-mmact="confirm">确认</button>
            <button type="button" class="btn ghost" style="font-size:11.5px;padding:3px 10px" data-mmact="drop">丢弃</button>
          </div>${suggHtml}</div>`
        }).join('')
        mmBox.querySelectorAll('[data-mmact]').forEach((btn) => {
          btn.onclick = async () => {
            const card = btn.closest('[data-mmid]')
            const id = card?.dataset.mmid
            if (!id) return
            btn.disabled = true
            const act = btn.dataset.mmact
            const rr = await window.moonlybox.rpc('candidates', { op: 'decide', id, action: act }, 20_000)
            if (rr.event === 'done' && rr.code === 0 && JSON.parse(rr.text).ok) {
              card.remove()
              const left = mmBox.querySelectorAll('[data-mmid]').length
              mmState.textContent = left ? `${left} 条待确认` : '已全部处理完 ✓'
              if (!left) mmBox.innerHTML = ''
            } else {
              btn.disabled = false
              mmState.textContent = `✗ ${rr.message ?? '操作失败'}`
            }
          }
        })
      }
      void loadCandidates()
        } else {
      const subLabel = currentSetSub ? ` · ${SET_SUB_LABELS[currentSetSub] ?? currentSetSub}` : ''
      panel(`${cat.label}${subLabel}`, '此分类的配置项随功能开启逐步展示。', '')
    }
    return
  }
  // ---------- 备份（#257）：新建向导 + 详情面板 ----------
  if (nav === 'backup') {
    if (arg?.create) {
      // 新建界面：本地目录选择 + 归属目录下拉 + 格式说明
      let dirs = [{ id: null, label: '书房根目录' }]
      w.innerHTML = `
        <div class="set-panel">
          <h3>新建备份目录</h3>
          <p class="set-desc">把一个本地文件夹持续备份到云端书房的指定目录（归属目录）下。<br/>
          <b>可识别的文件格式：.md、.txt 文本文件</b>（其它格式自动跳过）；备份只上传、不改动本地文件；
          文件内容未变化时自动跳过。</p>
          <div class="set-field">
            <label>本地目录</label>
            <div class="set-row" style="margin:0"><input id="bk-path" readonly placeholder="未选择" style="flex:1" />
              <button type="button" class="btn ghost" id="bk-pick">选择…</button></div>
          </div>
          <div class="set-field">
            <label>云端归属目录（同步目标）</label>
            <select id="bk-dir" class="set-select" style="max-width:340px"><option>加载中…</option></select>
          </div>
          <div class="set-field">
            <label>云端删除后（网页端删了这份文件）</label>
            <select id="bk-ondel" class="set-select" style="max-width:340px">
              <option value="resync">下次同步重新上传（备份目录为源）</option>
              <option value="keep">不再同步该文件（保留云端删除动作）</option>
            </select>
          </div>
          <div class="set-field">
            <label>同名策略（云端已有同名文档，如另一台电脑备份过）</label>
            <select id="bk-onconf" class="set-select" style="max-width:340px">
              <option value="rename" selected>重命名上传（保留双方，互不覆盖）</option>
            </select>
            <p class="set-desc" style="margin:4px 0 0">同名文档上传为「笔记 2」，双方并存；重装/换机需接管云端同名文档时，新建时会先出现「同名认领」确认。</p>
          </div>
          <div class="set-row">
            <button type="button" class="btn" id="bk-save">注册并立即同步</button>
            <span class="set-status" id="bk-status"></span>
          </div>
        </div>`
      $('bk-pick').onclick = async () => {
        const r = await window.moonlybox.pickFolder()
        if (r.ok) $('bk-path').value = r.path
      }
      try {
        const rd = await window.moonlybox.rpc('backup', { op: 'dirs' }, 15_000)
        dirs = JSON.parse(rd.text).dirs ?? dirs
      } catch {}
      const sel = $('bk-dir')
      sel.innerHTML = dirs.map((d) => `<option value="${d.id ?? ''}">${d.label}</option>`).join('')
      $('bk-save').onclick = async () => {
        const st = $('bk-status')
        st.className = 'set-status'; st.textContent = ''
        const localPath = $('bk-path').value
        if (!localPath) { st.className = 'set-status err'; st.textContent = '先选择本地目录'; return }
        const dirId = sel.value || null
        const dirName = sel.options[sel.selectedIndex]?.text ?? '书房根目录'
        // #260 预检：云端同名清单 → 有则内嵌确认（重命名/覆盖认领二选一）
        st.textContent = '检查云端同名文件…'
        let hits = []
        try {
          const rc = await window.moonlybox.rpc('backup', { op: 'check', localPath, directoryId: dirId }, 20_000)
          if (rc.event !== 'done' || rc.code !== 0) { st.className = 'set-status err'; st.textContent = rc.message ?? rc.text ?? '预检失败'; return }
          hits = JSON.parse(rc.text).hits ?? []
        } catch (e) { st.className = 'set-status err'; st.textContent = '预检失败：' + String(e?.message ?? e); return }
        let claims = null
        if (hits.length) {
          st.className = 'set-status'; st.textContent = ''
          const listHtml = hits.map((h) => `<div class="set-card" style="margin:6px 0"><div class="sc-main"><div class="sc-title">${h.title}</div><div class="sc-desc">云端已有同名文档（版本 ${h.version}${h.updatedAt ? '，更新于 ' + new Date(h.updatedAt).toLocaleString() : ''}）</div></div></div>`).join('')
          const panel = w.querySelector('.set-panel')
          const confirmBox = document.createElement('div')
          confirmBox.innerHTML = `
            <div style="margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:10px">
              <div style="font-weight:600;margin-bottom:4px">发现 ${hits.length} 个同名文件</div>
              <p class="set-desc">云端归属目录中已存在同名文档。若这是<b>重装/换机后的认领</b>（本机就是这些文件的原始作者，且<b>确保没有其他电脑同时在同步这些文件</b>），可选择覆盖认领；否则请选重命名上传（保留双方）。</p>
              ${listHtml}
              <div class="set-row" style="margin-top:10px">
                <button type="button" class="btn" id="bk-claim">覆盖认领（重装机）</button>
                <button type="button" class="btn ghost" id="bk-rename">重命名上传（推荐）</button>
              </div>
            </div>`
          panel.appendChild(confirmBox)
          const userPick = await new Promise((resolve) => {
            confirmBox.querySelector('#bk-rename').onclick = () => resolve('rename')
            confirmBox.querySelector('#bk-claim').onclick = () => resolve('claim')
          })
          confirmBox.remove()
          if (userPick === 'claim') {
            claims = {}
            for (const h of hits) claims[h.title] = h.docId
          }
        }
        st.textContent = '注册中…'
        const r = await window.moonlybox.rpc('backup', { op: 'add', localPath, directoryId: dirId, directoryName: dirName, onDelete: $('bk-ondel').value, onConflict: $('bk-onconf').value, ...(claims ? { claims } : {}) }, 15_000)
        if (r.event !== 'done' || r.code !== 0) { st.className = 'set-status err'; st.textContent = r.message ?? r.text ?? '注册失败'; return }
        const entry = JSON.parse(r.text).entry
        st.textContent = '已注册，首次同步中…'
        const rs = await window.moonlybox.rpc('backup', { op: 'sync', id: entry.id }, 120_000)
        currentBkId = entry.id
        renderList('backup')
        renderWork('backup', { id: entry.id, justSynced: rs.event === 'done' && rs.code === 0 ? JSON.parse(rs.text).report : null })
      }
      return
    }
    if (arg?.id) {
      // 详情面板
      const r = await window.moonlybox.rpc('backup', { op: 'list' }, 10_000)
      const d = JSON.parse(r.text)
      const e = d.entries.find((x) => x.id === arg.id)
      if (!e) { w.innerHTML = '<div class="set-panel"><p class="set-desc">备份目录不存在</p></div>'; return }
      w.innerHTML = `
        <div class="set-panel">
          <h3>${e.localPath.split(/[\\/]/).pop()}</h3>
          <p class="set-desc">${e.localPath}</p>
          <div class="set-card"><div class="sc-main"><div class="sc-title">云端归属目录</div><div class="sc-desc">${e.directoryName}</div></div></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">启用备份</div><div class="sc-desc">停用后此目录不再参与同步（已上传内容保留在云端）</div></div>
            <button type="button" class="toggle ${e.enabled ? 'on' : ''}" id="bk-toggle"></button></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">云端删除后</div><div class="sc-desc">网页端删除此备份上传的文档后，下次同步的行为</div></div>
            <select class="set-select" id="bk-ondel" style="max-width:220px">
              <option value="resync"${e.onDelete !== 'keep' ? ' selected' : ''}>重新上传</option>
              <option value="keep"${e.onDelete === 'keep' ? ' selected' : ''}>不再同步</option>
            </select></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">同名策略</div><div class="sc-desc">云端已有同名文档时重命名上传（重装认领走新建时的「同名认领」一次性确认，不在此列）</div></div>
            <select class="set-select" id="bk-onconf" style="max-width:220px">
              <option value="rename" selected>重命名上传（保留双方）</option>
            </select></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">上次同步</div><div class="sc-desc">${e.lastSyncAt ? new Date(e.lastSyncAt).toLocaleString() : '从未'}</div></div>
            <button type="button" class="btn" id="bk-sync">立即同步</button></div>
          <div class="set-row" style="margin-top:20px"><button type="button" class="btn ghost" id="bk-del" style="color:var(--err)">删除此备份目录</button></div>
          <div class="set-status" id="bk-detail-status"></div>
        </div>`
      if (arg.justSynced) {
        const rep = arg.justSynced
        const st = $('bk-detail-status')
        st.className = 'set-status ok'
        const parts = [`上传 ${rep.uploaded.length}`, `更新 ${rep.updated.length}`, `跳过 ${rep.skipped.length}`]
        if (rep.cloudDeleted?.length) parts.push(`云端删除感知 ${rep.cloudDeleted.length}`)
        if (rep.cloudUpdated?.length) parts.push(`云端更新采纳 ${rep.cloudUpdated.length}`)
        if (rep.conflicts.length) parts.push(`需处理 ${rep.conflicts.length}`)
        st.textContent = `同步完成：${parts.join('，')}`
      }
      $('bk-toggle').onclick = async (ev) => {
        ev.currentTarget.classList.toggle('on')
        await window.moonlybox.rpc('backup', { op: 'toggle', id: e.id, enabled: $('bk-toggle').classList.contains('on') }, 10_000)
        renderList('backup')
      }
      $('bk-sync').onclick = async (ev) => {
        const st = $('bk-detail-status')
        st.className = 'set-status'; st.textContent = '同步中…'
        const rs = await window.moonlybox.rpc('backup', { op: 'sync', id: e.id }, 120_000)
        if (rs.event === 'done' && rs.code === 0) {
          const rep = JSON.parse(rs.text).report
          st.className = 'set-status ok'
          const parts = [`上传 ${rep.uploaded.length}`, `更新 ${rep.updated.length}`, `跳过 ${rep.skipped.length}`]
          if (rep.cloudDeleted?.length) parts.push(`云端删除感知 ${rep.cloudDeleted.length}`)
          if (rep.cloudUpdated?.length) parts.push(`云端更新采纳 ${rep.cloudUpdated.length}`)
          if (rep.conflicts.length) parts.push(`需处理 ${rep.conflicts.length}（${rep.conflicts[0].reason.slice(0, 60)}）`)
          st.textContent = `完成：${parts.join('，')}`
        } else { st.className = 'set-status err'; st.textContent = rs.message ?? rs.text ?? '同步失败' }
        renderList('backup')
      }
      $('bk-ondel').onchange = async (ev) => {
        await window.moonlybox.rpc('backup', { op: 'policies', id: e.id, onDelete: ev.currentTarget.value }, 10_000)
        renderList('backup')
      }

      $('bk-del').onclick = async () => {
        await window.moonlybox.rpc('backup', { op: 'remove', id: e.id }, 10_000)
        currentBkId = null
        renderList('backup')
        renderWork('backup')
      }
      return
    }
    // 无选中：占位
    w.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center" class="muted">选择左侧备份目录，或点「＋ 新建」注册一个</div>'
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
    // #290 创建返工：新建走「＋ 新建→模板弹窗→填名称→自动填充示例」流程；未创建前不出现保存/存书房/AI 按钮
    w.innerHTML = `
      <div class="row" style="padding:10px 16px;border-bottom:1px solid var(--border)">
        <input id="dg-title" placeholder="图示标题" style="width:180px" />
        <button class="btn" id="dg-save" style="font-size:12px;padding:5px 10px">保存草稿</button>
        <button class="btn" id="dg-activate" style="background:var(--ok);font-size:12px;padding:5px 10px">存进书房</button>
        <button class="btn" id="dg-ai" style="background:#7c3aed;font-size:12px;padding:5px 10px">✨ AI 生成</button>
        <span id="dg-state" class="muted" style="font-size:11px;margin-left:auto"></span>
      </div>
      <div id="dg-empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px">
        <div class="muted" style="font-size:13px">从模板创建图示，或打开左侧已有图示</div>
        <button class="btn" id="dg-new" style="padding:8px 22px;font-size:13px">＋ 新建</button>
      </div>
      <div id="dg-editor" style="display:none;flex:1;min-height:0">
        <div style="flex:1;display:flex;min-height:0;height:100%">
          <textarea id="dg-code" spellcheck="false" style="flex:1;border:0;border-right:1px solid var(--border);padding:14px;font:12px/1.6 ui-monospace,monospace;resize:none;background:transparent;color:inherit;outline:none" placeholder="mermaid 代码（例：graph TD; A[开始] --> B[结束]）"></textarea>
          <div id="dg-preview" style="flex:1;overflow:auto;padding:16px"></div>
        </div>
        <div id="dg-err" style="display:none;padding:8px 16px;font-size:12px;color:var(--err);border-top:1px solid var(--border)"></div>
      </div>`
    const newRow = $('dg-new')
    if (newRow) {
      newRow.onclick = async () => {
        let pick = null
        try { pick = await showDiagramTemplateDialog() } catch { return } // 取消=留在空态
        $('dg-empty').style.display = 'none'
        $('dg-editor').style.display = 'flex'
        $('dg-editor').style.flexDirection = 'column'
        bindDiagramWorkbench(null, pick)
      }
    }
    // arg=打开已有图示 → 直接进编辑器；无 arg → 空态（按钮隐藏）
    if (arg?.id) {
      $('dg-empty').style.display = 'none'
      $('dg-editor').style.display = 'flex'
      $('dg-editor').style.flexDirection = 'column'
      bindDiagramWorkbench(arg)
    } else {
      const hide = ['dg-save', 'dg-activate', 'dg-ai']
      for (const id of hide) { const el = $(id); if (el) el.style.display = 'none' }
      const ti = $('dg-title'); if (ti) ti.style.display = 'none'
      $('dg-state').textContent = ''
    }
    return
  }
  if (nav === 'xiaoyue') {
    // #282：arg.chat=打开指定对话（恢复历史+绑定 chatId/workspaceId）；无参=占位
    let meta = null
    if (arg?.chat) {
      const r = await window.moonlybox.rpc('workspace', { op: 'chat', id: arg.chat }, 15_000)
      if (r.event === 'done' && r.code === 0) meta = JSON.parse(r.text).chat
    }
    // #283.4：标签带工作空间名——用户能一眼确认当前对话是否真的挂在工作空间下（fs 工具只在此时装配）
    let wsName = ''
    if (meta?.workspaceId) {
      try {
        const rw = await window.moonlybox.rpc('workspace', { op: 'list' }, 10_000)
        wsName = (JSON.parse(rw.text).workspaces ?? []).find((x) => x.id === meta.workspaceId)?.name ?? ''
      } catch {}
    }
    const wsLabel = meta ? (meta.workspaceId ? `📁 工作空间${wsName ? `「${wsName}」` : ''}对话（可读写挂载目录）` : '💬 无工作空间（无本地文件访问，仅文档库/MCP）') : ''
    w.innerHTML = `
      ${meta ? `<div class="muted" style="padding:8px 16px 0;font-size:12px">${meta.title} · ${wsLabel}</div>` : ''}
      <div id="log" class="mono" style="flex:1;overflow-y:auto;padding:16px;white-space:pre-wrap;user-select:text"></div>
      <div class="row" style="padding:12px 16px;border-top:1px solid var(--border)">
        <input id="q" placeholder="${meta ? (meta.workspaceId ? '问小月（工作空间内可读写文件）…' : '问小月（文档库/MCP，无本地目录访问）…') : '先在左侧选择或新建对话'}" style="flex:1" ${meta ? '' : 'disabled'} />
        <button class="btn" id="btn-ask" ${meta ? '' : 'disabled'}>发送</button>
      </div>`
    if (meta) bindChat({ meta })
    else w.insertAdjacentHTML('afterbegin', '<div class="muted" style="padding:16px">左侧新建工作空间或对话开始。</div>')
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

// ---------- 图示模板（#290 创建返工：新建→模板弹窗→名称→自动填充示例） ----------
const DG_TEMPLATES = [
  { key: 'flowchart', name: '流程图', icon: '🔀', desc: '步骤流转 / 判断分支', common: true,
    code: `flowchart TD
    A[开始] --> B{是否已登录?}
    B -- 是 --> C[进入首页]
    B -- 否 --> D[跳转登录页]
    D --> E[输入账密]
    E --> F{验证通过?}
    F -- 通过 --> C
    F -- 失败 --> D
    C --> G[结束]` },
  { key: 'sequence', name: '时序图', icon: '🔗', desc: '模块间调用时序', common: true,
    code: `sequenceDiagram
    participant U as 用户
    participant C as 客户端
    participant S as 服务端
    U->>C: 点击登录
    C->>S: 提交账密
    S-->>C: 返回 token
    C-->>U: 进入首页` },
  { key: 'mindmap', name: '思维导图', icon: '🧠', desc: '主题发散 / 知识梳理', common: true,
    code: `mindmap
  root((产品规划))
    核心功能
      对话
      图示
    增长
      渠道合作
      内容营销
    商业化
      订阅制` },
  { key: 'pie', name: '饼图', icon: '🥧', desc: '占比分布', common: true,
    code: `pie title 时间分配
    "开发" : 45
    "设计" : 20
    "会议" : 15
    "其他" : 20` },
  { key: 'gantt', name: '甘特图', icon: '📅', desc: '项目排期', common: true,
    code: `gantt
    title 项目排期
    dateFormat YYYY-MM-DD
    section 设计
    原型设计 :a1, 2026-10-01, 7d
    视觉稿 :a2, after a1, 5d
    section 开发
    前端开发 :b1, after a2, 10d
    联调测试 :b2, after b1, 5d` },
  { key: 'er', name: 'ER 图', icon: '🗄️', desc: '数据模型 / 实体关系', common: true,
    code: `erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    USER {
        string id PK
        string name
    }
    ORDER {
        string id PK
        datetime created_at
    }` },
  { key: 'state', name: '状态图', icon: '🚦', desc: '状态机流转', common: false,
    code: `stateDiagram-v2
    [*] --> 草稿
    草稿 --> 待审核 : 提交
    待审核 --> 已发布 : 通过
    待审核 --> 草稿 : 驳回
    已发布 --> [*]` },
  { key: 'journey', name: '用户旅程', icon: '🛤️', desc: '体验流程 / 满意度', common: false,
    code: `journey
    title 用户注册旅程
    section 发现
      访问官网: 5: 用户
      了解产品: 4: 用户
    section 转化
      注册账号: 3: 用户
      首次使用: 4: 用户` },
  { key: 'timeline', name: '时间线', icon: '🗓️', desc: '事件脉络', common: false,
    code: `timeline
    title 产品里程碑
    2026-01 : 立项
    2026-04 : 内测上线
    2026-09 : 正式发布` },
  { key: 'quadrant', name: '象限图', icon: '🎯', desc: '四象限分析', common: false,
    code: `quadrantChart
    title 需求优先级
    x-axis 低紧迫 --> 高紧迫
    y-axis 低重要 --> 高重要
    需求A: [0.8, 0.9]
    需求B: [0.3, 0.7]
    需求C: [0.6, 0.2]` },
  { key: 'gitgraph', name: 'Git 图', icon: '🌿', desc: '分支策略', common: false,
    code: `gitGraph
    commit id: "init"
    branch dev
    commit
    commit
    merge main
    commit id: "v1.0" tag: "v1.0"` },
  { key: 'class', name: '类图', icon: '📦', desc: '类结构 / 继承关系', common: false,
    code: `classDiagram
    class Animal {
        +String name
        +eat()
    }
    class Dog {
        +bark()
    }
    Animal <|-- Dog` },
  { key: 'empty', name: '空图示', icon: '📄', desc: '从空白开始', common: false, code: '' },
]

// 模板选择弹窗：resolve(选择) / reject(取消)；名称在此填写，确认后进工作台自动填充
function showDiagramTemplateDialog() {
  return new Promise((resolve, reject) => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center'
    const card = document.createElement('div')
    card.style.cssText = 'width:620px;max-width:92vw;max-height:86vh;overflow-y:auto;background:var(--panel,#1e1e2e);border:1px solid var(--border);border-radius:10px;padding:18px'
    const common = DG_TEMPLATES.filter((t) => t.common && t.key !== 'empty')
    const rest = DG_TEMPLATES.filter((t) => !t.common)
    card.innerHTML = `
      <div style="display:flex;align-items:center;margin-bottom:4px"><b style="font-size:15px">新建图示</b><span style="flex:1"></span><span id="dg-tpl-close" style="cursor:pointer;color:var(--muted);font-size:16px;padding:0 4px">×</span></div>
      <div class="set-desc" style="margin-bottom:10px">选择图示类型，示例代码会自动填充，稍后可修改。</div>
      <div class="set-desc" style="margin:8px 0 6px;font-weight:600">常用</div>
      <div id="dg-tpl-common" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px"></div>
      <div class="set-desc" style="margin:12px 0 6px;font-weight:600">更多类型</div>
      <div id="dg-tpl-more" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px"></div>
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
        <div class="set-desc" style="margin-bottom:6px">图示名称</div>
        <div style="display:flex;gap:8px">
          <input id="dg-tpl-title" placeholder="给图示起个名字（必填）" style="flex:1" maxlength="60" />
          <button class="btn" id="dg-tpl-ok" style="background:var(--accent)">创建</button>
        </div>
      </div>`
    ov.appendChild(card)
    document.body.appendChild(ov)
    let picked = null
    const itemHtml = (t) => `
      <div data-tpl="${t.key}" style="border:1px solid var(--border);border-radius:8px;padding:10px;cursor:pointer;text-align:center;transition:border-color .15s">
        <div style="font-size:20px">${t.icon}</div>
        <div style="font-size:13px;margin:4px 0 2px">${t.name}</div>
        <div class="set-desc" style="font-size:11px">${t.desc}</div>
      </div>`
    card.querySelector('#dg-tpl-common').innerHTML = common.map(itemHtml).join('')
    card.querySelector('#dg-tpl-more').innerHTML = rest.map(itemHtml).join('')
    const markSel = () => {
      card.querySelectorAll('[data-tpl]').forEach((el) => {
        el.style.borderColor = el.dataset.tpl === picked ? 'var(--accent)' : 'var(--border)'
      })
    }
    card.querySelectorAll('[data-tpl]').forEach((el) => {
      el.onclick = () => { picked = el.dataset.tpl; markSel() }
      el.onmouseenter = () => { el.style.borderColor = 'var(--accent)' }
      el.onmouseleave = markSel
    })
    const close = () => { ov.remove(); reject(new Error('cancelled')) }
    card.querySelector('#dg-tpl-close').onclick = close
    ov.onclick = (e) => { if (e.target === ov) close() }
    card.querySelector('#dg-tpl-ok').onclick = () => {
      const title = card.querySelector('#dg-tpl-title').value.trim()
      if (!picked) return
      if (!title) { card.querySelector('#dg-tpl-title').focus(); card.querySelector('#dg-tpl-title').placeholder = '请先填写图示名称（必填）'; return }
      const tpl = DG_TEMPLATES.find((t) => t.key === picked)
      ov.remove()
      resolve({ key: tpl.key, name: tpl.name, title, code: tpl.code })
    }
    card.querySelector('#dg-tpl-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') card.querySelector('#dg-tpl-ok').click() })
  })
}

// ---------- 图示工作台绑定（从旧 renderer 迁移，#252 逻辑保留） ----------
let dgCurrentId = null
let dgRenderTimer = null
let dgLastError = null

function bindDiagramWorkbench(existing, pick) {
  dgCurrentId = existing?.id ?? null
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
  // #290：pick=模板弹窗选择结果——填充名称+示例代码，新草稿从这一刻开始
  $('dg-code').value = pick ? (pick.code ?? '') : (existing?.content ?? '')
  $('dg-title').value = pick ? pick.title : (existing?.title ?? '')
  // 从空态新建：显示标题框与保存/存书房/AI 按钮（打开已有图示时本就显示）
  const show = ['dg-save', 'dg-activate', 'dg-ai', 'dg-title']
  for (const id of show) { const el = $(id); if (el) el.style.display = '' }
  $('dg-state').textContent = pick ? `已选模板：${pick.name}——示例已填充，可编辑后保存` : existing?.state === 'draft' ? '📝 云端草稿' : existing?.state ? '📚 已存书房' : '新草稿'

  const render = async () => {
    const err = $('dg-err')
    const box = $('dg-preview')
    const src = $('dg-code').value
    const m = src.match(/```mermaid\n([\s\S]*?)```/)
    const code = (m ? m[1] : src).trim()
    if (!code) { box.innerHTML = '<span class="muted" style="font-size:12px">输入 mermaid 代码即时预览</span>'; return }
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
      const isNew = !dgCurrentId
      dgCurrentId = d.id
      $('dg-state').textContent = `✓ 已保存草稿 v${d.version}`
      // #291：保存后立刻刷新侧栏列表（新建首存/改名都不用再切功能回来）
      void renderList('diagram')
      if (isNew) $('dg-state').textContent += '（已加入左侧列表）'
    } else $('dg-state').textContent = '保存失败：' + (r.text || r.message)
  }
  $('dg-activate').onclick = async () => {
    if (!dgCurrentId) { $('dg-state').textContent = '先保存草稿'; return }
    const r = await window.moonlybox.rpc('diagram', { op: 'activate', id: dgCurrentId }, 60_000)
    if (r.event === 'done' && r.code === 0) {
      $('dg-state').textContent = '📚 已存进书房'
      void renderList('diagram') // #291：📝→📚 徽标即时更新
    } else $('dg-state').textContent = '准入失败：' + (r.text || r.message)
  }
  $('dg-ai').onclick = async () => {
    const prompt = window.prompt('描述你要画的图')
    if (!prompt?.trim()) return
    const aiBtn = $('dg-ai') // #283.11：await 期间面板可能重渲——持有引用而非事后 querySelector（重渲后为 null）
    aiBtn.disabled = true
    $('dg-state').textContent = '✨ AI 生成中…'
    const r = await window.moonlybox.rpc('diagram', { op: 'ai', prompt }, 150_000)
    aiBtn.disabled = false
    if (r.event === 'done' && r.code === 0) {
      $('dg-code').value = JSON.parse(r.text).source
      dgCurrentId = null
      $('dg-state').textContent = '✓ AI 已生成'
      render()
    } else $('dg-state').textContent = 'AI 生成失败：' + (r.text || r.message)
  }
}

// ---------- 小月会话列表与工作空间（#282） ----------
let xyActiveChat = null      // 当前打开的对话 id
let xyActiveWorkspace = null // 新建对话的默认归属（null=无工作空间）

async function renderXiaoyueList() {
  const box = $('xy-list')
  if (!box) return
  const rw = await window.moonlybox.rpc('workspace', { op: 'list' }, 10_000)
  const rc = await window.moonlybox.rpc('workspace', { op: 'chats' }, 10_000)
  const wss = rw.event === 'done' && rw.code === 0 ? JSON.parse(rw.text).workspaces : []
  const chats = rc.event === 'done' && rc.code === 0 ? JSON.parse(rc.text).chats : []
  box.innerHTML = ''
  const openChat = async (id, wsId) => {
    xyActiveChat = id
    xyActiveWorkspace = wsId
    box.querySelectorAll('.xy-chat.active').forEach((x) => x.classList.remove('active'))
    const el = box.querySelector(`[data-chat="${id}"]`)
    if (el) el.classList.add('active')
    await renderWork('xiaoyue', { chat: id })
  }
  const chatItem = (c, wsId) => {
    const el = document.createElement('div')
    el.className = 'tree-item xy-chat' + (c.id === xyActiveChat ? ' active' : '')
    el.style.paddingLeft = '26px'
    el.dataset.chat = c.id
    el.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.title}</span><span data-del="1" style="color:var(--muted);cursor:pointer;padding:0 4px">×</span>`
    el.onclick = (e) => { if (!e.target.dataset.del) openChat(c.id, wsId) }
    el.querySelector('[data-del]').onclick = async (e) => {
      e.stopPropagation()
      await window.moonlybox.rpc('workspace', { op: 'deleteChat', id: c.id }, 10_000)
      if (xyActiveChat === c.id) { xyActiveChat = null; await renderWork('xiaoyue') }
      await renderXiaoyueList()
    }
    return el
  }
  // 工作空间分组
  for (const ws of wss) {
    const group = document.createElement('div')
    group.className = 'xy-ws-group'
    group.innerHTML = `<div class="tree-item" style="font-weight:600"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ws.dirs.map((d, i) => (i === (ws.primaryIndex ?? 0) ? `【主】${d}` : d)).join('\n')}">📁 ${ws.name}</span><span class="xy-ws-chat" style="color:var(--muted);cursor:pointer;padding:0 4px" title="在此工作空间新建对话">💬＋</span><span class="xy-ws-add" style="color:var(--muted);cursor:pointer;padding:0 4px" title="增加工作目录">＋</span><span class="xy-ws-del" style="color:var(--muted);cursor:pointer;padding:0 4px" title="删除工作空间">×</span></div>`
    group.querySelector('.xy-ws-chat').onclick = async () => {
      const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: ws.id }, 15_000)
      if (r.event === 'done' && r.code === 0) {
        xyActiveChat = JSON.parse(r.text).chat.id
        xyActiveWorkspace = ws.id
        await renderWork('xiaoyue')
        await renderWork('xiaoyue', { chat: xyActiveChat })
        await renderXiaoyueList()
      }
    }
    group.querySelector('.xy-ws-add').onclick = async () => {
      const r = await window.moonlybox.pickFolder()
      const dir = r?.ok ? r.path : null
      if (!dir) return
      await window.moonlybox.rpc('workspace', { op: 'update', id: ws.id, addDir: dir }, 10_000)
      await renderXiaoyueList()
    }
    group.querySelector('.xy-ws-del').onclick = async () => {
      if (!window.confirm(`删除工作空间「${ws.name}」？其下对话将变为无工作空间对话（历史保留）。`)) return
      await window.moonlybox.rpc('workspace', { op: 'delete', id: ws.id }, 10_000)
      await renderXiaoyueList()
    }
    box.appendChild(group)
    for (const c of chats.filter((x) => x.workspaceId === ws.id)) box.appendChild(chatItem(c, ws.id))
    // 工作空间下新建对话
    const add = document.createElement('div')
    add.className = 'tree-item'
    add.style.paddingLeft = '26px'
    add.style.color = 'var(--muted)'
    add.textContent = '＋ 新对话'
    add.onclick = async () => {
      const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: ws.id }, 15_000)
      if (r.event === 'done' && r.code === 0) { xyActiveChat = JSON.parse(r.text).chat.id; xyActiveWorkspace = ws.id; await renderWork('xiaoyue'); await renderWork('xiaoyue', { chat: xyActiveChat }) }
    }
    box.appendChild(add)
  }
  // 无工作空间的「对话」分类
  const free = chats.filter((c) => !c.workspaceId)
  const freeGroup = document.createElement('div')
  freeGroup.className = 'xy-ws-group'
  freeGroup.innerHTML = `<div class="tree-item" style="font-weight:600">💬 对话<span class="set-desc" style="margin-left:6px;font-weight:400">无工作空间</span><span class="xy-free-add" style="color:var(--muted);cursor:pointer;padding:0 4px" title="新建无工作空间对话">＋</span></div>`
  box.appendChild(freeGroup)
  freeGroup.querySelector('.xy-free-add').onclick = async () => {
    const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: null }, 15_000)
    if (r.event === 'done' && r.code === 0) {
      xyActiveChat = JSON.parse(r.text).chat.id
      xyActiveWorkspace = null
      await renderWork('xiaoyue')
      await renderWork('xiaoyue', { chat: xyActiveChat })
      await renderXiaoyueList()
    }
  }
  for (const c of free) box.appendChild(chatItem(c, null))
}

function showWorkspaceDialog() {
  const dlg = document.createElement('dialog')
  dlg.innerHTML = `
    <div class="dlg-body" style="min-width:420px">
      <div class="sc-title" style="font-size:15px;font-weight:600;margin-bottom:12px">新建工作空间</div>
      <div class="set-field"><label>名称（必填）</label><input id="ws-name" placeholder="例：毕业论文" /></div>
      <div class="set-field"><label>工作目录（必选，可多个）</label>
        <div id="ws-dirs" style="margin:4px 0 6px;display:flex;flex-direction:column;gap:4px"></div>
        <button class="btn ghost" id="ws-add-dir">＋ 添加目录</button>
      </div>
      <div class="set-row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="ws-create">创建</button><button class="btn ghost" id="ws-cancel">取消</button></div>
      <div class="set-status" id="ws-status"></div>
    </div>`
  document.body.appendChild(dlg)
  dlg.showModal()
  const dirs = []
  let primaryIdx = 0
  // #282.2：目录独立行渲染——每行全路径+主目录标记+设主/删除按钮（主目录=fs 相对路径解析基准）
  const renderDirs = () => {
    const box = dlg.querySelector('#ws-dirs')
    box.innerHTML = ''
    if (!dirs.length) { box.innerHTML = '<div class="set-desc">尚未选择</div>'; return }
    dirs.forEach((d, i) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 6px;border:1px solid var(--border);border-radius:6px'
      const tag = i === primaryIdx ? '<span style="color:var(--accent);font-weight:600;flex-shrink:0">主</span>' : ''
      row.innerHTML = `${tag}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d}">${d}</span>`
      if (i !== primaryIdx) {
        const setMain = document.createElement('span')
        setMain.textContent = '设为主目录'
        setMain.style.cssText = 'color:var(--muted);cursor:pointer;flex-shrink:0'
        setMain.onclick = () => { primaryIdx = i; renderDirs() }
        row.appendChild(setMain)
      }
      const del = document.createElement('span')
      del.textContent = '×'
      del.style.cssText = 'color:var(--muted);cursor:pointer;padding:0 2px;flex-shrink:0'
      del.onclick = () => {
        dirs.splice(i, 1)
        if (primaryIdx === i) primaryIdx = 0
        else if (primaryIdx > i) primaryIdx--
        renderDirs()
      }
      row.appendChild(del)
      box.appendChild(row)
    })
  }
  dlg.querySelector('#ws-add-dir').onclick = async () => {
    const r = await window.moonlybox.pickFolder()
    const dir = r?.ok ? r.path : null
    if (!dir) return
    if (!dirs.includes(dir)) { dirs.push(dir); renderDirs() }
  }
  renderDirs()
  dlg.querySelector('#ws-cancel').onclick = () => dlg.close()
  dlg.querySelector('#ws-create').onclick = async () => {
    const name = dlg.querySelector('#ws-name').value.trim()
    const st = dlg.querySelector('#ws-status')
    if (!name) { st.className = 'set-status err'; st.textContent = '名称必填'; return }
    if (!dirs.length) { st.className = 'set-status err'; st.textContent = '至少选择一个工作目录'; return }
    const r = await window.moonlybox.rpc('workspace', { op: 'create', name, dirs, primaryIndex: primaryIdx }, 15_000)
    if (r.event === 'done' && r.code === 0) {
      dlg.close(); dlg.remove()
      await renderXiaoyueList() // #283.3：第二列会话列表刷新（原只重渲第三列工作台——新工作空间不出现）
      await renderWork('xiaoyue')
    } else { st.className = 'set-status err'; st.textContent = r.text || '创建失败' }
  }
}

// ---------- 小月对话绑定（从旧 renderer 迁移） ----------
let kernelEventBound = false
function bindChat(chatInfo) {
  const meta = chatInfo?.meta
  // #288 对话 UI：log() 升级为结构化消息渲染——行前缀分类（用户气泡/AI 气泡 Markdown/工具折叠条/思考折叠条/活动小字）。
  // daemon 协议不变（console.log 行级流），渲染分类全在 renderer 侧。
  const logEl = () => $('log')
  // 当前聚合态：连续相关行并入同一容器（AI 气泡 / 工具折叠 / 思考折叠）
  let cur = { type: null, el: null, text: '' }
  const scroll = () => { const el = logEl(); if (el) el.scrollTop = el.scrollHeight }
  const flushCur = () => {
    if (!cur.type || !cur.el) return
    if (cur.type === 'ai') setBubbleMarkdown(cur.el.querySelector('.msg-bubble'), cur.text)
    cur = { type: null, el: null, text: '' }
  }
  const addMsg = (role, text) => {
    flushCur() // 连续消息安全：先终稿上一个聚合容器（ai 气泡渲染最终 markdown）
    const wrap = document.createElement('div')
    wrap.className = `msg ${role}`
    const roleEl = document.createElement('div')
    roleEl.className = 'msg-role'
    roleEl.textContent = role === 'user' ? '你' : '小月'
    const bubble = document.createElement('div')
    bubble.className = 'msg-bubble'
    wrap.append(roleEl, bubble)
    logEl().appendChild(wrap)
    if (role === 'user') bubble.textContent = text
    else { cur = { type: 'ai', el: wrap, text } ; setBubbleMarkdown(bubble, text) }
    scroll()
    return bubble
  }
  const addFold = (summary, body, cls) => {
    const d = document.createElement('details')
    d.className = `chat-fold ${cls ?? ''}`
    const s = document.createElement('summary')
    s.textContent = summary
    const b = document.createElement('div')
    b.className = 'fold-body'
    if (body) b.textContent = body
    d.append(s, b)
    logEl().appendChild(d)
    scroll()
    return b
  }
  const addActLine = (text, indent) => {
    const el = document.createElement('div')
    el.className = 'chat-act-line' + (indent ? ' indent' : '')
    el.textContent = text
    logEl().appendChild(el)
    scroll()
  }
  const log = (t) => {
    const el = logEl()
    if (!el) return
    const line = String(t)
    // 分类规则（与 kernel 行形态一一对应）：
    if (line.startsWith('你> ')) {
      flushCur()
      addMsg('user', line.slice(3))
      return
    }
    if (line.startsWith('小月：')) {
      flushCur()
      // 终答（可能多行——payload 单条含 \n）
      addMsg('ai', line.slice(3))
      return
    }
    if (cur.type === 'ai' && line.trim()) {
      // AI 气泡的续行（answer 多行被 daemon 拆行时并入）
      cur.text += '\n' + line
      setBubbleMarkdown(cur.el.querySelector('.msg-bubble'), cur.text)
      scroll()
      return
    }
    if (line.startsWith('⚙ ')) {
      flushCur()
      const body = addFold(line, '', 'tool')
      cur = { type: 'tool', el: body, text: '' }
      return
    }
    if (/^（LLM 响应：/.test(line) || /^（已接入工具 /.test(line) || /^（本地/.test(line) || /^（云端/.test(line) || /^（上下文/.test(line)) {
      flushCur()
      const isThink = line.startsWith('（LLM 响应：')
      const body = addFold(isThink ? '💭 思考过程' : line.replace(/^（|）$/g, ''), line, 'think')
      cur = { type: 'think', el: body, text: line }
      return
    }
    if (/^  → |^  ✗ |^  （/.test(line) && (cur.type === 'tool' || cur.type === 'think')) {
      // 工具结果/子行并入折叠体
      cur.text += (cur.text ? '\n' : '') + line
      cur.el.textContent = cur.text
      scroll()
      return
    }
    if (line.startsWith('—— ')) {
      flushCur()
      const sep = document.createElement('div')
      sep.className = 'chat-act-line'
      sep.style.textAlign = 'center'
      sep.style.opacity = '.7'
      sep.textContent = line
      el.appendChild(sep)
      scroll()
      return
    }
    if (line.startsWith('[stderr] ')) {
      flushCur()
      const errEl = document.createElement('div')
      errEl.className = 'chat-err'
      errEl.textContent = '⚠ ' + line.slice(9)
      el.appendChild(errEl)
      scroll()
      return
    }
    // 普通过程行（（本地轨：...）/（工具调用 ...）等）
    flushCur()
    addActLine(line)
  }
  // #280.3：事件绑定只做一次——bindChat 每次进对话页都跑，重复 subscribe+onKernelEvent
  // 会让 main eventHooks 与 renderer 监听累加，同一 log 事件渲染 N 份（「装配行越聊越多」根因）
  if (!kernelEventBound) {
    window.moonlybox.subscribe()
    window.moonlybox.onKernelEvent((msg) => {
      if (msg.event === 'log') log(msg.payload)
      else if (msg.event === 'stderr') log('[stderr] ' + msg.payload)
      else if (msg.event === 'confirm_request') renderConfirmBar(msg.id, msg.payload)
    })
    kernelEventBound = true
  }
  async function ask() {
    const q = $('q').value.trim()
    if (!q) return
    $('q').value = ''
    const askBtn = $('btn-ask') // #283.11：await 最长 300s，期间切对话/切页重渲——持有引用，事后 querySelector 会是 null
    askBtn.disabled = true
    addMsg('user', q) // #288：用户消息直接走气泡（不再经行分类）
    // #269：工具（管家模式）归 MCP 分类——mcp.builtinEnabled 总闸；#282 chatId/workspaceId 随请求
    const tools = APP_SETTINGS?.mcp?.builtinEnabled !== false
    const payload = { q, chatId: meta?.id, workspaceId: meta ? (meta.workspaceId ?? null) : undefined }
    if (tools) payload.tools = true
    const r = await window.moonlybox.rpc('xiaoyue', payload, 300_000)
    askBtn.disabled = false
    // #283.4：回答只显示一路——过程行（含「小月：」终答）已经 kernel log 实时上屏，
    // done.text 是同一批行的整包（parts.join），再 log 一次＝回答重复两段。done 分支只报错误。
    if (!(r.event === 'done' && r.code === 0)) {
      flushCur()
      const errEl = document.createElement('div')
      errEl.className = 'chat-err'
      errEl.textContent = '⚠ ' + (r.message ?? r.text ?? '请求失败')
      logEl().appendChild(errEl)
      scroll()
    }
    flushCur()
    // 会话标题随首轮更新（列表刷新）
    if (meta && meta.title === '新对话') renderXiaoyueList()
  }
  $('btn-ask').onclick = ask
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask() })
  // #282：恢复历史轮次（#288：气泡形态）
  if (meta?.turns?.length) {
    const sep = document.createElement('div')
    sep.className = 'chat-act-line'
    sep.style.textAlign = 'center'
    sep.style.opacity = '.7'
    sep.textContent = `—— 历史对话（${meta.turns.length} 轮）——`
    logEl().appendChild(sep)
    for (const t of meta.turns.slice(-40)) addMsg(t.role === 'user' ? 'user' : 'ai', t.content)
    const sep2 = sep.cloneNode(true)
    sep2.textContent = '—— 以上为历史 ——'
    logEl().appendChild(sep2)
    scroll()
  }
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

// ---------- 对话 Markdown 渲染（#288：marked vendor+sanitize+mermaid 回填；图示页 mdToHtml 同逻辑全局化） ----------
function renderMarkdownSafe(src) {
  const mermaidBlocks = []
  const staged = src.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    mermaidBlocks.push(code)
    return `\n<!--MBMERMAID${mermaidBlocks.length - 1}-->\n`
  })
  let html = window.marked ? window.marked.parse(staged, { breaks: true, gfm: true }) : '<pre>' + staged.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>'
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('script,iframe,object,embed,link,meta').forEach((el) => el.remove())
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name)
    }
  })
  const out = tpl.innerHTML.replace(/<!--MBMERMAID(\d+)-->/g, (_m, i) => `<div class="mb-mermaid" data-mbcode="${encodeURIComponent(mermaidBlocks[Number(i)] ?? '')}"></div>`)
  // mermaid 回填（异步出图）
  requestAnimationFrame(() => {
    document.querySelectorAll('.mb-mermaid:not([data-mbdone])').forEach(async (el) => {
      el.dataset.mbdone = '1'
      const code = decodeURIComponent(el.dataset.mbcode ?? '')
      if (!code || !window.mermaid) return
      try {
        const id = 'mbm' + Math.random().toString(36).slice(2, 8)
        const svg = await window.mermaid.render(id, code)
        el.innerHTML = svg.svg || svg
      } catch (e) {
        el.textContent = '（图示渲染失败）'
      }
    })
  })
  return out
}
// 把纯文本（可能多行）按 Markdown 渲染进气泡
function setBubbleMarkdown(el, text) {
  el.innerHTML = renderMarkdownSafe(text)
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
    // #262：profile 拉到真实头像 → rail 主界面头像同步更新（修「面板有头像、rail 还是字母」不同步）
    applyRailAvatar(avatarUrl, d.email, true)
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
    btn.dataset.tip = `新版本 v${version} 后台下载中…`
  } else if (state === 'ready') {
    dot.style.display = 'block'; btn.classList.add('ready', 'active')
    text.textContent = '重启更新'
    btn.dataset.tip = `v${version} 已就绪，点击安装并重启`
  } else {
    dot.style.display = 'none'; btn.classList.remove('ready', 'active')
    text.textContent = ''
    btn.dataset.tip = '检查更新'
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

// #262：rail 头像渲染统一入口（panel/登录流/启动共用；profile 数据就手时直接喂，避免二次 RPC）
function applyRailAvatar(avatarUrl, email, loggedIn) {
  const btn = $('btn-avatar')
  if (!btn) return
  if (loggedIn && email) {
    if (avatarUrl) {
      btn.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer"/>`
    } else {
      btn.textContent = (email[0] ?? '?').toUpperCase()
    }
    // #266：动态状态走 data-tip（单例浮层），不写原生 title——否则与 data-tip 浮层双重提示
    btn.dataset.tip = `已登录：${email}`
  } else {
    btn.textContent = '未'
    btn.dataset.tip = '未登录（点击登录）'
  }
}

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
      applyRailAvatar(avatarUrl, d.email, true)
    } else {
      applyRailAvatar('', d.email, false)
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
