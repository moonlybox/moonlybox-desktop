/**
 * 设置中心存储（#256 设置迭代）：~/.config/moonlybox/settings.json
 *
 * 范式：非敏感配置全落本文件（无 token/key——key 纪律：一律钥匙串，
 * service=moonlybox，account 按 provider 区分）；main.js 与 daemon 共读同一份。
 * loadSettings 带 schema 默认值合并——用户缺项时回退默认，不崩。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './config'

export interface SettingsSchema {
  general: {
    launchAtLogin: boolean // 开机启动
    launchMinimized: boolean // 启动时最小化到托盘
    closeToTray: boolean // 关闭时最小化到托盘（false=真退出）
    keepAwake: boolean // 运行任务时保持电脑唤醒（powerSaveBlocker）
    clipboardWatch: boolean // 剪贴板自动采集（原 T3 开关迁入）
    toolsEnabled: boolean // 工具（管家模式）开关
  }
  appearance: {
    theme: 'dark' | 'light' | 'system' | 'time' // 色彩风格（time=跟随时间 18:00-06:00 深色）
    lang: 'zh-CN' | 'en' // 语言
    zoom: number // 缩放 100~200（百分比整数）
  }
  chat: {
    contextEnabled: boolean // 启用上下文管理
    autoCompress: boolean // 上下文自动压缩
    compressThreshold: number // 压缩阈值 50~100（%）
    compressTarget: number // 压缩目标 10~30（%）
    maxRetries: number // 模型重试次数（默认 10）
  }
  model: {
    provider: string // 平台 API 提供商 id（settings PROVIDERS 键）
    custom: { baseUrl: string; model: string } | null // 自定义（api 地址自填）
  }
  messaging: {
    providers: Record<string, { enabled: boolean; config: Record<string, string> }> // 平台 id → 配置
  }
  mcp: {
    builtinEnabled: boolean // 内置 MoonLink MCP（工具/管家模式）总开关
    custom: Array<{ name: string; url: string; apiKey: string | null; enabled: boolean }>
  }
  websearch: {
    provider: string // 搜索服务商 id（WEBSEARCH_PROVIDERS 键）
    config: Record<string, string> // api 地址/key 等
  }
  urlextract: {
    mode: 'local' | 'provider' // 本地提取 or 服务商
    provider: string // 服务商 id（mode=provider 时）
    config: Record<string, string> // 服务商 api 地址/key
  }
  docproc: {
    mode: 'local' | 'provider' // 本地 OCR or 第三方
    provider: string
    config: Record<string, string>
  }
  memory: {
    enabled: boolean // 长期记忆开关
    provider: string // 记忆提供方
    config: Record<string, string>
  }
}

export const DEFAULT_SETTINGS: SettingsSchema = {
  general: { launchAtLogin: false, launchMinimized: false, closeToTray: false, keepAwake: false, clipboardWatch: false, toolsEnabled: true },
  appearance: { theme: 'system', lang: 'zh-CN', zoom: 100 },
  chat: { contextEnabled: true, autoCompress: true, compressThreshold: 80, compressTarget: 20, maxRetries: 10 },
  model: { provider: '', custom: null },
  messaging: { providers: {} },
  mcp: { builtinEnabled: true, custom: [] },
  websearch: { provider: '', config: {} },
  urlextract: { mode: 'local', provider: '', config: {} },
  docproc: { mode: 'local', provider: '', config: {} },
  memory: { enabled: true, provider: 'builtin', config: {} },
}

function settingsPath(): string {
  return path.join(configDir(), 'settings.json')
}

export function loadSettings(): SettingsSchema {
  let file: Partial<SettingsSchema> = {}
  try {
    file = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    /* 无文件/坏 json → 全默认 */
  }
  // 逐节合并（缺节补默认；深合并只到两层——settings 结构已知且浅）
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SettingsSchema
  for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof SettingsSchema>) {
    if (file[k] && typeof file[k] === 'object') Object.assign(out[k] as object, file[k])
  }
  return out
}

export function saveSettings(patch: Record<string, unknown>): SettingsSchema {
  const cur = loadSettings() as unknown as Record<string, unknown>
  for (const [sec, val] of Object.entries(patch)) {
    if (cur[sec] && typeof cur[sec] === 'object' && val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(cur[sec] as object, val)
    } else {
      cur[sec] = val
    }
  }
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
  return cur as unknown as SettingsSchema
}

/** 平台 API 提供商清单（#256.4：按提供商列出，填 key 即成——OpenAI 兼容端点） */
export const PLATFORM_PROVIDERS: Array<{ id: string; label: string; baseUrl: string; models: string[]; docs: string }> = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], docs: 'https://platform.deepseek.com' },
  { id: 'moonshot', label: 'Moonshot AI（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'], docs: 'https://platform.moonshot.cn' },
  { id: 'zhipu', label: '智谱 AI（GLM）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'], docs: 'https://open.bigmodel.cn' },
  { id: 'dashscope', label: '阿里云百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], docs: 'https://bailian.console.aliyun.com' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], docs: 'https://platform.openai.com' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514'], docs: 'https://console.anthropic.com' },
]

/** 网络搜索服务商（#256.8：本质=服务商 MCP 暴露给 Agent——先配层，能力接续迭代） */
export const WEBSEARCH_PROVIDERS: Array<{ id: string; label: string; baseUrl: string; needs: string[] }> = [
  { id: 'bocha', label: '博查 Bocha', baseUrl: 'https://api.bochaai.com/v1/web-search', needs: ['apiKey'] },
  { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com/search', needs: ['apiKey'] },
  { id: 'bing', label: 'Bing Search（Azure）', baseUrl: 'https://api.bing.microsoft.com/v7.0/search', needs: ['apiKey'] },
  { id: 'serpapi', label: 'Serper', baseUrl: 'https://google.serper.dev/search', needs: ['apiKey'] },
  { id: 'custom', label: '自定义（MCP 端点）', baseUrl: '', needs: ['baseUrl', 'apiKey'] },
]

/** 消息平台（#256.5：参考 Hermes 可对接平台；token/key 一律钥匙串不入本清单） */
export const MESSAGING_PROVIDERS: Array<{ id: string; label: string; needs: Array<{ key: string; label: string; secret?: boolean }> }> = [
  { id: 'feishu', label: '飞书', needs: [{ key: 'appId', label: 'App ID' }, { key: 'appSecret', label: 'App Secret', secret: true }] },
  { id: 'wecom', label: '企业微信', needs: [{ key: 'corpId', label: '企业 ID' }, { key: 'corpSecret', label: '应用 Secret', secret: true }, { key: 'agentId', label: 'AgentId' }] },
  { id: 'dingtalk', label: '钉钉', needs: [{ key: 'appKey', label: 'AppKey' }, { key: 'appSecret', label: 'AppSecret', secret: true }] },
  { id: 'telegram', label: 'Telegram Bot', needs: [{ key: 'botToken', label: 'Bot Token', secret: true }] },
  { id: 'slack', label: 'Slack', needs: [{ key: 'botToken', label: 'Bot Token (xoxb-)', secret: true }] },
]

/** 记忆提供方（#256.11：参考 Hermes——内置为主，预留扩展） */
export const MEMORY_PROVIDERS: Array<{ id: string; label: string; note: string }> = [
  { id: 'builtin', label: '内置（书房记忆库）', note: 'MoonLink add_memory/search_memory 本地落库' },
  { id: 'mem0', label: 'Mem0（预留）', note: '需 API Key，后续迭代接入' },
]
