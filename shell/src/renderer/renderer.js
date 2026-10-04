/** renderer：#253 壳层重构——3 列布局（图标栏/功能列表/工作台）+ 标题栏 MDI 页帧 + 设置弹窗。 */
const $ = (id) => document.getElementById(id)
// #310.12.3：HTML 插值转义（Ollama 版本/模型名等外部数据进 innerHTML；#310.11 从云端搬 esc 未带定义——客户端此前无此工具）
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

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
  tasks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  xiaoyue: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
}
const navIconSvg = (nav, size = 18) => `<svg viewBox="0 0 24 24" style="width:${size}px;height:${size}px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${ICON_PATHS[nav] ?? ''}</svg>`
const NAVS = {
  vault: { label: 'nav.vault' },
  diagram: { label: 'nav.diagram' },
  cloud: { label: 'nav.cloud' },
  backup: { label: 'nav.backup' },
  tasks: { label: 'nav.tasks' },
  xiaoyue: { label: 'nav.xiaoyue' },
  help: { label: 'nav.help' },
  settings: { label: 'nav.settings' },
};  // 对象字面量后接 IIFE 必须分号（ASI 陷阱 #253.20）
let currentNav = null
// #317.MDI：小月持久面板当前会话（模块级——切功能页不销毁）
let xyPaneMeta = null
// #317.MDI/M2：后台完成未读集合（会话 id）——打开该对话即清除
const xyUnread = new Set()
// #317.MDI/M2：执行中会话集合（askWith 生命周期）
const xyRunning = new Set()
function xyActiveChatTitle() {
  return xyPaneMeta?.title ?? ''
}
// #317.MDI：页帧上下文名——默认 MDI 各功能销毁式重建时更新 tab 文案（「功能名 · 上下文」；无上下文=纯功能名）
const FRAME_CTX = {}
function setFrameTabCtx(nav, text) {
  const t0 = String(text ?? '').trim()
  if (t0) FRAME_CTX[nav] = t0
  else delete FRAME_CTX[nav]
  renderFrameTabs()
}
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
  { id: 'general', label: 'set.cat.general' },
  { id: 'appearance', label: 'set.cat.appearance' },
  { id: 'library', label: 'set.cat.library' },
  { id: 'chat', label: 'set.cat.chat' },
  { id: 'model', label: 'set.cat.model', subs: ['platform', 'custom', 'local'] }, // #310.2：平台API→自定义→本地部署
  { id: 'messaging', label: 'set.cat.messaging' },
  { id: 'mcp', label: 'set.cat.mcp', subs: ['builtin', 'custom'] }, // #321：MCP 市场移除（上下文占用对小模型不利，无必经 MCP 的推荐增强），销账
  { id: 'skills', label: 'set.cat.skills' },
  { id: 'websearch', label: 'set.cat.websearch' },
  { id: 'docproc', label: 'set.cat.docproc' },
  { id: 'memory', label: 'set.cat.memory' },
]
const SET_SUB_LABELS = { platform: 'set.sub.platform', local: 'set.sub.local', custom: 'set.sub.custom', builtin: 'set.sub.builtin' }
let currentHelpArg = 'about' // #310.5：帮助侧栏选中态跟踪（默认=关于）
let _dbgOn = null; let _dbgAt = 0
async function debugMirror() { // #310.7：调试开关缓存查询（#319.8：与调试页 UI 同源——settings 缺省时 dev=开/打包=关）
  if (_dbgOn !== null && Date.now() - _dbgAt < 10_000) return _dbgOn
  try {
    const [gs, env] = [await loadAppSettings(), await window.moonlybox.envInfo().catch(() => null)]
    const defOn = env ? !env.packaged : false
    _dbgOn = (gs.debug ?? {}).enabled === true || (gs.debug == null && defOn)
  } catch { _dbgOn = false }
  _dbgAt = Date.now()
  return _dbgOn
}
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
// ---------- #313 客户端 i18n 双语（zh 默认/en） ----------
// 键控字典：UI 高频标签全走 t()；t 读 APP_SETTINGS.appearance.lang（zh-CN→zh/en），未加载时按 navigator 回落。
const I18N_DICT = {
  'nav.vault': { zh: '书房（本地）', en: 'Study (Local)' },
  'nav.diagram': { zh: '图示', en: 'Diagrams' },
  'nav.cloud': { zh: '云端', en: 'Cloud' },
  'nav.backup': { zh: '备份', en: 'Backup' },
  'nav.tasks': { zh: '任务', en: 'Tasks' },
  'nav.xiaoyue': { zh: '小月', en: 'Moonie' },
  'nav.help': { zh: '帮助', en: 'Help' },
  'nav.settings': { zh: '设置', en: 'Settings' },
  'set.cat.general': { zh: '通用', en: 'General' },
  'set.cat.appearance': { zh: '外观', en: 'Appearance' },
  'set.cat.library': { zh: '文档库', en: 'Library' },
  'set.cat.chat': { zh: '对话', en: 'Chat' },
  'set.cat.model': { zh: '模型', en: 'Models' },
  'set.cat.messaging': { zh: '消息接入', en: 'Messaging' },
  'set.cat.mcp': { zh: 'MCP', en: 'MCP' },
  'set.cat.skills': { zh: '技能', en: 'Skills' },
  'set.cat.websearch': { zh: '网络搜索', en: 'Web Search' },
  'set.cat.docproc': { zh: '文档处理', en: 'Doc Processing' },
  'set.cat.memory': { zh: '记忆', en: 'Memory' },
  'cloud.nav.bookmarks': { zh: '收藏', en: 'Bookmarks' },
  'cloud.nav.tags': { zh: '标签', en: 'Tags' },
  'cloud.nav.stickies': { zh: '便签墙', en: 'Sticky Wall' },
  'cloud.nav.todos': { zh: '待办', en: 'Todos' },
  'cloud.nav.docs': { zh: '书房（云端）', en: 'Library (Cloud)' },
  'cloud.nav.entities': { zh: '记忆实体', en: 'Memory Entities' },
  'cloud.nav.moments': { zh: '动态', en: 'Moments' },
  'cloud.nav.square': { zh: '广场', en: 'Square' },
  'set.sub.platform': { zh: '平台 API', en: 'Platform API' },
  'set.sub.local': { zh: '本地部署', en: 'Local' },
  'set.sub.custom': { zh: '自定义', en: 'Custom' },
  'set.sub.builtin': { zh: '内置', en: 'Built-in' },
  'help.terms': { zh: '📜 条款', en: '📜 Terms' },
  'help.feedback': { zh: '📝 问题反馈', en: '📝 Feedback' },
  'help.debug': { zh: '🐞 调试', en: '🐞 Debug' },
  'help.cloudaddr': { zh: '🌐 官方网址', en: '🌐 Website' },
  'help.kernel': { zh: '🧠 内核状态', en: '🧠 Kernel' },
  'help.about': { zh: 'ℹ️ 关于', en: 'ℹ️ About' },
  'tree.expandAll': { zh: '全部展开', en: 'Expand all' },
  'tree.syncNow': { zh: '立即同步', en: 'Sync now' },
  'tree.syncing': { zh: '同步中…', en: 'Syncing…' },
  'tree.syncDone': { zh: '同步完成（补传/下行/索引已跑一轮）。', en: 'Sync complete (backfill / download / index refreshed).' },
  'tree.syncFail': { zh: '同步失败：', en: 'Sync failed: ' },
  'ui.saveFail': { zh: '保存失败', en: 'Save failed' },
  'ui.saving': { zh: '保存中…', en: 'Saving…' },
  'ui.saved': { zh: '✓ 已保存', en: '✓ Saved' },
  'ui.stop': { zh: '停用', en: 'Disable' },
  'ui.edit': { zh: '编辑', en: 'Edit' },
  'ui.untitled': { zh: '未命名', en: 'Untitled' },
  'ui.updateNow': { zh: '立即更新', en: 'Update Now' },
  'ui.checking': { zh: '检查中…', en: 'Checking…' },
  'ui.enable': { zh: '启用', en: 'Enable' },
  'panel.sub.general': { zh: '基础行为设置。更改即时生效。', en: 'Core behavior. Changes apply instantly.' },
  'panel.sub.appearance': { zh: '主题、语言与缩放。', en: 'Theme, language and zoom.' },
  'panel.sub.chat': { zh: '小月的上下文与重试行为。上下文仅存内存（本机），不落盘。', en: 'Moonie context and retry behavior. Context stays in memory only (this machine), never written to disk.' },
  'panel.sub.library': { zh: '本地书房目录与同步内核。目录是同步、检索、小月的单一数据源。', en: 'Local study directory and sync kernel. The directory is the single source for sync, search and Moonie.' },
  'panel.sub.model.platform': { zh: '每个平台可单独配置 API Key 与模型、单独启用/停用；任一实例可设为对话默认模型。Key 只存本机钥匙串，永不上传', en: 'Configure API key, model and on/off per platform; any instance can be the default chat model. Keys stay in the local keychain, never uploaded.' },
  'panel.sub.model.local': { zh: '连接本机已有的 Ollama 服务，模型数据不出本机；已装则直接复用，不重复安装。', en: 'Connect to a local Ollama service; data never leaves this machine. Reuses an existing install instead of reinstalling.' },
  'panel.sub.model.custom': { zh: '添加多个 OpenAI 兼容端点（Ollama / LM Studio / vLLM / 中转站 / 私有部署），每条可单独启用/停用，任一可设为对话默认。本地端点 Key 可留空。', en: 'Add multiple OpenAI-compatible endpoints (Ollama / LM Studio / vLLM / proxy / self-hosted); each can be toggled and set as default. Local endpoints need no key.' },
  'panel.sub.messaging': { zh: '对接 IM 平台，让你在小月里远程收发消息与操作。Token/Secret 只存本机钥匙串。', en: 'Connect IM platforms to chat with Moonie remotely. Tokens/secrets stay in the local keychain.' },
  'panel.sub.mcp.builtin': { zh: 'Model Context Protocol 服务器——给小月接入外部工具与数据源的标准协议。', en: 'Model Context Protocol servers — the standard way to give Moonie external tools and data sources.' },
  'panel.sub.mcp.custom': { zh: '添加自己的 MCP 服务器（Streamable HTTP）。', en: 'Add your own MCP servers (Streamable HTTP).' },
  'panel.sub.skills': { zh: '书房里的自定义技能：小月按需读取技能全文并照其中的流程执行。数据不出本机、随书房备份。', en: 'Custom skills in your study: Moonie reads and follows them on demand. Data stays local and backs up with the study.' },
  'panel.sub.websearch': { zh: '给小月接上搜索与网页提取能力（本质=服务商能力暴露给 Agent 的工具）。', en: 'Give Moonie web search and page extraction (provider capabilities exposed as agent tools).' },
  'panel.sub.docproc': { zh: 'PDF/Office/图片解析为文本：本地处理（离线引擎）或第三方云服务。', en: 'Parse PDF/Office/images to text: local (offline engine) or third-party cloud services.' },
  'panel.sub.memory': { zh: '持久记忆：小月跨会话记住关键信息。', en: 'Persistent memory: Moonie remembers key info across sessions.' },
  'panel.general': { zh: '通用', en: 'General' },
  'panel.appearance': { zh: '外观', en: 'Appearance' },
  'panel.library': { zh: '文档库（书房）', en: 'Library (Study)' },
  'panel.chat': { zh: '对话', en: 'Chat' },
  'panel.model.platform': { zh: '模型 · 平台 API', en: 'Models · Platform API' },
  'panel.model.custom': { zh: '模型 · 自定义', en: 'Models · Custom' },
  'panel.model.local': { zh: '模型 · 本地部署', en: 'Models · Local' },
  'panel.messaging': { zh: '消息接入', en: 'Messaging' },
  'panel.mcp.builtin': { zh: 'MCP · 内置', en: 'MCP · Built-in' },
  'panel.mcp.custom': { zh: 'MCP · 自定义', en: 'MCP · Custom' },
  'panel.skills': { zh: '技能', en: 'Skills' },
  'panel.websearch': { zh: '网络搜索', en: 'Web Search' },
  'panel.docproc': { zh: '文档处理', en: 'Doc Processing' },
  'panel.memory': { zh: '记忆', en: 'Memory' },
  'gen.launch': { zh: '开机启动', en: 'Launch at Login' },
  'gen.launch.desc': { zh: '登录系统后自动启动魔力宝盒（安装版生效）', en: 'Start MoonlyBox automatically after login (packaged build)' },
  'gen.minLaunch': { zh: '启动时最小化到托盘', en: 'Minimize to Tray on Launch' },
  'gen.minLaunch.desc': { zh: '开机/启动后不弹主窗口，仅在托盘待命', en: 'No main window on launch; stays in tray' },
  'gen.minClose': { zh: '关闭时最小化到托盘', en: 'Minimize to Tray on Close' },
  'gen.minClose.desc': { zh: '点关闭按钮时隐藏到托盘而非退出（托盘图标可退出）', en: 'Close button hides to tray instead of quitting (tray icon has Quit)' },
  'gen.awake': { zh: '运行任务时保持电脑唤醒', en: 'Keep Computer Awake on Tasks' },
  'gen.awake.desc': { zh: '小月执行任务期间阻止系统休眠', en: 'Prevent system sleep while Moonie runs tasks' },
  'gen.clip': { zh: '剪贴板自动采集', en: 'Clipboard Auto Capture' },
  'gen.clip.desc': { zh: '监听复制的文本/链接，存入收集箱；快捷键 Alt+Shift+C 可随时手动采集（不受此开关限制）', en: 'Watch copied text/links into Inbox; Alt+Shift+C always works manually' },
  'ap.theme': { zh: '色彩风格', en: 'Theme' },
  'ap.theme.sys': { zh: '跟随系统', en: 'System' },
  'ap.theme.light': { zh: '浅色', en: 'Light' },
  'ap.theme.dark': { zh: '深色', en: 'Dark' },
  'ap.theme.time': { zh: '跟随时间（18:00-06:00 深色）', en: 'By time (dark 18:00–06:00)' },
  'ap.lang': { zh: '语言', en: 'Language' },
  'ap.zoom': { zh: '缩放：', en: 'Zoom: ' },
  'chat.ctx': { zh: '启用上下文管理', en: 'Context Management' },
  'chat.compact': { zh: '上下文自动压缩', en: 'Auto Context Compaction' },
  'chat.defaultModel': { zh: '默认模型（小月对话/图示 AI 使用）', en: 'Default model (used by Moonie chat / diagram AI)' },
  'chat.unset': { zh: '— 未指定（回落已配置模型）—', en: '— Unset (fall back to configured model) —' },
  'chat.unsetHint': { zh: '未指定——按已配置模型回落', en: 'Unset — falls back to configured model' },
  'chat.setDefault': { zh: '✓ 已设为默认模型', en: '✓ Set as default model' },
  'lib.vault': { zh: '书房目录（Vault）', en: 'Study Directory (Vault)' },
  'lib.notChosen': { zh: '未选择', en: 'Not chosen' },
  'lib.migrateBtn': { zh: '📦 迁移到新目录…', en: '📦 Migrate to New Directory…' },
  'lib.compileTitle': { zh: '知识整理', en: 'Knowledge Compiling' },
  'lib.compileDesc': { zh: '把书房文档用本地模型整理成知识页（存入「知识页」目录），在对话里让小月批量整理即可创建任务。', en: 'Compile study documents into knowledge pages with your local model (saved under "Knowledge Pages"). Ask Moonie in chat to compile in bulk.' },
  'lib.compileModel': { zh: '整理所用模型', en: 'Compile model' },
  'lib.compileFollow': { zh: '跟随对话默认模型', en: 'Follow chat default model' },
  'lib.compileHint': { zh: '留空时按对话默认模型整理；本地模型推荐用于批量整理。', en: 'Leave empty to use the chat default model. Local models are recommended for bulk compiling.' },
  'lib.compileSync': { zh: '整理后的知识沉淀到云端', en: 'Persist compiled knowledge to the cloud' },
  'lib.compileSyncDesc': { zh: '整理完成后自动回传，先进「待准入」，在网页端确认后入书房。', en: 'Auto-push after compiling; lands in Pending review, then enters the study once approved on web.' },
  'lib.migrateTitle': { zh: '迁移书房目录', en: 'Migrate Study Directory' },
  'lib.migrateNew': { zh: '新目录（必须为空或不存在）', en: 'New directory (must be empty or not exist)' },
  'lib.migrateStart': { zh: '开始迁移', en: 'Start Migration' },
  'lib.migrating': { zh: '迁移中…（取决于书房大小，请勿关闭应用）', en: 'Migrating… (depends on study size; keep the app open)' },
  'lib.migrateFail': { zh: '迁移失败', en: 'Migration failed' },
  'lib.savedRestart': { zh: '✓ 已保存（内核重启后生效）', en: '✓ Saved (takes effect after kernel restart)' },
  'mp.name': { zh: '名称', en: 'Name' },
  'mp.model': { zh: '模型名', en: 'Model Name' },
  'mp.baseUrl': { zh: 'API 地址', en: 'API Base URL' },
  'mp.key': { zh: 'API Key（本地端点可留空）', en: 'API Key (leave empty for local endpoints)' },
  'mp.recommended': { zh: '— 推荐模型 —', en: '— Recommended models —' },
  'mp.required': { zh: '提供商与模型名必填', en: 'Provider and model name are required' },
  'mp.ollamaEg': { zh: '例：本地 Ollama', en: 'e.g. local Ollama' },
  'mp.noKey': { zh: ' · 未配置 Key', en: ' · No key configured' },
  'mp.default': { zh: '默认', en: 'Default' },
  'ol.detecting': { zh: '正在检测本机 Ollama…', en: 'Detecting local Ollama…' },
  'ol.detectFail': { zh: '检测失败', en: 'Detection failed' },
  'ol.pickFirst': { zh: '请先勾选模型', en: 'Select at least one model' },
  'ol.starting': { zh: '启动中…', en: 'Starting…' },
  'ol.startRetry': { zh: '启动失败，重试', en: 'Start failed, retry' },
  'dg.noModel': { zh: '未设模型', en: 'No model set' },
  'lib.notChosenParen': { zh: '（未选择）', en: '(not chosen)' },
  'ui.appliesInstant': { zh: '（即刻生效）', en: ' (applies instantly)' },
  'dg.tpl.flowchart': { zh: '流程图', en: 'Flowchart' },
  'dg.tpld.flowchart': { zh: '步骤流转 / 判断分支', en: 'Steps & branches' },
  'dg.tpl.sequence': { zh: '时序图', en: 'Sequence' },
  'dg.tpld.sequence': { zh: '模块间调用时序', en: 'Calls between modules' },
  'dg.tpl.mindmap': { zh: '思维导图', en: 'Mind Map' },
  'dg.tpld.mindmap': { zh: '主题发散 / 知识梳理', en: 'Topic branches / knowledge' },
  'dg.tpl.pie': { zh: '饼图', en: 'Pie Chart' },
  'dg.tpld.pie': { zh: '占比分布', en: 'Proportions' },
  'dg.tpl.gantt': { zh: '甘特图', en: 'Gantt' },
  'dg.tpld.gantt': { zh: '项目排期', en: 'Project schedule' },
  'dg.tpl.er': { zh: 'ER 图', en: 'ER Diagram' },
  'dg.tpld.er': { zh: '数据模型 / 实体关系', en: 'Data model / relations' },
  'dg.tpl.state': { zh: '状态图', en: 'State Diagram' },
  'dg.tpld.state': { zh: '状态机流转', en: 'State machine' },
  'dg.tpl.journey': { zh: '用户旅程', en: 'User Journey' },
  'dg.tpld.journey': { zh: '体验流程 / 满意度', en: 'Experience / satisfaction' },
  'dg.tpl.timeline': { zh: '时间线', en: 'Timeline' },
  'dg.tpld.timeline': { zh: '事件脉络', en: 'Event timeline' },
  'dg.tpl.quadrant': { zh: '象限图', en: 'Quadrant' },
  'dg.tpld.quadrant': { zh: '四象限分析', en: 'Quadrant analysis' },
  'dg.tpl.gitgraph': { zh: 'Git 图', en: 'Git Graph' },
  'dg.tpld.gitgraph': { zh: '分支策略', en: 'Branch strategy' },
  'dg.tpl.class': { zh: '类图', en: 'Class Diagram' },
  'dg.tpld.class': { zh: '类结构 / 继承关系', en: 'Class structure' },
  'dg.tpl.empty': { zh: '空图示', en: 'Blank' },
  'dg.tpld.empty': { zh: '从空白开始', en: 'Start from scratch' },  'dg.nameRequired': { zh: '请先填写图示名称（必填）', en: 'Diagram name is required' },
  'dg.pickedTpl': { zh: '已选模板', en: 'Selected template' },
  'dg.tplFilled': { zh: '示例已填充，可编辑后保存', en: 'Sample filled — edit and save' },
  'dg.draft': { zh: '📝 云端草稿', en: '📝 Cloud draft' },
  'dg.inStudy': { zh: '📚 已存书房', en: '📚 In Study' },
  'dg.newDraft': { zh: '新草稿', en: 'New draft' },
  'dg.quickTitle': { zh: '图示名称（必填）', en: 'Diagram name (required)' },
  'dg.quickOk': { zh: '创建并编辑', en: 'Create & Edit' },
  'dg.quickDesc': { zh: '选择图示类型，创建后自动填充该类型的示例代码，稍后可修改。', en: 'Pick a type — sample code is filled on create, editable later.' },
  'dg.untitled': { zh: '未命名图示', en: 'Untitled diagram' },
  'xy.prompts': { zh: '常用指令', en: 'Quick prompts' },
  'xy.p1': { zh: '整理我的收藏，对未打标签的收藏打上合适的标签', en: 'Organize my bookmarks: add suitable tags to untagged ones' },
  'xy.p2': { zh: '给没有描述的收藏补充描述', en: 'Fill in descriptions for bookmarks that have none' },
  'xy.p3': { zh: '新增一个备忘标签，标签内容：……', en: 'Create a memo tag, content: …' },
  'xy.p4': { zh: '新建一条待办，一周后到期，内容是……，项目是……，目标是……', en: 'New todo due in a week — what: …, project: …, goal: …' },
  'xy.p5': { zh: '帮我找关于……的收藏', en: 'Find my bookmarks about …' },
  'xy.historySep': { zh: '—— 以上为历史 ——', en: '—— history above ——' },
  'xy.thinking': { zh: '小月思考中…', en: 'Xiaoyue is thinking…' },
  'xy.retrying': { zh: '模型响应慢，重试 {n}/{total}（{err}）…', en: 'Model slow, retry {n}/{total} ({err})…' },
  'xy.phaseDigest': { zh: '正在整理工具结果…', en: 'Digesting tool results…' },
  'xy.phaseTools': { zh: '工具就绪，正在思考…', en: 'Tools ready — thinking…' },
  'xy.phaseToolRun': { zh: '正在执行工具…', en: 'Running tool…' },
  'xy.phaseModel': { zh: '模型已响应，继续处理…', en: 'Model responded — continuing…' },
  'xy.phasePrep': { zh: '正在准备上下文…', en: 'Preparing context…' },
  'xy.stop': { zh: '■ 停止', en: '■ Stop' },
  'xy.stopped': { zh: '已停止——后台任务完成后自动结束，本轮内容不再显示', en: 'Stopped — the background task will finish on its own; this turn is no longer shown' },
  'xy.retry': { zh: '重试', en: 'Retry' },
  'xy.createFail': { zh: '创建失败', en: 'Create failed' },
  'xy.wsNameReq': { zh: '名称必填', en: 'Name is required' },
  'xy.wsDirsReq': { zh: '至少选择一个工作目录', en: 'Pick at least one directory' },
  'xy.inWorkspace': { zh: '将在当前选中的工作空间下新建对话', en: 'New chat will be created in the selected workspace' },
  'xy.noWorkspace': { zh: '将新建无工作空间对话（无本地文件访问）', en: 'New chat without workspace (no local file access)' },
  'lib.draft': { zh: '草稿', en: 'Draft' },
  'lib.inStudy': { zh: '已存书房', en: 'In Study' },
  'lib.unknownType': { zh: '未知类型', en: 'Unknown' },
  'lib.delFail': { zh: '删除失败：', en: 'Delete failed: ' },
  'lib.setPrimary': { zh: '设为主目录', en: 'Set Primary' },
  'lib.addedTip': { zh: '（已加入左侧列表）', en: '(added to the list)' },
  'ui.cancel': { zh: '取消', en: 'Cancel' },
  'ui.confirm': { zh: '确认', en: 'OK' },
  'ui.install': { zh: '安装', en: 'Install' },
  'ui.latest': { zh: '已是最新版本', en: 'Up to date' },
  'ui.checkUpdate': { zh: '检查更新', en: 'Check for Updates' },
  'ui.updating': { zh: '更新中', en: 'Updating' },
  'ui.restartUpdate': { zh: '重启更新', en: 'Restart to Update' },
  'ui.notLogin': { zh: '未登录（点击登录）', en: 'Not signed in (click to sign in)' },
  'ui.reqFail': { zh: '请求失败', en: 'Request failed' },
  'help.debugMode': { zh: '调试模式', en: 'Debug Mode' },
  'help.debugMode.desc': { zh: '开启后内核输出全量镜像到日志文件（mb-debug.log）；', en: 'Mirror full kernel output to log file (mb-debug.log); ' },
  'help.debugLog': { zh: '调试日志 / 诊断包', en: 'Debug Log / Diagnostics' },
  'help.debugLog.desc': { zh: '打开日志目录：mb-debug.log（调试日志）与系统信息；反馈问题时可整目录打包附上', en: 'Open log folder: mb-debug.log (debug log) and system info; attach the whole folder when reporting issues' },
  'help.openLogs': { zh: '打开日志目录', en: 'Open Log Folder' },
  'help.envInfo': { zh: '环境信息', en: 'Environment' },
  'help.envPlatform': { zh: '平台', en: 'Platform' },
  'help.envPkg': { zh: '安装包', en: 'Packaged' },
  'help.envLocale': { zh: '语言', en: 'Language' },
  'help.yes': { zh: '是', en: 'Yes' },
  'help.noDevMode': { zh: '否（开发模式）', en: 'No (dev mode)' },
  'help.openFail': { zh: '打开失败：', en: 'Open failed: ' },
  'help.devDefault': { zh: '开发模式默认开启', en: 'on by default in dev' },
  'help.pkgDefault': { zh: '安装包默认关闭', en: 'off by default in packaged builds' },
  'help.site': { zh: '魔力宝盒官网', en: 'MoonlyBox Website' },
  'help.copy': { zh: '复制', en: 'Copy' },
  'help.copied': { zh: '已复制', en: 'Copied' },
  'help.site.open': { zh: '打开官网', en: 'Open Website' },
  'help.site.copyAddr': { zh: '复制网址', en: 'Copy URL' },
  'help.kernelOk': { zh: '✓ 已连接（daemon pong）', en: '✓ Connected (daemon pong)' },
  'help.kernelDown': { zh: '未连接', en: 'Not connected' },
  'help.kernelPick': { zh: '选择左侧项目开始', en: 'Select an item to begin' },
  'help.kernelFrame': { zh: '内核状态', en: 'Kernel' },
  'help.kernelCard': { zh: '同步内核', en: 'Sync Kernel' },
  'help.kernelCard.desc': { zh: '本地书房的同步/检索/小月服务进程', en: 'Service process for study sync, search and Moonie' },
  'help.vaultCard': { zh: '书房目录', en: 'Study Folder' },
  'help.vaultCard.desc': { zh: '同步、检索与小月的单一数据源', en: 'Single source of truth for sync, search and Moonie' },
  'help.vaultNone': { zh: '未选择', en: 'Not selected' },
  'about.name': { zh: '魔力宝盒', en: 'MoonlyBox' },
  'about.slogan': { zh: '你的智能信息管家 · 收藏、便签、待办、书房与小月，一盒皆收', en: 'Your smart info butler · bookmarks, notes, todos, study and Moonie in one box' },
  'about.autoUpdate': { zh: '自动更新', en: 'Auto Update' },
  'about.autoUpdate.desc': { zh: '关闭后仅在打开本页点击「立即更新」时检查', en: 'When off, checks only when you click "Update Now" on this page' },
  'about.notes': { zh: '当前版本说明', en: 'Release Notes' },
  'about.notesDefault': { zh: '稳定性修复与细节优化。', en: 'Stability fixes and polish.' },
  'about.env': { zh: '环境：', en: 'Environment: ' },
  'about.newVer': { zh: '发现新版本', en: 'New Version Available' },
  'about.installAsk': { zh: '已就绪，安装并重启？', en: 'is ready. Install and restart?' },
  'dg.saveFirst': { zh: '先保存草稿', en: 'Save draft first' },
  'dg.admitFail': { zh: '准入失败：', en: 'Admission failed: ' },
  'dg.aiPrompt': { zh: '描述你要画的图', en: 'Describe the diagram to draw' },
  'dg.aiDone': { zh: '✓ AI 已生成', en: '✓ AI generated' },
  'dg.aiFail': { zh: 'AI 生成失败：', en: 'AI generation failed: ' },
  'dg.saveFail': { zh: '保存失败：', en: 'Save failed: ' },
  'xy.pickFirst': { zh: '先在左侧选择或新建对话', en: 'Pick or create a chat on the left first' },
  'xy.qPlaceholder': { zh: '问小月（工作空间内可读写文件）…', en: 'Ask Moonie (can read/write files in workspaces)…' },
  'xy.docOnly': { zh: '问小月（文档库/MCP，无本地目录访问）…', en: 'Ask Moonie (library/MCP, no local file access)…' },  'list.settings': { zh: '设置', en: 'Settings' },
  'list.vaultNotChosen': { zh: '未选择书房目录<br/>请到 设置 → Vault 目录 选择', en: 'No study folder selected<br/>Go to Settings → Vault Folder to choose one' },
  'tree.collapseAll': { zh: '全部收起', en: 'Collapse All' },
  'tree.isExpanded': { zh: '全部展开', en: 'Expand All' },
  'list.backup': { zh: '备份', en: 'Backup' },

  'tk.empty': { zh: '暂无任务——在对话里让小月整理文档即创建', en: 'No tasks yet — ask Moonie in chat to compile docs' },
  'tk.pickHint': { zh: '左侧选择任务查看详情。', en: 'Select a task on the left for details.' },
  'tk.startedAt': { zh: '启动于', en: 'Started at' },
  'tk.pagesTab': { zh: '知识页', en: 'Knowledge pages' },
  'tk.tabItems': { zh: '任务清单', en: 'Items' },
  'tk.tabPages': { zh: '产物', en: 'Outputs' },
  'tk.pagesEmpty': { zh: '暂无本地知识页产物。', en: 'No local knowledge pages yet.' },
  'tk.cloudNoPages': { zh: '对云端资源进行整理，无本地产物。', en: 'Cloud resources were organized; no local outputs.' },
  'tk.cloudItem': { zh: '收藏 #{n}', en: 'Bookmark #{n}' },
  'dir.noReadme': { zh: '此目录暂无 README.md 说明。', en: 'No README.md in this directory.' },
  'ui.ok': { zh: '确定', en: 'OK' },
  'lib.backfillDone': { zh: '补传完成：扫描 {s} 篇，成功 {p} 篇', en: 'Backfill done: {s} scanned, {p} pushed' },
  'lib.backfillNone': { zh: '没有可补传的产物', en: 'Nothing to backfill' },
  'lib.syncDownDone': { zh: '下行更新 {n} 篇', en: '{n} doc(s) pulled' },
  'lib.syncDownFail': { zh: '下行对账失败', en: 'Down-sync failed' },
  'lib.syncMarked': { zh: '{n} 篇已确认同步', en: '{n} doc(s) confirmed synced' },
  'lib.recompile': { zh: '重新整理', en: 'Recompile' },
  'lib.recompileQueued': { zh: '已创建重新整理任务：{t}', en: 'Recompile task queued: {t}' },
  'tk.delThis': { zh: '删除此文件', en: 'Delete this file' },
  'tk.selectAll': { zh: '全选', en: 'Select all' },
  'tk.delSelected': { zh: '删除所选', en: 'Delete selected' },
  'tk.delConfirm': { zh: '确认删除所选 {n} 个知识页文件？对应源文档将重新视为「未整理」（可再次整理）。', en: 'Delete {n} local knowledge page files? Their sources become uncompiled again (can be recompiled).' },
  'tk.delDone': { zh: '已删除 {d} 个文件，{r} 个源文档已重置为未整理。', en: 'Deleted {d} files; {r} sources reset to uncompiled.' },
  'tk.jobDel': { zh: '删除任务', en: 'Delete Task' },
  'tk.jobDelConfirm': { zh: '删除任务「{t}」？\n已生成的知识页产物会保留在书房，仅删除任务记录。', en: 'Delete task "{t}"?\nGenerated knowledge pages stay in the study; only the task record is removed.' },
  'tk.pgPending': { zh: '已回传待准入', en: 'pending review' },
  'tk.pgSynced': { zh: '已同步云端', en: 'Synced' },
  'tk.pgMissing': { zh: '文件已不在', en: 'file missing' },
  'tk.willUse': { zh: '将使用：', en: 'Will use: ' },
  'tk.changeModel': { zh: '更改', en: 'Change' },
  'tk.cancel': { zh: '取消任务', en: 'Cancel' },
  'tk.stQueued': { zh: '排队中', en: 'Queued' },
  'tk.stRunning': { zh: '执行中', en: 'Running' },
  'tk.stDone': { zh: '已完成', en: 'Completed' },
  'tk.stFail': { zh: '失败', en: 'Failed' },
  'tk.stCancel': { zh: '已取消', en: 'Cancelled' },
  'tk.iPending': { zh: '等待', en: 'Pending' },
  'tk.iRunning': { zh: '整理中', en: 'Compiling' },
  'tk.iDone': { zh: '完成', en: 'Done' },
  'tk.iFail': { zh: '失败', en: 'Failed' },
  'tk.iSkip': { zh: '跳过', en: 'Skipped' },
  'tk.iCancel': { zh: '已取消', en: 'Cancelled' },  'ui.new': { zh: '＋ 新建', en: '＋ New' },
  'list.loading': { zh: '加载中…', en: 'Loading…' },
  'list.bkEmpty': { zh: '还没有备份目录<br/>点右上「＋ 新建」注册一个本地目录，<br/>把它同步到云端书房的指定目录下。', en: 'No backup folders yet<br/>Click "＋ New" (top right) to register a local folder,<br/>and sync it into a folder in your cloud study.' },
  'bk.holdN': { zh: ' 项已停更', en: ' items on hold' },
  'list.loadFail': { zh: '加载失败', en: 'Load failed' },
  'list.navLoadFail': { zh: '导航加载失败：', en: 'Failed to load navigation: ' },
  'list.navParseFail': { zh: '导航解析失败（登录后可用）', en: 'Failed to parse navigation (sign in first)' },
  'dg.newBtn': { zh: '＋ 新建图示', en: '＋ New Diagram' },
  'dg.more': { zh: '更多', en: 'More' },
  'dg.delItem': { zh: '删除', en: 'Delete' },
  'dg.delConfirm': { zh: '删除图示「{t}」？将移入回收站（30 天内可在云端书房恢复）。', en: 'Delete diagram "{t}"? It moves to trash (restorable in cloud study for 30 days).' },
  'dg.none': { zh: '暂无图示', en: 'No diagrams' },
  'dg.listFail': { zh: '列表加载失败（登录后可用）', en: 'Failed to load list (sign in first)' },
  'xy.newWs': { zh: '＋ 工作空间', en: '＋ Workspace' },
  'xy.newChat': { zh: '＋ 对话', en: '＋ Chat' },
  'xy.delMenu': { zh: '删除', en: 'Delete' },
  'xy.delChatConfirm': { zh: '删除对话「{t}」？', en: 'Delete chat "{t}"?' },
  'xy.freeGroup': { zh: '💬 对话', en: '💬 Chats' },
  'xy.noWs': { zh: '无工作空间', en: 'No workspace' },
  'xy.freeAddTip': { zh: '新建无工作空间对话', en: 'New chat without workspace' },
  'xy.wsAddTip': { zh: '在此工作空间新建对话', en: 'New chat in this workspace' },
  'xy.addDir': { zh: '增加工作目录', en: 'Add Work Folder' },
  'xy.delWsConfirm': { zh: '删除工作空间「{t}」？其下对话将变为无工作空间对话（历史保留）。', en: 'Delete workspace "{t}"? Its chats become workspace-free (history kept).' },
  'xy.newWsTitle': { zh: '新建工作空间', en: 'New Workspace' },
  'xy.wsName': { zh: '名称（必填）', en: 'Name (required)' },
  'xy.wsNamePh': { zh: '例：毕业论文', en: 'e.g. Thesis' },
  'xy.wsDirs': { zh: '工作目录（必选，可多个）', en: 'Work folders (required, multiple allowed)' },
  'xy.addDirBtn': { zh: '＋ 添加目录', en: '＋ Add Folder' },
  'xy.create': { zh: '创建', en: 'Create' },
  'xy.primary': { zh: '主', en: 'Main' },
  'chat.ctxDesc': { zh: '小月记住本次会话中的对话', en: 'What Moonie remembers within this session' },
  'chat.compactDesc': { zh: '历史过长时自动摘要，节省 token', en: 'Auto-summarize long history to save tokens' },
  'chat.ctLabel': { zh: '压缩阈值（历史达到容量的比例时触发）：', en: 'Compact threshold (trigger at this share of capacity): ' },
  'chat.cgLabel': { zh: '压缩目标（压缩后保留的容量）：', en: 'Compact target (capacity kept after compact): ' },
  'chat.retryOn': { zh: '模型超时重试', en: 'Retry on Timeout/Failure' },
  'chat.retryOnDesc': { zh: '模型调用失败/超时后自动重试', en: 'Auto-retry when a model call fails or times out' },
  'chat.retryLabel': { zh: '重试次数', en: 'Retry count' },
  'mp.groupCloud': { zh: '平台 API', en: 'Platform APIs' },
  'mp.groupCustom': { zh: '自定义', en: 'Custom' },
  'mp.groupLocal': { zh: '本地部署', en: 'Local' },
  'mp.wxHint': { zh: '（只存钥匙串）', en: ' (stored in keychain only)' },
  'mp.keyDocs': { zh: 'API Key 获取：', en: 'Get API key: ' },
  'mp.addPv': { zh: '＋ 添加平台', en: '＋ Add Platform' },
  'mp.pvLabel': { zh: '平台提供商', en: 'Platform provider' },
  'mp.pickPv': { zh: '— 选择提供商 —', en: '— Pick a provider —' },
  'mp.pickModel': { zh: '— 推荐模型 —', en: '— Recommended models —' },
  'mp.save': { zh: '保存', en: 'Save' },
  'mp.cancel': { zh: '取消', en: 'Cancel' },
  'mp.emptyPv': { zh: '尚未添加平台——点「＋ 添加平台」接入第一个模型服务', en: 'No platforms yet — click "＋ Add Platform" to connect your first model service' },
  'mp.setDefault': { zh: '设为默认', en: 'Set Default' },
  'mp.del': { zh: '删除', en: 'Delete' },
  'mp.addCustom': { zh: '＋ 添加自定义模型', en: '＋ Add Custom Model' },
  'mp.baseUrlAuto': { zh: 'API 地址（自动填入）', en: 'API URL (auto-filled)' },
  'mp.customEmpty': { zh: '尚未添加自定义模型', en: 'No custom models yet' },
  'mp.reqBoth': { zh: 'API 地址与模型名必填', en: 'API URL and model name are required' },
  'mp.urlScheme': { zh: 'API 地址需以 http(s):// 开头', en: 'API URL must start with http(s)://' },
  'mp.customName': { zh: '自定义模型', en: 'Custom Model' },
  'msg.gateway': { zh: '启动网关', en: 'Start Gateway' },
  'msg.starting': { zh: '启动中…', en: 'Starting…' },
  'msg.runningN': { zh: '运行中：', en: 'Running: ' },
  'msg.noneEnabled': { zh: '无已启用平台', en: 'No enabled platforms' },
  'msg.startFail': { zh: '启动失败：', en: 'Start failed: ' },
  'msg.qrWait': { zh: '等待扫码…', en: 'Waiting for scan…' },
  'msg.qrScanned': { zh: '已扫码，请在微信里确认…', en: 'Scanned — confirm in WeChat…' },
  'msg.qrExpired': { zh: '✗ 二维码已过期，请重新点击扫码登录', en: '✗ QR expired — click scan login again' },
  'msg.qrGet': { zh: '获取二维码…', en: 'Getting QR code…' },
  'msg.qrGetFail': { zh: '获取二维码失败', en: 'Failed to get QR code' },
  'msg.qrHint': { zh: '请用微信扫描上方二维码（有效期约 5 分钟）…', en: 'Scan the QR above with WeChat (valid ~5 minutes)…' },
  'msg.loginOk': { zh: '登录成功', en: 'Signed in' },
  'msg.tokenKept': { zh: '——Token 已存钥匙串，可直接启动网关', en: ' — token stored in keychain; you can start the gateway now' },
  'msg.queryFail': { zh: '查询失败', en: 'Query failed' },
  'msg.notStarted': { zh: '未启动', en: 'Not started' },
  'ws.title': { zh: '搜索服务商', en: 'Search Provider' },
  'ws.pvLabel': { zh: '服务商', en: 'Provider' },
  'ws.none': { zh: '— 未启用 —', en: '— Disabled —' },
  'ue.title': { zh: 'URL 提取（收藏网页正文）', en: 'URL Extraction (web page content)' },
  'ue.modeLabel': { zh: '提取方式', en: 'Extraction Mode' },
  'ue.local': { zh: '本地提取（内置 Readability，零成本）', en: 'Local (built-in Readability, free)' },
  'ue.provider': { zh: '服务商 API（质量更高）', en: 'Provider API (higher quality)' },
  'ue.baseUrlAuto': { zh: 'API 地址（选商自动填）', en: 'API URL (auto-filled per provider)' },
  'ue.localDesc': { zh: '本地提取：内置 Readability 算法在本机解析正文，零流量零成本。', en: 'Local extraction: built-in Readability parses content on this machine — no traffic, no cost.' },
  'dp.pvLabel': { zh: '处理方式与服务商', en: 'Processing & Provider' },
  'dp.localGroup': { zh: '本地处理', en: 'Local' },
  'dp.cloudGroup': { zh: '第三方服务', en: 'Third-party Services' },
  'dp.prov.builtin': { zh: '内置解析（纯文本/PDF 文本层，无需网络）', en: 'Built-in parser (plain text / PDF text layer, offline)' },
  'dp.prov.winocr': { zh: 'Windows OCR（系统自带，离线）', en: 'Windows OCR (system, offline)' },
  'dp.prov.paddle': { zh: 'PaddleOCR（本地服务）', en: 'PaddleOCR (local service)' },
  'dp.baseUrlAuto': { zh: 'API 地址（选商自动填）', en: 'API URL (auto-filled per provider)' },
  'mm.enable': { zh: '启用持久记忆', en: 'Persistent Memory' },
  'mm.enableDesc': { zh: '对话中的关键事实自动沉淀到本机记忆层，跨会话可 recall', en: 'Key facts from chats settle into local memory, recallable across sessions' },
  'mm.sync': { zh: '同步到月忆', en: 'Sync to Memories' },
  'mm.syncDesc': { zh: '本机沉淀的记忆条目同时上行到云端月忆候选池，你确认后才进入云端正式记忆（跨设备可用）', en: 'Local memory entries also upload to the cloud candidate pool; they enter cloud Memories only after your confirmation (cross-device)' },
  'mm.modeLabel': { zh: '记忆模式', en: 'Memory Mode' },
  'mm.modeBuiltin': { zh: '本机内置 + 月忆（MoonRecall）增强', en: 'Local built-in + Memories (MoonRecall) enhanced' },
  'mm.modeDesc': { zh: '本机记忆层恒在（MEMORY.md/USER.md，明文可编辑、不出本机），月忆作为云端增强跨设备可用。', en: 'Local memory is always on (MEMORY.md/USER.md, plain-text, stays on this device); cloud Memories add cross-device access.' },
  'mm.limitLabel': { zh: '记忆注入上限（字符）', en: 'Memory injection limit (chars)' },
  'mm.limitDesc': { zh: '每次对话注入小月的记忆上下文上限，超出按新旧保留截断。默认 5000。', en: 'Max memory context injected per chat; overflow trimmed oldest-first. Default 5000.' },
  'mm.candidate': { zh: '云端候选池', en: 'Cloud Candidate Pool' },
  'mm.candidateDesc': { zh: '对话沉淀的候选记忆（含重复命中的合并建议）在此确认后进入云端正式记忆；未登录或未开启同步时为空。', en: 'Candidate memories from chats (with merge suggestions on duplicates) await confirmation here; empty when signed out or sync is off.' },
  'mm.loading': { zh: '加载中…', en: 'Loading…' },
  'mm.loadFail': { zh: '加载失败', en: 'Load failed' },
  'mm.empty': { zh: '候选池为空——对话中沉淀的候选记忆会出现在这里，确认后进入云端正式记忆。', en: 'No candidates — memories distilled from chats appear here and enter cloud memory after confirmation.' },
  'mm.pending': { zh: ' 条待确认', en: ' pending' },
  'mm.mergeSugg': { zh: '合并建议：', en: 'Merge suggestions: ' },
  'mm.confirm': { zh: '确认', en: 'Confirm' },
  'mm.drop': { zh: '丢弃', en: 'Drop' },
  'mm.allDone': { zh: '已全部处理完 ✓', en: 'All done ✓' },
  'mm.opFail': { zh: '操作失败', en: 'Operation failed' },
  'mm.catDesc': { zh: '此分类的配置项随功能开启逐步展示。', en: 'Settings for this category appear as features roll out.' },
  'bk.newTitle': { zh: '新建备份目录', en: 'New Backup Folder' },
  'bk.newDesc': { zh: '把一个本地文件夹持续备份到云端书房的指定目录（归属目录）下。', en: 'Continuously back up a local folder into a chosen cloud study folder.' },
  'bk.formats': { zh: '可识别的文件格式：.md、.txt 文本文件', en: 'Recognized formats: .md and .txt text files' },
  'bk.uploadOnly': { zh: '备份只上传、不改动本地文件；文件内容未变化时自动跳过。', en: 'Backup only uploads and never modifies local files; unchanged content is skipped automatically.' },
  'bk.localDir': { zh: '本地目录', en: 'Local Folder' },
  'bk.notChosen': { zh: '未选择', en: 'Not chosen' },
  'bk.pick': { zh: '选择…', en: 'Browse…' },
  'bk.targetDir': { zh: '云端归属目录（同步目标）', en: 'Cloud Target Folder (sync destination)' },
  'bk.skipNote': { zh: '（其它格式自动跳过）', en: ' (other formats are skipped automatically)' },
  'bk.rootDir': { zh: '书房根目录', en: 'Study root' },
  'bk.pickFirst': { zh: '先选择本地目录', en: 'Choose a local folder first' },
  'bk.checking': { zh: '检查云端同名文件…', en: 'Checking cloud for same-name files…' },
  'bk.preFail': { zh: '预检失败：', en: 'Pre-check failed: ' },
  'bk.preFailShort': { zh: '预检失败', en: 'Pre-check failed' },
  'bk.foundN': { zh: '发现 {n} 个同名文件', en: 'Found {n} same-name file(s)' },
  'bk.claimDesc': { zh: '云端归属目录中已存在同名文档。若这是<b>重装/换机后的认领</b>（本机就是这些文件的原始作者，且<b>确保没有其他电脑同时在同步这些文件</b>），可选择覆盖认领；否则请选重命名上传（保留双方）。', en: 'Same-name documents already exist in the cloud folder. If this is a <b>claim after reinstall/new machine</b> (this machine is the original author and <b>no other computer is syncing these files</b>), you may claim and overwrite; otherwise choose rename-upload (keep both).' },
  'bk.claimBtn': { zh: '覆盖认领（重装机）', en: 'Claim & Overwrite (reinstall)' },
  'bk.renameBtn': { zh: '重命名上传（推荐）', en: 'Rename Upload (recommended)' },
  'bk.registering': { zh: '注册中…', en: 'Registering…' },
  'bk.regFail': { zh: '注册失败', en: 'Registration failed' },
  'bk.registered': { zh: '已注册，首次同步中…', en: 'Registered — first sync running…' },
  'bk.notExist': { zh: '备份目录不存在', en: 'Backup folder does not exist' },
  'bk.targetCard': { zh: '云端归属目录', en: 'Cloud Target Folder' },
  'bk.enableCard': { zh: '启用备份', en: 'Enable Backup' },
  'bk.enableDesc': { zh: '停用后此目录不再参与同步（已上传内容保留在云端）', en: 'When off, this folder stops syncing (uploaded content stays in cloud)' },
  'bk.onDeleteCard': { zh: '云端删除后', en: 'After Cloud Deletion' },
  'bk.onDeleteDesc': { zh: '网页端删除此备份上传的文档后，下次同步的行为', en: 'What happens on next sync after the web app deletes an uploaded document' },
  'bk.resync': { zh: '重新上传', en: 'Re-upload' },
  'bk.keep': { zh: '不再同步', en: 'Stop syncing' },
  'bk.dupCard': { zh: '同名策略', en: 'Same-name Policy' },
  'bk.dupDesc': { zh: '云端已有同名文档时重命名上传（重装认领走新建时的「同名认领」一次性确认，不在此列）', en: 'Same-name cloud documents get renamed on upload (reinstall claims use the one-time "same-name claim" prompt at creation, not here)' },
  'bk.dupRename': { zh: '重命名上传（保留双方）', en: 'Rename Upload (keep both)' },
  'bk.lastSync': { zh: '上次同步', en: 'Last Sync' },
  'bk.neverSync': { zh: '从未同步', en: 'Never synced' },
  'bk.syncNow': { zh: '立即同步', en: 'Sync Now' },
  'bk.delSelf': { zh: '删除此备份目录', en: 'Remove this Backup Folder' },
  'bk.upN': { zh: '上传 {n}', en: 'Uploaded {n}' },
  'bk.updN': { zh: '更新 {n}', en: 'Updated {n}' },
  'bk.skipN': { zh: '跳过 {n}', en: 'Skipped {n}' },
  'bk.cloudDelN': { zh: '云端删除感知 {n}', en: 'Cloud deletions detected {n}' },
  'bk.cloudUpdN': { zh: '云端更新采纳 {n}', en: 'Cloud updates adopted {n}' },
  'bk.conflictN': { zh: '需处理 {n}', en: 'Needs attention {n}' },
  'bk.doneJoin': { zh: '同步完成：', en: 'Sync done: ' },
  'bk.doneJoin2': { zh: '完成：', en: 'Done: ' },
  'bk.syncing': { zh: '同步中…', en: 'Syncing…' },
  'bk.syncFail': { zh: '同步失败', en: 'Sync failed' },
  'ui.joinComma': { zh: '，', en: ', ' },
  'ap.langZh': { zh: '中文简体', en: '中文简体' },
  'lib.migrateNow': { zh: '当前：', en: 'Current: ' },
  'lib.migrateDesc2': { zh: '迁移会把当前书房的<b>全部内容</b>复制到新目录，完成后自动切换并重启内核；原目录保留不动（作为迁移前备份）。', en: 'Migration copies <b>everything</b> in the current study to the new folder, then switches and restarts the kernel; the old folder stays untouched as a backup.' },
  'lib.migPick': { zh: '点击右侧选择…', en: 'Pick via the button…' },
  'lib.migChoose': { zh: '选择…', en: 'Browse…' },
  'ol.detectDesc': { zh: '检测服务与已安装版本。', en: 'Detecting service and installed version.' },
  'ol.runningDesc': { zh: '复用系统级服务（127.0.0.1:11434），与其他应用公用，不重复安装。', en: 'Reuses the system-level service (127.0.0.1:11434) shared with other apps — no duplicate install.' },
  'ol.stoppedDesc': { zh: '启动后即可复用已有模型，无需重新安装。', en: 'Start it to reuse installed models — no reinstall needed.' },
  'ol.startBtn': { zh: '▶ 启动 Ollama', en: '▶ Start Ollama' },
  'ol.notFoundDesc': { zh: '本机未安装 Ollama。可前往官网下载安装（安装后回到此页自动检测；也可以在「自定义」中直接填其他本地端点）。', en: 'Ollama is not installed. Download from the official site (this page re-detects afterwards); or point a Custom endpoint at another local server.' },
  'ol.retryHint': { zh: '请重试。', en: 'Please retry.' },
  'ol.runningTitle': { zh: '检测到 Ollama v{v} · 运行中', en: 'Ollama v{v} detected · running' },
  'ol.installedStoppedTitle': { zh: '检测到 Ollama 已安装{v}，但服务未运行', en: 'Ollama is installed{v} but not running' },
  'ol.notFoundTitle': { zh: '未检测到 Ollama', en: 'Ollama not found' },
  'ol.noModelsTitle': { zh: '尚未拉取模型', en: 'No models pulled yet' },
  'ol.installedModelsTitle': { zh: '已装模型（勾选接入）', en: 'Installed models (check to connect)' },
  'ol.addedCount': { zh: '已接入 {n} 个模型', en: 'Connected {n} model(s)' },
  'ol.addedTag': { zh: '已接入', en: 'Connected' },
  'ol.pickBtn': { zh: '手工定位', en: 'Locate manually' },
  'ol.pickFail': { zh: '定位失败', en: 'Locate failed' },
  'ol.pickedOk': { zh: '已定位 Ollama {v}——重新检测中…', en: 'Located Ollama {v} — re-probing…' },
  'ol.recoPull': { zh: '⬇ 拉取（终端可见）', en: '⬇ Pull (visible terminal)' },
  'ol.tblModel': { zh: '模型', en: 'Model' },
  'ol.tblSpec': { zh: '参数', en: 'Params' },
  'ol.tblSize': { zh: '体积', en: 'Size' },
  'ol.tblRam': { zh: '内存要求', en: 'RAM' },
  'ol.recoRam8': { zh: '8GB 内存可跑', en: 'runs on 8GB RAM' },
  'ol.recoRam16': { zh: '建议 16GB 内存', en: '16GB RAM recommended' },
  'ol.pullLaunched': { zh: '已在系统终端启动拉取 {m}——下载完成后回到此页点「重新检测」', en: 'Pulling {m} in a visible terminal — click Re-check here when done' },
  'ol.pullFail': { zh: '拉取启动失败', en: 'Failed to launch pull' },
  'ol.dlBtn': { zh: '⬇ 打开 Ollama 下载页', en: '⬇ Open Ollama Download Page' },
  'ol.recheck': { zh: '↻ 重新检测', en: '↻ Re-check' },
  'ol.pullHint': { zh: '在终端执行 <code>ollama pull qwen3:4b</code> 拉取模型后，回到此页即可一键接入。', en: 'Run <code>ollama pull qwen3:4b</code> in a terminal, then come back here to connect with one click.' },
  'ol.installedDesc': { zh: '接入后可在「对话默认模型」中选择；接入即复用 Ollama 现有模型，不复制文件。', en: 'After connecting, pick it under "Default Chat Model"; connecting reuses existing Ollama models — no files copied.' },
  'ol.addPicked': { zh: '接入所选模型', en: 'Connect Selected' },
  'ui.save': { zh: '保存', en: 'Save' },
  'ui.cancel': { zh: '取消', en: 'Cancel' },
  'mcp.title': { zh: '工具（管家模式）· MoonLink（魔力宝盒内置）', en: 'Tools (Butler Mode) · MoonLink (built-in)' },
  'mcp.desc': { zh: '小月能否调用工具代你执行任务（总闸）：关闭后小月纯对话，不装配 MoonLink 工具；开启后写操作仍逐一确认。原「通用」分类的此项已升格至此统一管理。', en: 'Whether Moonie may call tools for you (master switch): off = pure chat without MoonLink tools; on = write actions still confirm one by one. Moved here from the General category.' },
  'mcp.del': { zh: '删除', en: 'Delete' },
  'mcp.name': { zh: '名称', en: 'Name' },
  'mcp.keyOpt': { zh: 'API Key（可选，只存钥匙串）', en: 'API Key (optional, keychain only)' },
  'mcp.keyPh': { zh: '服务器要求鉴权时填写', en: 'Fill in if the server requires auth' },
  'mcp.add': { zh: '添加', en: 'Add' },
  'sk.noDesc': { zh: '（无描述）', en: '(no description)' },
  'sk.enable': { zh: '启用技能', en: 'Enable Skills' },
  'sk.enableDesc': { zh: '关闭后小月不加载技能清单与技能工具', en: 'When off, Moonie loads no skill list or skill tools' },
  'sk.openDir': { zh: '📁 打开技能目录', en: '📁 Open Skills Folder' },
  'sk.pickVaultFirst': { zh: '⚠ 先在 设置 → 通用 选择书房目录', en: '⚠ Choose a study folder in Settings → General first' },
  'sk.openFail': { zh: '⚠ 打开失败：', en: '⚠ Open failed: ' },
  'bk.newDesc2': { zh: '文件内容未变化时自动跳过。', en: 'Unchanged files are skipped automatically.' },
  'bk.dirLoading': { zh: '加载中…', en: 'Loading…' },
  'bk.onDeleteLabel': { zh: '云端删除后（网页端删了这份文件）', en: 'After cloud deletion (web removed this file)' },
  'bk.resyncOpt': { zh: '下次同步重新上传（备份目录为源）', en: 'Re-upload on next sync (backup folder is the source)' },
  'bk.keepOpt': { zh: '不再同步该文件（保留云端删除动作）', en: 'Stop syncing this file (keep the cloud deletion)' },
  'bk.dupLabel': { zh: '同名策略（云端已有同名文档，如另一台电脑备份过）', en: 'Same-name policy (cloud already has same-name docs, e.g. from another computer)' },
  'bk.dupRenameOpt': { zh: '重命名上传（保留双方，互不覆盖）', en: 'Rename upload (keep both, never overwrite)' },
  'bk.dupNote': { zh: '同名文档上传为「笔记 2」，双方并存；重装/换机需接管云端同名文档时，新建时会先出现「同名认领」确认。', en: 'Same-name docs upload as "Note 2" side by side; to take over cloud same-name docs after reinstall/new machine, the one-time "same-name claim" prompt appears at creation.' },
  'bk.saveBtn': { zh: '注册并立即同步', en: 'Register && Sync Now' },
  'about.kernel': { zh: '内核 v', en: 'Kernel v' },
  'dg.saveDraft': { zh: '保存草稿', en: 'Save Draft' },
  'dg.admit': { zh: '存进书房', en: 'Save to Study' },
  'dg.aiBtn': { zh: '✨ AI 生成', en: '✨ AI Generate' },
  'dg.quickNew': { zh: '新建图示', en: 'New Diagram' },
  'dg.quickHint': { zh: '打开左侧已有图示继续编辑。', en: 'Open an existing diagram on the left to keep editing.' },
  'xy.send': { zh: '发送', en: 'Send' },
  'xy.model': { zh: '模型', en: 'Model' },
  'xy.thinking': { zh: '思考', en: 'Thinking' },
  'xy.thinkOn': { zh: '开', en: 'On' },
  'xy.subAgent': { zh: '启用子任务', en: 'Enable Subtasks' },
  'xy.subAgentDesc': { zh: '允许小月在对话中派出独立子任务执行复杂多步研究（子任务过程静默，结论回主对话；写操作仍会向你确认）。默认关闭。', en: 'Let Xiaoyue dispatch isolated subagents for complex multi-step research in chat (silent run, summary returns to main chat; writes still ask you). Off by default.' },
  'xy.subAgentOk': { zh: '当前模型可支撑子任务。', en: 'Current model supports subagents.' },
  'xy.subOvAuto': { zh: '子任务:自动', en: 'Subagent: auto' },
  'chat.cacheOpt': { zh: '优化缓存命中', en: 'Optimize Cache Hits' },
  'chat.cacheOptDesc': { zh: '云端 API 模型按前缀缓存计费，开启后动态记忆挪到消息尾部，多轮对话输入费用更低。仅对云端模型生效，本地部署模型自动忽略。', en: 'Cloud APIs bill cached prefixes cheaper. Moves dynamic memory to the message tail for cheaper multi-turn input. Cloud models only; local models ignore this.' },
  'xy.subOvOn': { zh: '子任务:开', en: 'Subagent: on' },
  'xy.subOvOff': { zh: '子任务:关', en: 'Subagent: off' },
  'xy.subAgentOff': { zh: '子任务未开启或当前模型不建议开启。', en: 'Subagent is off or not recommended for the current model.' },
  'xy.thinkOff': { zh: '关', en: 'Off' },
  'lg.openAuth': { zh: '打开授权页', en: 'Open Auth Page' },
  'ue.keyKept': { zh: 'API Key（只存钥匙串）', en: 'API Key (keychain only)' },
  'ue.keySet': { zh: '已配置，不回显', en: 'Configured (hidden)' },
  'mp.keyKept': { zh: 'API Key（只存钥匙串）', en: 'API Key (keychain only)' },
  'lib.migrateNote': { zh: '整体复制到新目录（目标目录需为空），完成后自动切换并重启内核', en: 'Copies everything to the new folder (it must be empty), then switches and restarts the kernel' },
  'sk.sideNote': { zh: '在书房 .moonlybox/skills/&lt;技能名&gt;/ 放置 SKILL.md 即生效', en: 'Drop a SKILL.md into study .moonlybox/skills/&lt;name&gt;/ to activate' },
  'sk.filesN': { zh: ' · 关联文件 {n}', en: ' · {n} file(s)' },
  'ac.feedback': { zh: '问题反馈', en: 'Feedback' },
  'ac.settings': { zh: '个人设置', en: 'Account Settings' },
  'ac.logout': { zh: '退出登录', en: 'Sign Out' },
  'up.downloading': { zh: '新版本 v{v} 后台下载中…', en: 'New version v{v} downloading in background…' },
  'up.ready': { zh: 'v{v} 已就绪，点击安装并重启', en: 'v{v} ready — click to install and restart' },
  'up.latest': { zh: '最新', en: 'Latest' },
  'ac.signedAs': { zh: '已登录：{e}', en: 'Signed in: {e}' },
  'ac.premiumBadge': { zh: '高级会员', en: 'Premium' },
  'ac.freeBadge': { zh: '免费版', en: 'Free' },
  'ac.upgrade': { zh: '升级高级会员，解锁云端 AI 调用', en: 'Upgrade to Premium for cloud AI tools' },
  'ac.notSigned': { zh: '未', en: 'Off' },
  'lg.title': { zh: '登录魔力宝盒', en: 'Sign in to MoonlyBox' },
  'lg.steps': { zh: '1. 点击下方按钮在浏览器打开授权页（手机也可以）<br/>2. 输入用户码确认 → 回到本窗口等待', en: '1. Click below to open the auth page in a browser (phone works too)<br/>2. Enter the code, confirm, then come back and wait' },
  'lg.getCode': { zh: '获取中…', en: 'Getting…' },
  'lg.waitAuth': { zh: '等待授权…', en: 'Waiting for authorization…' },
  'lg.startFail': { zh: '发起失败：', en: 'Failed to start: ' },
  'lg.openFail': { zh: '打开失败，请手动访问：', en: 'Open failed — visit manually: ' },
  'lg.copyLink': { zh: '手动复制授权链接', en: 'Copy auth link manually' },
  'lg.signedIn': { zh: '✓ 已登录：', en: '✓ Signed in: ' },
  'lg.premiumHint': { zh: '云端 AI 调用（月光链）需要高级会员，升级后可用', en: 'Cloud AI tools (MoonLink) require Premium membership' },
  'lg.waitConfirm': { zh: '等待你在浏览器/手机确认…', en: 'Waiting for you to confirm in browser/phone…' },
  'lg.denied': { zh: '已在网页拒绝', en: 'Denied on the web page' },
  'lg.expired': { zh: '用户码过期，重新点击头像', en: 'Code expired — click avatar again' },
}
function curLang() {
  const l = APP_SETTINGS?.appearance?.lang
  if (l === 'en') return 'en'
  return 'zh' // zh-CN/缺省=中文
}
function t(key) {
  const e = I18N_DICT[key]
  if (!e) return key
  return e[curLang()] ?? e.zh ?? key
}
// #316.7：模型下拉三组 optgroup 生成（对话/文档库-知识整理 共用；第三处消费者出现时继续复用）
function modelPickerOpts(selectedValue) {
  const mm = APP_SETTINGS?.model ?? {}
  return `<optgroup label="${t('mp.groupCloud')}">${(mm.providers ?? []).filter((x) => x.enabled).map((x) => {
    const pv = (APP_PROVIDERS?.platform ?? PLATFORM_PROVIDERS_FALLBACK).find((p) => p.id === x.providerId)
    return `<option value="platform:${x.id}" ${selectedValue === `platform:${x.id}` ? 'selected' : ''}>${pv?.label ?? x.providerId} · ${x.model}</option>`
  }).join('')}</optgroup>` +
    `<optgroup label="${t('mp.groupCustom')}">${(mm.custom ?? []).filter((x) => x.enabled).map((x) => `<option value="custom:${x.id}" ${selectedValue === `custom:${x.id}` ? 'selected' : ''}>${x.name} · ${x.model}</option>`).join('')}</optgroup>` +
    `<optgroup label="${t('mp.groupLocal')}">${(mm.local ?? []).filter((x) => x.enabled).map((x) => `<option value="local:${x.id}" ${selectedValue === `local:${x.id}` ? 'selected' : ''}>${x.name} · ${x.model}</option>`).join('')}</optgroup>`
}
// #316 第三批：确认卡「将使用」——编译任务确认卡展示将用的模型（与主进程 resolveCompileModel 同链：compileDefault→default→''）
function compileModelLabel() {
  const mm = APP_SETTINGS?.model ?? {}
  const ref = mm.compileDefault || mm.default || ''
  const [kind, id] = String(ref).split(':')
  if (kind === 'platform') {
    const x = (mm.providers ?? []).find((p) => p.id === id)
    if (x) { const pv = (APP_PROVIDERS?.platform ?? []).find((p) => p.id === x.providerId); return `${pv?.label ?? x.providerId} · ${x.model}` }
  } else if (kind === 'custom') {
    const x = (mm.custom ?? []).find((p) => p.id === id)
    if (x) return `${x.name} · ${x.model}`
  } else if (kind === 'local') {
    const x = (mm.local ?? []).find((p) => p.id === id)
    if (x) return `${x.name} · ${x.model}`
  }
  return ''
}
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
  return { ok: false, error: r.message ?? r.text ?? t('ui.saveFail') }
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
// #296：解析当前主题为实际明暗两值（dark/light）——传云端内嵌用（请求级，不写用户云端设置）
function resolveThemeDark() {
  const mode = APP_SETTINGS?.appearance?.theme ?? 'system'
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  if (mode === 'time') return (new Date().getHours() >= 18 || new Date().getHours() < 6) ? 'dark' : 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
// #315→#315.1：mermaid 主题跟随明暗——深色不用 theme:'dark'（其扇区/节点同为深色系，深底上不可见）；
// 改 base+themeVariables（浅字/灰线/深节点底，数据系列沿用 base 亮色板深底醒目）
const MM_DARK_VARS = {
  background: 'transparent',
  primaryColor: '#312e81',
  secondaryColor: '#3b4a6b',
  tertiaryColor: '#4a3b6b',
  cScale0: '#3b4a6b',
  cScale1: '#4a3b6b',
  cScale2: '#6b3b5a',
  cScale3: '#6b4a3b',
  cScale4: '#3b6b5a',
  cScale5: '#3b5a6b',
  cScale6: '#5a6b3b',
  cScale7: '#6b3b3b',
  cScale8: '#4b3b6b',
  cScale9: '#3b6b6b',
  cScale10: '#6b5a3b',
  cScale11: '#4a6b3b',
  primaryTextColor: '#e2e8f0', secondaryTextColor: '#e2e8f0', textColor: '#e2e8f0', titleColor: '#e2e8f0',
  lineColor: '#94a3b8', mainBkg: '#1e293b', nodeBorder: '#64748b',
  clusterBkg: '#1e293b', clusterBorder: '#475569', edgeLabelBackground: '#1e293b',
  labelBoxBkgColor: '#1e293b', noteBkgColor: '#312e81', noteTextColor: '#e2e8f0',
  actorBkg: '#1e293b', actorBorder: '#64748b', actorTextColor: '#e2e8f0', signalTextColor: '#e2e8f0', sequenceNumberColor: '#0f172a',
  sectionBkgColor: '#1e293b', altSectionBkgColor: '#0f172a', sectionBkgColor2: '#1e293b',
  taskBkgColor: '#312e81', taskTextColor: '#e2e8f0', taskTextLightColor: '#e2e8f0', activeTaskBkgColor: '#4338ca',
  doneTaskBkgColor: '#334155', doneTaskBorderColor: '#64748b', critBkgColor: '#b91c1c', gridColor: '#475569', todayLineColor: '#f59e0b',
  attributeBackgroundColorOdd: '#0f172a', attributeBackgroundColorEven: '#1e293b',
}
function mmApplyTheme() {
  if (!window.mermaid) return
  const dark = resolveThemeDark() === 'dark'
  try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'base' : 'default', ...(dark ? { themeVariables: MM_DARK_VARS } : {}) }) } catch {}
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
  // #307：confirm() 同步阻塞会吞掉 mouseup——dragging 残留导致后续指针行为异常；多点兜底自愈
  const endDrag = () => {
    if (!resizer.classList.contains('dragging')) return
    resizer.classList.remove('dragging')
    document.body.classList.remove('col-resizing')
  }
  window.addEventListener('blur', endDrag)
  window.addEventListener('pointercancel', endDrag)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') endDrag() })
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
// #313：rail tooltip 按当前语言重写（index.html data-tip 为中文默认；EN 时由字典覆盖，tooltip 浮层动态读 data-tip 即时生效）
function applyRailLangTips() {
  for (const b of document.querySelectorAll('#rail .rail-btn')) {
    const nav = b.dataset.nav
    if (nav && NAVS[nav]) b.setAttribute('data-tip', t(NAVS[nav].label))
  }
}
try { applyRailLangTips() } catch {} // 顶层执行（NAVS/t 已定义；APP_SETTINGS 未载时按 zh 兜底）

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
  // #317.MDI（用户定案修正）：两页帧——「默认页帧」=所有非小月功能共用（文字随当前聚焦功能+上下文更新）；
  // 「小月页帧」=独立持久容器（访问过小月后出现）。左侧 rail 已有高亮，页帧不再按功能多开。
  const box = $('frame-tabs')
  box.innerHTML = ''
  const mk = (nav, label, active, onclick) => {
    const b = document.createElement('button')
    b.className = 'frame-tab' + (active ? ' active' : '')
    b.innerHTML = `${navIconSvg(nav, 13)}<span style="vertical-align:middle;margin-left:5px">${label}</span>`
    b.onclick = onclick
    box.appendChild(b)
  }
  const defNav = currentNav === 'xiaoyue' ? (switchNav._lastDef ?? 'vault') : currentNav
  if (currentNav !== 'xiaoyue') switchNav._lastDef = currentNav
  const cur = FRAME_CTX[defNav]
  const defLabel = `${t(NAVS[defNav]?.label ?? 'nav.vault')}${cur ? `<span style="opacity:.65;font-weight:400"> · ${cur}</span>` : ''}`
  mk(defNav, defLabel, currentNav !== 'xiaoyue', () => switchNav(defNav))
  if (openFrames.has('xiaoyue')) {
    const ctx = FRAME_CTX['xiaoyue']
    mk('xiaoyue', `小月${ctx ? `<span style="opacity:.65;font-weight:400"> · ${ctx}</span>` : ''}`, currentNav === 'xiaoyue', () => switchNav('xiaoyue'))
  }
}

function switchNav(nav) {
  currentNav = nav
  if (nav === 'xiaoyue') openFrames.add('xiaoyue') // #317.MDI：仅标记「小月页帧已开」（出现独立页帧）
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
let currentTaskId = null // #316.5 任务页选中态
let tkTimer = null // #310.23 任务详情自动刷新句柄（切页/重入防叠）

async function renderList(nav) {
  const head = $('list-head')
  const body = $('list-body')

  // 设置中心：第二列=分类列表（#253.48）
  if (nav === 'settings') {
    head.textContent = t('list.settings')
    body.innerHTML = ''
    for (const cat of SETTINGS_CATS) {
      const el = document.createElement('div')
      const active = cat.id === currentSetCat
      el.className = 'set-cat' + (active ? ' active' : '')
      // #256 用户：第二列只留图标+名称，去掉右侧对齐的二级说明文字
      el.innerHTML = `${setIconSvg(cat.id)}<span>${t(cat.label)}</span>`
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
  head.textContent = t(NAVS[nav].label)
  body.innerHTML = ''

  if (nav === 'vault') {
    const v = await window.moonlybox.vaultGet()
    if (!v || !require_exists(v)) {
      body.innerHTML = `<div class="muted" style="padding:10px">${t('list.vaultNotChosen')}</div>`
      return
    }
    // 全展开/全收起（#253.29）+ #317.8c 立即同步（跑一轮周期闭环：补传+下行+打标+索引）
    head.innerHTML = `${t(NAVS[nav].label)} <span id="tree-sync" style="float:right;font-weight:400;font-size:11px;color:var(--muted);cursor:pointer;margin-left:12px">${t('tree.syncNow')}</span><span id="tree-exp" style="float:right;font-weight:400;font-size:11px;color:var(--muted);cursor:pointer">${t('tree.expandAll')}</span>`
    const syncEl = $('tree-sync')
    if (syncEl) syncEl.onclick = async () => {
      if (syncEl.dataset.busy === '1') return
      syncEl.dataset.busy = '1'
      syncEl.textContent = t('tree.syncing')
      try {
        const r = await window.moonlybox.rpc('syncNow', {}, 120_000)
        const ok = r.event === 'done' && r.code === 0
        mbAlert(ok ? t('tree.syncDone') : (t('tree.syncFail') + (r.message ?? '')))
      } catch (e) { mbAlert(t('tree.syncFail') + String(e)) }
      syncEl.dataset.busy = '0'
      syncEl.textContent = t('tree.syncNow')
      await renderList('vault')
    }
    $('tree-exp').onclick = async () => {
      const expanding = $('tree-exp').textContent === t('tree.isExpanded')
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
      if (exp) exp.textContent = expanding ? t('tree.collapseAll') : t('tree.isExpanded')
    }
    await renderTree(body, '', 0)
  } else if (nav === 'backup') {
    // #257 备份：第二列=注册的备份目录列表
    head.innerHTML = `${t('list.backup')} <span id="bk-add" style="float:right;font-weight:400;font-size:12px;color:var(--accent);cursor:pointer">${t('ui.new')}</span>`
    $('bk-add').onclick = () => renderWork('backup', { create: true })
    body.innerHTML = `<div class="muted" style="padding:10px">${t('list.loading')}</div>`
    try {
      const r = await window.moonlybox.rpc('backup', { op: 'list' }, 10_000)
      const d = JSON.parse(r.text)
      if (!d.entries?.length) {
        body.innerHTML = `<div class="muted" style="padding:10px">${t('list.bkEmpty')}</div>`
        return
      }
      body.innerHTML = ''
      for (const e of d.entries) {
        const holdN = Object.values(e.files ?? {}).filter((f) => f.hold).length
        const el = document.createElement('div')
        el.className = 'tree-item' + (currentBkId === e.id ? ' active' : '')
        el.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">📁 ${e.localPath.split(/[\\/]/).pop()}</span>
          <span class="muted" style="font-size:10.5px;flex:none">${e.enabled ? (holdN ? `${holdN}${t('bk.holdN')}` : t('ui.enable')) : t('ui.stop')}</span>`
        el.onclick = () => { currentBkId = e.id; renderList('backup'); renderWork('backup', { id: e.id }) }
        body.appendChild(el)
      }
    } catch (e) {
      body.innerHTML = `<div class="muted" style="padding:10px">${t('list.loadFail')}</div>`
    }
    return
  } else if (nav === 'tasks') {
    // #316.5：任务页列表（origin 预留云端任务；v1 只有 local）
    head.textContent = t('nav.tasks')
    body.innerHTML = `<div class="muted" style="padding:10px">${t('list.loading')}</div>`
    try {
      const r = await window.moonlybox.rpc('tasks', { op: 'list' }, 10_000)
      const jobs = JSON.parse(r.text).jobs ?? []
      // #310.27：知识页入口迁出任务侧栏（产物≠任务类型，层级错位）——书房「知识页」目录节点+任务详情「产物」tab 承接
      body.innerHTML = ''
      if (!jobs.length) return
      const ICONS = { queued: '⏳', running: '⚙', completed: '✓', failed: '✗', cancelled: '⊘' }
      for (const j of jobs) {
        const el = document.createElement('div')
        el.className = 'tree-item' + (currentTaskId === j.id ? ' active' : '')
        const canDel = j.status !== 'running' && j.status !== 'queued'
        el.innerHTML = `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${ICONS[j.status] ?? '•'} ${j.title}</span>
          <span class="muted" style="font-size:10.5px;flex:none">${j.progress.done}/${j.progress.total}</span>
          ${canDel ? `<button class="tk-job-del btn ghost" data-jid="${esc(j.id)}" title="${t('tk.jobDel')}" style="flex:none;display:none;font-size:11px;padding:0 6px">✕</button>` : ''}`
        el.onclick = () => { currentTaskId = j.id; renderList('tasks'); renderWork('tasks', { id: j.id }) }
        // #317.7：删除任务（hover 显形；mbConfirm 确认；只删记录产物保留）
        const delBtn = el.querySelector('.tk-job-del')
        if (delBtn) {
          el.onmouseenter = () => { delBtn.style.display = '' }
          el.onmouseleave = () => { delBtn.style.display = 'none' }
          delBtn.onclick = async (ev) => {
            ev.stopPropagation() // 不触发行点击（不进详情）
            if (!(await mbConfirm(t('tk.jobDelConfirm').replace('{t}', j.title)))) return
            const rd = await window.moonlybox.rpc('tasks', { op: 'delete', id: j.id }, 10_000)
            if (rd.event !== 'done' || rd.code !== 0) { mbAlert(t('lib.delFail') + (rd.text || rd.message || '')); return }
            if (currentTaskId === j.id) currentTaskId = null
            renderList('tasks')
            renderWork('tasks')
          }
        }
        body.appendChild(el)
      }
    } catch (e) {
      body.innerHTML = `<div class="muted" style="padding:10px">${t('list.loadFail')}</div>`
    }
    return
  } else if (nav === 'cloud') {
    // #254：云端功能=服务端下发 manifest（功能升级/新增零客户端发版）
    const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
    if (r.event !== 'done' || r.code !== 0) {
      body.innerHTML = `<div class="muted" style="padding:10px">${t('list.navLoadFail')}` + (r.text || r.message) + '</div>'
      return
    }
    try {
      const { nav: items } = JSON.parse(r.text).data
      for (const it of items) {
        if (CLOUD_HIDDEN.has(it.id)) continue // 云端隐藏的功能本地不同步出现
        const el = document.createElement('div')
        el.className = 'tree-item' + (currentCloudId === it.id ? ' active' : '')
        el.dataset.cid = it.id
        // #319.3：侧栏 label 客户端本地化——manifest id 命中字典走 t()，未命中回落服务端 label
        const navLabel = t(`cloud.nav.${it.id}`)
        el.innerHTML = `${cloudIconSvg(it.icon)}<span>${navLabel === `cloud.nav.${it.id}` ? it.label : navLabel}</span>`
        el.onclick = () => {
          body.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
          el.classList.add('active')
          currentCloudId = it.id
          renderWork('cloud', it)
        }
        body.appendChild(el)
      }
    } catch {
      body.innerHTML = `<div class="muted" style="padding:10px">${t('list.navParseFail')}</div>`
    }
  } else if (nav === 'diagram') {
    // #290：顶部「＋ 新建」→ renderWork('diagram', { __new: true }) 进空态（编辑器按钮隐藏，工作台内点「＋ 新建」走模板弹窗）
    const newBtn = document.createElement('div')
    newBtn.className = 'tree-item'
    newBtn.style.color = 'var(--accent)'
    newBtn.textContent = t('dg.newBtn')
    newBtn.onclick = () => {
      body.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active')) // #302：新建=离开编辑态，清选中高亮
      renderWork('diagram', {})
    }
    body.appendChild(newBtn)
    const r = await window.moonlybox.rpc('diagram', { op: 'list' }, 30_000)
    try {
      const items = JSON.parse(r.text).data.diagrams || []
      for (const it of items) {
        const el = document.createElement('div')
        // #302：选中态=正在编辑的草稿（dgCurrentId 对齐）——打开行时 DOM 级切换高亮（不重渲列表）
        el.className = 'tree-item' + (it.id && it.id === dgCurrentId ? ' active' : '')
        el.style.position = 'relative'
        // #292：图标=图示类型（存档标签优先，内容嗅探兜底）——草稿半透明+title 标状态，废除 📝/📚（风格与小月/文档统一）
        // #300：悬停显示最后修改时间（居右）+「⋯」更多菜单（行级：删除）
        const fmtTime = (() => { try { const d = new Date(it.updatedAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` } catch { return '' } })()
        el.innerHTML = `<span style="opacity:${it.state === 'draft' ? '.55' : '1'}">${dgTypeIcon(it)}</span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(it.title).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span><span class="dg-time" style="display:none;font-size:10.5px;color:var(--muted);flex:none">${fmtTime}</span><span class="dg-more" style="display:none;cursor:pointer;padding:0 4px;color:var(--muted);flex:none" title="${t('dg.more')}">⋯</span>`
        el.title = `${it.state === 'draft' ? t('lib.draft') : t('lib.inStudy')} · ${it.diagramType ?? sniffDiagramType(it.content) ?? t('lib.unknownType')}`
        el.onmouseenter = () => {
          el.querySelector('.dg-time').style.display = ''
          el.querySelector('.dg-more').style.display = ''
        }
        el.onmouseleave = () => {
          el.querySelector('.dg-time').style.display = 'none'
          el.querySelector('.dg-more').style.display = 'none'
          // #301：菜单挂 body——移出行不关菜单（移向菜单必经行外），关闭靠 document click / 再点 ⋯ / 行滚出视口
        }
        el.onclick = () => {
          body.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
          el.classList.add('active')
          renderWork('diagram', it)
        }
        // ⋯ 更多菜单：#301 改挂 body+fixed 定位——行内 absolute 会被 .list-body overflow-y:auto 裁剪（菜单只能显示半截）
        el.querySelector('.dg-more').onclick = (e) => {
          e.stopPropagation()
          const existed = document.querySelector('.dg-menu')
          if (existed) { existed.remove(); existed._row?.classList.remove('menu-open'); return }
          const menu = document.createElement('div')
          menu.className = 'dg-menu'
          menu._row = el // #304：菜单打开期间锚定行保持 hover 背景（归属感）——关闭时移除
          el.classList.add('menu-open')
          const rect = el.getBoundingClientRect()
          menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:112px;box-shadow:0 8px 24px rgba(0,0,0,.35)'
          // 默认锚在行下方右对齐；底部放不下则翻转到行上方
          menu.style.visibility = 'hidden'
          document.body.appendChild(menu)
          const mh = menu.offsetHeight
          const below = rect.bottom + 2 + mh <= window.innerHeight - 8
          menu.style.left = `${Math.min(rect.right - 118, window.innerWidth - 126)}px`
          menu.style.top = `${below ? rect.bottom + 2 : rect.top - mh - 2}px`
          menu.style.visibility = ''
          menu.innerHTML = `<div class="dg-del" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--err,#f87171)">${t('dg.delItem')}</div>`
          menu.querySelector('.dg-del').onclick = async (e2) => {
            e2.stopPropagation()
            closeCtxMenu(menu)
            if (!(await mbConfirm(t('dg.delConfirm').replace('{t}', it.title)))) return
            const rr = await window.moonlybox.rpc('diagram', { op: 'delete', id: it.id }, 30_000)
            if (rr.event === 'done' && rr.code === 0 && JSON.parse(rr.text).ok !== false) {
              void renderList('diagram')
              if (typeof dgCurrentId === 'string' && dgCurrentId === it.id) renderWork('diagram', {})
            } else {
              const st = $('dg-state')
              if (st) st.textContent = t('lib.delFail') + (rr.text || rr.message)
            }
          }
          // 点外部/列表滚动关闭（menu 已挂 document.body）
          const close = (e3) => { if (!menu.contains(e3.target)) { closeCtxMenu(menu); document.removeEventListener('click', close); lb?.removeEventListener('scroll', close) } }
          const lb = el.closest('.list-body')
          lb?.addEventListener('scroll', close, { once: true })
          setTimeout(() => document.addEventListener('click', close), 0)
        }
        body.appendChild(el)
      }
      if (!items.length) body.insertAdjacentHTML('beforeend', `<div class="muted" style="padding:10px">${t('dg.none')}</div>`)
    } catch {
      body.insertAdjacentHTML('beforeend', `<div class="muted" style="padding:10px">${t('dg.listFail')}</div>`)
    }
  } else if (nav === 'xiaoyue') {
    // #282 会话列表：工作空间分组 + 对话（无工作空间）分类
    body.innerHTML = `
      <div style="padding:8px 8px 4px;display:flex;gap:6px">
        <button class="btn" id="xy-new-ws" style="flex:1;font-size:12px">${t('xy.newWs')}</button>
        <button class="btn ghost" id="xy-new-chat" style="flex:1;font-size:12px" title="${xyActiveWorkspace ? t('xy.inWorkspace') : t('xy.noWorkspace')}">${t('xy.newChat')}</button>
      </div>
      <div id="xy-list" style="flex:1;overflow-y:auto;padding:4px 8px 12px"></div>`
    $('xy-new-ws').onclick = () => showWorkspaceDialog()
    $('xy-new-chat').onclick = async () => {
      if (xyCreating) return // #305 防重入
      xyCreating = true
      try {
        const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: xyActiveWorkspace }, 15_000)
        if (r.event === 'done' && r.code === 0) {
          xyActiveChat = JSON.parse(r.text).chat.id
          xyActiveWorkspace = null // 新无工作空间对话
          await renderWork('xiaoyue')
          await renderWork('xiaoyue', { chat: xyActiveChat })
          await renderXiaoyueList() // #305：新建后即时刷列表（消掉「按钮还在可再点」的窗口）
        }
      } finally { xyCreating = false }
    }
    await renderXiaoyueList()
  } else if (nav === 'help') {
    // #310.5：帮助项选中态——currentHelpArg 跟踪当前项，DOM 级切换（点击换 active，不重渲侧栏）
    for (const [arg, label, fn] of [['terms', t('help.terms'), () => renderWork('help', 'terms')], ['feedback', t('help.feedback'), () => renderWork('help', 'feedback')], ['debug', t('help.debug'), () => renderWork('help', 'debug')], ['cloudaddr', t('help.cloudaddr'), () => renderWork('help', 'cloudaddr')], ['kernel', t('help.kernel'), () => renderWork('help', 'kernel')], ['about', t('help.about'), () => renderWork('help', 'about')]]) {
      const el = document.createElement('div')
      el.className = 'tree-item' + (currentHelpArg === arg ? ' active' : '')
      el.textContent = label
      el.onclick = () => {
        currentHelpArg = arg
        body.querySelectorAll('.tree-item').forEach((x) => x.classList.remove('active'))
        el.classList.add('active')
        fn()
      }
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
  container.innerHTML = '' // #310.32c：原地重入安全（删除产物后单层刷新不清旧节点=幽灵节点残留）
  for (const item of r.items) {
    const relPath = rel ? `${rel}/${item.name}` : item.name
    // #310.32：书房根 README.md=客户端元数据位（目录说明单源）——树中不显示不可编辑
    if (!rel && !item.dir && item.name.toLowerCase() === 'readme.md') continue
    const el = document.createElement('div')
    el.className = 'tree-item' + (item.dir ? ' dir' : '')
    el.style.paddingLeft = `${8 + depth * 14}px`
    el.dataset.rel = relPath
    if (item.dir) {
      const collapsed = treeCollapsed.has(relPath)
      el.innerHTML = `<span class="tw" style="display:inline-block;width:14px;cursor:pointer;text-align:center;color:var(--muted)">${collapsed ? '▸' : '▾'}</span><span style="margin-left:2px">📁</span><span style="margin-left:4px">${item.name}</span>`
      el.onclick = async () => {
        // #310.24：高亮清除必须全树范围（container 只覆盖当前子层——跨目录选择时旧目录 active 残留）
        document.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
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
        // #310.24：同上——全树范围清除
        document.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'))
        el.classList.add('active')
        await renderWork('vault', { rel: relPath, dir: false })
      }
      // #310.32b（用户澄清）：产物管理在文件右键菜单——知识页产物右键出菜单（删除+ledger 重置；将来菜单项可扩展）
      if (relPath.startsWith('知识页/')) {
        el.oncontextmenu = async (e) => {
          e.preventDefault()
          e.stopPropagation()
          const existed = document.querySelector('.tp-menu')
          if (existed) { closeCtxMenu(existed); return }
          const menu = document.createElement('div')
          menu.className = 'tp-menu'
          menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:132px;box-shadow:0 8px 24px rgba(0,0,0,.35)'
          menu.style.visibility = 'hidden'
          document.body.appendChild(menu)
          const mh = menu.offsetHeight
          const below = e.clientY + 2 + mh <= window.innerHeight - 8
          menu.style.left = `${Math.min(e.clientX, window.innerWidth - 140)}px`
          menu.style.top = `${below ? e.clientY + 2 : e.clientY - mh - 2}px`
          menu.style.visibility = ''
          menu.innerHTML = `<div class="tp-mi-del" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--err,#f87171)">${t('tk.delThis')}</div>`
          const mi = menu.querySelector('.tp-mi-del')
          mi.onmouseenter = () => { mi.style.background = 'var(--hover)' }
          mi.onmouseleave = () => { mi.style.background = '' }
          mi.onclick = async () => {
            closeCtxMenu(menu)
            // #310.34：confirm() OS 模态会打断焦点（小月对话框无法聚焦）——用页面内置 mbConfirm（#309 范式）
            if (!(await mbConfirm(t('tk.delConfirm').replace('{n}', 1)))) return
            // rel 形态（树 rel「知识页/xx.md」）——daemon delete_pages 侧归一 abs 后过白名单
            const rd = await window.moonlybox.rpc('tasks', { op: 'delete_pages', paths: [relPath] }, 30_000)
            try {
              const d = JSON.parse(rd.text)
              if (d.ok) {
                mbAlert(t('tk.delDone').replace('{d}', d.deleted).replace('{r}', d.resetLedger))
                await renderTree(container, rel, depth)
                // 工作区正显示被删文件→回落到该层目录详情（#310.32c）
                const wEl = $('work')
                if (wEl && wEl.querySelector('.md-view, #wf-view') && wEl.textContent.includes(item.name)) renderWork('vault', { rel, dir: true })
              } else mbAlert(t('lib.delFail') + (d.message ?? ''))
            } catch { mbAlert(t('lib.delFail')) }
          }
          const close = (e3) => { if (!menu.contains(e3.target)) { closeCtxMenu(menu); document.removeEventListener('click', close); document.removeEventListener('contextmenu', close) } }
          setTimeout(() => { document.addEventListener('click', close); document.addEventListener('contextmenu', close) }, 0)
        }
      } else {
        // #310.61：源文档右键「重新整理」——本地重编译（用户定案：LLM 用户自持，重编不需云端；产物并存旧版保留，云端按 localItemId 幂等更新同篇）
        el.oncontextmenu = async (e) => {
          e.preventDefault()
          e.stopPropagation()
          const existed = document.querySelector('.tp-menu')
          if (existed) { closeCtxMenu(existed); return }
          const menu = document.createElement('div')
          menu.className = 'tp-menu'
          menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:132px;box-shadow:0 8px 24px rgba(0,0,0,.35)'
          menu.style.visibility = 'hidden'
          document.body.appendChild(menu)
          const mh = menu.offsetHeight
          const below = e.clientY + 2 + mh <= window.innerHeight - 8
          menu.style.left = `${Math.min(e.clientX, window.innerWidth - 140)}px`
          menu.style.top = `${below ? e.clientY + 2 : e.clientY - mh - 2}px`
          menu.style.visibility = ''
          menu.innerHTML = `<div class="tp-mi-recomp" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">${t('lib.recompile')}</div>`
          const mi = menu.querySelector('.tp-mi-recomp')
          mi.onmouseenter = () => { mi.style.background = 'var(--hover)' }
          mi.onmouseleave = () => { mi.style.background = '' }
          mi.onclick = async () => {
            closeCtxMenu(menu)
            const rd = await window.moonlybox.rpc('tasks', { op: 'create_compile', paths: [relPath], force: true }, 30_000)
            try {
              const d = JSON.parse(rd.text)
              if (d.ok) {
                mbAlert(t('lib.recompileQueued').replace('{t}', d.job?.title ?? ''))
                renderWork('tasks', { id: d.job?.id })
              } else mbAlert(t('lib.delFail') + (d.message ?? rd.text ?? ''))
            } catch { mbAlert(t('lib.delFail')) }
          }
          const close = (e3) => { if (!menu.contains(e3.target)) { closeCtxMenu(menu); document.removeEventListener('click', close); document.removeEventListener('contextmenu', close) } }
          setTimeout(() => { document.addEventListener('click', close); document.addEventListener('contextmenu', close) }, 0)
        }
      }
      container.appendChild(el)
    }
  }
}

// ---------- 第三列渲染 ----------
// #299：渲染世代令牌——快速切换功能时旧 renderWork 协程作废（await 期间 DOM 已被新渲染重写，
// 旧协程继续执行会 null 报错或把新页面覆盖成旧页面）。cloud 长链路每步 await 后检查。
let renderGen = 0
/** #317.MDI：小月持久面板（容器 #work-xiaoyue；渲染一次后不销毁） */
async function renderXiaoyuePane(arg) {
  const xyPane = $('work-xiaoyue')
  const w = xyPane
    // #282：arg.chat=打开指定对话（恢复历史+绑定 chatId/workspaceId）；无参=占位
    xyPaneMeta = null
    if (arg?.chat) {
      const r = await window.moonlybox.rpc('workspace', { op: 'chat', id: arg.chat }, 15_000)
      if (r.event === 'done' && r.code === 0) xyPaneMeta = JSON.parse(r.text).chat
    }
    // #283.4：标签带工作空间名——用户能一眼确认当前对话是否真的挂在工作空间下（fs 工具只在此时装配）
    let wsName = ''
    if (xyPaneMeta?.workspaceId) {
      try {
        const rw = await window.moonlybox.rpc('workspace', { op: 'list' }, 10_000)
        wsName = (JSON.parse(rw.text).workspaces ?? []).find((x) => x.id === xyPaneMeta.workspaceId)?.name ?? ''
      } catch {}
    }
    const wsLabel = xyPaneMeta ? (xyPaneMeta.workspaceId ? `📁 工作空间${wsName ? `「${wsName}」` : ''}对话（可读写挂载目录）` : '💬 无工作空间（无本地文件访问，仅文档库/MCP）') : ''
    w.innerHTML = `
      ${xyPaneMeta ? `<div class="muted" style="padding:8px 16px 0;font-size:12px">${xyPaneMeta.title} · ${wsLabel}</div>` : ''}
      <div id="log" class="mono" style="flex:1;overflow-y:auto;padding:16px;white-space:pre-wrap;user-select:text"></div>
      <div style="padding:8px 16px 12px;border-top:1px solid var(--border)">
        <textarea id="q" rows="1" placeholder="${xyPaneMeta ? (xyPaneMeta.workspaceId ? t('xy.qPlaceholder') : t('xy.docOnly')) : t('xy.pickFirst')}" style="display:block;width:100%;resize:none;box-sizing:border-box;line-height:1.5;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#0f172a);color:var(--fg,#e2e8f0);font:inherit;max-height:160px;overflow-y:auto" ${xyPaneMeta ? '' : 'disabled'}></textarea>
        <div class="row" style="margin-top:6px;align-items:center;gap:8px;position:relative">
          <button class="btn ghost" id="xy-prompts-btn" style="font-size:12px" ${xyPaneMeta ? '' : 'disabled'}>⭐ ${t('xy.prompts')}</button>
          <button class="btn ghost" id="xy-model-btn" style="font-size:12px" ${xyPaneMeta ? '' : 'disabled'}>⚙ <span id="xy-model-label"></span></button>
          <button class="btn ghost" id="xy-think-btn" style="font-size:12px" ${xyPaneMeta ? '' : 'disabled'}>🧠 <span id="xy-think-label"></span></button>
          <div style="flex:1"></div>
          <button class="btn ghost" id="btn-stop" style="display:none">${t('xy.stop')}</button>
          <button class="btn" id="btn-ask" ${xyPaneMeta ? '' : 'disabled'}>${t('xy.send')}</button>
        </div>
      </div>`
        // #317.F8c：重渲后恢复运行态——上一次 askWith 仍在 await（切页切回），停止按钮不能被模板 display:none 吞掉
    {
      const ab = document.getElementById('btn-ask')
      const sb = document.getElementById('btn-stop')
      if (ab && sb && ab.disabled) sb.style.display = ''
    }
    // #325 常用指令（提示词模板）：点选→填入输入框（不直接发送——留空位给用户补全/确认）。点击面板外关闭。
    const promptsBtn = document.getElementById('xy-prompts-btn')
    if (promptsBtn) {
      const PROMPTS = [
        t('xy.p1'), t('xy.p2'), t('xy.p3'), t('xy.p4'), t('xy.p5'),
      ]
      promptsBtn.onclick = (e) => {
        e.stopPropagation()
        let panel = document.getElementById('xy-prompts-panel')
        if (panel) { panel.remove(); return }
        panel = document.createElement('div')
        panel.id = 'xy-prompts-panel'
        panel.style.cssText = 'position:absolute;bottom:44px;left:0;z-index:30;min-width:340px;max-width:460px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);padding:6px;display:flex;flex-direction:column'
        for (const p of PROMPTS) {
          const it = document.createElement('div')
          it.textContent = p
          it.style.cssText = 'padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;line-height:1.5'
          it.onmouseenter = () => { it.style.background = 'var(--hover)' }
          it.onmouseleave = () => { it.style.background = 'transparent' }
          it.onclick = () => {
            const q = document.getElementById('q')
            if (q) { q.value = p; q.focus(); q.dispatchEvent(new Event('input')) }
            panel.remove()
          }
          panel.appendChild(it)
        }
        promptsBtn.parentElement.appendChild(panel)
        setTimeout(() => {
          document.addEventListener('click', function h(ev) {
            if (!panel.contains(ev.target)) { panel.remove(); document.removeEventListener('click', h) }
          })
        }, 0)
      }
    }
    if (xyPaneMeta) {
      bindChat({ meta: xyPaneMeta })
      // #317.MDI：重放后台缓冲行（该会话跑过的过程流）——bindChat 的 log 分类管道现成可用
      const buf = xyBufById.get(xyPaneMeta.id) ?? []
      xyBufById.delete(xyPaneMeta.id)
      window.__xyReplay?.(buf)
    } else w.insertAdjacentHTML('afterbegin', '<div class="muted" style="padding:16px">左侧新建工作空间或对话开始。</div>')
    xyPane.dataset.ready = '1'
    setFrameTabCtx('xiaoyue', xyActiveChatTitle())
    return
}

async function renderWork(nav, arg, label2) {
  ensureFocusAlive() // #307：删除/confirm 后焦点断链自愈
  // #317.MDI：双容器路由——小月=持久容器（首次渲染后切走只隐藏，切回恢复；换会话由 arg.chat 显式 reset）；
  // 其余功能=默认容器销毁式重建（现状不变）。两容器互斥显示。
  const xyPane = $('work-xiaoyue')
  const defPane = $('work')
  const isXy = nav === 'xiaoyue'
  xyPane.style.display = isXy ? '' : 'none'
  defPane.style.display = isXy ? 'none' : ''
  if (isXy) {
    // 持久容器短路：已渲染且非「打开指定对话」→ 只刷新列表选中，不重建（状态保持）
    if (xyPane.dataset.ready === '1' && !arg?.chat) {
      setFrameTabCtx('xiaoyue', xyActiveChatTitle())
      return
    }
    return renderXiaoyuePane(arg)
  }
  const w = defPane
  // #317.MDI：无选中对象（列表态）→ 清上下文（各分支选中后再覆盖）
  if (!arg) setFrameTabCtx(nav, '')
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
        mmApplyTheme()
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
    const btnToggle = mkBtn(t('ui.edit'), true)
    const btnSave = mkBtn('保存', false)
    const applyMode = () => {
      if (mode === 'read') {
        edit.style.display = 'none'; view.style.display = ''
        renderView()
        btnToggle.textContent = t('ui.edit')
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
      if (!wr.ok) { state.textContent = t('dg.saveFail') + wr.message; return }
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
    setFrameTabCtx('vault', arg.rel)
    return
  }
  if (nav === 'vault' && arg?.dir) {
    // #310.32b（用户澄清）：目录详情统一=README 拆段显示（含「知识页」）——产物管理不在目录页，在文件右键菜单。
        // #310.31：目录详情=书房根 README.md 中本目录的说明段（单源拆分——目录无元数据位；子目录 README.md 会与用户同名文档混淆，不采用）。
    // 拆分规则：README 按 `## 目录名` 切段；子目录取顶层段（rel='文档/xx'→'文档'段）；无匹配段=占位提示。
    let readmeText = ''
    try { const rr = await window.moonlybox.fsRead('README.md'); if (rr && rr.ok && rr.content) readmeText = rr.content } catch {}
    const dirName = String(arg.rel).split(/[\\/]/)[0]
    let section = ''
    if (readmeText) {
      const secs = readmeText.split(/^## (.+)$/m)
      // split 形态：[前文, 标题1, 段1, 标题2, 段2, ...]
      for (let si = 1; si < secs.length - 1; si += 2) {
        if (secs[si].trim() === dirName) { section = secs[si + 1].trim(); break }
      }
    }
    w.innerHTML = `<div style="padding:16px 20px;border-bottom:1px solid var(--border)"><strong style="font-size:13px">📁 ${esc(arg.rel)}</strong></div>
      <div style="flex:1;overflow-y:auto;padding:6px 20px 20px" class="md-view">${section ? renderMarkdownSafe(section) : `<div class="muted" style="padding:8px 0">${t('dir.noReadme')}</div>`}</div>`
    return
  }
  // ---------- 设置中心：第三列面板（#253.48） ----------
  if (nav === 'settings') {
    const cat = SETTINGS_CATS.find((c) => c.id === currentSetCat) ?? SETTINGS_CATS[0]
    if (cat.subs && !currentSetSub) currentSetSub = cat.subs[0] // 有二级分类默认进第一个（模型→平台 API）
    setFrameTabCtx('settings', currentSetSub ? `${t(cat.label)} / ${t(SET_SUB_LABELS[currentSetSub] ?? currentSetSub)}` : t(cat.label))
    const panel = (title, desc, inner) => {
      const tabs = cat.subs
        ? `<div class="set-row" style="gap:6px;margin:0 0 18px">${cat.subs.map((s) => `<button type="button" class="btn ${s === currentSetSub ? '' : 'ghost'}" data-setsub="${s}">${t(SET_SUB_LABELS[s] ?? s)}</button>`).join('')}</div>`
        : ''
      w.innerHTML = `<div class="set-panel"><div class="set-body"><h3>${title}</h3><p class="set-desc">${desc}</p>${tabs}${inner}</div></div>`
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
      panel(t('panel.general'), t('panel.sub.general'), `
        ${card('sp-launch', t('gen.launch'), t('gen.launch.desc'), !!gv.launchAtLogin)}
        ${card('sp-min', t('gen.minLaunch'), t('gen.minLaunch.desc'), !!gv.launchMinimized)}
        ${card('sp-tray', t('gen.minClose'), t('gen.minClose.desc'), !!gv.closeToTray)}
        ${card('sp-awake', t('gen.awake'), t('gen.awake.desc'), !!gv.keepAwake)}
        ${card('sp-watch', t('gen.clip'), t('gen.clip.desc'), clipboardWatch)}
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
      panel(t('panel.appearance'), t('panel.sub.appearance'), `
        <div class="set-field" style="max-width:320px"><label>${t('ap.theme')}</label>
          <select id="sp-theme" class="set-select">
            <option value="system" ${av.theme === 'system' || !av.theme ? 'selected' : ''}>${t('ap.theme.sys')}</option>
            <option value="light" ${av.theme === 'light' ? 'selected' : ''}>${t('ap.theme.light')}</option>
            <option value="dark" ${av.theme === 'dark' ? 'selected' : ''}>${t('ap.theme.dark')}</option>
            <option value="time" ${av.theme === 'time' ? 'selected' : ''}>${t('ap.theme.time')}</option>
          </select>
        </div>
        <div class="set-field" style="max-width:320px"><label>${t('ap.lang')}</label>
          <select id="sp-lang" class="set-select">
            <option value="zh-CN" ${av.lang === 'zh-CN' || !av.lang ? 'selected' : ''}>${t('ap.langZh')}</option>
            <option value="en" ${av.lang === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>
        <div class="set-field"><label>${t('ap.zoom')}<span id="sp-zoom-v">${av.zoom ?? 100}%</span></label>
          <input type="range" id="sp-zoom" min="100" max="200" step="10" value="${av.zoom ?? 100}" style="width:260px" />
        </div>
        <div class="set-status" id="sp-ap-status"></div>
      `)
      $('sp-theme').onchange = async (e) => {
        APP_SETTINGS.appearance = { ...(APP_SETTINGS.appearance ?? {}), theme: e.target.value }
        applyThemeSettings()
        await saveAppSettings({ appearance: { theme: e.target.value } })
        // #315：mermaid 主题随明暗切换——重渲当前工作区让已出图重上色
        if (currentNav !== 'settings') { try { await renderWork(currentNav) } catch {} }
      }
      $('sp-lang').onchange = async (e) => {
        APP_SETTINGS.appearance = { ...(APP_SETTINGS.appearance ?? {}), lang: e.target.value }
        await saveAppSettings({ appearance: { lang: e.target.value } })
        // #313：立即生效——rail tooltip+当前视图重渲（框架标签全走 t()，随 curLang() 切换）
        applyRailLangTips()
        await renderList(currentNav)
        await renderWork('settings')
        const st = $('sp-ap-status'); st.className = 'set-status ok'; st.textContent = '✓ Saved / 已保存'
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
      // #283：默认模型下拉=平台API/自定义/本地部署三组已启用实例列出（#316：本地部署已实装）
      const modelOpts = modelPickerOpts(g.model?.default) // #316.7：共享生成器
      panel(t('panel.chat'), t('panel.sub.chat'), `
        <div class="set-field" style="margin-bottom:14px"><label>${t('chat.defaultModel')}</label>
          <select id="sp-chat-model" class="set-select set-select-sm" style="max-width:420px">
            <option value="">${t('chat.unset')}</option>
            ${modelOpts}
          </select>
          <div class="set-desc" style="margin-top:4px" id="sp-chat-model-hint"></div>
        </div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('chat.ctx')}</div><div class="sc-desc">${t('chat.ctxDesc')}</div></div>
          <button type="button" class="toggle ${cv.contextEnabled !== false ? 'on' : ''}" id="sp-ctx"></button></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('chat.compact')}</div><div class="sc-desc">${t('chat.compactDesc')}</div></div>
          <button type="button" class="toggle ${cv.autoCompress !== false ? 'on' : ''}" id="sp-compress" ${cv.contextEnabled === false ? 'disabled' : ''}></button></div>
        <div class="set-field"><label>${t('chat.ctLabel')}<span id="sp-ct-v">${cv.compressThreshold ?? 80}%</span></label>
          <input type="range" id="sp-ct" min="50" max="100" step="5" value="${cv.compressThreshold ?? 80}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-field"><label>${t('chat.cgLabel')}<span id="sp-cg-v">${cv.compressTarget ?? 20}%</span></label>
          <input type="range" id="sp-cg" min="10" max="30" step="5" value="${cv.compressTarget ?? 20}" style="width:260px" ${cv.contextEnabled === false || cv.autoCompress === false ? 'disabled' : ''} /></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('xy.subAgent')}</div><div class="sc-desc">${t('xy.subAgentDesc')}</div></div>
          <button type="button" class="toggle ${(g.agent?.subAgent ?? false) ? 'on' : ''}" id="sp-subagent"></button></div>
        <div class="set-desc" id="sp-subagent-hint" style="margin:-6px 0 10px;min-height:16px"></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('chat.cacheOpt')}</div><div class="sc-desc">${t('chat.cacheOptDesc')}</div></div>
          <button type="button" class="toggle ${g.chat?.cacheOptimize !== false ? 'on' : ''}" id="sp-cacheopt"></button></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('chat.retryOn')}</div><div class="sc-desc">${t('chat.retryOnDesc')}</div></div>
          <button type="button" class="toggle ${cv.retryEnabled !== false ? 'on' : ''}" id="sp-retryon"></button></div>
        <div class="set-field"><label>${t('chat.retryLabel')}</label>
          <input type="number" id="sp-retry" min="1" max="50" value="${cv.maxRetries ?? 3}" style="width:120px" ${cv.retryEnabled === false ? 'disabled' : ''} /></div>
        <div class="set-status" id="sp-chat-status"></div>
      `)
      const syncDisabled = () => {
        const ctx = $('sp-ctx').classList.contains('on'), ac = $('sp-compress').classList.contains('on')
        $('sp-compress').disabled = !ctx
        $('sp-ct').disabled = !ctx || !ac
        $('sp-cg').disabled = !ctx || !ac
        $('sp-retry').disabled = !$('sp-retryon').classList.contains('on') // #322：重试开关关闭→次数禁用
      }
      $('sp-chat-model').onchange = async (e) => {
        await saveAppSettings({ model: { default: e.target.value } })
        const hint = $('sp-chat-model-hint')
        hint.textContent = e.target.value ? t('chat.setDefault') : t('chat.unsetHint')
        setTimeout(() => { hint.textContent = '' }, 2500)
      }
      $('sp-ctx').onclick = (e) => { e.currentTarget.classList.toggle('on'); syncDisabled(); saveChat() }
      $('sp-retryon').onclick = (e) => { e.currentTarget.classList.toggle('on'); syncDisabled(); saveChat() }
      $('sp-compress').onclick = (e) => { e.currentTarget.classList.toggle('on'); saveChat() }
      $('sp-ct').oninput = (e) => { $('sp-ct-v').textContent = `${e.target.value}%` }
      $('sp-cg').oninput = (e) => { $('sp-cg-v').textContent = `${e.target.value}%` }
      const saveChat = async () => {
        const st = $('sp-chat-status')
        st.className = 'set-status'; st.textContent = t('ui.saving')
        // #322.2：单一 chat 对象——历史双 chat key 后者覆盖前者，maxRetries 等字段被静默丢弃（保存成功但无效）
        const r = await saveAppSettings({
          chat: {
            ...(APP_SETTINGS.chat ?? {}),
            contextEnabled: $('sp-ctx').classList.contains('on'),
            autoCompress: $('sp-compress').classList.contains('on'),
            compressThreshold: Number($('sp-ct').value),
            compressTarget: Number($('sp-cg').value),
            retryEnabled: $('sp-retryon').classList.contains('on'),
            maxRetries: Number($('sp-retry').value) || 3,
            cacheOptimize: $('sp-cacheopt').classList.contains('on'),
          },
          agent: { subAgent: $('sp-subagent').classList.contains('on') },
        })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? t('ui.saved') + t('ui.appliesInstant') : (r.error ?? t('ui.saveFail'))
        void refreshSubAgentHint()
      }
      for (const id of ['sp-ctx', 'sp-compress', 'sp-ct', 'sp-cg', 'sp-retry', 'sp-retryon', 'sp-subagent', 'sp-cacheopt']) $(id).onchange = saveChat
      // #317.6b：子任务准入提示（当前默认模型判定；总闸关=显示总闸提示）
      const refreshSubAgentHint = async () => {
        const el = $('sp-subagent-hint'); if (!el) return
        try {
          const r = await window.moonlybox.rpc('settings', { op: 'subAgentVerdict' }, 10_000)
          if (r.event === 'done' && r.code === 0) {
            const v = JSON.parse(r.text)
            const on = $('sp-subagent').classList.contains('on')
            el.textContent = on ? (v.hint || t('xy.subAgentOk')) : (v.hint || t('xy.subAgentOff'))
            el.style.color = (v.allow && on) || (!v.allow && !on) ? '' : 'var(--warn, #c80)'
          }
        } catch { el.textContent = '' }
      }
      refreshSubAgentHint()
    } else if (cat.id === 'library') {
      // #316.7：gset 先取（模板内 modelPickerOpts 求值需要）
      const gset = await loadAppSettings()
      panel(t('panel.library'), t('panel.sub.library'), `
        <div class="set-h2">${t('lib.vault')}</div>
        <div class="set-field"><div class="set-row" style="margin:0"><input id="sp-vault" readonly placeholder=\"${t('lib.notChosen')}\" style="flex:1" /><button type="button" class="btn ghost" id="sp-vault-pick">选择…</button></div></div>
        <div class="set-row" style="margin:0"><button type="button" class="btn ghost" id="sp-vault-migrate" style="font-size:12px">${t('lib.migrateBtn')}</button><span class="set-desc" style="align-self:center;margin:0">${t('lib.migrateNote')}</span></div>
        <div class="set-status" id="sp-vault-status"></div>
        <div class="set-h2">${t('lib.compileTitle')}</div>
        <div class="set-desc" style="margin:0 0 10px">${t('lib.compileDesc')}</div>
        <div class="set-field"><label>${t('lib.compileModel')}</label>
          <select id="sp-compile-model" class="set-select set-select-sm" style="max-width:420px">
            <option value="">${t('lib.compileFollow')}</option>
            ${modelPickerOpts(gset?.model?.default ?? '')}
          </select>
          <div class="set-desc" style="margin-top:4px">${t('lib.compileHint')}</div>
        </div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('lib.compileSync')}</div><div class="sc-desc">${t('lib.compileSyncDesc')}</div></div>
          <button type="button" class="toggle ${gset?.model?.syncToMoon !== false ? 'on' : ''}" id="sp-compile-sync"></button></div>
        <div class="set-status" id="sp-compile-status"></div>
      `)
      $('sp-vault').value = (await window.moonlybox.vaultGet()) ?? ''
      // #316.7：知识整理默认模型（存 model.compileDefault——解析回落链见 compile-model.ts）
      $('sp-compile-model').value = gset.model?.compileDefault ?? ''
      // #316 第三批：回传云端开关（默认开；false 才关——compile-runner 同语义）
      $('sp-compile-sync').onclick = async (e) => {
        const btn = e.currentTarget
        const next = !btn.classList.contains('on')
        btn.classList.toggle('on', next)
        await saveAppSettings({ model: { syncToMoon: next } })
        const st = $('sp-compile-status')
        st.className = 'set-status ok'; st.textContent = t('ui.saved')
        setTimeout(() => { st.textContent = '' }, 2000)
        // #310.39：开关打开→补传存量产物（编译/同步解耦；幂等——已回传的 cloudWikiId 防重复）
        if (next) {
          try {
            const rb = await window.moonlybox.rpc('tasks', { op: 'backfill_push' }, 120_000)
            const db = JSON.parse(rb.text ?? '{}')
            if (db.ok) {
              // #310.40：三闸结果全部回显（0 篇也要让用户知道原因——未登录/开关/无云端归属不再静默）
              st.textContent = db.reason ? `${t('lib.backfillNone')}（${db.reason}）` : t('lib.backfillDone').replace('{s}', db.scanned).replace('{p}', db.pushed)
              st.className = 'set-status ' + (db.reason ? 'warn' : 'ok')
              // #310.55：补传后顺带下行对账——结果回显（下行 N 更新/豁免静默；error 警示但不阻断）
              if (db.down) {
                if (db.down.error) { st.textContent += `；${t('lib.syncDownFail')}（${db.down.error}）`; st.className = 'set-status warn' }
                else if (db.down.marked) st.textContent += `；${t('lib.syncMarked').replace('{n}', db.down.marked)}`
                else if (db.down.downloaded || db.down.updated) st.textContent += `；${t('lib.syncDownDone').replace('{n}', (db.down.downloaded + db.down.updated))}`
              }
              setTimeout(() => { st.textContent = '' }, 15_000) // #310.41：15s（6s 用户反馈「一闪而过」看不清）
            }
          } catch {}
        }
      }
      $('sp-compile-model').onchange = async (e) => {
        await saveAppSettings({ model: { compileDefault: e.target.value } })
        const st = $('sp-compile-status')
        st.className = 'set-status ok'
        st.textContent = t('ui.saved')
        setTimeout(() => { st.textContent = '' }, 2000)
      }
      $('sp-vault-pick').onclick = async () => {
        const r = await window.moonlybox.vaultPick()
        if (r.ok) {
          $('sp-vault').value = r.root
          $('sp-vault-status').className = 'set-status ok'
          $('sp-vault-status').textContent = t('lib.savedRestart')
        }
      }
      // #310.10：迁移弹窗——选目录→弹窗内执行（目标非空阻断/不支持覆盖）→成功自动切换+内核重启
      $('sp-vault-migrate').onclick = () => {
        const dlg = document.createElement('dialog')
        dlg.innerHTML = `
          <div class="dlg-body" style="min-width:460px">
            <div class="sc-title" style="font-size:15px;font-weight:600;margin-bottom:8px">${t('lib.migrateTitle')}</div>
            <div class="set-desc" style="margin-bottom:12px;line-height:1.7">${t('lib.migrateNow')}${$('sp-vault').value ?? t('lib.notChosenParen')}<br/>${t('lib.migrateDesc2')}</div>
            <div class="set-field"><label>${t('lib.migrateNew')}</label>
              <div class="set-row" style="margin:0"><input id="mg-target" readonly placeholder="${t('lib.migPick')}" style="flex:1" /><button type="button" class="btn ghost" id="mg-pick">${t('lib.migChoose')}</button></div>
            </div>
            <div class="set-status" id="mg-status" style="margin-top:10px"></div>
            <div class="set-row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="mg-go" disabled>${t('lib.migrateStart')}</button><button class="btn ghost" id="mg-cancel">${t('ui.cancel')}</button></div>
          </div>`
        document.body.appendChild(dlg)
        dlg.showModal()
        dlg.querySelector('#mg-cancel').onclick = () => { dlg.close(); dlg.remove() }
        dlg.querySelector('#mg-pick').onclick = async () => {
          const r = await window.moonlybox.pickFolder()
          if (r?.ok) {
            dlg.querySelector('#mg-target').value = r.path
            dlg.querySelector('#mg-go').disabled = false
          }
        }
        dlg.querySelector('#mg-go').onclick = async (e) => {
          const btn = e.currentTarget
          const st = dlg.querySelector('#mg-status')
          btn.disabled = true
          st.className = 'set-status'
          st.textContent = t('lib.migrating')
          const r = await window.moonlybox.vaultMigrate(dlg.querySelector('#mg-target').value)
          if (r.ok) {
            st.className = 'set-status ok'
            st.textContent = `✓ 迁移完成（${r.files} 项）——已切换到 ${r.root}，内核重启中…`
            $('sp-vault').value = r.root
            currentSetCat = 'library'; currentSetSub = null
            setTimeout(() => { dlg.close(); dlg.remove(); renderList('settings'); renderWork('settings') }, 1600)
          } else {
            st.className = 'set-status err'
            st.textContent = '✗ ' + (r.message ?? t('lib.migrateFail'))
            btn.disabled = false
          }
        }
      }
    } else if (cat.id === 'model' && currentSetSub === 'platform') {
      // #283：平台API=多服务商卡片列表——每实例单独配置 key/模型/启停，任一可设为对话默认
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.platform ?? PLATFORM_PROVIDERS_FALLBACK
      const mcfg = g.model ?? {}
      const insts = Array.isArray(mcfg.providers) ? mcfg.providers : []
      const isDefault = (id) => mcfg.default === `platform:${id}`
      const html = (defOpen) => panel(t('panel.model.platform'), t('panel.sub.model.platform'), `
        <div id="sp-pv-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button type="button" class="btn ghost" id="sp-pv-add" style="margin-top:10px">${t('mp.addPv')}</button>
        <div id="sp-pv-form" style="display:${defOpen ? 'block' : 'none'};margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-field"><label>${t('mp.pvLabel')}</label>
            <select id="sp-pv-prov" class="set-select set-select-sm">
              <option value="">${t('mp.pickPv')}</option>
              ${provs.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
            </select>
            <div class="set-desc" style="margin-top:4px" id="sp-pv-docs"></div>
          </div>
          <div class="set-field"><label>${t('mp.model')}</label>
            <div class="set-row" style="margin:0"><input id="sp-pv-model" placeholder="glm-4.5" style="flex:1" />
              <select id="sp-pv-models" class="set-select set-select-sm"><option value="">${t('mp.pickModel')}</option></select></div>
          </div>
          <div class="set-field"><label>API Key</label><input id="sp-pv-key" type="password" placeholder="sk-…" /></div>
          <div class="set-row">
            <button type="button" class="btn" id="sp-pv-save">${t('mp.save')}</button>
            <button type="button" class="btn ghost" id="sp-pv-cancel">${t('mp.cancel')}</button>
            <span class="set-status" id="sp-pv-status"></span>
          </div>
        </div>`)
      html(insts.length === 0)
      const renderList = () => {
        const box = $('sp-pv-list')
        box.innerHTML = ''
        if (!insts.length) { box.innerHTML = `<div class="set-desc">${t('mp.emptyPv')}</div>`; return }
        for (const inst of insts) {
          const pv = provs.find((x) => x.id === inst.providerId)
          const card = document.createElement('div')
          card.className = 'set-card'
          card.innerHTML = `<div class="sc-main"><div class="sc-title">${pv?.label ?? inst.providerId}${isDefault(inst.id) ? ` <span style=\"color:var(--accent);font-size:11px\">${t('mp.default')}</span>` : ''}</div>
            <div class="sc-desc">${inst.model || t('dg.noModel')}${inst.hasKey || inst.enabled ? '' : t('mp.noKey')}</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              ${isDefault(inst.id) ? '' : `<button type="button" class="btn ghost" data-act="default" style="padding:2px 8px;font-size:11px">${t('mp.setDefault')}</button>`}
              <button type="button" class="btn ghost" data-act="del" style="padding:2px 8px;font-size:11px">${t('mp.del')}</button>
              <select class="set-select set-select-sm" data-act="subov" title="${t('xy.subAgent')}" style="padding:2px 6px;font-size:11px;width:auto">
                <option value="auto" ${inst.subAgentOverride == null || inst.subAgentOverride === 'auto' ? 'selected' : ''}>${t('xy.subOvAuto')}</option>
                <option value="on" ${inst.subAgentOverride === true ? 'selected' : ''}>${t('xy.subOvOn')}</option>
                <option value="off" ${inst.subAgentOverride === false ? 'selected' : ''}>${t('xy.subOvOff')}</option>
              </select>
              <button type="button" class="toggle ${inst.enabled ? 'on' : ''}" data-act="toggle"></button>
            </div>`
          card.querySelector('[data-act=subov]').onchange = async (e) => {
            const v = e.currentTarget.value === 'on' ? true : e.currentTarget.value === 'off' ? false : 'auto'
            const arr = insts.map((x) => (x.id === inst.id ? { ...x, subAgentOverride: v } : x))
            await saveAppSettings({ model: { providers: arr } })
          }
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
        $('sp-pv-docs').innerHTML = pv ? `${t('mp.keyDocs')}<a href="#" data-ext="${pv.docs}">${pv.docs}</a>` : ''
        $('sp-pv-docs').querySelectorAll('[data-ext]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); window.moonlybox.openExternal(a.dataset.ext) } })
        $('sp-pv-models').innerHTML = '<option value="">' + t('mp.recommended') + '</option>' + (pv ? pv.models.map((m) => `<option value="${m}">${m}</option>`).join('') : '')
      }
      $('sp-pv-models').onchange = () => { if ($('sp-pv-models').value) $('sp-pv-model').value = $('sp-pv-models').value }
      $('sp-pv-save').onclick = async () => {
        const st = $('sp-pv-status')
        st.className = 'set-status'; st.textContent = t('ui.saving')
        const providerId = $('sp-pv-prov').value
        const model = $('sp-pv-model').value.trim()
        const apiKey = $('sp-pv-key').value.trim()
        if (!providerId || !model) { st.className = 'set-status err'; st.textContent = t('mp.required'); return }
        const inst = { id: `platform_${providerId}_${Date.now().toString(36)}`, providerId, enabled: true, model, ...(apiKey ? { apiKey } : {}) }
        const arr = [...insts, inst]
        const r = await saveAppSettings({ model: { providers: arr, ...(insts.length === 0 ? { default: `platform:${inst.id}` } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        if (r.ok) renderWork('settings')
        else st.textContent = r.error ?? t('ui.saveFail')
      }
    } else if (cat.id === 'model' && currentSetSub === 'local') {
      // #310.11：本地部署四态探测（公用不私用：检测已有 Ollama 直接复用，不重复安装；失效给修复入口）
      // #317.F16/P3f：骨架占位——rpc 返回前布局固定（硬件检测中动效+名单等待语），避免打开时空窗后跳变
      const lmSkel = (inner) => `<div style="border:1px solid var(--border);border-radius:10px;padding:11px 16px;background:var(--bg2);font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:8px">
        <span class="lm-spin" style="width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--fg,#e2e8f0);border-radius:50%;display:inline-block;animation:lmSpin 0.8s linear infinite;flex:none"></span>${inner}</div>`
      panel(t('panel.model.local'), t('panel.sub.model.local'), `
        <style>@keyframes lmSpin{to{transform:rotate(360deg)}}</style>
        <div id="sp-lm-profile">${lmSkel('正在检测本机硬件（内存/显卡/磁盘）…')}</div>
        <div id="sp-ol-state" class="set-card" style="margin-top:10px"><div class="sc-main"><div class="sc-title">${t('ol.detecting')}</div><div class="sc-desc">${t('ol.detectDesc')}</div></div></div>
        <div id="sp-lm-catalog" style="margin-top:10px">${lmSkel('等待硬件检测结果后查询推荐模型清单…')}</div>
      `)
      // #317.F16/P1：硬件画像+模型名单卡（fit 分级）——主体是「模型本身」，Ollama 降权为状态条
      // #317.F16/P3j：抽具名函数——Ollama「启动」成功后需重拉名单（模型卡「未安装/未运行」stale 问题）
      const renderCatalog = async () => {
        const profBox = $('sp-lm-profile'); const catBox = $('sp-lm-catalog')
        if (!profBox || !catBox) return
        let lm = null
        try {
          const r = await window.moonlybox.rpc('localModels', {}, 10000)
          if (r && r.event === 'done' && r.code === 0) lm = JSON.parse(r.text)
        } catch {}
        if (!lm || !lm.ok) {
          profBox.innerHTML = ''
          catBox.innerHTML = `<div style="border:1px solid var(--err,#ef4444);border-radius:10px;padding:12px 16px;background:var(--bg2);font-size:12.5px;color:var(--err,#ef4444)">模型名单加载失败（${esc(lm?.error ?? 'daemon 无响应')}）——其余功能不受影响，可重进设置页重试。</div>`
          return
        }
        const hw = lm.hw
        const FIT_BADGE = {
          recommended: { txt: '推荐', color: 'var(--ok,#22c55e)' },
          ok: { txt: '可用', color: 'var(--muted)' },
          warn: { txt: '勉强', color: 'var(--warn,#f59e0b)' },
          blocked: { txt: '不建议', color: 'var(--err,#ef4444)' },
        }
        profBox.innerHTML = `<div style="border:1px solid var(--border);border-radius:10px;padding:11px 16px;background:var(--bg2);font-size:12.5px;display:flex;gap:14px;flex-wrap:wrap;color:var(--muted)">
          <span>💾 内存 <b style="color:var(--fg)">${hw.memTotalGB.toFixed(0)}GB</b>（可用 ${hw.memFreeGB.toFixed(0)}GB）</span>
          ${hw.gpuName ? `<span>🖥 GPU ${esc(hw.gpuName)}</span>` : '<span>🖥 无独显信息（按内存评估）</span>'}
          ${hw.diskFreeGB != null ? `<span>📀 磁盘余量 <b style="color:var(--fg)">${hw.diskFreeGB.toFixed(0)}GB</b></span>` : ''}
        </div>`
        // #317.F16/P2：GPU 预期说明（感知不配置——Ollama 自动 offload，客户端只管说清楚）
        const gpuHint = hw.gpuName ? '检测到独显：Ollama 将自动用 GPU 加速（快）' : '未检测到独显：纯 CPU 运行，大模型较慢，建议选小档'
        // #317.F16/P3k：本机其他已装模型（名单外自装，如 deepseek-r1:8b）收编进名单卡——老「勾选接入」卡退役
        const otherHtml = (lm.otherInstalled && lm.otherInstalled.length) ? `
          <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:11.5px;color:var(--muted)">本机其他已装模型（名单外自装）</div>
          ${lm.otherInstalled.map((o) => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:12px 16px;background:var(--bg2);margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <b style="font-size:13.5px">${esc(o.id)}</b>
              <span style="font-size:11px;color:var(--muted)">${o.sizeGB != null ? o.sizeGB.toFixed(1) + 'GB' : ''}</span>
              ${o.configured ? '<span style="font-size:11px;color:var(--ok,#22c55e)">✓ 已接入</span>' : '<span style="font-size:11px;color:var(--muted)">未接入</span>'}
              <span style="flex:1"></span>
              ${o.configured
                ? `<button type="button" class="btn ghost" data-lmremove-other="${esc(o.instanceId ?? o.id)}" data-lmremove-name="${esc(o.id)}" style="font-size:12px">解除接入</button>`
                : `<button type="button" class="btn ghost" data-lmadd-other="${esc(o.id)}" style="font-size:12px">接入</button>`}
            </div>
            ${o.configured ? `<div style="margin-top:6px;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted)">子任务调用
              <select class="set-select set-select-sm" data-olsubov="${esc(o.id)}" style="padding:2px 6px;font-size:11px;width:auto">
                <option value="auto">跟随默认</option><option value="on">允许</option><option value="off">禁止</option>
              </select></div>` : ''}
          </div>`).join('')}` : ''
        catBox.innerHTML = `<div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">${gpuHint}</div>` + lm.models.map((m) => {
          const b = FIT_BADGE[m.fit] || FIT_BADGE.ok
          const stateTxt = m.installed ? (lm.ollamaState === 'running' ? '✅ 就绪' : '已安装（Ollama 未运行）') : '未安装'
          const canAct = lm.ollamaState === 'running' && m.fit !== 'blocked'
          let actions = ''
          if (m.fit === 'blocked') {
            actions = `<button type="button" class="btn ghost" disabled style="font-size:12px;opacity:.5">不建议安装</button>`
          } else if (!m.installed) {
            actions = `<button type="button" class="btn ghost" data-lmpull="${esc(m.id)}" ${lm.ollamaState === 'running' ? '' : 'disabled title="先启动 Ollama（下方）"'} style="font-size:12px">安装</button>`
          } else if (!m.configured) {
            actions = `<button type="button" class="btn ghost" data-lmadd="${esc(m.id)}" ${lm.ollamaState === 'running' ? '' : 'disabled'} style="font-size:12px">接入</button>`
          } else if (lm.defaultModel === m.instanceId) {
            actions = `<span style="font-size:11.5px;color:var(--ok,#22c55e)">✓ 对话默认</span>`
          } else {
            actions = `<button type="button" class="btn ghost" data-lmdefault="${esc(m.instanceId)}" style="font-size:12px">设为对话默认</button>`
          }
          // #317.F16/P3：调优折叠区（已接入卡；temperature/max_tokens 用户可改+恢复默认）
          const tuneId = `sp-lm-tune-${esc(m.id).replace(/[^a-z0-9]/gi, '-')}`
          const tuneBlock = m.configured ? `
            <div style="margin-top:6px"><button type="button" class="btn ghost" data-lmtune="${tuneId}" style="font-size:11px;padding:2px 8px">调优 ▸</button></div>
            <div id="${tuneId}" style="display:none;margin-top:6px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;font-size:12px">
              <label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px">温度
                <input type="number" step="0.1" min="0" max="2" value="${m.params?.temperature ?? 0.3}" data-lmtemp="${esc(m.id)}" class="set-input" style="width:70px;padding:2px 6px;font-size:12px"></label>
              <label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px" title="单次回复最多生成多少 token——防止慢模型长时间占用；与上下文窗口（能读多少）是两回事">生成上限 max_tokens
                <input type="number" step="256" min="256" max="16384" value="${m.params?.maxTokens ?? 4096}" data-lmmaxtok="${esc(m.id)}" class="set-input" style="width:90px;padding:2px 6px;font-size:12px"></label>
              <label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px">子任务调用
                <select class="set-select set-select-sm" data-olsubov="${esc(m.id)}" style="padding:2px 6px;font-size:11px;width:auto">
                  <option value="auto">跟随默认</option><option value="on">允许</option><option value="off">禁止</option>
                </select></label>
              <button type="button" class="btn ghost" data-lmreset="${esc(m.id)}" style="font-size:11px;padding:2px 8px">恢复默认</button>
              <span style="font-size:10.5px;color:var(--muted)">修改即时生效（对话请求层）；上下文窗口 ${m.ctxSuggest ?? 8192} 已按本机内存自动配置（Ollama 服务层）</span>
            </div>` : ''
          return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 16px;background:var(--bg2)">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <b style="font-size:13.5px">${esc(m.title)}</b>
              <span style="font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid ${b.color};color:${b.color}">${b.txt}</span>
              <span style="font-size:11px;color:var(--muted)">${stateTxt}</span>
              <span style="flex:1"></span>
              <span style="font-size:11px;color:var(--muted)">${m.sizeGB.toFixed(1)}GB · 上下文 ${m.ctxSuggest}</span>
              ${actions}
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">${esc(m.tagline)}</div>
            ${m.fitReason ? `<div style="font-size:11.5px;color:${b.color};margin-top:4px">${esc(m.fitReason)}</div>` : ''}
            ${m.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;opacity:.85">ℹ ${esc(m.notes)}</div>` : ''}
            ${m.caps && m.caps.length ? `<div style="margin-top:5px;display:flex;gap:5px;flex-wrap:wrap">${m.caps.map((c) => `<span style="font-size:10.5px;padding:1px 7px;border-radius:5px;background:var(--bg3,#1e293b);color:var(--muted)">${c === 'tools' ? '工具调用' : c === 'thinking' ? '思考' : c === 'embed' ? '嵌入检索' : c}</span>`).join('')}</div>` : ''}
            ${tuneBlock}
          </div>`
        }).join('<div style="height:8px"></div>') + otherHtml
        // P2 动作接线
        catBox.querySelectorAll('[data-lmpull]').forEach((el) => { el.onclick = async () => {
          const name = el.dataset.lmpull; el.disabled = true; el.textContent = '安装中…'
          const g = await loadAppSettings(); const cli = ((g.general ?? {}).ollamaCli) || null
          const r = await window.moonlybox.ollamaPullTerm({ cli, model: name })
          if (r && r.ok) { el.textContent = '终端已拉起，完成后自动点亮'; setTimeout(() => renderWork('settings'), 2500) }
          else { el.disabled = false; el.textContent = '安装' }
        } })
        catBox.querySelectorAll('[data-lmadd]').forEach((el) => { el.onclick = async () => {
          const name = el.dataset.lmadd; el.disabled = true
          const g = await loadAppSettings(); const mcfg = g.model ?? {}
          const arr = [...(mcfg.local ?? [])]
          if (!arr.some((x) => x.model === name)) arr.push({ id: `ol-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `Ollama · ${name}`, model: name, enabled: true, baseUrl: 'http://127.0.0.1:11434/v1' })
          const r = await saveAppSettings({ model: { local: arr, ...(arr.length && !mcfg.default ? { default: `local:${arr[0].id}` } : {}) } })
          if (r.ok) renderWork('settings')
        } })
        catBox.querySelectorAll('[data-lmdefault]').forEach((el) => { el.onclick = async () => {
          const id = el.dataset.lmdefault; el.disabled = true
          const r = await saveAppSettings({ model: { default: `local:${id}` } })
          if (r.ok) renderWork('settings')
        } })
        // #317.F16/P3：调优折叠+保存（temperature/max_tokens 即时生效；恢复默认=删 params 键）
        catBox.querySelectorAll('[data-lmtune]').forEach((el) => { el.onclick = () => {
          const box = document.getElementById(el.dataset.lmtune)
          if (box) { const open = box.style.display === 'none'; box.style.display = open ? '' : 'none'; el.textContent = open ? '调优 ▾' : '调优 ▸' }
        } })
        const saveParam = async (modelTag, key, value) => {
          const g = await loadAppSettings()
          const arr = (g.model?.local ?? []).map((x) => (x.model === modelTag ? { ...x, params: { ...(x.params ?? {}), [key]: value } } : x))
          return saveAppSettings({ model: { local: arr } })
        }
        catBox.querySelectorAll('input[data-lmtemp]').forEach((el) => { el.onchange = async () => {
          const v = Math.max(0, Math.min(2, Number(el.value) || 0.3))
          el.value = v
          const r = await saveParam(el.dataset.lmtemp, 'temperature', v)
          if (!r.ok) el.style.borderColor = 'var(--err,#ef4444)'
        } })
        catBox.querySelectorAll('input[data-lmmaxtok]').forEach((el) => { el.onchange = async () => {
          const v = Math.max(256, Math.min(16384, Number(el.value) || 4096))
          el.value = v
          const r = await saveParam(el.dataset.lmmaxtok, 'maxTokens', v)
          if (!r.ok) el.style.borderColor = 'var(--err,#ef4444)'
        } })
        catBox.querySelectorAll('[data-lmreset]').forEach((el) => { el.onclick = async () => {
          const tag = el.dataset.lmreset
          const g = await loadAppSettings()
          const arr = (g.model?.local ?? []).map((x) => (x.model === tag ? { ...x, params: undefined } : x))
          await saveAppSettings({ model: { local: arr } })
          renderWork('settings')
        } })
        // #317.F16/P3k：其他已装模型——接入/解除/子任务覆盖
        catBox.querySelectorAll('[data-lmadd-other]').forEach((el) => { el.onclick = async () => {
          const name = el.dataset.lmaddOther; el.disabled = true; el.textContent = '接入中…'
          const g = await loadAppSettings()
          const mcfg = g.model ?? {}
          const arr = [...(mcfg.local ?? [])]
          if (!arr.some((x) => x.model === name)) {
            arr.push({ id: `ol-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `Ollama · ${name}`, model: name, enabled: true, baseUrl: 'http://127.0.0.1:11434/v1' })
          }
          const r = await saveAppSettings({ model: { local: arr, ...(arr.length && !mcfg.default ? { default: `local:${arr[0].id}` } : {}) } })
          if (r.ok) renderCatalog(); else { el.disabled = false; el.textContent = '接入' }
        } })
        catBox.querySelectorAll('[data-lmremove-other]').forEach((el) => { el.onclick = async () => {
          const id = el.dataset.lmremoveOther; const name = el.dataset.lmremoveName
          const g = await loadAppSettings()
          const mcfg = g.model ?? {}
          const inst = (mcfg.local ?? []).find((x) => x.id === id)
          const arr = (mcfg.local ?? []).filter((x) => x.id !== id)
          // 边界：解除的是当前对话默认→清 default 指向（避免悬空引用）
          const wasDefault = inst && mcfg.default === `local:${inst.id}`
          const r = await saveAppSettings({ model: { local: arr, ...(wasDefault ? { default: '' } : {}) } })
          if (r.ok) {
            if (wasDefault) { /* default 已清空：对话会回退云端默认，名单卡刷新后可重选 */ }
            renderCatalog()
          }
        } })
        catBox.querySelectorAll('select[data-olsubov]').forEach((sel) => {
          // 预选已存值
          ;(async () => {
            try {
              const g = await loadAppSettings()
              const inst = (g.model?.local ?? []).find((x) => x.model === sel.dataset.olsubov)
              const v = inst?.subAgentOverride
              sel.value = v === true ? 'on' : v === false ? 'off' : 'auto'
            } catch {}
          })()
          sel.onchange = async (e) => {
            e.stopPropagation()
            const name = e.currentTarget.dataset.olsubov
            const v = e.currentTarget.value === 'on' ? true : e.currentTarget.value === 'off' ? false : 'auto'
            const g2 = await loadAppSettings()
            const arr2 = (g2.model?.local ?? []).map((x) => (x.model === name ? { ...x, subAgentOverride: v } : x))
            await saveAppSettings({ model: { local: arr2 } })
          }
        })
      }
      renderCatalog()
      {
        const box = $('sp-ol-state')
        const renderState = async () => {
          let savedCli = null
          try { savedCli = ((await loadAppSettings()).general ?? {}).ollamaCli ?? null } catch {}
          const p = await window.moonlybox.ollamaProbe(savedCli)
          if (!p) { box.innerHTML = `<div class="sc-main"><div class="sc-title">${t('ol.detectFail')}</div><div class="sc-desc">${t('ol.retryHint')}</div></div>`; return }
          if (p.state === 'running') {
            // #317.F15b：运行时上下文可见化——4096 默认值会静默截断工具表，在配置页就告诉用户（不用等对话失败）
            const ctxLine = typeof p.context === 'number' && p.context < 8192
              ? `<div class="sc-desc" style="color:var(--warn,#f59e0b)">⚠ 上下文窗口 ${p.context}（过小：工具清单会被截断）——退出 Ollama 后设置环境变量 OLLAMA_CONTEXT_LENGTH=32768 再启动，或点上方「启动」由本客户端按内存自动配置</div>`
              : (typeof p.context === 'number' ? `<div class="sc-desc">上下文窗口：${p.context}</div>` : '')
            // #317.F16/P3e：依赖卡收敛——单行「✅ Ollama v0.35 · 上下文 N」；长说明只在异常时出现
            const ctxTxt = typeof p.context === 'number' ? ` · 上下文 ${p.context}` : ''
            const warnTxt = typeof p.context === 'number' && p.context < 8192
              ? `<div class="sc-desc" style="color:var(--warn,#f59e0b)">⚠ 上下文 ${p.context} 过小（工具清单会被截断）——点下方「启动」由本客户端按内存自动重配</div>`
              : ''
            box.innerHTML = `<div class="sc-main"><div class="sc-title">✅ Ollama 运行中 ${p.version ? 'v' + esc(p.version) : ''}${ctxTxt}</div>${warnTxt}</div>`
          } else if (p.state === 'installed_stopped') {
            // #317.F16/P3e：单行「Ollama v0.32 · 未运行 [启动]」
            box.innerHTML = `<div class="sc-main" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div class="sc-title">Ollama ${p.version ? 'v' + esc(p.version) : ''} · 未运行</div>
              <button type="button" class="btn ghost" id="sp-ol-start" style="font-size:12px;padding:3px 12px">${t('ol.startBtn')}</button></div>`
            $('sp-ol-start').onclick = async () => {
              const b = $('sp-ol-start'); b.disabled = true; b.textContent = t('ol.starting')
              const r = await window.moonlybox.ollamaServe(p.cli)
              if (r && r.ok) {
                // #317.F15b：启动即按内存配好上下文（≥14G→32768/≥7G→16384/≥3.5G→8192）——安装全程无需用户手配
                if (r.contextLength) { b.textContent = `${t('ol.startBtn')} ✓（上下文 ${r.contextLength}）` } 
                await renderState()
                renderCatalog() // #317.F16/P3j：名单卡当时渲染的 ollamaState=not running（模型卡「未运行/未安装」stale）——启动成功后整卡重拉
              } else { b.disabled = false; b.textContent = t('ol.startRetry'); }
            }
          } else {
            box.innerHTML = `<div class="sc-main"><div class="sc-title">${t('ol.notFoundTitle')}</div>
              <div class="sc-desc">${t('ol.notFoundDesc')}</div>
              <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="btn ghost" id="sp-ol-dl">${t('ol.dlBtn')}</button>
                <button type="button" class="btn ghost" id="sp-ol-pick">${t('ol.pickBtn')}</button>
                <button type="button" class="btn ghost" id="sp-ol-recheck">${t('ol.recheck')}</button>
              </div>
              <div class="set-status" id="sp-ol-pick-status" style="margin-top:6px"></div></div>`
            $('sp-ol-dl').onclick = () => window.moonlybox.openExternal('https://ollama.com/download')
            $('sp-ol-recheck').onclick = () => renderState()
            // #310.12：手工定位——文件选择→--version 校验→存 settings.general.ollamaCli→重探
            $('sp-ol-pick').onclick = async () => {
              const st = $('sp-ol-pick-status')
              const r = await window.moonlybox.ollamaPick()
              if (r.canceled) return
              if (!r.ok) { st.className = 'set-status err'; st.textContent = r.error ?? t('ol.pickFail'); return }
              const g = await loadAppSettings()
              await saveAppSettings({ general: { ...(g.general ?? {}), ollamaCli: r.cli } })
              st.className = 'set-status ok'
              st.textContent = t('ol.pickedOk').replace('{v}', r.version)
              // #310.12.1：反馈可读——立即重探会重建状态条把绿字瞬间抹掉（用户实测一闪即逝），延迟 1.2s 再接管
              setTimeout(() => { renderState() }, 1200)
            }
          }
        }
        renderState()
      }
    } else if (cat.id === 'model' && currentSetSub === 'custom') {
      // #283：自定义=多模型列表——每条单独启停/删除，任一可设为对话默认；key 走钥匙串
      const g = await loadAppSettings()
      const mcfg = g.model ?? {}
      const insts = Array.isArray(mcfg.custom) ? mcfg.custom : []
      const isDefault = (id) => mcfg.default === `custom:${id}`
      panel(t('panel.model.custom'), t('panel.sub.model.custom'), `
        <div id="sp-cu-list" style="display:flex;flex-direction:column;gap:8px"></div>
        <button type="button" class="btn ghost" id="sp-cu-add" style="margin-top:10px">${t('mp.addCustom')}</button>
        <div id="sp-cu-form" style="display:${insts.length === 0 ? 'block' : 'none'};margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-field"><label>${t('mp.name')}</label><input id="sp-cu-name" placeholder="${t('mp.ollamaEg')}" /></div>
          <div class="set-field"><label>${t('mp.baseUrl')}</label><input id="sp-cu-url" placeholder="http://127.0.0.1:11434/v1（Ollama）或 https://your-endpoint.example.com/v1" /></div>
          <div class="set-field"><label>${t('mp.model')}</label><input id="sp-cu-model" placeholder="your-model" /></div>
          <div class="set-field"><label>${t('mp.key')}</label><input id="sp-cu-key" type="password" placeholder="sk-…" /></div>
          <div class="set-row">
            <button type="button" class="btn" id="sp-cu-save">${t('ui.save')}</button>
            <button type="button" class="btn ghost" id="sp-cu-cancel">${t('ui.cancel')}</button>
            <span class="set-status" id="sp-cu-status"></span>
          </div>
        </div>`)
      const renderList = () => {
        const box = $('sp-cu-list')
        box.innerHTML = ''
        if (!insts.length) { box.innerHTML = `<div class="set-desc">${t('mp.customEmpty')}</div>`; return }
        for (const inst of insts) {
          const card = document.createElement('div')
          card.className = 'set-card'
          card.innerHTML = `<div class="sc-main"><div class="sc-title">${inst.name || t('ui.untitled')}${isDefault(inst.id) ? ` <span style=\"color:var(--accent);font-size:11px\">${t('mp.default')}</span>` : ''}</div>
            <div class="sc-desc">${inst.model} · ${inst.baseUrl}</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              ${isDefault(inst.id) ? '' : `<button type="button" class="btn ghost" data-act="default" style="padding:2px 8px;font-size:11px">${t('mp.setDefault')}</button>`}
              <select class="set-select set-select-sm" data-act="subov" title="${t('xy.subAgent')}" style="padding:2px 6px;font-size:11px;width:auto">
                <option value="auto" ${inst.subAgentOverride == null || inst.subAgentOverride === 'auto' ? 'selected' : ''}>${t('xy.subOvAuto')}</option>
                <option value="on" ${inst.subAgentOverride === true ? 'selected' : ''}>${t('xy.subOvOn')}</option>
                <option value="off" ${inst.subAgentOverride === false ? 'selected' : ''}>${t('xy.subOvOff')}</option>
              </select>
              <button type="button" class="toggle ${inst.enabled ? 'on' : ''}" data-act="toggle"></button>
              <span data-act="del" style="color:var(--muted);cursor:pointer;padding:0 4px">×</span>
            </div>`
          card.querySelector('[data-act=subov]').onchange = async (e) => {
            const v = e.currentTarget.value === 'on' ? true : e.currentTarget.value === 'off' ? false : 'auto'
            const arr = insts.map((x) => (x.id === inst.id ? { ...x, subAgentOverride: v } : x))
            await saveAppSettings({ model: { custom: arr } })
          }
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
        st.className = 'set-status'; st.textContent = t('ui.saving')
        const name = $('sp-cu-name').value.trim()
        const baseUrl = $('sp-cu-url').value.trim().replace(/\/+$/, '')
        const model = $('sp-cu-model').value.trim()
        const apiKey = $('sp-cu-key').value.trim()
        if (!baseUrl || !model) { st.className = 'set-status err'; st.textContent = t('mp.reqBoth'); return }
        if (!/^https?:\/\//.test(baseUrl)) { st.className = 'set-status err'; st.textContent = t('mp.urlScheme'); return }
        const inst = { id: `custom_${Date.now().toString(36)}`, name: name || t('mp.customName'), baseUrl, model, enabled: true, ...(apiKey ? { apiKey } : {}) }
        const r = await saveAppSettings({ model: { custom: [...insts, inst], ...(insts.length === 0 ? { default: `custom:${inst.id}` } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        if (r.ok) renderWork('settings')
        else st.textContent = r.error ?? t('ui.saveFail')
      }

    } else if (cat.id === 'messaging') {
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.messaging ?? []
      const enabled = g.messaging?.providers ?? {}
      panel(t('panel.messaging'), t('panel.sub.messaging'), `
        ${provs.map((p) => {
          const cur = enabled[p.id] ?? { enabled: false }
          return `<div class="set-card"><div class="sc-main"><div class="sc-title">${p.label}</div><div class="sc-desc">${cur.enabled ? '已开启' : '对接后可在此平台收发消息'}</div></div>
            <button type="button" class="toggle ${cur.enabled ? 'on' : ''}" data-msg="${p.id}"></button></div>
          <div data-msgcfg="${p.id}" style="display:${cur.enabled ? 'block' : 'none'};margin:0 0 10px">
            ${p.needs.map((n) => `<div class="set-field" style="max-width:340px"><label>${n.label}${n.secret ? t('mp.wxHint') : ''}</label><input type="${n.secret ? 'password' : 'text'}" data-msgkey="${p.id}.${n.key}" value="${(cur.config ?? {})[n.key] && !n.secret ? (cur.config ?? {})[n.key] : ''}" placeholder="${n.secret ? '已配置时不回显' : ''}" /></div>`).join('')}
            ${p.id === 'weixin' ? `<div class="set-row" style="margin-top:8px"><button type="button" class="btn" id="sp-wx-login">扫码登录（获取 Token）</button><span class="set-desc" id="sp-wx-login-state"></span></div><div id="sp-wx-qr" style="margin-top:8px;max-width:200px"></div>` : ''}
          </div>`
        }).join('')}
        <div class="set-status" id="sp-msg-status"></div>
        <div class="set-row" style="margin-top:10px"><button type="button" class="btn" id="sp-msg-start">${t('msg.gateway')}</button><span class="set-desc" id="sp-msg-run"></span></div>
      `)
      $('sp-msg-start').onclick = async () => {
        const run = $('sp-msg-run')
        run.textContent = t('msg.starting')
        const r = await window.moonlybox.rpc('messaging', { op: 'start' }, 30_000)
        if (r.event === 'done' && r.code === 0) {
          const statuses = JSON.parse(r.text).statuses ?? []
          const parts = statuses.map((s) => `${s.platform}：${s.running ? '✓ ' + t('ui.enable') : `✗ ${s.error ?? t('msg.notStarted')}`}`)
          run.textContent = parts.join('  ') || t('msg.noneEnabled')
        } else run.textContent = `${t('msg.startFail')}${r.message ?? r.text}`
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
            st.textContent = `✗ ${r.message ?? r.text ?? t('msg.queryFail')}`
            return
          }
          const j = JSON.parse(r.text)
          if (j.status === 'wait') st.textContent = t('msg.qrWait')
          else if (j.status === 'scaned') st.textContent = t('msg.qrScanned')
          else if (j.status === 'scaned_but_redirect' && j.redirectHost) {
            wxBase = `https://${j.redirectHost}`
            st.textContent = t('msg.qrScanned')
          } else if (j.status === 'expired') {
            stopWx()
            st.textContent = t('msg.qrExpired')
          } else if (j.status === 'confirmed') {
            stopWx()
            st.textContent = `✓ ${t('msg.loginOk')} (${j.accountId})${t('msg.tokenKept')}`
            const qr = $('sp-wx-qr')
            if (qr) qr.innerHTML = ''
            renderWork('settings')
          }
        }
        wxLoginBtn.onclick = async () => {
          stopWx()
          const st = $('sp-wx-login-state')
          const qrBox = $('sp-wx-qr')
          st.textContent = t('msg.qrGet')
          const r = await window.moonlybox.rpc('messaging', { op: 'wxLoginStart' }, 40_000)
          if (r.event !== 'done' || r.code !== 0) {
            st.textContent = `✗ ${r.message ?? r.text ?? t('msg.qrGetFail')}`
            return
          }
          const j = JSON.parse(r.text)
          wxQrcode = j.qrcode
          wxBase = ''
          if (qrBox) qrBox.innerHTML = j.svg
          st.textContent = t('msg.qrHint')
          stopWx()
          wxTimer = setInterval(pollWx, 3000)
          void pollWx()
        }
      }
      window.moonlybox.rpc('messaging', { op: 'status' }, 10_000).then((r) => {
        if (r.event === 'done' && r.code === 0) {
          const running = JSON.parse(r.text).running ?? []
          if (running.length) $('sp-msg-run').textContent = `${t('msg.runningN')}${running.join('、')}`
        }
      })
      w.querySelectorAll('[data-msg]').forEach((tg) => {
        tg.onclick = () => { tg.classList.toggle('on'); const box = w.querySelector(`[data-msgcfg="${tg.dataset.msg}"]`); if (box) box.style.display = tg.classList.contains('on') ? 'block' : 'none'; saveMessaging() }
      })
      w.querySelectorAll('[data-msgkey]').forEach((inp) => { inp.onchange = saveMessaging })
      async function saveMessaging() {
        const st = $('sp-msg-status'); st.className = 'set-status'; st.textContent = t('ui.saving')
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
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'builtin') {
      const g = await loadAppSettings()
      panel(t('panel.mcp.builtin'), t('panel.sub.mcp.builtin'), `
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('mcp.title')}</div>
          <div class="sc-desc">${t('mcp.desc')}</div></div>
          <button type="button" class="toggle ${g.mcp?.builtinEnabled !== false ? 'on' : ''}" id="sp-mcp-builtin"></button></div>
        <div class="set-status" id="sp-mcp-status"></div>
      `)
      $('sp-mcp-builtin').onclick = async (e) => {
        e.currentTarget.classList.toggle('on')
        const r = await saveAppSettings({ mcp: { builtinEnabled: $('sp-mcp-builtin').classList.contains('on') } })
        const st = $('sp-mcp-status'); st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
      }
    } else if (cat.id === 'mcp' && currentSetSub === 'custom') {
      const g = await loadAppSettings()
      const list = g.mcp?.custom ?? []
      panel(t('panel.mcp.custom'), t('panel.sub.mcp.custom'), `
        <div id="sp-mcp-list">${list.map((m, i) => `<div class="set-field" style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="set-row" style="margin:0 0 6px"><b>${m.name || t('ui.untitled')}</b><span class="set-desc" style="margin:0">${m.enabled !== false ? '已启用' : '已停用'}${m.keyStored ? ' · Key 已存钥匙串' : ''}</span>
            <button type="button" class="btn ghost" data-mcptoggle="${i}" style="margin-left:auto">${m.enabled !== false ? t('ui.stop') : t('ui.enable')}</button>
            <button type="button" class="btn ghost" data-mcpdel="${i}">${t('mcp.del')}</button></div>
          <div class="set-desc" style="margin:0">${m.url}</div></div>`).join('') || '<div class="set-status">暂无自定义 MCP 服务器。</div>'}</div>
        <div class="set-field" style="margin-top:14px"><label>${t('mcp.name')}</label><input id="sp-mcp-name" placeholder="my-mcp" /></div>
        <div class="set-field"><label>URL</label><input id="sp-mcp-url" placeholder="https://…/mcp" /></div>
        <div class="set-field"><label>${t('mcp.keyOpt')}</label><input type="password" id="sp-mcp-key" placeholder="${t('mcp.keyPh')}" /></div>
        <div class="set-row"><button type="button" class="btn" id="sp-mcp-add">${t('mcp.add')}</button><span class="set-status" id="sp-mcp2-status"></span></div>
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
        else { st.className = 'set-status err'; st.textContent = r.error ?? t('ui.saveFail') }
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
            ? items.map((s) => `<div class="set-card"><div class="sc-main"><div class="sc-title">${s.name}</div><div class="sc-desc">${s.description || t('sk.noDesc')}${s.files?.length ? t('sk.filesN').replace('{n}', s.files.length) : ''}</div></div></div>`).join('')
            : '<div class="set-desc">书房暂无技能——在书房目录打开 .moonlybox/skills/&lt;技能名&gt;/SKILL.md（含 name/description 头部）即生效，随书房备份。</div>'
        } else listHtml = '<div class="set-desc">技能清单读取失败。</div>'
      } catch { listHtml = '<div class="set-desc">技能清单读取失败。</div>' }
      panel(t('panel.skills'), t('panel.sub.skills'), `
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('sk.enable')}</div><div class="sc-desc">${t('sk.enableDesc')}</div></div>
          <button type="button" class="toggle ${openState ? 'on' : ''}" id="sp-sk-on"></button></div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="btn ghost" id="sp-sk-open" style="font-size:12px;padding:5px 10px">${t('sk.openDir')}</button><span class="set-desc" style="align-self:center">${t('sk.sideNote')}</span></div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px" id="sp-sk-list">${listHtml}</div>
      `)
      $('sp-sk-on').onclick = async (e) => {
        e.currentTarget.classList.toggle('on')
        await saveAppSettings({ skills: { enabled: e.currentTarget.classList.contains('on') } })
      }
      // #310.3：打开技能目录（书房 vault/.moonlybox/skills）——未选书房时提示
      $('sp-sk-open').onclick = async () => {
        const vault = await window.moonlybox.vaultGet()
        if (!vault) { $('sp-sk-open').textContent = t('sk.pickVaultFirst'); return }
        const err = await window.moonlybox.openPath(vault + '/.moonlybox/skills')
        if (err) $('sp-sk-open').textContent = t('sk.openFail') + err
      }
    } else if (cat.id === 'websearch') {
      // #256.2 用户 5 点：URL 提取并入网络搜索分类（分组块）；选项类=自定义下拉
      const g = await loadAppSettings()
      const provs = APP_PROVIDERS?.websearch ?? []
      const ws = g.websearch ?? {}
      const ue = g.urlextract ?? {}
      panel(t('panel.websearch'), t('panel.sub.websearch'), `
        <div class="sc-title" style="font-size:13.5px;font-weight:600;margin:0 0 10px">${t('ws.title')}</div>
        <div class="set-field" style="max-width:340px"><label>${t('ws.pvLabel')}</label>
          <select id="sp-ws-prov" class="set-select">
            <option value="">${t('ws.none')}</option>
            ${provs.filter((p) => p.id !== 'custom').map((p) => `<option value="${p.id}" ${ws.provider === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <div id="sp-ws-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ws-save">${t('ui.save')}</button><span class="set-status" id="sp-ws-status"></span></div>
        <div class="sc-title" style="font-size:13.5px;font-weight:600;margin:26px 0 10px">${t('ue.title')}</div>
        <div class="set-field" style="max-width:340px"><label>${t('ue.modeLabel')}</label>
          <select id="sp-ue-mode" class="set-select">
            <option value="local" ${ue.mode !== 'provider' ? 'selected' : ''}>${t('ue.local')}</option>
            <option value="provider" ${ue.mode === 'provider' ? 'selected' : ''}>${t('ue.provider')}</option>
          </select>
        </div>
        <div id="sp-ue-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-ue-save">${t('ui.save')}</button><span class="set-status" id="sp-ue-status"></span></div>
      `)
      const renderWsCfg = () => {
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const box = $('sp-ws-cfg')
        if (!pv) { box.innerHTML = ''; return }
        if (pv.baseUrl) box.innerHTML = `<div class="set-field" style="max-width:340px"><label>${t('mp.baseUrlAuto')}</label><input id="sp-ws-baseUrl" value="${pv.baseUrl}" readonly /></div>`
        else box.innerHTML = `<div class="set-field" style="max-width:340px"><label>API 地址</label><input id="sp-ws-baseUrl" value="${ws.config?.baseUrl ?? ''}" placeholder="https://…" /></div>`
        box.innerHTML += `<div class="set-field" style="max-width:340px"><label>${t('mp.keyKept')}</label><input type="password" id="sp-ws-apiKey" placeholder="${ws.config?.apiKey ? '已配置，不回显' : ''}" /></div>`
      }
      $('sp-ws-prov').onchange = renderWsCfg
      renderWsCfg()
      $('sp-ws-save').onclick = async () => {
        const st = $('sp-ws-status'); st.className = 'set-status'; st.textContent = t('ui.saving')
        const pv = provs.find((x) => x.id === $('sp-ws-prov').value)
        const config = {}
        const b = $('sp-ws-baseUrl')
        if (b && b.value) config.baseUrl = b.value
        const k = $('sp-ws-apiKey')
        // #279：key 走节顶层 apiKey 字段→daemon 剥离入钥匙串（settings.json 不落 key 本体）
        const r = await saveAppSettings({ websearch: { provider: $('sp-ws-prov').value, config, ...(k && k.value ? { apiKey: k.value } : {}) } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
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
        if (mode !== 'provider') { box.innerHTML = `<div class="set-desc" style="margin:0">${t('ue.localDesc')}</div>`; return }
        const cur = UE_PROVIDERS.find((x) => x.id === (ue.provider ?? 'jina')) ?? UE_PROVIDERS[0]
        box.innerHTML = `
          <div class="set-field" style="max-width:340px"><label>${t('ws.pvLabel')}</label>
            <select id="sp-ue-prov" class="set-select">${UE_PROVIDERS.map((x) => `<option value="${x.id}" ${x.id === cur.id ? 'selected' : ''}>${x.label}</option>`).join('')}</select>
          </div>
          <div class="set-field" style="max-width:340px"><label>${t('ue.baseUrlAuto')}</label><input id="sp-ue-url" value="${ue.config?.baseUrl ?? cur.baseUrl}" placeholder="https://…" /></div>
          <div class="set-field" style="max-width:340px"><label>${t('ue.keyKept')}</label><input type="password" id="sp-ue-key" placeholder="${ue.config?.apiKey ? t('ue.keySet') : ''}" /></div>`
        $('sp-ue-prov').onchange = () => {
          const pv = UE_PROVIDERS.find((x) => x.id === $('sp-ue-prov').value)
          $('sp-ue-url').value = pv.baseUrl
        }
      }
      $('sp-ue-mode').onchange = renderUeCfg
      renderUeCfg()
      $('sp-ue-save').onclick = async () => {
        const st = $('sp-ue-status'); st.className = 'set-status'; st.textContent = t('ui.saving')
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
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
      }
    } else if (cat.id === 'docproc') {
      // #256.2 用户 6 点：本地处理=具体服务商下拉（选商自动填 API 地址，不手填）
      const g = await loadAppSettings()
      const dp = g.docproc ?? {}
      const DP_PROVIDERS = [
        { id: 'builtin', label: 'dp.prov.builtin', baseUrl: '', local: true, needsKey: false },
        { id: 'winocr', label: 'dp.prov.winocr', baseUrl: '', local: true, needsKey: false, disabled: true },
        { id: 'paddle', label: 'dp.prov.paddle', baseUrl: 'http://127.0.0.1:8866', local: true, needsKey: false, disabled: true },
        { id: 'doc2x', label: 'Doc2X', baseUrl: 'https://v2.doc2x.noedgeai.com', local: false, needsKey: true },
        { id: 'mineru', label: 'MinerU', baseUrl: 'https://mineru.net/api/v4', local: false, needsKey: true },
        { id: 'mathpix', label: 'Mathpix', baseUrl: 'https://api.mathpix.com', local: false, needsKey: true },
        { id: 'textin', label: 'TextIn（合合信息）', baseUrl: 'https://api.textin.com', local: false, needsKey: true },
      ]
      const cur = DP_PROVIDERS.find((x) => x.id === (dp.provider ?? 'builtin')) ?? DP_PROVIDERS[0]
      const mode = dp.mode ?? (cur.local ? 'local' : 'provider')
      panel(t('panel.docproc'), t('panel.sub.docproc'), `
        <div class="set-field" style="max-width:400px"><label>${t('dp.pvLabel')}</label>
          <select id="sp-dp-prov" class="set-select">
            <optgroup label="${t('dp.localGroup')}">${DP_PROVIDERS.filter((x) => x.local).map((x) => `<option value="${x.id}" ${cur.id === x.id ? 'selected' : ''} ${x.disabled ? 'disabled title="即将支持——当前回落内置解析"' : ''}>${t(x.label)}${x.disabled ? '（即将支持）' : ''}</option>`).join('')}</optgroup>
            <optgroup label="${t('dp.cloudGroup')}">${DP_PROVIDERS.filter((x) => !x.local).map((x) => `<option value="${x.id}" ${cur.id === x.id ? 'selected' : ''}>${t(x.label)}</option>`).join('')}</optgroup>
          </select>
        </div>
        <div id="sp-dp-cfg"></div>
        <div class="set-row"><button type="button" class="btn" id="sp-dp-save">${t('ui.save')}</button><span class="set-status" id="sp-dp-status"></span></div>
      `)
      const renderDpCfg = () => {
        const pv = DP_PROVIDERS.find((x) => x.id === $('sp-dp-prov').value)
        const box = $('sp-dp-cfg')
        if (!pv) { box.innerHTML = ''; return }
        let html = ''
        if (pv.baseUrl) html += `<div class="set-field" style="max-width:400px"><label>${t('dp.baseUrlAuto')}</label><input id="sp-dp-url" value="${pv.baseUrl}" ${pv.local ? 'readonly' : ''} /></div>`
        else html += `<div class="set-field" style="max-width:400px"><label>API 地址</label><input id="sp-dp-url" value="${dp.config?.baseUrl && dp.provider === pv.id ? dp.config.baseUrl : ''}" placeholder="本地引擎无需地址" ${pv.local && !pv.baseUrl ? 'readonly' : ''} /></div>`
        if (pv.needsKey) html += `<div class="set-field" style="max-width:400px"><label>${t('mp.keyKept')}</label><input type="password" id="sp-dp-key" placeholder="${dp.config?.keyStored ? '已配置，不回显' : ''}" /></div>`
        box.innerHTML = html
      }
      $('sp-dp-prov').onchange = renderDpCfg
      renderDpCfg()
      $('sp-dp-save').onclick = async () => {
        const st = $('sp-dp-status'); st.className = 'set-status'; st.textContent = t('ui.saving')
        const pv = DP_PROVIDERS.find((x) => x.id === $('sp-dp-prov').value)
        const config = {}
        const b = $('sp-dp-url')
        if (b && b.value) config.baseUrl = b.value
        const k = $('sp-dp-key')
        if (k && k.value) config.apiKey = k.value // #287：真 key 发 daemon→剥离入钥匙串 docproc-key（哨兵形态进不了钥匙串）
        else if (dp.config?.keyStored && dp.provider === pv.id) config.keyStored = true
        const r = await saveAppSettings({ docproc: { mode: pv.local ? 'local' : 'provider', provider: pv.id, config } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
      }
} else if (cat.id === 'memory') {
      const g = await loadAppSettings()
      const mm = g.memory ?? {}
      panel(t('panel.memory'), t('panel.sub.memory'), `
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('mm.enable')}</div><div class="sc-desc">${t('mm.enableDesc')}</div></div>
          <button type="button" class="toggle ${mm.enabled !== false ? 'on' : ''}" id="sp-mm-on"></button></div>
        <div class="set-card"><div class="sc-main"><div class="sc-title">${t('mm.sync')}</div><div class="sc-desc">${t('mm.syncDesc')}</div></div>
          <button type="button" class="toggle ${mm.syncToMoon !== false ? 'on' : ''}" id="sp-mm-sync"></button></div>
        <div class="set-field"><label>${t('mm.modeLabel')}</label>
          <select id="sp-mm-mode" class="set-select set-select-sm">
            <option value="builtin_moonrecall" selected>${t('mm.modeBuiltin')}</option>
          </select>
          <div class="set-desc" style="margin-top:4px">${t('mm.modeDesc')}</div>
        </div>
        <div class="set-field"><label>${t('mm.limitLabel')}</label>
          <input id="sp-mm-limit" type="number" min="500" step="100" value="${mm.injectLimit ?? 5000}" style="max-width:180px" />
          <div class="set-desc" style="margin-top:4px">${t('mm.limitDesc')}</div>
        </div>
        <div class="set-row"><button type="button" class="btn" id="sp-mm-save">${t('ui.save')}</button><span class="set-status" id="sp-mm-status"></span></div>
        <div style="border-top:1px solid var(--border);margin:14px 0 10px"></div>
        <div class="sc-title" style="margin-bottom:2px">${t('mm.candidate')}</div>
        <div class="set-desc" style="margin-bottom:8px">${t('mm.candidateDesc')}</div>
        <div class="set-status" id="sp-mm-cand-state"></div>
        <div id="sp-mm-cand-body" style="display:flex;flex-direction:column;gap:8px;margin-top:6px"></div>
      `)
      $('sp-mm-on').onclick = (e) => { e.currentTarget.classList.toggle('on'); $('sp-mm-save').click() }
      $('sp-mm-sync').onclick = (e) => { e.currentTarget.classList.toggle('on'); $('sp-mm-save').click() }
      $('sp-mm-save').onclick = async () => {
        const st = $('sp-mm-status'); st.className = 'set-status'; st.textContent = t('ui.saving')
        const limit = Math.max(500, Math.floor(Number($('sp-mm-limit').value) || 5000))
        const r = await saveAppSettings({ memory: { enabled: $('sp-mm-on').classList.contains('on'), mode: $('sp-mm-mode').value, injectLimit: limit, syncToMoon: $('sp-mm-sync').classList.contains('on') } })
        st.className = r.ok ? 'set-status ok' : 'set-status err'
        st.textContent = r.ok ? t('ui.saved') : (r.error ?? t('ui.saveFail'))
      }
      // #289 云端候选池：candidate 态实体列表+确认/丢弃（登录态经 daemon apiGet/apiPost；未登录自然报未登录错误）
      const mmBox = $('sp-mm-cand-body')
      const mmState = $('sp-mm-cand-state')
      const TYPE_LABELS = { fact: '事实', opinion: '观点', preference: '偏好', goal: '目标', project: '项目', person: '人物', action: '行动' }
      const loadCandidates = async () => {
        if (!mmBox) return
        mmState.textContent = t('mm.loading')
        const r = await window.moonlybox.rpc('candidates', { op: 'list' }, 20_000)
        if (!(r.event === 'done' && r.code === 0)) {
          mmState.textContent = `✗ ${r.message ?? r.text ?? t('mm.loadFail')}`
          mmBox.innerHTML = ''
          return
        }
        const items = JSON.parse(r.text).items ?? []
        if (!items.length) {
          mmState.textContent = t('mm.empty')
          mmBox.innerHTML = ''
          return
        }
        mmState.textContent = `${items.length}${t('mm.pending')}`
        mmBox.innerHTML = items.map((it) => {
          const sugg = (() => { try { return (JSON.parse(it.attributes ?? '{}')?.suggested ?? []) } catch { return [] } })()
          const suggHtml = sugg.length ? `<div class="set-desc" style="margin:3px 0 0 26px">${t('mm.mergeSugg')}${sugg.map((s) => `「${String(s).slice(0, 40)}」`).join('、')}</div>` : ''
          return `<div class="set-card" data-mmid="${it.id}" style="flex-direction:column;align-items:stretch"><div style="display:flex;align-items:center;gap:8px">
            <span class="set-desc" style="flex:0 0 auto">${TYPE_LABELS[it.type] ?? it.type ?? '—'}</span>
            <span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(it.subject ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>
            <button type="button" class="btn" style="font-size:11.5px;padding:3px 10px" data-mmact="confirm">${t('mm.confirm')}</button>
            <button type="button" class="btn ghost" style="font-size:11.5px;padding:3px 10px" data-mmact="drop">${t('mm.drop')}</button>
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
              mmState.textContent = left ? `${left}${t('mm.pending')}` : t('mm.allDone')
              if (!left) mmBox.innerHTML = ''
            } else {
              btn.disabled = false
              mmState.textContent = `✗ ${rr.message ?? t('mm.opFail')}`
            }
          }
        })
      }
      void loadCandidates()
        } else {
      const subLabel = currentSetSub ? ` · ${t(SET_SUB_LABELS[currentSetSub] ?? currentSetSub)}` : ''
      panel(`${t(cat.label)}${subLabel}`, t('mm.catDesc'), '')
    }
    return
  }
  // ---------- 备份（#257）：新建向导 + 详情面板 ----------
  if (nav === 'tasks') {
    // #316.5 任务详情 + #310.23：骨架一次渲染+局部 patch（自动刷新不再整页 innerHTML——滚动位置保持/无闪烁）；
    // items 按状态着色（done 绿底/failed 红/running accent+spinner）
    if (!arg?.id) {
      w.innerHTML = `<div class="muted" style="padding:20px">${t('tk.pickHint')}</div>`
      return
    }
    const ST = { queued: t('tk.stQueued'), running: t('tk.stRunning'), completed: t('tk.stDone'), failed: t('tk.stFail'), cancelled: t('tk.stCancel') }
    const IST = { pending: t('tk.iPending'), running: t('tk.iRunning'), done: t('tk.iDone'), failed: t('tk.iFail'), skipped: t('tk.iSkip'), cancelled: t('tk.iCancel') }
    // 行渲染（状态→样式语义色）
    const itemRow = (it) => {
      let name = String(it.path).split(/[\\/]/).pop()
      // #329.3：云端整理占位行名——「cloud:#N」→「收藏 #N」（用户可读；任务详情/产物说明已有 tk.cloudNoPages）
      if (/^cloud:#\d+$/.test(name)) name = t('tk.cloudItem').replace('{n}', name.slice(7))
      const color = { done: 'var(--ok,#34d399)', failed: 'var(--danger,#e56969)', running: 'var(--accent,#818cf8)', skipped: 'inherit', cancelled: 'inherit', pending: 'inherit' }[it.status] ?? 'inherit'
      const badgeBg = { done: 'rgba(52,211,153,.12)', failed: 'rgba(229,105,105,.14)', running: 'rgba(129,140,248,.14)' }[it.status] ?? 'transparent'
      const spin = it.status === 'running' ? '<span style="display:inline-block;animation:tkspin 1s linear infinite">◐</span> ' : ''
      const err = it.error ? `<div class="muted" style="font-size:11px;color:var(--danger,#e56969);margin-top:2px">${esc(it.error)}</div>` : ''
      const out = it.outPath ? `<div class="muted" style="font-size:11px;margin-top:2px">→ ${esc(it.outPath)}</div>` : ''
      return `<div data-tkitem="${esc(it.path)}" data-st="${it.status}" data-err="${esc(it.error ?? '')}" style="padding:7px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:8px;align-items:center"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${spin}${esc(name)}</span><span style="font-size:11px;flex:none;color:${color};background:${badgeBg};padding:1px 8px;border-radius:8px">${IST[it.status] ?? it.status}</span></div>${err}${out}
      </div>`
    }
    const fill = (j) => {
      setFrameTabCtx('tasks', j.title ?? '')
      const pct = j.progress.total ? Math.round((j.progress.done / j.progress.total) * 100) : 0
      const st = $('tk-st'); if (st) st.textContent = ST[j.status] ?? j.status
      const bar = $('tk-bar'); if (bar) bar.style.width = pct + '%'
      const cnt = $('tk-cnt'); if (cnt) cnt.textContent = `${j.progress.done}/${j.progress.total} · ${pct}%`
      const list = $('tk-list')
      if (list) {
        // 局部 diff：已存在的行按状态更新 badge/spinner/err/out，新行 append（保滚动位置）
        list.querySelectorAll('.tk-empty-hint').forEach((el) => el.remove())
        const exist = new Map(Array.from(list.querySelectorAll('[data-tkitem]')).map((el) => [el.dataset.tkitem, el]))
        const seen = new Set() // #310.29：补定义（#310.23 落地即缺失——调度协程无 try 时表现为 [promise] unhandled）
        for (const it of j.items) {
          const key = it.path
          seen.add(key)
          const html = itemRow(it)
          const prev = exist.get(key)
          if (prev) {
            if (prev.dataset.st !== it.status || prev.dataset.err !== String(it.error ?? '')) {
              const tpl = document.createElement('template'); tpl.innerHTML = html
              prev.replaceWith(tpl.content.firstElementChild)
            }
          } else {
            const tpl = document.createElement('template'); tpl.innerHTML = html
            list.appendChild(tpl.content.firstElementChild)
          }
        }
        // 清单中已消失的行（如 ledger 重置后 item 转 pending 但 path 不变——不消失；保守不移除任何行）
      }
      const head = $('tk-head'); if (head) head.textContent = j.title
      const model = $('tk-model'); if (model) model.textContent = j.modelLabel ?? ''
      const started = $('tk-started')
      if (started) {
        const d = j.startedAt ? new Date(j.startedAt) : null
        started.textContent = d && !isNaN(d) ? `${t('tk.startedAt')} ${d.toLocaleString()}` : ''
      }
      // #310.54：产物 tab 局部刷新——fill 原本只刷清单/进度，「产物 (N)」徽标与列表是初次渲染静态值，
      // 停留详情页观察编译时恒为 (0)/空。此处按最新 job 重算 donePages 并原地更新（保 tab 显隐与勾选态无关，重建行）。
      const pagesEl = $('tk-pages')
      const tabBtn = $('tk-tab-pages')
      if (pagesEl && tabBtn) {
        const donePages = j.items.filter((it) => it.status === 'done' && it.outPath)
        tabBtn.textContent = `${t('tk.tabPages')} (${donePages.length})`
        const keepSel = new Set(Array.from(pagesEl.querySelectorAll('.tkp-chk:checked')).map((c) => c.dataset.abs))
        pagesEl.innerHTML = donePages.length ? `<div style="display:flex;align-items:center;gap:10px;padding:4px 0 8px;position:sticky;top:0;background:var(--bg,#fff);z-index:1">
          <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="tkp-selall" /> ${t('tk.selectAll')}</label>
          <button class="btn ghost" id="tkp-del" style="font-size:12px;padding:2px 10px;margin-left:auto">${t('tk.delSelected')}</button>
        </div>` + donePages.map((it) => {
          const name = String(it.outPath).split(/[\\/]/).pop()
          const cloud = it.syncedAt ? `<span style="font-size:10.5px;margin-left:6px;color:var(--ok,#34c777)">✓ ${t('tk.pgSynced')}</span>` : (it.cloudWikiId ? `<span class="muted" style="font-size:10.5px;margin-left:6px">☁ ${t('tk.pgPending')}</span>` : '')
          return `<div style="padding:7px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
            <input type="checkbox" class="tkp-chk" data-abs="${esc(it.outPath)}" ${keepSel.has(it.outPath) ? 'checked' : ''} />
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}${cloud}</div>
              <div class="muted" style="font-size:10.5px">${esc(t('tk.iDone'))}</div>
            </div>
          </div>`
        }).join('') : `<div class="muted" style="padding:10px 0">${t('tk.pagesEmpty')}</div>`
        // 重绑工具条事件（innerHTML 重建后节点换新）
        const selall2 = $('tkp-selall')
        if (selall2) selall2.onchange = (e) => { pagesEl.querySelectorAll('.tkp-chk').forEach((c) => { c.checked = e.target.checked }) }
        const delBtn2 = $('tkp-del')
        if (delBtn2) delBtn2.onclick = async () => {
          const sel = [...pagesEl.querySelectorAll('.tkp-chk:checked')].map((c) => c.dataset.abs)
          if (!sel.length) return
          if (!(await mbConfirm(t('tk.delConfirm').replace('{n}', sel.length)))) return
          const rd = await window.moonlybox.rpc('tasks', { op: 'delete_pages', paths: sel }, 30_000)
          try {
            const d = JSON.parse(rd.text)
            if (d.ok) { mbAlert(t('tk.delDone').replace('{d}', d.deleted).replace('{r}', d.resetLedger)); renderTree(); renderWork('tasks', { id: j.id }) }
            else mbAlert(t('lib.delFail') + (d.message ?? ''))
          } catch { mbAlert(t('lib.delFail')) }
        }
      }
    }
    const bindCancel = (jid) => {
      const cbtn = $('tk-cancel')
      if (cbtn) cbtn.onclick = async () => {
        cbtn.disabled = true
        await window.moonlybox.rpc('tasks', { op: 'cancel', id: jid }, 10_000)
        renderList('tasks')
        renderWork('tasks', { id: jid })
      }
    }
    const schedule = (jid) => {
      if (tkTimer) clearTimeout(tkTimer)
      tkTimer = setTimeout(async () => {
        tkTimer = null
        if (currentNav !== 'tasks' || currentTaskId !== jid) return
        try {
          const rr = await window.moonlybox.rpc('tasks', { op: 'get', id: jid }, 10_000)
          if (rr.event === 'done' && rr.code === 0) {
            const jj = JSON.parse(rr.text).job
            fill(jj)
            bindCancel(jj.id)
            if (jj.status === 'running' || jj.status === 'queued') schedule(jid)
            else renderList('tasks')
          }
        } catch {} // #310.29：刷新失败静默（下轮重试）——不让 unhandled rejection 冒泡
      }, 2000)
    }
    // 首次整页骨架
    const r = await window.moonlybox.rpc('tasks', { op: 'get', id: arg.id }, 10_000)
    if (r.event !== 'done' || r.code !== 0) {
      w.innerHTML = `<div class="muted" style="padding:20px">${t('list.loadFail')}</div>`
      return
    }
    const j = JSON.parse(r.text).job
    const startedHtml = (() => { const d = j.startedAt ? new Date(j.startedAt) : null; return d && !isNaN(d) ? `<div class="muted" style="font-size:11px;width:100%" id="tk-started">${t('tk.startedAt')} ${d.toLocaleString()}</div>` : '<div id="tk-started" style="display:none"></div>' })()
    // #310.27：详情双 tab——「任务清单」（源文档维度）与「产物」（done 产物维度）平行
    // #326：云端整理任务（cloud_organize）——产物在云端，无本地产物：产物页帧恒 0 + 说明文案
    const isCloud = j.type === 'cloud_organize'
    const donePages = isCloud ? [] : j.items.filter((it) => it.status === 'done' && it.outPath)
    w.innerHTML = `
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <strong style="font-size:14px" id="tk-head">${esc(j.title)}</strong>
        <span class="muted" style="font-size:12px" id="tk-st">${ST[j.status] ?? j.status}</span>
        <span style="margin-left:auto;font-size:11px" class="muted" id="tk-model">${esc(j.modelLabel ?? '')}</span>
        ${startedHtml}
        ${['queued', 'running'].includes(j.status) ? `<button class="btn ghost" id="tk-cancel" style="font-size:12px;padding:2px 10px">${t('tk.cancel')}</button>` : ''}
      </div>
      <div style="padding:12px 18px">
        <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden"><div id="tk-bar" style="height:100%;width:${j.progress.total ? Math.round((j.progress.done / j.progress.total) * 100) : 0}%;background:var(--accent);transition:width .4s"></div></div>
        <div class="muted" style="font-size:11.5px;margin-top:6px" id="tk-cnt">${j.progress.done}/${j.progress.total}</div>
      </div>
      <div style="padding:6px 18px 0;display:flex;gap:6px" id="tk-tabs">
        <button id="tk-tab-items" style="font-size:12px;padding:3px 12px;border:0;border-radius:8px;cursor:pointer;background:var(--active-bg);color:var(--active-fg);font-weight:600">${t('tk.tabItems')}</button>
        <button id="tk-tab-pages" style="font-size:12px;padding:3px 12px;border:0;border-radius:8px;cursor:pointer;background:transparent;color:inherit">${t('tk.tabPages')} (${donePages.length})</button>
      </div>${''}
      <div style="flex:1;overflow-y:auto;padding:0 18px 16px" id="tk-list">${j.items.map(itemRow).join('') || `<div class="muted tk-empty-hint" style="padding:10px 0">${t('tk.empty')}</div>`}</div>
      <div style="flex:1;overflow-y:auto;padding:6px 18px 16px;display:none" id="tk-pages">
        ${isCloud ? `<div class="muted" style="padding:14px 0;font-size:12.5px">${t('tk.cloudNoPages')}</div>` : donePages.length ? `<div style="display:flex;align-items:center;gap:10px;padding:4px 0 8px;position:sticky;top:0;background:var(--bg,#fff);z-index:1">
          <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="tkp-selall" /> ${t('tk.selectAll')}</label>
          <button class="btn ghost" id="tkp-del" style="font-size:12px;padding:2px 10px;margin-left:auto">${t('tk.delSelected')}</button>
        </div>` : ''}
        ${donePages.map((it) => {
          const name = String(it.outPath).split(/[\\/]/).pop()
          // #310.46：三态——✓ 已同步（syncedAt）/ ☁ 待准入（cloudWikiId）/ 无标
          const cloud = it.syncedAt ? `<span style="font-size:10.5px;margin-left:6px;color:var(--ok,#34c777)">✓ ${t('tk.pgSynced')}</span>` : (it.cloudWikiId ? `<span class="muted" style="font-size:10.5px;margin-left:6px">☁ ${t('tk.pgPending')}</span>` : '')
          return `<div style="padding:7px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
            <input type="checkbox" class="tkp-chk" data-abs="${esc(it.outPath)}" />
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}${cloud}</div>
              <div class="muted" style="font-size:10.5px">${esc(t('tk.iDone'))}</div>
            </div>
          </div>`
        }).join('') || `<div class="muted" style="padding:10px 0">${t('tk.pagesEmpty')}</div>`}
      </div>`
    // tab 切换（DOM 显隐，不整页重渲）
    const listEl0 = $('tk-list'), pagesEl0 = $('tk-pages')
    const setTab = (which) => {
      const on = which === 'items'
      listEl0.style.display = on ? '' : 'none'
      pagesEl0.style.display = on ? 'none' : ''
      const bi = $('tk-tab-items'), bp = $('tk-tab-pages')
      bi.style.background = on ? 'var(--active-bg)' : 'transparent'
      bi.style.color = on ? 'var(--active-fg)' : 'inherit'
      bi.style.fontWeight = on ? '600' : '400'
      bp.style.background = on ? 'transparent' : 'var(--active-bg)'
      bp.style.color = on ? 'inherit' : 'var(--active-fg)'
      bp.style.fontWeight = on ? '400' : '600'
    }
    $('tk-tab-items').onclick = () => setTab('items')
    $('tk-tab-pages').onclick = () => setTab('pages')
    const selall = $('tkp-selall')
    if (selall) selall.onchange = (e) => { pagesEl0.querySelectorAll('.tkp-chk').forEach((c) => { c.checked = e.target.checked }) }
    const delBtn = $('tkp-del')
    if (delBtn) delBtn.onclick = async () => {
      const sel = [...pagesEl0.querySelectorAll('.tkp-chk:checked')].map((c) => c.dataset.abs)
      if (!sel.length) return
      if (!(await mbConfirm(t('tk.delConfirm').replace('{n}', sel.length)))) return
      const rd = await window.moonlybox.rpc('tasks', { op: 'delete_pages', paths: sel }, 30_000)
      try {
        const d = JSON.parse(rd.text)
        if (d.ok) {
          mbAlert(t('tk.delDone').replace('{d}', d.deleted).replace('{r}', d.resetLedger))
          renderWork('tasks', { id: j.id })
        } else mbAlert(t('lib.delFail') + (d.message ?? ''))
      } catch { mbAlert(t('lib.delFail')) }
    }
    bindCancel(j.id)
    if (j.status === 'running' || j.status === 'queued') schedule(j.id)
    return
  }
  if (nav === 'backup') {
    if (arg?.create) {
      // 新建界面：本地目录选择 + 归属目录下拉 + 格式说明
      let dirs = [{ id: null, label: t('bk.rootDir') }]
      w.innerHTML = `
        <div class="set-panel">
          <h3>${t('bk.newTitle')}</h3>
          <p class="set-desc">${t('bk.newDesc')}<br/>
          <b>${t('bk.formats')}</b>${t('bk.skipNote')}；${t('bk.uploadOnly')}；
          ${t('bk.newDesc2')}</p>
          <div class="set-field">
            <label>${t('bk.localDir')}</label>
            <div class="set-row" style="margin:0"><input id="bk-path" readonly placeholder="${t('bk.notChosen')}" style="flex:1" />
              <button type="button" class="btn ghost" id="bk-pick">${t('bk.pick')}</button></div>
          </div>
          <div class="set-field">
            <label>${t('bk.targetDir')}</label>
            <select id="bk-dir" class="set-select" style="max-width:340px"><option>${t('bk.dirLoading')}</option></select>
          </div>
          <div class="set-field">
            <label>${t('bk.onDeleteLabel')}</label>
            <select id="bk-ondel" class="set-select" style="max-width:340px">
              <option value="resync">${t('bk.resyncOpt')}</option>
              <option value="keep">${t('bk.keepOpt')}</option>
            </select>
          </div>
          <div class="set-field">
            <label>${t('bk.dupLabel')}</label>
            <select id="bk-onconf" class="set-select" style="max-width:340px">
              <option value="rename" selected>${t('bk.dupRenameOpt')}</option>
            </select>
            <p class="set-desc" style="margin:4px 0 0">${t('bk.dupNote')}</p>
          </div>
          <div class="set-row">
            <button type="button" class="btn" id="bk-save">${t('bk.saveBtn')}</button>
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
        if (!localPath) { st.className = 'set-status err'; st.textContent = t('bk.pickFirst'); return }
        const dirId = sel.value || null
        const dirName = sel.options[sel.selectedIndex]?.text ?? t('bk.rootDir')
        // #260 预检：云端同名清单 → 有则内嵌确认（重命名/覆盖认领二选一）
        st.textContent = t('bk.checking')
        let hits = []
        try {
          const rc = await window.moonlybox.rpc('backup', { op: 'check', localPath, directoryId: dirId }, 20_000)
          if (rc.event !== 'done' || rc.code !== 0) { st.className = 'set-status err'; st.textContent = rc.message ?? rc.text ?? t('bk.preFailShort'); return }
          hits = JSON.parse(rc.text).hits ?? []
        } catch (e) { st.className = 'set-status err'; st.textContent = t('bk.preFail') + String(e?.message ?? e); return }
        let claims = null
        if (hits.length) {
          st.className = 'set-status'; st.textContent = ''
          const listHtml = hits.map((h) => `<div class="set-card" style="margin:6px 0"><div class="sc-main"><div class="sc-title">${h.title}</div><div class="sc-desc">云端已有同名文档（版本 ${h.version}${h.updatedAt ? '，更新于 ' + new Date(h.updatedAt).toLocaleString() : ''}）</div></div></div>`).join('')
          const panel = w.querySelector('.set-panel')
          const confirmBox = document.createElement('div')
          confirmBox.innerHTML = `
            <div style="margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:10px">
              <div style="font-weight:600;margin-bottom:4px">${t('bk.foundN').replace('{n}', hits.length)}</div>
              <p class="set-desc">${t('bk.claimDesc')}</p>
              ${listHtml}
              <div class="set-row" style="margin-top:10px">
                <button type="button" class="btn" id="bk-claim">${t('bk.claimBtn')}</button>
                <button type="button" class="btn ghost" id="bk-rename">${t('bk.renameBtn')}</button>
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
        st.textContent = t('bk.registering')
        const r = await window.moonlybox.rpc('backup', { op: 'add', localPath, directoryId: dirId, directoryName: dirName, onDelete: $('bk-ondel').value, onConflict: $('bk-onconf').value, ...(claims ? { claims } : {}) }, 15_000)
        if (r.event !== 'done' || r.code !== 0) { st.className = 'set-status err'; st.textContent = r.message ?? r.text ?? t('bk.regFail'); return }
        const entry = JSON.parse(r.text).entry
        st.textContent = t('bk.registered')
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
      if (!e) { w.innerHTML = `<div class="set-panel"><p class="set-desc">${t('bk.notExist')}</p></div>`; return }
      setFrameTabCtx('backup', e.localPath.split(/[\\/]/).pop())
      w.innerHTML = `
        <div class="set-panel">
          <h3>${e.localPath.split(/[\\/]/).pop()}</h3>
          <p class="set-desc">${e.localPath}</p>
          <div class="set-card"><div class="sc-main"><div class="sc-title">${t('bk.targetCard')}</div><div class="sc-desc">${e.directoryName}</div></div></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">${t('bk.enableCard')}</div><div class="sc-desc">${t('bk.enableDesc')}</div></div>
            <button type="button" class="toggle ${e.enabled ? 'on' : ''}" id="bk-toggle"></button></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">${t('bk.onDeleteCard')}</div><div class="sc-desc">${t('bk.onDeleteDesc')}</div></div>
            <select class="set-select" id="bk-ondel" style="max-width:220px">
              <option value="resync"${e.onDelete !== 'keep' ? ' selected' : ''}>${t('bk.resync')}</option>
              <option value="keep"${e.onDelete === 'keep' ? ' selected' : ''}>${t('bk.keep')}</option>
            </select></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">${t('bk.dupCard')}</div><div class="sc-desc">${t('bk.dupDesc')}</div></div>
            <select class="set-select" id="bk-onconf" style="max-width:220px">
              <option value="rename" selected>${t('bk.dupRename')}</option>
            </select></div>
          <div class="set-card"><div class="sc-main"><div class="sc-title">${t('bk.lastSync')}</div><div class="sc-desc">${e.lastSyncAt ? new Date(e.lastSyncAt).toLocaleString() : t('bk.neverSync')}</div></div>
            <button type="button" class="btn" id="bk-sync">${t('bk.syncNow')}</button></div>
          <div class="set-row" style="margin-top:20px"><button type="button" class="btn ghost" id="bk-del" style="color:var(--err)">${t('bk.delSelf')}</button></div>
          <div class="set-status" id="bk-detail-status"></div>
        </div>`
      if (arg.justSynced) {
        const rep = arg.justSynced
        const st = $('bk-detail-status')
        st.className = 'set-status ok'
        const parts = [t('bk.upN').replace('{n}', rep.uploaded.length), t('bk.updN').replace('{n}', rep.updated.length), t('bk.skipN').replace('{n}', rep.skipped.length)]
        if (rep.cloudDeleted?.length) parts.push(t('bk.cloudDelN').replace('{n}', rep.cloudDeleted.length))
        if (rep.cloudUpdated?.length) parts.push(t('bk.cloudUpdN').replace('{n}', rep.cloudUpdated.length))
        if (rep.conflicts.length) parts.push(t('bk.conflictN').replace('{n}', rep.conflicts.length))
        st.textContent = t('bk.doneJoin') + parts.join(t('ui.joinComma'))
      }
      $('bk-toggle').onclick = async (ev) => {
        ev.currentTarget.classList.toggle('on')
        await window.moonlybox.rpc('backup', { op: 'toggle', id: e.id, enabled: $('bk-toggle').classList.contains('on') }, 10_000)
        renderList('backup')
      }
      $('bk-sync').onclick = async (ev) => {
        const st = $('bk-detail-status')
        st.className = 'set-status'; st.textContent = t('bk.syncing')
        const rs = await window.moonlybox.rpc('backup', { op: 'sync', id: e.id }, 120_000)
        if (rs.event === 'done' && rs.code === 0) {
          const rep = JSON.parse(rs.text).report
          st.className = 'set-status ok'
          const parts = [t('bk.upN').replace('{n}', rep.uploaded.length), t('bk.updN').replace('{n}', rep.updated.length), t('bk.skipN').replace('{n}', rep.skipped.length)]
          if (rep.cloudDeleted?.length) parts.push(t('bk.cloudDelN').replace('{n}', rep.cloudDeleted.length))
          if (rep.cloudUpdated?.length) parts.push(t('bk.cloudUpdN').replace('{n}', rep.cloudUpdated.length))
          if (rep.conflicts.length) parts.push(t('bk.conflictN').replace('{n}', rep.conflicts.length) + `(${rep.conflicts[0].reason.slice(0, 60)})`)
          st.textContent = t('bk.doneJoin2') + parts.join(t('ui.joinComma'))
        } else { st.className = 'set-status err'; st.textContent = rs.message ?? rs.text ?? t('bk.syncFail') }
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
    // #319.3：页帧标题与侧栏同源本地化（arg.label=服务端中文兜底，字典命中走 t()）
    const frameNavLabel = (() => { const v = t(`cloud.nav.${arg.id}`); return v === `cloud.nav.${arg.id}` ? (arg.label ?? '') : v })()
    setFrameTabCtx('cloud', frameNavLabel)
    const gen = ++renderGen // #299：本协程世代号——期间用户切走则后续步骤全部作废
    const genValid = () => gen === renderGen && $('cloud-wv') !== null
    // #253.41/#253.42：防闪烁+加载动画——webview 初始透明+spinner 覆盖层，目标页 did-finish-load 后淡入并移除 spinner（无调试文字）
    w.innerHTML = `<div style="flex:1;display:flex;position:relative;background:var(--bg)">
      <webview id="cloud-wv" style="flex:1;width:100%;height:100%;opacity:0;transition:opacity .25s" src="about:blank"></webview>
      <div id="cloud-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="width:34px;height:34px;border:3px solid color-mix(in srgb, var(--accent) 25%, transparent);border-top-color:var(--accent);border-radius:50%;animation:cloudspin .8s linear infinite"></div>
      </div>
    </div>`
    const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
    if (!genValid()) return // #299：await 期间用户切走——本协程作废（防 null addEventListener 与覆盖新页面）
    if (r.event !== 'done' || r.code !== 0) { w.innerHTML = `<div style="padding:16px" class="muted">加载失败：${r.text ?? ''}</div>`; return }
    const parsed = JSON.parse(r.text)
    const webBase = parsed.data?.webBase ?? parsed.webBase ?? 'https://moonlybox.cn'  // webBase 在 data 里（daemon nav: {ok,data,token}），兜底官方域
    const token = parsed.token
    const wv = $('cloud-wv')
    if (!wv) return // #299：双保险（世代校验兜底）
    let injected = false
    wv.addEventListener('dom-ready', async () => {
      // 只处理目标域的首次 ready（about:blank 阶段不注入）
      if (injected || !genValid()) return // #299：切走后协程作废，不再注入/跳转
      const cur = wv.getURL() || ''
      if (!cur.startsWith(webBase)) return
      injected = true
      // #319.2：语言跟随客户端（appearance.lang）——云端工作台与 terms/feedback 同款注入；
      // 时序成立的前提：注入发生在 loadURL 目标页之前，目标页 React 首渲染读 localStorage 已命中
      const clLang = (APP_SETTINGS?.appearance?.lang === 'en') ? 'en' : 'zh'
      try {
        if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`)
        await wv.executeJavaScript(`localStorage.setItem('mf_lang', ${JSON.stringify(clLang)}); 'ok'`)
      } catch {
        // 注入失败重试一次（guest 页偶发未就绪）
        await new Promise((r2) => setTimeout(r2, 600))
        if (!genValid()) return // #299：重试等待期间切走=作废
        try { if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`) } catch {}
        try { await wv.executeJavaScript(`localStorage.setItem('mf_lang', ${JSON.stringify(clLang)}); 'ok'`) } catch {}
      }
      // 路由跳转（#253.35）：web=BrowserRouter（path 路由）——manifest url 归一化去 '#'
      const path = arg.url.replace(/^\/#/, '/')
      // 目标页就绪后淡入（#253.41）：did-finish-load 后再延迟（用户 #253.43：SPA 内部路由
      // 跳转/首屏渲染需要一点时间——立即淡入会闪现中间页），spinner 多转一会
      const reveal = () => {
        wv.removeEventListener('did-finish-load', reveal)
        setTimeout(() => {
          if (!genValid()) return // #299：淡入延迟期间切走=不动 DOM（防云端页覆盖已切换的功能页）
          wv.style.opacity = '1'
          $('cloud-loading')?.remove()
        }, 450)
      }
      wv.addEventListener('did-finish-load', reveal)
      // #296：客户端主题以请求级参数传云端（mb_theme=dark|light 两值）——云端按本次请求加载，不影响用户云端主题设置
      if (!genValid()) return // #299：跳转前最后校验
      const sep = path.includes('?') ? '&' : '?'
      await wv.loadURL(`${webBase}${path}${sep}mb_theme=${resolveThemeDark()}`)
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
        <button class="btn" id="dg-save" style="font-size:12px;padding:5px 10px">${t('dg.saveDraft')}</button>
        <button class="btn" id="dg-activate" style="background:var(--ok);font-size:12px;padding:5px 10px">${t('dg.admit')}</button>
        <button class="btn" id="dg-ai" style="background:#7c3aed;font-size:12px;padding:5px 10px">${t('dg.aiBtn')}</button>
        <span id="dg-state" class="muted" style="font-size:11px;margin-left:auto"></span>
      </div>
      <div id="dg-empty" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px">
        <div style="font-size:15px;font-weight:600">${t('dg.quickNew')}</div>
        <div class="set-desc">${t('dg.quickDesc')}</div>
        <div id="dg-quick-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;width:100%;max-width:640px"></div>
        <div style="display:flex;gap:8px;width:100%;max-width:640px;margin-top:6px">
          <input id="dg-quick-title" placeholder="${t('dg.quickTitle')}" style="flex:1" maxlength="60" />
          <button class="btn" id="dg-quick-ok" style="background:var(--accent)">${t('dg.quickOk')}</button>
        </div>
        <div class="set-desc" id="dg-quick-hint" style="margin-top:4px">${t('dg.quickHint')}</div>
      </div>
      <div id="dg-editor" style="display:none;flex:1;min-height:0">
        <div style="flex:1;display:flex;min-height:0;height:100%">
          <textarea id="dg-code" spellcheck="false" style="flex:1;border:0;border-right:1px solid var(--border);padding:14px;font:12px/1.6 ui-monospace,monospace;resize:none;background:transparent;color:inherit;outline:none" placeholder="mermaid 代码（例：graph TD; A[开始] --> B[结束]）"></textarea>
          <div id="dg-preview" style="flex:1;overflow:auto;padding:16px"></div>
        </div>
        <div id="dg-err" style="display:none;padding:8px 16px;font-size:12px;color:var(--err);border-top:1px solid var(--border)"></div>
      </div>`
    const openEditor = (existing, pick) => {
      $('dg-empty').style.display = 'none'
      $('dg-editor').style.display = 'flex'
      $('dg-editor').style.flexDirection = 'column'
      bindDiagramWorkbench(existing, pick)
    }
    // #294：空态页=快捷新建页——模板网格+名称就地填，砍掉弹窗（#290/#293 两轮形态定稿）
    const grid = $('dg-quick-grid')
    let picked = DG_TEMPLATES[0].key // 默认选「流程图」
    const tplCard = (tpl) => `
      <div data-tpl="${tpl.key}" style="border:1px solid ${tpl.key === picked ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:10px 6px;cursor:pointer;text-align:center">
        <div style="font-size:20px">${tpl.icon}</div>
        <div style="font-size:12.5px;margin-top:4px">${t(tpl.name)}</div>
      </div>`
    const renderGrid = () => { grid.innerHTML = DG_TEMPLATES.map(tplCard).join('') }
    renderGrid()
    // #310：事件委托——原实现重建 innerHTML 后不重绑，第二次点击落在无 onclick 的新元素上完全失效
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-tpl]')
      if (!cell) return
      picked = cell.dataset.tpl
      renderGrid()
    })
    const quickCreate = () => {
      const title = $('dg-quick-title').value.trim()
      if (!title) { const inp = $('dg-quick-title'); inp.focus(); inp.placeholder = t('dg.nameRequired'); return }
      const tpl = DG_TEMPLATES.find((t) => t.key === picked)
      openEditor(null, { key: tpl.key, name: tpl.name, title, code: tpl.code })
    }
    $('dg-quick-ok').onclick = quickCreate
    $('dg-quick-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickCreate() })
    // arg.id=打开已有图示；无 arg=快捷新建页
    if (arg?.id) {
      openEditor(arg)
    } else {
      const hide = ['dg-save', 'dg-activate', 'dg-ai']
      for (const id of hide) { const el = $(id); if (el) el.style.display = 'none' }
      const ti = $('dg-title'); if (ti) ti.style.display = 'none'
      $('dg-state').textContent = ''
    }
    return
  }
  // #317.MDI：小月分支迁出→renderXiaoyuePane（持久容器）

  if (nav === 'help' && !arg) return renderWork('help', currentHelpArg || 'about') // #310.5：进帮助默认打开上次/关于
  if (nav === 'help' && arg === 'debug') {
    setFrameTabCtx('help', t('help.debug'))
    // #310.7：调试模式（dev 默认开/安装包默认关，可手动改）+日志导出；开启时内核 log/stderr 全量镜像 userData/mb-debug.log
    const env = await window.moonlybox.envInfo().catch(() => null)
    const gs = await loadAppSettings()
    const defOn = env ? !env.packaged : false
    const on = (gs.debug ?? { enabled: defOn }).enabled === true || (gs.debug == null && defOn)
    w.innerHTML = `
      <div style="padding:24px 28px;overflow-y:auto;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px">
        <div class="set-card" style="display:flex;align-items:center;gap:12px;padding:14px 20px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${t('help.debugMode')}</div>
            <div class="set-desc" style="margin-top:2px">${t('help.debugMode.desc')}${env ? (env.packaged ? t('help.pkgDefault') : t('help.devDefault')) : ''}</div>
          </div>
          <button type="button" class="toggle ${on ? 'on' : ''}" id="dbg-on"></button>
        </div>
        <div class="set-card" style="display:flex;align-items:center;gap:12px;padding:14px 20px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${t('help.debugLog')}</div>
            <div class="set-desc" style="margin-top:2px">${t('help.debugLog.desc')}</div>
          </div>
          <button class="btn ghost" id="dbg-export">${t('help.openLogs')}</button>
        </div>
        <div class="set-card" style="padding:14px 20px">
          <div style="font-size:13px;font-weight:600">${t('help.envInfo')}</div>
          <div class="set-desc" id="dbg-env" style="margin-top:6px;line-height:1.8"></div>
        </div>
      </div>`
    $('dbg-on').onclick = async (e) => {
      e.currentTarget.classList.toggle('on')
      await saveAppSettings({ debug: { enabled: e.currentTarget.classList.contains('on') } })
      renderWork('help', 'debug')
    }
    $('dbg-export').onclick = async () => {
      const err = await window.moonlybox.openLogDir()
      if (err) $('dbg-export').textContent = t('help.openFail') + err
    }
    if (env) $('dbg-env').innerHTML = `${t('help.envPlatform')}：${env.platform}<br/>Electron：${env.electron} · Node：${env.node}<br/>${t('help.envPkg')}：${env.packaged ? t('help.yes') : t('help.noDevMode')}<br/>${t('help.envLocale')}：${env.locale}`
    return
  }
  if (nav === 'help' && arg === 'cloudaddr') {
    setFrameTabCtx('help', t('help.cloudaddr'))
    // #310.7：云端地址（只读展示+复制）
    let webBase = 'https://moonlybox.cn'
    try {
      const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
      if (r.event === 'done' && r.code === 0) {
        const parsed = JSON.parse(r.text)
        webBase = parsed.data?.webBase ?? parsed.webBase ?? webBase
      }
    } catch {}
    // #319.6：版面简化（用户定稿）——单行：卡名 + 网址 + [打开官网] [复制网址]；desc/label 删
    w.innerHTML = `
      <div style="padding:24px 28px;overflow-y:auto;height:100%;box-sizing:border-box">
        <div class="set-card" style="padding:14px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:13px;font-weight:600;flex:none">${t('help.site')}</div>
          <a href="${webBase}" id="cld-link" style="flex:1;min-width:160px;color:var(--accent);text-decoration:none;font-family:ui-monospace,monospace;font-size:12px" title="${webBase}">${webBase}</a>
          <button class="btn" id="cld-open" style="flex:none">${t('help.site.open')}</button>
          <button class="btn ghost" id="cld-copy" style="flex:none">${t('help.site.copyAddr')}</button>
        </div>
      </div>`
    $('cld-open').onclick = () => window.moonlybox.openExternal(webBase)
    $('cld-link').onclick = (e) => { e.preventDefault(); window.moonlybox.openExternal(webBase) }
    $('cld-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(webBase); $('cld-copy').textContent = t('help.copied'); setTimeout(() => { const b = $('cld-copy'); if (b) b.textContent = t('help.site.copyAddr') }, 1500) } catch {}
    }
    return
  }
  if (nav === 'help' && arg === 'kernel') {
    // #319.4：帧名词条化+状态卡片化（与关于页 set-card 风格一致；原单行 mono 写死中文）
    setFrameTabCtx('help', t('help.kernelFrame'))
    const r = await window.moonlybox.rpc('ping', {}, 10_000)
    const vault = await window.moonlybox.vaultGet()
    const kernelOk = r.event === 'done'
    w.innerHTML = `
      <div style="padding:24px 28px;overflow-y:auto;height:100%;box-sizing:border-box">
        <div class="set-card" style="display:flex;align-items:center;gap:16px;padding:14px 20px">
          <div class="sc-main">
            <div class="sc-title">${t('help.kernelCard')}</div>
            <div class="sc-desc">${t('help.kernelCard.desc')}</div>
            <div style="margin-top:8px;font-size:12.5px;font-weight:600;color:${kernelOk ? 'var(--ok)' : 'var(--bad, #d64545)'}">${kernelOk ? t('help.kernelOk') : '✗ ' + (r.message ?? t('help.kernelDown'))}</div>
          </div>
          <span style="width:10px;height:10px;border-radius:999px;background:${kernelOk ? 'var(--ok)' : 'var(--bad, #d64545)'};flex:none"></span>
        </div>
        <div class="set-card" style="margin-top:12px;padding:14px 20px">
          <div class="sc-main">
            <div class="sc-title">${t('help.vaultCard')}</div>
            <div class="sc-desc">${t('help.vaultCard.desc')}</div>
            <div style="margin-top:8px;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;user-select:text;color:var(--fg)">${vault ? vault : t('help.vaultNone')}</div>
          </div>
        </div>
      </div>`
    return
  }
  if (nav === 'help' && (arg === 'feedback' || arg === 'terms')) {
    setFrameTabCtx('help', arg === 'feedback' ? t('help.feedback') : t('help.terms'))
    // #310.3/.6：问题反馈/条款=内嵌云端页（embed=1 隐藏云端主菜单；登录态注入同 cloud 模式）
    const gen = ++renderGen
    const genValid = () => gen === renderGen && $('fb-wv') !== null
    w.innerHTML = `<div style="flex:1;display:flex;position:relative;background:var(--bg)">
      <webview id="fb-wv" style="flex:1;width:100%;height:100%;opacity:0;transition:opacity .25s" src="about:blank"></webview>
      <div id="fb-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="width:34px;height:34px;border:3px solid color-mix(in srgb, var(--accent) 25%, transparent);border-top-color:var(--accent);border-radius:50%;animation:cloudspin .8s linear infinite"></div>
      </div>
    </div>`
    let webBase = 'https://moonlybox.cn'
    let token = null
    try {
      const r = await window.moonlybox.rpc('diagram', { op: 'nav' }, 30_000)
      if (!genValid()) return
      if (r.event === 'done' && r.code === 0) {
        const parsed = JSON.parse(r.text)
        webBase = parsed.data?.webBase ?? parsed.webBase ?? webBase
        token = parsed.token ?? null
      }
    } catch {}
    if (!genValid()) return
    const wv = $('fb-wv')
    if (!wv) return
    let injected = false
    wv.addEventListener('dom-ready', async () => {
      if (injected || !genValid()) return
      const cur = wv.getURL() || ''
      if (!cur.startsWith(webBase)) return
      injected = true
      try {
        if (token) await wv.executeJavaScript(`localStorage.setItem('mf_token', ${JSON.stringify(token)}); 'ok'`)
        // #310.9：语言跟随客户端（appearance.lang zh-CN→zh）——云端页内嵌语言一致
        const lang = (APP_SETTINGS?.appearance?.lang === 'en') ? 'en' : 'zh'
        await wv.executeJavaScript(`localStorage.setItem('mf_lang', ${JSON.stringify(lang)}); 'ok'`)
      } catch {}
      if (!genValid()) return
      // #310.4/.6：embed=1——AppShell 嵌入模式（#253.36）+PublicPageShell 嵌入模式（#310.9）——云端主菜单与页面自有头/脚都隐藏
      await wv.loadURL(`${webBase}/${arg === 'terms' ? 'terms' : 'feedback'}?mb_theme=${resolveThemeDark()}&embed=1`)
    })
    wv.addEventListener('did-finish-load', () => {
      if (!genValid()) return
      setTimeout(() => {
        if (!genValid()) return
        wv.style.opacity = '1'
        $('fb-loading')?.remove()
      }, 450)
    })
    // #310.8：terms/feedback 均为云端公开路由——直接加载目标页（同源注入 token 即可，无需先跳 /login 绕路；未登录 token=null 照常显示公开内容）
    wv.src = `${webBase}/${arg === 'terms' ? 'terms' : 'feedback'}?mb_theme=${resolveThemeDark()}&embed=1`
    return
  }
  if (nav === 'help' && arg === 'about') {
    setFrameTabCtx('help', t('help.about'))
    // #310.7：关于页卡片化——LOGO/名称/口号/版本徽章/更新区（自动更新开关+立即更新）/版本说明/发现新版本章节
    const v = await window.moonlybox.versions()
    const env = await window.moonlybox.envInfo().catch(() => null)
    const gs = await loadAppSettings()
    const autoOn = (gs.updater ?? { enabled: true }).enabled !== false
    const st = await window.moonlybox.updateState().catch(() => ({}))
    const LOGO_SVG = document.querySelector('#titlebar svg')?.outerHTML ?? ''
    // 版本说明（本地常量——发版时随版本更新；键=版本号）
    const VERSION_NOTES = {
      '0.5.1': '设置中心 11 分类；云端内嵌主题跟随；图示快建与侧栏细节批；小月对话 UI 与工作空间。',
      '0.5.0': '图示（Mermaid 代码面板+实时预览+AI 生成）；工作空间与对话持久化；消息平台八通道。',
    }
    const notes = VERSION_NOTES[v.shellVersion] ?? t('about.notesDefault')
    const prog = st?.progress != null ? `<div style="margin-top:8px;height:6px;border-radius:999px;background:var(--hover);overflow:hidden"><div style="width:${st.progress}%;height:100%;background:var(--accent);transition:width .3s"></div></div>` : ''
    const updateSection = st?.downloaded
      ? `<div class="set-card" style="border-color:var(--ok)"><div class="sc-main"><div class="sc-title" style="color:var(--ok)">✓ 新版本 v${st.version} 已就绪</div><div class="sc-desc">重启应用后完成安装</div></div><button class="btn" id="abt-install" style="background:var(--ok)">立即安装</button></div>`
      : st?.available
        ? `<div class="set-card" style="border-color:var(--accent)"><div class="sc-main"><div class="sc-title" style="color:var(--accent)">${t('about.newVer')} v${st.version}</div><div class="sc-desc">${VERSION_NOTES[st.version] ?? '修复与优化，详见官网更新日志。'}${st?.checking ? ' · 下载中…' : ''}</div></div></div>${prog}`
        : ''
    w.innerHTML = `
      <div style="padding:24px 28px;overflow-y:auto;height:100%;box-sizing:border-box">
        <div class="set-card" style="display:flex;align-items:center;gap:16px;padding:18px 20px">
          <div style="width:52px;height:52px;border-radius:14px;background:var(--hover);display:flex;align-items:center;justify-content:center;flex:none">${LOGO_SVG.replace('viewBox="132 72 236 343" style="width:18px;height:18px;flex:none"', 'viewBox="132 72 236 343" style="width:34px;height:34px"')}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:17px;font-weight:700">${t('about.name')}</div>
            <div class="set-desc" style="margin-top:2px">${t('about.slogan')}</div>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              <span style="font-size:11px;padding:2px 9px;border-radius:999px;background:var(--hover);color:var(--muted)">GUI v${v.shellVersion}</span>
              <span style="font-size:11px;padding:2px 9px;border-radius:999px;background:var(--hover);color:var(--muted)">${t('about.kernel')}${v.kernelVersion}</span>
              ${env?.packaged ? '' : '<span style="font-size:11px;padding:2px 9px;border-radius:999px;background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent)">开发模式</span>'}
            </div>
          </div>
        </div>

        <div class="set-card" style="margin-top:12px;display:flex;align-items:center;gap:12px;padding:14px 20px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${t('about.autoUpdate')}</div>
            <div class="set-desc" style="margin-top:2px">${t('about.autoUpdate.desc')}</div>
          </div>
          <button type="button" class="toggle ${autoOn ? 'on' : ''}" id="abt-auto"></button>
          <button class="btn" id="btn-check2">${st?.checking ? t('ui.checking') : t('ui.updateNow')}</button>
        </div>
        ${updateSection}

        <div class="set-card" style="margin-top:12px;padding:14px 20px">
          <div style="font-size:13px;font-weight:600">${t('about.notes')}</div>
          <div class="set-desc" style="margin-top:6px;line-height:1.7">v${v.shellVersion} · ${notes}</div>
        </div>

        <div class="set-desc" style="margin-top:14px">${t('about.env')}${env ? `${env.platform} · Electron ${env.electron}` : ''}</div>
      </div>`
    $('abt-auto').onclick = async (e) => {
      e.currentTarget.classList.toggle('on')
      const on = e.currentTarget.classList.contains('on')
      await saveAppSettings({ updater: { enabled: on } })
      await window.moonlybox.setAutoUpdate(on)
    }
    $('btn-check2').onclick = async (e) => {
      // #319.1：e.currentTarget 在 await 让出事件循环后已被事件派发重置为 null——先存引用再用
      // （分支1/2 走 renderWork 重建整个关于页，按钮无需再改文字；仅「已是最新」分支用存引用改文字）
      const btn = e.currentTarget
      btn.textContent = t('ui.checking')
      const st2 = await window.moonlybox.updateCheck()
      if (st2?.downloaded) renderWork('help', 'about')
      else if (st2?.available) renderWork('help', 'about')
      else btn.textContent = t('ui.latest')
    }
    const inst = $('abt-install')
    if (inst) inst.onclick = () => window.moonlybox.updateInstall()
    return
  }
  w.innerHTML = `<div style="padding:20px" class="muted">${t('help.kernelPick')}</div>`
}

// ---------- 上下文菜单关闭助手（#304）：移除菜单+清锚定行 hover 保持 ----------
function closeCtxMenu(menu) {
  menu._row?.classList.remove('menu-open')
  menu.remove()
}

// ---------- 确认弹窗（#307.2→#309：页面内置 <dialog>——UI 与新建工作空间统一；无 OS 模态往返，
// 焦点全程由 showModal/close 在 renderer 内管理（用户实测 dialog 开合恰好能重置焦点环）→失焦源头消除）。
// 确定后 forceFocus 归还焦点；桥 confirmBox 保留但不再默认使用。
// #310.34：页面内置通知（替代 OS 级 alert()——焦点打断同源问题；fire-and-forget）
function mbAlert(message) {
  const dlg = document.createElement('dialog')
  dlg.innerHTML = `
    <div class="dlg-body" style="min-width:320px">
      <div style="font-size:14px;line-height:1.6;white-space:normal;margin-bottom:18px">${message}</div>
      <div class="set-row" style="justify-content:flex-end;gap:8px">
        <button class="btn" id="mba-ok">${t('ui.ok')}</button>
      </div>
    </div>`
  document.body.appendChild(dlg)
  const finish = () => { dlg.close(); dlg.remove() }
  dlg.addEventListener('cancel', finish)
  dlg.addEventListener('close', finish)
  dlg.querySelector('#mba-ok').onclick = finish
  dlg.showModal()
}

function mbConfirm(message, okText = '删除') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.innerHTML = `
      <div class="dlg-body" style="min-width:360px">
        <div style="font-size:14px;line-height:1.6;white-space:normal;margin-bottom:18px">${message}</div>
        <div class="set-row" style="justify-content:flex-end;gap:8px">
          <button class="btn" id="mbc-ok" style="background:var(--err,#dc2626);color:#fff;border-color:transparent">${okText}</button>
          <button class="btn ghost" id="mbc-cancel">${t('ui.cancel')}</button>
        </div>
      </div>`
    document.body.appendChild(dlg)
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      dlg.close(); dlg.remove()
      document.removeEventListener('cancel', onCancel)
      resolve(v)
    }
    const onCancel = () => finish(false)
    dlg.addEventListener('cancel', onCancel) // Esc=取消
    dlg.addEventListener('close', () => finish(false)) // 兜底：任何 close 路径未走 finish
    dlg.querySelector('#mbc-ok').onclick = () => finish(true)
    dlg.querySelector('#mbc-cancel').onclick = () => finish(false)
    dlg.showModal()
    dlg.querySelector('#mbc-cancel').focus()
  })
}

// ---------- 焦点复位（#307）：confirm/删除 DOM 后 activeElement 可能残留在已断链节点——
// 此后 click 聚焦任何 input 失灵（焦点系统脏）。重渲入口统一自愈：断链则 blur 归还 body。
function ensureFocusAlive() {
  const sweep = () => {
    try {
      const ae = document.activeElement
      if (ae && ae !== document.body && !ae.isConnected) {
        ae.blur?.()
        document.body.focus?.()
      }
    } catch {}
  }
  sweep()
  setTimeout(sweep, 0)   // 重渲后节点才真正断链——下一帧再扫一次
  requestAnimationFrame(sweep)
}

// #307.3：焦点强重置——脏态下（activeElement 卡死/点击聚焦无效）按 dialog 开合同等效果重置焦点环：
// 依次尝试 blur 当前 → body 拿焦点 → 目标元素 focus；document.activeElement 不达目标时由 Chromium 重置收尾。
function forceFocus(el) {
  if (!el) return
  try {
    const ae = document.activeElement
    if (ae && ae !== el && ae !== document.body) ae.blur?.()
    if (!document.body.hasAttribute('tabindex')) document.body.setAttribute('tabindex', '-1')
    document.body.focus({ preventScroll: true })
    el.focus({ preventScroll: true })
  } catch {}
}

// ---------- 图示类型嗅探（#292）：代码首关键词 → DG_TEMPLATES key（存书房标签同源） ----------
function sniffDiagramType(code) {
  const head = String(code ?? '').replace(/^\s*```(?:mermaid)?/, '').trimStart().split(/\s/)[0] ?? ''
  const table = [
    ['flowchart', /^(flowchart|graph)\b/i], ['sequence', /^sequenceDiagram\b/i],
    ['mindmap', /^mindmap\b/i], ['pie', /^pie\b/i], ['gantt', /^gantt\b/i],
    ['er', /^erDiagram\b/i], ['state', /^stateDiagram/i], ['journey', /^journey\b/i],
    ['timeline', /^timeline\b/i], ['quadrant', /^quadrantChart\b/i],
    ['gitgraph', /^gitGraph\b/i], ['class', /^classDiagram\b/i],
  ]
  for (const [key, re] of table) if (re.test(head)) return key
  return null
}
function dgTypeIcon(item) {
  const key = item.diagramType ?? sniffDiagramType(item.content)
  const tpl = DG_TEMPLATES.find((t) => t.key === key)
  return (tpl && key !== 'empty' ? tpl.icon : '') || '📊'
}

// ---------- 图示模板（#290 创建返工：新建→模板弹窗→名称→自动填充示例） ----------
const DG_TEMPLATES = [
  { key: 'flowchart', name: 'dg.tpl.flowchart', icon: '🔀', desc: 'dg.tpld.flowchart', common: true,
    code: `flowchart TD
    A[开始] --> B{是否已登录?}
    B -- 是 --> C[进入首页]
    B -- 否 --> D[跳转登录页]
    D --> E[输入账密]
    E --> F{验证通过?}
    F -- 通过 --> C
    F -- 失败 --> D
    C --> G[结束]` },
  { key: 'sequence', name: 'dg.tpl.sequence', icon: '🔗', desc: 'dg.tpld.sequence', common: true,
    code: `sequenceDiagram
    participant U as 用户
    participant C as 客户端
    participant S as 服务端
    U->>C: 点击登录
    C->>S: 提交账密
    S-->>C: 返回 token
    C-->>U: 进入首页` },
  { key: 'mindmap', name: 'dg.tpl.mindmap', icon: '🧠', desc: 'dg.tpld.mindmap', common: true,
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
  { key: 'pie', name: 'dg.tpl.pie', icon: '🥧', desc: 'dg.tpld.pie', common: true,
    code: `pie title 时间分配
    "开发" : 45
    "设计" : 20
    "会议" : 15
    "其他" : 20` },
  { key: 'gantt', name: 'dg.tpl.gantt', icon: '📅', desc: 'dg.tpld.gantt', common: true,
    code: `gantt
    title 项目排期
    dateFormat YYYY-MM-DD
    section 设计
    原型设计 :a1, 2026-10-01, 7d
    视觉稿 :a2, after a1, 5d
    section 开发
    前端开发 :b1, after a2, 10d
    联调测试 :b2, after b1, 5d` },
  { key: 'er', name: 'dg.tpl.er', icon: '🗄️', desc: 'dg.tpld.er', common: true,
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
  { key: 'state', name: 'dg.tpl.state', icon: '🚦', desc: 'dg.tpld.state', common: false,
    code: `stateDiagram-v2
    [*] --> 草稿
    草稿 --> 待审核 : 提交
    待审核 --> 已发布 : 通过
    待审核 --> 草稿 : 驳回
    已发布 --> [*]` },
  { key: 'journey', name: 'dg.tpl.journey', icon: '🛤️', desc: 'dg.tpld.journey', common: false,
    code: `journey
    title 用户注册旅程
    section 发现
      访问官网: 5: 用户
      了解产品: 4: 用户
    section 转化
      注册账号: 3: 用户
      首次使用: 4: 用户` },
  { key: 'timeline', name: 'dg.tpl.timeline', icon: '🗓️', desc: 'dg.tpld.timeline', common: false,
    code: `timeline
    title 产品里程碑
    2026-01 : 立项
    2026-04 : 内测上线
    2026-09 : 正式发布` },
  { key: 'quadrant', name: 'dg.tpl.quadrant', icon: '🎯', desc: 'dg.tpld.quadrant', common: false,
    code: `quadrantChart
    title 需求优先级
    x-axis "低紧迫 --> 高紧迫"
    y-axis "低重要 --> 高重要"
    "需求A": [0.8, 0.9]
    "需求B": [0.3, 0.7]
    "需求C": [0.6, 0.2]` },
  { key: 'gitgraph', name: 'dg.tpl.gitgraph', icon: '🌿', desc: 'dg.tpld.gitgraph', common: false,
    code: `gitGraph
    commit id: "init"
    branch dev
    commit
    commit
    merge main
    commit id: "v1.0" tag: "v1.0"` },
  { key: 'class', name: 'dg.tpl.class', icon: '📦', desc: 'dg.tpld.class', common: false,
    code: `classDiagram
    class Animal {
        +String name
        +eat()
    }
    class Dog {
        +bark()
    }
    Animal <|-- Dog` },
  { key: 'empty', name: 'dg.tpl.empty', icon: '📄', desc: 'dg.tpld.empty', common: false, code: '' },
]


// ---------- 图示工作台绑定（从旧 renderer 迁移，#252 逻辑保留） ----------
let dgCurrentId = null
let dgRenderTimer = null
let dgLastError = null

function bindDiagramWorkbench(existing, pick) {
  dgCurrentId = existing?.id ?? null
  mmApplyTheme()
  // #290：pick=模板弹窗选择结果——填充名称+示例代码，新草稿从这一刻开始
  $('dg-code').value = pick ? (pick.code ?? '') : (existing?.content ?? '')
  $('dg-title').value = pick ? pick.title : (existing?.title ?? '')
  setFrameTabCtx('diagram', $('dg-title').value || '')
  // 从空态新建：显示标题框与保存/存书房/AI 按钮（打开已有图示时本就显示）
  const show = ['dg-save', 'dg-activate', 'dg-ai', 'dg-title']
  for (const id of show) { const el = $(id); if (el) el.style.display = '' }
  $('dg-state').textContent = pick ? `${t('dg.pickedTpl')}：${t(pick.name)}——${t('dg.tplFilled')}` : existing?.state === 'draft' ? t('dg.draft') : existing?.state ? t('dg.inStudy') : t('dg.newDraft')

  const render = async () => {
    const err = $('dg-err')
    const box = $('dg-preview')
    const src = $('dg-code').value
    const m = src.match(/```mermaid\n([\s\S]*?)```/)
    const code = (m ? m[1] : src).trim()
    if (!code) { box.innerHTML = '<span class="muted" style="font-size:12px">输入 mermaid 代码即时预览</span>'; return }
    try {
      mmApplyTheme()
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
    const title = $('dg-title').value.trim() || t('dg.untitled')
    const r = await window.moonlybox.rpc('diagram', { op: 'save', id: dgCurrentId, title, content: $('dg-code').value, diagramType: sniffDiagramType($('dg-code').value) }, 60_000)
    if (r.event === 'done' && r.code === 0) {
      const d = JSON.parse(r.text).data
      const isNew = !dgCurrentId
      dgCurrentId = d.id
      $('dg-state').textContent = `✓ 已保存草稿 v${d.version}`
      setFrameTabCtx('diagram', title)
      // #291：保存后立刻刷新侧栏列表（新建首存/改名都不用再切功能回来）
      void renderList('diagram')
      if (isNew) $('dg-state').textContent += t('lib.addedTip')
    } else $('dg-state').textContent = t('dg.saveFail') + (r.text || r.message)
  }
  $('dg-activate').onclick = async () => {
    if (!dgCurrentId) { $('dg-state').textContent = t('dg.saveFirst'); return }
    const r = await window.moonlybox.rpc('diagram', { op: 'activate', id: dgCurrentId }, 60_000)
    if (r.event === 'done' && r.code === 0) {
      $('dg-state').textContent = '📚 已存进书房'
      void renderList('diagram') // #291：📝→📚 徽标即时更新
    } else $('dg-state').textContent = t('dg.admitFail') + (r.text || r.message)
  }
  $('dg-ai').onclick = async () => {
    const prompt = window.prompt(t('dg.aiPrompt'))
    if (!prompt?.trim()) return
    const aiBtn = $('dg-ai') // #283.11：await 期间面板可能重渲——持有引用而非事后 querySelector（重渲后为 null）
    aiBtn.disabled = true
    $('dg-state').textContent = '✨ AI 生成中…'
    const r = await window.moonlybox.rpc('diagram', { op: 'ai', prompt }, 150_000)
    aiBtn.disabled = false
    if (r.event === 'done' && r.code === 0) {
      $('dg-code').value = JSON.parse(r.text).source
      dgCurrentId = null
      $('dg-state').textContent = t('dg.aiDone')
      document.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active')) // #302：AI 新内容未保存，清列表选中高亮
      render()
    } else $('dg-state').textContent = t('dg.aiFail') + (r.text || r.message)
  }
}

// ---------- 小月会话列表与工作空间（#282） ----------
let xyActiveChat = null      // 当前打开的对话 id
let xyActiveWorkspace = null // 新建对话的默认归属（null=无工作空间）
let xyCreating = false       // #305：createChat 防重入门（列表不实时刷新期间连点会建重复对话）

async function renderXiaoyueList() {
  ensureFocusAlive() // #307：删除工作空间/对话（confirm+DOM 重建）后焦点断链自愈
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
    // #317.MDI/M2：未读徽标（后台完成未查看）
    const unread = xyUnread.has(c.id)
    const running = xyRunning.has(c.id)
    const el = document.createElement('div')
    el.className = 'tree-item xy-chat' + (c.id === xyActiveChat ? ' active' : '')
    el.style.paddingLeft = '26px'
    el.dataset.chat = c.id
    // #303：删除收敛进 ⋯ 更多菜单（挂 body+fixed，#301 范式）
    el.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">💬 ${c.title}${running ? ' <span style="color:var(--muted);font-size:10px">⟳ 执行中</span>' : ''}${unread ? ' <span style="background:var(--err,#ef4444);color:#fff;border-radius:99px;font-size:10px;padding:0 6px">NEW</span>' : ''}</span><span data-more="1" style="color:var(--muted);cursor:pointer;padding:0 4px" title="${t('dg.more')}">⋯</span>`
    el.onclick = (e) => { if (!e.target.dataset.more) { xyUnread.delete(c.id); openChat(c.id, wsId) } }
    el.querySelector('[data-more]').onclick = (e) => {
      e.stopPropagation()
      const existed = document.querySelector('.xy-menu')
      if (existed) { closeCtxMenu(existed); return }
      const menu = document.createElement('div')
      menu.className = 'xy-menu'
      menu._row = el // #304：锚定行 hover 保持
      el.classList.add('menu-open')
      const rect = el.getBoundingClientRect()
      menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:96px;box-shadow:0 8px 24px rgba(0,0,0,.35);visibility:hidden'
      document.body.appendChild(menu)
      menu.innerHTML = `<div class="xy-mi-del" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--err)">${t('xy.delMenu')}</div>`
      const mh = menu.offsetHeight
      const below = rect.bottom + 2 + mh <= window.innerHeight - 8
      menu.style.left = `${Math.min(rect.right - 104, window.innerWidth - 112)}px`
      menu.style.top = `${below ? rect.bottom + 2 : rect.top - mh - 2}px`
      menu.style.visibility = ''
      menu.querySelector('.xy-mi-del').onclick = async (e2) => {
        e2.stopPropagation()
        closeCtxMenu(menu)
        if (!(await mbConfirm(t('xy.delChatConfirm').replace('{t}', c.title)))) return
        await window.moonlybox.rpc('workspace', { op: 'deleteChat', id: c.id }, 10_000)
        if (xyActiveChat === c.id) { xyActiveChat = null; await renderWork('xiaoyue') }
        await renderXiaoyueList()
      }
      const close = (e3) => { if (!menu.contains(e3.target)) { closeCtxMenu(menu); document.removeEventListener('click', close); lb?.removeEventListener('scroll', close) } }
      const lb = box.closest('.list-body')
      lb?.addEventListener('scroll', close, { once: true })
      setTimeout(() => document.addEventListener('click', close), 0)
    }
    return el
  }
  // 无工作空间组固定最前（#303）；工作空间按创建时间倒序（最新在上）
  const free = chats.filter((c) => !c.workspaceId)
  const freeGroup = document.createElement('div')
  freeGroup.className = 'xy-ws-group'
  // #303：组头副标签改内联样式（原 .set-desc 行高致「无工作空间」与主文字不齐平）
  // #310：＋ 居右——与工作空间组头（名称 flex:1 → 图标居右）同构
  freeGroup.innerHTML = `<div class="tree-item" style="font-weight:600"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t('xy.freeGroup')}<span style="margin-left:6px;font-weight:400;font-size:11px;color:var(--muted)">${t('xy.noWs')}</span></span><span class="xy-free-add" style="color:var(--muted);cursor:pointer;padding:0 4px" title="${t('xy.freeAddTip')}">＋</span></div>`
  box.appendChild(freeGroup)
  freeGroup.querySelector('.xy-free-add').onclick = async () => {
    if (xyCreating) return // #305 防重入
    xyCreating = true
    try {
      const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: null }, 15_000)
      if (r.event === 'done' && r.code === 0) {
        xyActiveChat = JSON.parse(r.text).chat.id
        xyActiveWorkspace = null
        await renderWork('xiaoyue')
        await renderWork('xiaoyue', { chat: xyActiveChat })
        await renderXiaoyueList()
      }
    } finally { xyCreating = false }
  }
  for (const c of free) box.appendChild(chatItem(c, null))
  const sorted = [...wss].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  for (const ws of sorted) {
    const group = document.createElement('div')
    group.className = 'xy-ws-group'
    // #303：组头收敛——保留「💬 在此工作空间新建对话」（单图标），「增加工作目录/删除」收进 ⋯ 更多菜单（参照图示 #300/#301：挂 body+fixed）
    group.innerHTML = `<div class="tree-item" style="font-weight:600"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ws.dirs.map((d, i) => (i === (ws.primaryIndex ?? 0) ? `【主】${d}` : d)).join('\n')}">📁 ${ws.name}</span><span class="xy-ws-chat" style="color:var(--muted);cursor:pointer;padding:0 4px" title="${t('xy.wsAddTip')}">💬</span><span class="xy-ws-more" style="color:var(--muted);cursor:pointer;padding:0 4px" title="${t('dg.more')}">⋯</span></div>`
    group.querySelector('.xy-ws-chat').onclick = async () => {
      if (xyCreating) return // #305 防重入
      xyCreating = true
      try {
        const r = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: ws.id }, 15_000)
        if (r.event === 'done' && r.code === 0) {
          xyActiveChat = JSON.parse(r.text).chat.id
          xyActiveWorkspace = ws.id
          await renderWork('xiaoyue')
          await renderWork('xiaoyue', { chat: xyActiveChat })
          await renderXiaoyueList()
        }
      } finally { xyCreating = false }
    }
    // #303：⋯ 更多菜单（挂 body+fixed，#301 范式）：增加工作目录 / 删除工作空间
    const openMenu = () => {
      const existed = document.querySelector('.xy-menu')
      if (existed) { closeCtxMenu(existed); return }
      const row = group.querySelector('.tree-item')
      const menu = document.createElement('div')
      menu.className = 'xy-menu'
      menu._row = row // #304：锚定行 hover 保持
      row.classList.add('menu-open')
      const rect = row.getBoundingClientRect()
      menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:132px;box-shadow:0 8px 24px rgba(0,0,0,.35);visibility:hidden'
      document.body.appendChild(menu)
      menu.innerHTML = `<div class="xy-mi-add" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">${t('xy.addDir')}</div><div class="xy-mi-del" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--err)">删除工作空间</div>`
      const mh = menu.offsetHeight
      const below = rect.bottom + 2 + mh <= window.innerHeight - 8
      menu.style.left = `${Math.min(rect.right - 140, window.innerWidth - 148)}px`
      menu.style.top = `${below ? rect.bottom + 2 : rect.top - mh - 2}px`
      menu.style.visibility = ''
      menu.querySelector('.xy-mi-add').onclick = async (e2) => {
        e2.stopPropagation()
        closeCtxMenu(menu)
        const r = await window.moonlybox.pickFolder()
        const dir = r?.ok ? r.path : null
        if (!dir) return
        await window.moonlybox.rpc('workspace', { op: 'update', id: ws.id, addDir: dir }, 10_000)
        await renderXiaoyueList()
      }
      menu.querySelector('.xy-mi-del').onclick = async (e2) => {
        e2.stopPropagation()
        closeCtxMenu(menu)
        if (!(await mbConfirm(t('xy.delWsConfirm').replace('{t}', ws.name)))) return
        await window.moonlybox.rpc('workspace', { op: 'delete', id: ws.id }, 10_000)
        await renderXiaoyueList()
      }
      const close = (e3) => { if (!menu.contains(e3.target)) { closeCtxMenu(menu); document.removeEventListener('click', close); lb?.removeEventListener('scroll', close) } }
      const lb = box.closest('.list-body')
      lb?.addEventListener('scroll', close, { once: true })
      setTimeout(() => document.addEventListener('click', close), 0)
    }
    group.querySelector('.xy-ws-more').onclick = (e) => { e.stopPropagation(); openMenu() }
    box.appendChild(group)
    for (const c of chats.filter((x) => x.workspaceId === ws.id)) box.appendChild(chatItem(c, ws.id))
    // #305：组尾「＋ 新对话」行删除——入口唯一（组头 💬 即新建对话入口）；原双入口连点会建重复对话
  }
}

function showWorkspaceDialog() {
  const dlg = document.createElement('dialog')
  dlg.innerHTML = `
    <div class="dlg-body" style="min-width:420px">
      <div class="sc-title" style="font-size:15px;font-weight:600;margin-bottom:12px">${t('xy.newWsTitle')}</div>
      <div class="set-field"><label>${t('xy.wsName')}</label><input id="ws-name" placeholder="${t('xy.wsNamePh')}" /></div>
      <div class="set-field"><label>${t('xy.wsDirs')}</label>
        <div id="ws-dirs" style="margin:4px 0 6px;display:flex;flex-direction:column;gap:4px"></div>
        <button class="btn ghost" id="ws-add-dir">${t('xy.addDirBtn')}</button>
      </div>
      <div class="set-row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="ws-create">${t('xy.create')}</button><button class="btn ghost" id="ws-cancel">${t('ui.cancel')}</button></div>
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
      const tag = i === primaryIdx ? `<span style="color:var(--accent);font-weight:600;flex-shrink:0">${t('xy.primary')}</span>` : ''
      row.innerHTML = `${tag}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d}">${d}</span>`
      if (i !== primaryIdx) {
        const setMain = document.createElement('span')
        setMain.textContent = t('lib.setPrimary')
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
    if (!name) { st.className = 'set-status err'; st.textContent = t('xy.wsNameReq'); return }
    if (!dirs.length) { st.className = 'set-status err'; st.textContent = t('xy.wsDirsReq'); return }
    const r = await window.moonlybox.rpc('workspace', { op: 'create', name, dirs, primaryIndex: primaryIdx }, 15_000)
    if (r.event === 'done' && r.code === 0) {
      dlg.close(); dlg.remove()
      // #306：创建工作空间的默认后续=顺便新建对话（打开+聚焦），用户切换功能回来对话保留（chats 持久化）
      const wsId = JSON.parse(r.text).workspace?.id ?? null
      xyActiveWorkspace = wsId
      if (wsId && !xyCreating) {
        xyCreating = true
        try {
          const rc = await window.moonlybox.rpc('workspace', { op: 'createChat', workspaceId: wsId }, 15_000)
          if (rc.event === 'done' && rc.code === 0) {
            xyActiveChat = JSON.parse(rc.text).chat.id
            await renderXiaoyueList()
            await renderWork('xiaoyue', { chat: xyActiveChat }) // bindChat 尾部自动聚焦输入框（#305）
            return
          }
        } finally { xyCreating = false }
      }
      await renderXiaoyueList() // #283.3：第二列会话列表刷新（原只重渲第三列工作台——新工作空间不出现）
      await renderWork('xiaoyue')
    } else { st.className = 'set-status err'; st.textContent = r.text || t('xy.createFail') }
  }
}

// ---------- 小月对话绑定（从旧 renderer 迁移） ----------
let kernelEventBound = false
let activeXyId = null // #317.F2：当前活跃 xiaoyue RPC id（模块级——bindChat 重入不丢）
const rpcCmdById = new Map() // #317.F2：rpc id→cmd（行门控只针对 xiaoyue）
// #317.MDI：行归属路由——rpcId→chatId；每会话行缓冲（非聚焦会话的行暂存，切回重放清空）
const xyRpcChat = new Map()
const xyBufById = new Map()
function bindChat(chatInfo) {
  const meta = chatInfo?.meta
  // #288 对话 UI：log() 升级为结构化消息渲染——行前缀分类（用户气泡/AI 气泡 Markdown/工具折叠条/思考折叠条/活动小字）。
  // daemon 协议不变（console.log 行级流），渲染分类全在 renderer 侧。
  const logEl = () => $('log')
  // 当前聚合态：连续相关行并入同一容器（AI 气泡 / 工具折叠 / 思考折叠）
  let cur = { type: null, el: null, text: '' }
  let lastAiText = '' // #329.5：最后一条 AI 气泡原始文本（兜底判重用——DOM textContent 经 markdown 渲染≠原文）
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
    else { cur = { type: 'ai', el: wrap, text }; lastAiText = text; setBubbleMarkdown(bubble, text) }
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
    if (body) b.textContent = String(body).split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n')
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
    // #310.17：静默行=不表示输出开始的过程注记——thinking 保持并更新阶段文案
    if (/^（已接入工具 /.test(line)) { showThinking(t('xy.phaseTools')); return }
    // #317.F16/P3o：工具回执行=上一轮的回答已出、本轮回执到达——此时 cur 常是上轮 AI 气泡→误并进气泡（真机：附加在回复中）。
    // 归 thinking 静默行：阶段文案短暂可见，不落常驻 DOM。
    if (/^（工具调用 \d+\/\d+ 成功）$/.test(line)) { showThinking(t('xy.phaseToolRun')); return }
    if (/^（本地|^（云端|^（上下文|^（记忆/.test(line)) { showThinking(t('xy.phasePrep')); return }
    // #317.F3：LLM 重试行=模型慢/瞬态错——thinking 持续并把轮次写进文案（用户知道没死机；本地大模型首 token 慢是常态）
    const mRetry = line.match(/^（LLM 调用失败，重试 (\d+)\/(\d+)：(.*)）$/)
    if (mRetry) { showThinking(t('xy.retrying').replace('{n}', mRetry[1]).replace('{total}', mRetry[2]).replace('{err}', mRetry[3].slice(0, 40))); return }
    // 分类规则（与 kernel 行形态一一对应）：
    hideThinking()
    if (line.startsWith('你> ')) {
      flushCur()
      addMsg('user', line.slice(3))
      return
    }
    if (line.startsWith('小月：')) {
      flushCur()
      hideThinking() // #317.F5：终答已出——thinking 立即收（不等 done；done 只是兜底）
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
      // #310.18：⚙=动作开始非结束——thinking 持续换「正在执行工具…」（慢工具如 local_task 扫描 10s+ 有状态）；结果行到达才收
      // #317.F16/P3o：summary 只留工具名（截首空格段）；参数进折叠体首行（裸 args 不再挂 summary 上屏）
      flushCur()
      const sp1 = line.indexOf(' ')
      const tName = sp1 > 0 ? line.slice(1, sp1) : line.slice(1)
      const tArgs = sp1 > 0 ? line.slice(sp1 + 1) : ''
      const body = addFold('⚙ ' + tName, tArgs, 'tool')
      cur = { type: 'tool', el: body, text: '' }
      showThinking(t('xy.phaseToolRun'))
      return
    }
    if (/^（LLM 响应：/.test(line) || /^（本地/.test(line) || /^（云端/.test(line) || /^（上下文/.test(line)) {
      flushCur()
      const isThink = line.startsWith('（LLM 响应：')
      const body = addFold(isThink ? '💭 思考过程' : line.replace(/^（|）$/g, ''), line, 'think')
      cur = { type: 'think', el: body, text: line }
      if (isThink) showThinking(t('xy.phaseModel')) // #310.17：诊断行进折叠卡但 thinking 持续（本轮还没结束）
      return
    }
    if (/^  → |^  ✗ |^  （/.test(line) && (cur.type === 'tool' || cur.type === 'think')) {
      // #310.18：结果行并入折叠体（#308.3：空行不并入）
      // #317.F5：→/✗=工具结果——Agent 循环可能还有下一轮 LLM（结果回注后模型继续），thinking 恢复而非收
      //   （旧行为 hideThinking 假设「结果行=完成」——多工具轮场景 GPU 在跑 UI 却假死观感）；
      //   （ 开头=确认请求/等待用户——thinking 收（确认条是主交互）
      if (/^  （/.test(line)) hideThinking()
      else showThinking(t('xy.phaseDigest'))
      if (line.trim()) {
        cur.text += (cur.text ? '\n' : '') + line
        cur.el.textContent = cur.text
      }
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
      // #317.F2：会话行门控——xiaoyue RPC 的行只上屏当前活跃会话（旧 RPC 迟到行不串扰）；其他 cmd 行不受影响
      if (msg.event === 'rpc-start') {
        rpcCmdById.set(msg.id, String(msg.payload ?? ''))
        if (msg.payload === 'xiaoyue') {
          // #317.MDI：rpcId→chatId 归属（发起时刻的会话）——后台行进各自缓冲，聚焦会话实时上屏
          if (window.__xyPendingChat) { xyRpcChat.set(msg.id, window.__xyPendingChat); window.__xyPendingChat = null }
          else if (!xyRpcChat.has(msg.id)) xyRpcChat.set(msg.id, xyPaneMeta?.id ?? '?')
          activeXyId = msg.id
        }
        return
      }
      if (msg.event === 'log' || msg.event === 'stderr') {
        if (rpcCmdById.get(msg.id) !== 'xiaoyue') return
        // #317.MDI：行按 rpcId→chatId 归属——聚焦会话实时上屏；后台会话进缓冲（切回重放）
        const chatId = xyRpcChat.get(msg.id) ?? '?'
        if (msg.id !== activeXyId || chatId !== (xyPaneMeta?.id ?? '?')) {
          if (!xyBufById.has(chatId)) xyBufById.set(chatId, [])
          xyBufById.get(chatId).push(msg.event === 'stderr' ? '[stderr] ' + msg.payload : msg.payload)
          return
        }
      }
      if (xyAborted && (msg.event === 'log' || msg.event === 'stderr')) return // #310.14：停止后不上屏
      if (msg.event === 'log') { log(msg.payload) }
      else if (msg.event === 'stderr') { hideThinking(); log('[stderr] ' + msg.payload) }
      else if (msg.event === 'confirm_request') renderConfirmBar(msg.id, msg.payload)
      // #310.7：调试模式镜像（模块级异步查一次开关，避免每行 RPC）
      if (msg.event === 'log' || msg.event === 'stderr') {
        debugMirror().then((on) => { if (on) window.moonlybox.debugLog(msg.payload) })
      }
    })
    kernelEventBound = true
  }
  // #310.14：运行态 UX——「小月思考中…」三点动画（首条过程行上屏即收）；停止按钮（前端中断上屏+丢弃结果）；
  // 失败错误行附「重试」。RPC 无 abort 通道：停止=不再渲染后续行+结果丢弃（后台任务自然结束，诚实提示）。
  let xyAborted = false
  let thinkingEl = null
  // #310.17：思考态=持续状态——静默行（装配/诊断/上下文注入）不摘除只更新文案；
  // 活动行（工具调用/终答/普通过程行）才收。元素始终置底（插队行上屏后 thinking 移到末尾）。
  const showThinking = (phase) => {
    // #317.MDI：占位页（无 #log）时行无处挂——静默跳过（kernel 行继续，进对话后自然恢复）
    if (!logEl()) return
    if (!thinkingEl) {
      const el = document.createElement('div')
      el.className = 'chat-act-line xy-thinking'
      el.innerHTML = `<span class="xy-dot"></span><span class="xy-dot"></span><span class="xy-dot"></span> <span class="xy-thinking-text"></span>`
      logEl().appendChild(el)
      thinkingEl = el
    } else {
      logEl().appendChild(thinkingEl) // 置底
    }
    thinkingEl.querySelector('.xy-thinking-text').textContent = phase ?? t('xy.thinking')
    scroll()
  }
  const hideThinking = () => { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null } }
  // #317.F16/P3p：思考档位有效值（与 xiaoyue 侧同源逻辑）——显式设置优先；未设置时本地默认模型=开（用户拍板）
  const xyThinkEffective = () => {
    const ex = APP_SETTINGS?.chat?.thinking
    if (ex === 'on' || ex === 'off') return ex === 'on'
    return String(APP_SETTINGS?.model?.default ?? '').startsWith('local:')
  }
  async function askWith(q) {
    const askBtn = $('btn-ask') // #283.11：await 最长 300s，期间切对话/切页重渲——持有引用，事后 querySelector 会是 null
    askBtn.disabled = true
    const stopBtn = $('btn-stop')
    if (stopBtn) stopBtn.style.display = ''
    xyAborted = false
    xyRunning.add(xyPaneMeta?.id ?? '?')
    window.__xyPendingChat = xyPaneMeta?.id ?? '?' // #317.MDI：rpc-start 时建归属映射
    addMsg('user', q) // #288：用户消息直接走气泡（不再经行分类）
    showThinking()
    // #269：工具（管家模式）归 MCP 分类——mcp.builtinEnabled 总闸；#282 chatId/workspaceId 随请求
    const tools = APP_SETTINGS?.mcp?.builtinEnabled !== false
    const payload = { q, chatId: meta?.id, workspaceId: meta ? (meta.workspaceId ?? null) : undefined }
    if (tools) payload.tools = true
    // #317.F16/P3o：本地默认模型放宽 RPC 等待——8 tok/s 下思考+工具轮常超 300s（真机 113.6s/轮×多轮），
    // 300s 硬超时=误判（模型仍在跑、任务仍会创建成功）。本地 600s，云端维持 300s。
    const isLocalDefault = String(APP_SETTINGS?.model?.default ?? '').startsWith('local:')
    const r = await window.moonlybox.rpc('xiaoyue', payload, isLocalDefault ? 600_000 : 300_000)
    askBtn.disabled = false
    if (stopBtn) stopBtn.style.display = 'none'
    hideThinking()
    // #283.4：回答只显示一路——过程行（含「小月：」终答）已经 kernel log 实时上屏，
    // done.text 是同一批行的整包（parts.join），再 log 一次＝回答重复两段。done 分支只报错误。
    // #329.1：终答兜底——真机反复出现「诊断行上屏但『小月：』终答缺失」（daemon 实验铁证 done.text 恒含终答行，
    // 丢失发生在行流段）——从 done.text 解析最后一条「小月：」行，屏上无此内容则补渲染（幂等）。
    if (r.event === 'done' && r.code === 0) {
      const full = String(r.text ?? '')
      const m = full.match(/(?:^|\n)小月：([\s\S]*?)(?=\n（工具调用 |\n（[^）]*）$|$)/)
      const finalAnswer = m ? m[1].trim() : ''
      if (finalAnswer && finalAnswer !== lastAiText.trim()) {
        addMsg('ai', finalAnswer)
      }
    }
    if (xyAborted) {
      flushCur()
      const el = document.createElement('div')
      el.className = 'chat-act-line'
      el.textContent = t('xy.stopped')
      logEl().appendChild(el)
      scroll()
    } else if (!(r.event === 'done' && r.code === 0)) {
      flushCur()
      const errEl = document.createElement('div')
      errEl.className = 'chat-err'
      const isTimeout = /timeout|timed out|超时/i.test(String(r.message ?? r.text ?? ''))
      if (isTimeout && isLocalDefault) {
        // #317.F16/P3o：本地慢模型 RPC 超时≠失败——kernel 那轮仍在跑（GPU 在转、任务仍会创建），
        // 「重试」会造成重复执行。文案如实+按钮改名。
        errEl.textContent = '⚠ 等待超时（本轮已超过 10 分钟断开显示，但模型可能仍在后台运行并完成任务）——建议稍等片刻直接提问查看结果，不要立即重发以免重复执行。'
        const keep = document.createElement('button')
        keep.className = 'btn ghost'
        keep.textContent = '仍要重发'
        keep.style.marginLeft = '8px'
        keep.onclick = () => { errEl.remove(); askWith(q) }
        errEl.appendChild(keep)
      } else {
        errEl.textContent = '⚠ ' + (r.message ?? r.text ?? t('ui.reqFail'))
        const retry = document.createElement('button')
        retry.className = 'btn ghost'
        retry.textContent = t('xy.retry')
        retry.style.marginLeft = '8px'
        retry.onclick = () => { errEl.remove(); askWith(q) }
        errEl.appendChild(retry)
      }
      logEl().appendChild(errEl)
      scroll()
    }
    xyRunning.delete(xyPaneMeta?.id ?? '?')
    xyRpcChat.delete(activeXyId)
    flushCur()
    // #317.MDI/M2：后台完成通知——发起时在对话 A，完成时用户已切到别的功能页 → 系统通知+列表徽标
    if (currentNav !== 'xiaoyue') {
      const okDone = r.event === 'done' && r.code === 0
      void window.moonlybox.notify?.(
        okDone ? '小月已完成回复' : '小月任务结束（出错或超时）',
        `${(xyPaneMeta?.title ?? '对话').slice(0, 20)}：${q.slice(0, 60)}`
      )
      xyUnread.add(xyPaneMeta?.id ?? '?')
      renderXiaoyueList()
    }
    // 会话标题随首轮更新（列表刷新）
    if (meta && meta.title === '新对话') renderXiaoyueList()
  }
  async function ask() {
    const q = $('q').value.trim()
    if (!q) return
    $('q').value = ''
    await askWith(q)
  }
  $('btn-ask').onclick = ask
  // #310.14：停止——置 aborted：后续 kernel log 不再上屏，RPC 结果丢弃
  const bindStop = () => {
    const sb = $('btn-stop')
    if (sb) sb.onclick = () => { xyAborted = true; hideThinking() }
  }
  bindStop()
  // #317.4：底部功能区——模型/思考 自绘下拉（dg-menu 范式：fixed+body 挂载+外点关闭；原生 select/confirm 禁用铁律）
  const closeMenu = (m) => { m?.remove(); document.removeEventListener('pointerdown', m?._pd, true) }
  const openMenu = (anchor, build) => {
    const existed = document.querySelector('.xy-menu')
    if (existed) { closeMenu(existed); return }
    const menu = document.createElement('div')
    menu.className = 'xy-menu'
    menu.style.cssText = 'position:fixed;z-index:1000;background:var(--bg2,#1e293b);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:180px;max-height:280px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.35)'
    menu.style.visibility = 'hidden'
    document.body.appendChild(menu)
    build(menu)
    const rect = anchor.getBoundingClientRect()
    const mh = menu.offsetHeight
    const below = rect.top - 4 - mh >= 8 // 输入框在底部——默认向上弹
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`
    menu.style.top = `${below ? rect.top - mh - 4 : rect.bottom + 4}px`
    menu.style.visibility = ''
    menu._pd = (ev) => { if (!menu.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeMenu(menu) }
    setTimeout(() => document.addEventListener('pointerdown', menu._pd, true), 0)
  }
  const menuItem = (menu, label, active, onclick) => {
    const it = document.createElement('div')
    it.textContent = (active ? '✓ ' : '') + label
    it.style.cssText = `padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--fg,#e2e8f0);${active ? 'background:rgba(99,102,241,.18);' : ''}`
    it.onmouseenter = () => { if (!active) it.style.background = 'rgba(148,163,184,.12)' }
    it.onmouseleave = () => { if (!active) it.style.background = '' }
    it.onclick = () => { closeMenu(menu); onclick() }
    menu.appendChild(it)
  }
  // 模型列表（与设置页 modelPickerOpts 同源：平台/自定义/本地 三组已启用实例）
  const xyModelList = () => {
    const mm = APP_SETTINGS?.model ?? {}
    const out = []
    for (const x of (mm.providers ?? []).filter((x) => x.enabled)) {
      const pv = (APP_PROVIDERS?.platform ?? PLATFORM_PROVIDERS_FALLBACK).find((p) => p.id === x.providerId)
      out.push({ ref: `platform:${x.id}`, label: `${pv?.label ?? x.providerId} · ${x.model}` })
    }
    for (const x of (mm.custom ?? []).filter((x) => x.enabled)) out.push({ ref: `custom:${x.id}`, label: `${x.name} · ${x.model}` })
    for (const x of (mm.local ?? []).filter((x) => x.enabled)) out.push({ ref: `local:${x.id}`, label: `${x.name} · ${x.model}` })
    return out
  }
  const refreshFunLabels = () => {
    const mm = APP_SETTINGS?.model ?? {}
    const list = xyModelList()
    const cur = list.find((x) => x.ref === (mm.default ?? ''))
    const ml = $('xy-model-label'); if (ml) ml.textContent = cur ? cur.label : t('xy.model')
    const tl = $('xy-think-label')
    if (tl) tl.textContent = `${t('xy.thinking')}: ${xyThinkEffective() ? t('xy.thinkOn') : t('xy.thinkOff')}`
  }
  refreshFunLabels()
  $('xy-model-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    openMenu(e.currentTarget, (menu) => {
      const cur = APP_SETTINGS?.model?.default ?? ''
      for (const m of xyModelList()) menuItem(menu, m.label, m.ref === cur, async () => {
        const r = await saveAppSettings({ model: { ...APP_SETTINGS.model, default: m.ref } })
        if (r?.ok) refreshFunLabels() // saveAppSettings 已回写 APP_SETTINGS
      })
    })
  })
  $('xy-think-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    openMenu(e.currentTarget, (menu) => {
      const cur = xyThinkEffective()
      menuItem(menu, t('xy.thinkOn'), cur, async () => { await saveAppSettings({ chat: { ...APP_SETTINGS.chat, thinking: 'on' } }); refreshFunLabels() })
      menuItem(menu, t('xy.thinkOff'), !cur, async () => { await saveAppSettings({ chat: { ...APP_SETTINGS.chat, thinking: 'off' } }); refreshFunLabels() })
    })
  })
  // #305：绑定完成即聚焦输入框（连续渲染后可直接输入；输入法状态不打断）
  // #307.3：focus 换 forceFocus——删除/confirm 等操作后焦点系统脏态下普通 focus() 会被忽略
  setTimeout(() => { const q = $('q'); if (q && !q.disabled) forceFocus(q) }, 50)
  // #317.4：textarea 自适应高度（1 行起步，随内容长高，max-height 160px 后内滚）+Enter 发送/Shift+Enter 换行
  const qTa = $('q')
  const autoGrow = () => { qTa.style.height = 'auto'; qTa.style.height = Math.min(qTa.scrollHeight, 160) + 'px' }
  qTa.addEventListener('input', autoGrow)
  qTa.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } })
  // #307.3：点击输入框时若焦点系统脏（点了没反应），pointerdown 内先强重置再聚焦——同点击动作内自愈
  $('q').addEventListener('pointerdown', () => { const q = $('q'); if (q && !q.disabled) forceFocus(q) })
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
    sep2.textContent = t('xy.historySep')
    logEl().appendChild(sep2)
    scroll()
  }
  // #317.MDI：暴露重放句柄（renderXiaoyuePane 切回会话时重放后台缓冲行）
  window.__xyReplay = (lines) => { for (const line of lines) log(line); scroll() }
}

function renderConfirmBar(rpcId, payload) {
  const log = $('log')
  if (!log) return
  const bar = document.createElement('div')
  bar.style.cssText = 'background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.55);border-radius:8px;padding:8px;margin:6px 0'
  // #310.20：daemon 发的字段名是 args（非 argsJson）——修 undefined 直出；参数截 200 防长参撑爆确认条
  bar.textContent = `⚙ ${payload.tool} ${String(payload.args ?? '').slice(0, 200)}（写操作，确认执行？）`
  // #316 第三批：编译任务确认卡「将使用：X（更改）」——模型透明+跳设置
  if (payload.tool === 'local_task_create_compile') {
    const lbl = compileModelLabel()
    if (lbl) {
      const ml = document.createElement('div')
      ml.style.cssText = 'margin:4px 0 6px;font-size:12px'
      ml.innerHTML = `${t('tk.willUse')} <b></b>`
      ml.querySelector('b').textContent = lbl
      const chg = document.createElement('a')
      chg.href = '#'; chg.style.marginLeft = '6px'; chg.textContent = t('tk.changeModel')
      chg.onclick = (e) => { e.preventDefault(); bar.remove(); nav('settings'); setTimeout(() => { const el = document.querySelector('[data-settab="library"]'); if (el) el.click() }, 60) }
      ml.appendChild(chg)
      bar.appendChild(ml)
    }
  }
  const yes = document.createElement('button')
  yes.className = 'btn'; yes.textContent = t('ui.confirm'); yes.style.marginRight = '6px'
  const no = document.createElement('button')
  no.className = 'btn ghost'; no.textContent = t('ui.cancel')
  yes.onclick = async () => { await window.moonlybox.confirmResponse(rpcId, true); bar.remove() }
  no.onclick = async () => { await window.moonlybox.confirmResponse(rpcId, false); bar.remove() }
  bar.append(yes, no)
  log.appendChild(bar)
}

// ---------- 对话 Markdown 渲染（#288：marked vendor+sanitize+mermaid 回填；图示页 mdToHtml 同逻辑全局化） ----------
function renderMarkdownSafe(src) {
  // #308.2：对话输出空白行压缩——LLM 常输出段间多空行/纯空格行（渲染成整行空白）；
  // 行尾空白全去、连续 2+ 空行压成 1 行、只含空白的行删除（保留单个空行=markdown 段落分隔语义）
  src = String(src ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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
  // #308.3：结果级空白行清理——marked 产出的裸 \n 文本节点与空段（含仅空白/&nbsp;）在行距下表现为整行空白
  tpl.content.querySelectorAll('p,li,h1,h2,h3,h4,td,th').forEach((el) => {
    const txt = (el.textContent || '').replace(/\u00a0/g, ' ').trim()
    if (!txt && !el.querySelector('img,svg,code,pre,table')) el.remove()
  })
  const out = tpl.innerHTML.replace(/<!--MBMERMAID(\d+)-->/g, (_m, i) => `<div class="mb-mermaid" data-mbcode="${encodeURIComponent(mermaidBlocks[Number(i)] ?? '')}"></div>`)
  // mermaid 回填（异步出图）
  requestAnimationFrame(() => {
    document.querySelectorAll('.mb-mermaid:not([data-mbdone])').forEach(async (el) => {
      el.dataset.mbdone = '1'
      const code = decodeURIComponent(el.dataset.mbcode ?? '')
      if (!code || !window.mermaid) return
      mmApplyTheme()
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
    // #323 连接态：会员徽标（premium 且未到期=高级会员；否则免费版+升级入口）——数据=profile 的 level/premiumExpiresAt
    const isPrem = !!(p?.level === 'premium' && p?.premiumExpiresAt && new Date(p.premiumExpiresAt) > new Date())
    const badge = isPrem
      ? `<span style="font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(251,191,36,.15);color:#fbbf24;margin-left:6px">${t('ac.premiumBadge')}${p.premiumExpiresAt ? ' · ' + p.premiumExpiresAt.slice(0, 10) : ''}</span>`
      : `<span style="font-size:11px;padding:1px 8px;border-radius:999px;background:var(--hover);color:var(--muted,#94a3b8);margin-left:6px">${t('ac.freeBadge')}</span>`
    const upgradeRow = isPrem ? '' : `<div id="ac-upgrade" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px;color:#fbbf24">${t('ac.upgrade')} ${extSvg}</div>`
    const dlg = document.createElement('dialog')
    dlg.innerHTML = `
      <div class="dlg-body">
      <div style="display:flex;align-items:center;gap:14px">
        ${avatarUrl
          ? `<img src="${avatarUrl}" style="width:52px;height:52px;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer"/>`
          : `<div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px">${(nickname[0] ?? '?').toUpperCase()}</div>`}
        <div style="min-width:0">
          <div style="font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${nickname}${badge}</div>
          <div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${signature || (d.email ?? '')}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin:14px 0 6px"></div>
      ${upgradeRow}
      <div id="ac-feedback" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px">${t('ac.feedback')} ${extSvg}</div>
      <div id="ac-settings" style="display:flex;align-items:center;justify-content:space-between;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px">${t('ac.settings')} ${extSvg}</div>
      <div id="ac-logout" style="display:flex;align-items:center;padding:9px 6px;border-radius:8px;cursor:pointer;font-size:13.5px;color:#f87171">${t('ac.logout')}</div>
      </div>`
    document.body.appendChild(dlg)
    dlg.showModal()
    const rows = dlg.querySelectorAll('#ac-feedback,#ac-settings,#ac-logout')
    rows.forEach((el) => {
      el.onmouseenter = () => { el.style.background = 'var(--hover)' }
      el.onmouseleave = () => { el.style.background = 'transparent' }
    })
    const upEl = dlg.querySelector('#ac-upgrade')
    if (upEl) upEl.onclick = () => { dlg.close(); window.moonlybox.openExternal('https://moonlybox.cn/upgrade') }
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
    text.textContent = t('ui.updating')
    btn.dataset.tip = t('up.downloading').replace('{v}', version)
  } else if (state === 'ready') {
    dot.style.display = 'block'; btn.classList.add('ready', 'active')
    text.textContent = t('ui.restartUpdate')
    btn.dataset.tip = t('up.ready').replace('{v}', version)
  } else {
    dot.style.display = 'none'; btn.classList.remove('ready', 'active')
    text.textContent = ''
    btn.dataset.tip = t('ui.checkUpdate')
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
    mbConfirm(`v${st.version} ${t('about.installAsk')}`, t('ui.install')).then((ok) => { if (ok) window.moonlybox.updateInstall() })
    return
  }
  setUpgradeState('available', st?.version ?? '')
  $('upgrade-text').textContent = t('ui.checking')
  const after = await window.moonlybox.updateCheck()
  if (after?.downloaded) setUpgradeState('ready', after.version)
  else if (after?.available) setUpgradeState('available', after.version)
  else {
    setUpgradeState('none', '')
    $('upgrade-text').textContent = t('up.latest')
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
    btn.dataset.tip = t('ac.signedAs').replace('{e}', email)
  } else {
    btn.textContent = t('ac.notSigned')
    btn.dataset.tip = t('ui.notLogin')
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
    <strong style="font-size:15px">${t('lg.title')}</strong>
    <p class="muted" style="font-size:12.5px;margin:10px 0">${t('lg.steps')}</p>
    <div class="mono" style="background:var(--hover);border-radius:8px;padding:10px;font-size:18px;letter-spacing:2px;text-align:center;margin:10px 0" id="lg-code">${t('lg.getCode')}</div>
    <div class="row" style="justify-content:center;gap:8px">
      <button class="btn" id="lg-open">${t('lg.openAuth')}</button>
      <button class="btn ghost" id="lg-cancel">${t('ui.cancel')}</button>
    </div>
    <p class="muted mono" id="lg-status" style="margin-top:10px;font-size:12px">${t('lg.waitAuth')}</p>`
  document.body.appendChild(dlg)
  dlg.showModal()
  const r = await window.moonlybox.rpc('auth', { op: 'start' }, 30_000)
  if (r.event !== 'done' || r.code !== 0) {
    $('lg-status').textContent = t('lg.startFail') + (r.text || r.message)
    return
  }
  const d = JSON.parse(r.text)
  $('lg-code').textContent = d.userCode
  // 授权页双通道：按钮打开+链接兜底（IPC openExternal 偶发无效时可右键复制/手动打开）
  const url = d.url || `https://moonlybox.cn/oauth/device?user_code=${d.userCode}`
  $('lg-open').onclick = async () => {
    try { await window.moonlybox.openExternal(url) } catch (e) { $('lg-status').textContent = t('lg.openFail') + url }
  }
  $('lg-cancel').onclick = () => { closed = true; dlg.close(); dlg.remove() }
  dlg.addEventListener('close', () => { closed = true })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点击 backdrop 关闭
  // 手动复制兜底（IPC 打开失败/浏览器未响应时）
  const det = document.createElement('details')
  det.style.cssText = 'margin-top:6px'
  det.innerHTML = `<summary class="muted" style="font-size:11px;cursor:pointer">${t('lg.copyLink')}</summary><div class="mono" style="font-size:11px;user-select:all;word-break:break-all">${url}</div>`
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
        $('lg-status').textContent = t('lg.signedIn') + pd.email
        // #323 连接态探针：登录成功即拉 profile 会员态——非 premium 提示月光链需会员（不阻塞登录，不拦截授权）
        try {
          const mr = await window.moonlybox.rpc('auth', { op: 'profile' }, 25_000)
          const mu = JSON.parse(mr.text)?.data?.user
          if (mu && !(mu.level === 'premium' && mu.premiumExpiresAt && new Date(mu.premiumExpiresAt) > new Date())) {
            $('lg-status').innerHTML = `${t('lg.signedIn')}${pd.email} · <span style="color:#fbbf24">${t('lg.premiumHint')}</span>`
          }
        } catch {}
        setTimeout(() => { closed = true; dlg.close(); dlg.remove(); if (currentNav === 'cloud') renderList('cloud') }, 1200)
        return
      }
      if (pd.status === 'pending' || pd.status === 'slow_down') $('lg-status').textContent = t('lg.waitConfirm')
      if (pd.status === 'denied') { $('lg-status').textContent = t('lg.denied'); break }
      if (pd.status === 'expired') { $('lg-status').textContent = t('lg.expired'); break }
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
