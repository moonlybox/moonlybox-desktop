/**
 * i18n（#256.2）：zh-CN / en 双语字典 + t() 查找。
 * 用法：t('settings.general')；缺 key 回退 zh-CN；语言切换后 renderer 全量重渲染。
 */
type Dict = Record<string, string>

const ZH: Dict = {
  'nav.home': '首页', 'nav.cloud': '云端', 'nav.vault': '书房', 'nav.settings': '设置',
  'settings.title': '设置', 'settings.general': '通用', 'settings.appearance': '外观',
  'settings.library': '文档库', 'settings.chat': '对话', 'settings.model': '模型',
  'settings.messaging': '消息平台', 'settings.mcp': 'MCP', 'settings.skills': '技能',
  'settings.websearch': '网络搜索', 'settings.docproc': '文档处理', 'settings.memory': '记忆',
  'settings.saved': '已保存', 'settings.save': '保存', 'settings.test': '测试连接',
  'settings.enabled': '启用', 'settings.disabled': '停用',
  'common.on': '开启', 'common.off': '关闭',
}

const EN: Dict = {
  'nav.home': 'Home', 'nav.cloud': 'Cloud', 'nav.vault': 'Library', 'nav.settings': 'Settings',
  'settings.title': 'Settings', 'settings.general': 'General', 'settings.appearance': 'Appearance',
  'settings.library': 'Documents', 'settings.chat': 'Chat', 'settings.model': 'Models',
  'settings.messaging': 'Messaging', 'settings.mcp': 'MCP', 'settings.skills': 'Skills',
  'settings.websearch': 'Web Search', 'settings.docproc': 'Doc Processing', 'settings.memory': 'Memory',
  'settings.saved': 'Saved', 'settings.save': 'Save', 'settings.test': 'Test Connection',
  'settings.enabled': 'Enabled', 'settings.disabled': 'Disabled',
  'common.on': 'On', 'common.off': 'Off',
}

const DICTS: Record<string, Dict> = { 'zh-CN': ZH, en: EN }
let currentLang = 'zh-CN'

export function setLang(lang: string): void {
  if (DICTS[lang]) currentLang = lang
}

export function t(key: string): string {
  return DICTS[currentLang]?.[key] ?? ZH[key] ?? key
}
