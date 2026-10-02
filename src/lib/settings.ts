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
    closeToTray: boolean // 关闭时最小化到托盘（#268 默认 true；false=真退出）
    keepAwake: boolean // 运行任务时保持电脑唤醒（powerSaveBlocker）
    clipboardWatch: boolean // 剪贴板自动采集（原 T3 开关迁入）
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
    /** #317.4：思考模式档位（小月对话输入框下拉）——'off'=关思考（默认，#310.36 现状）；'on'=开启思考（不注入关思考指令/Ollama think:true） */
    thinking?: 'on' | 'off'
  }
  model: {
    /** #283 对话默认模型（历史名 default=chatDefault 语义）：'platform:<id>' | 'custom:<id>' | 'local:<id>' | ''（空=回落旧 byok.json 兼容） */
    default: string
    /** #316.7 编译默认模型（知识整理）：同 default 引用形态；空/失效→回落 default→legacy（compile-model.resolveCompileModel） */
    compileDefault?: string
    /** #316 第二批：编译产物回传云端（§5.16.4 C 方案）——本地先行落书房，回传落云端待准入；失败不阻断本地（#284 syncToMoon 同构）。默认开 */
    syncToMoon?: boolean
    /** 平台 API 多服务商实例（每个可单独配置 key/启停；key 走钥匙串 account=llm:<id>） */
    providers: Array<{ id: string; providerId: string; enabled: boolean; model: string; baseUrl?: string }>
    /** 自定义多模型（OpenAI 兼容端点；本地推理 key 可空） */
    custom: Array<{ id: string; name: string; baseUrl: string; model: string; enabled: boolean }>
    /** 本地部署（#310.11 实装，结构同 custom；本地接入写此数组） */
    local: Array<{ id: string; name: string; model: string; enabled: boolean; baseUrl?: string }> // #310.11：本地端点（默认 Ollama /v1）
    /** 遗留字段（<=#282 单模型形态），迁移后零消费 */
    provider?: string
    /** 遗留字段（<=#282），迁移后零消费 */
    legacyCustom?: { baseUrl: string; model: string } | null
  }
  messaging: {
    providers: Record<string, { enabled: boolean; config: Record<string, string> }> // 平台 id → 配置
  }
  mcp: {
    builtinEnabled: boolean // 内置 MoonLink MCP（工具/管家模式）总开关——#269 自通用 toolsEnabled 升格而来
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
  skills: {
    enabled: boolean // #285 技能系统总开关（书房 .moonlybox/skills/ 只读消费）
  }
  memory: {
    enabled: boolean // 长期记忆开关
    /** #281 定稿：记忆模式唯一=本机内置+月忆增强；mode 字段=单选项下拉落点（现唯一取值 builtin_moonrecall，为将来受限扩展的挂载点） */
    mode?: string
    injectLimit: number // 记忆注入上限（字符），默认 5000
    /** #284：同步到月忆——本机沉淀的记忆条目同时上行云端 quick-capture 候选池（确认制，用户在云端确认后才进正式记忆） */
    syncToMoon?: boolean
    provider?: string // 遗留字段（≤#280 双档选择），仅存量兼容不消费
    config?: Record<string, string>
  }
}

export const DEFAULT_SETTINGS: SettingsSchema = {
  general: { launchAtLogin: false, launchMinimized: false, closeToTray: true, keepAwake: false, clipboardWatch: false },
  appearance: { theme: 'system', lang: 'zh-CN', zoom: 100 },
  chat: { contextEnabled: true, autoCompress: true, compressThreshold: 80, compressTarget: 20, maxRetries: 10 },
  model: { default: '', compileDefault: '', syncToMoon: true, providers: [], custom: [], local: [] },
  messaging: { providers: {} },
  mcp: { builtinEnabled: true, custom: [] },
  websearch: { provider: '', config: {} },
  urlextract: { mode: 'local', provider: '', config: {} },
  docproc: { mode: 'local', provider: '', config: {} },
  skills: { enabled: true },
  memory: { enabled: true, mode: 'builtin_moonrecall', injectLimit: 5000, syncToMoon: true },
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
  // #269 迁移：老版本 general.toolsEnabled → mcp.builtinEnabled（升格后字段归属 MCP；用户已落盘的值不丢）
  const legacy = (file as any).general?.toolsEnabled
  if (legacy !== undefined && (file as any).mcp?.builtinEnabled === undefined) {
    ;(out as any).mcp.builtinEnabled = !!legacy
  }
  // #283 迁移：旧单模型形态（provider/custom 对象）→ 新多实例结构。providers/custom 数组存在=已迁移过，不重复
  const fm = (file as any).model ?? {}
  const migrated = Array.isArray(fm.providers) || Array.isArray(fm.custom)
  if (!migrated && (fm.provider || fm.custom)) {
    if (fm.provider) {
      ;(out as any).model.providers = [{ id: `mig_${fm.provider}`, providerId: String(fm.provider), enabled: true, model: String(fm.model ?? '') }]
      ;(out as any).model.default = `platform:mig_${fm.provider}`
    } else if (fm.custom?.baseUrl) {
      ;(out as any).model.custom = [{ id: 'mig_custom', name: '自定义（迁移）', baseUrl: String(fm.custom.baseUrl), model: String(fm.custom.model ?? ''), enabled: true }]
      ;(out as any).model.default = 'custom:mig_custom'
    }
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
  { id: 'wecom', label: '企业微信（AI 机器人）', needs: [{ key: 'botId', label: 'Bot ID' }, { key: 'secret', label: 'Bot Secret', secret: true }] },
  { id: 'weixin', label: '个人微信（iLink 机器人）', needs: [{ key: 'token', label: 'Bot Token（扫码登录获取）', secret: true }, { key: 'accountId', label: '账号 ID（ilink_bot_id）' }] },
  { id: 'dingtalk', label: '钉钉', needs: [{ key: 'appKey', label: 'AppKey' }, { key: 'appSecret', label: 'AppSecret', secret: true }] },
  { id: 'qqbot', label: 'QQ 机器人', needs: [{ key: 'appId', label: 'AppID' }, { key: 'appSecret', label: 'AppSecret', secret: true }] },
  { id: 'telegram', label: 'Telegram Bot', needs: [{ key: 'botToken', label: 'Bot Token', secret: true }] },
  { id: 'slack', label: 'Slack', needs: [{ key: 'botToken', label: 'Bot Token (xoxb-)', secret: true }, { key: 'appToken', label: 'App-Level Token (xapp-)', secret: true }] },
  { id: 'email', label: 'Email（邮件）', needs: [{ key: 'address', label: '邮箱地址' }, { key: 'password', label: '密码 / 授权码', secret: true }, { key: 'imapHost', label: 'IMAP 服务器（如 imap.qq.com）' }, { key: 'imapPort', label: 'IMAP 端口（默认 993）' }, { key: 'smtpHost', label: 'SMTP 服务器（如 smtp.qq.com）' }, { key: 'smtpPort', label: 'SMTP 端口（默认 587，465=SSL）' }] },
]

/** URL 提取服务商（#256.9：本地 Readability 或服务商；Jina 免 Key） */
export const URL_EXTRACT_PROVIDERS: Array<{ id: string; label: string; baseUrl?: string; note?: string; needs?: string[] }> = [
  { id: 'local', label: '本地提取（内置 Readability）', note: '本机解析正文，零流量零成本' },
  { id: 'jina', label: 'Jina Reader', baseUrl: 'https://r.jina.ai', note: '免 Key' },
  { id: 'firecrawl', label: 'Firecrawl', baseUrl: 'https://api.firecrawl.dev', needs: ['apiKey'] },
  { id: 'custom', label: '自定义', baseUrl: '', needs: ['baseUrl', 'apiKey'] },
]

/**
 * 记忆模式（#281 用户定稿）：唯一=「本机内置+月忆（MoonRecall）增强」——本机记忆层恒在、月忆为云端增强，
 * 不再提供提供方选择（MEMORY_PROVIDERS 双档表退役；云端清单 memory 类客户端不消费）。
 * 月忆增强的同步开关挂账（采集走 quick-capture 确认制管道）。
 */
