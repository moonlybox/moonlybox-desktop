#!/usr/bin/env bun
/**
 * moonlybox daemon（M4 T2）：壳（Electron）与内核的常驻 JSONL RPC 通道。
 *
 * 协议（stdin/stdout 每行一个 JSON 对象）：
 *   请求  {"id":1,"cmd":"xiaoyue","args":{"q":"...","dir":"..."}}
 *         {"id":2,"cmd":"sync","args":{"dir":"..."}}
 *         {"id":3,"cmd":"search","args":{"q":"...","dir":"..."}}
 *         {"id":4,"cmd":"memory","args":{"sub":"search","q":"..."}}
 *         {"id":5,"cmd":"ping"}
 *   响应  {"id":1,"event":"log","text":"（本地轨：命中《…》）"}   // 过程行（无序到达）
 *         {"id":1,"event":"done","code":0,"text":"最终回答全文"}   // 终止行
 *         {"id":1,"event":"error","message":"..."}               // 异常终止
 *
 * 设计纪律：
 * - 单源：daemon 直接 import 各命令的内部实现函数（不 spawn 子进程、不复制业务逻辑）；
 * - 输出拦截：命令实现用 console.log 打过程行——daemon 换掉全局 console 捕获为 log 事件；
 * - 壳可并发发多个 id，daemon 逐行读顺序执行（单 worker 足够：本地操作毫秒级，LLM 调用为主耗时）。
 */
import { cmdXiaoyue } from '../commands/xiaoyue'
import { runAgentTools } from '../commands/xiaoyue'
import { byokReady, byokChat, loadByokMeta, saveByokMeta, saveByokKey, clearByok, loadByokKey } from '../lib/llm'
import { cmdSync } from '../commands/sync'
import { syncReturnFile } from '../lib/sync'
import { cmdSearch } from '../commands/search'
import { cmdMemory } from '../commands/memory'
import { loadSettings, saveSettings, PLATFORM_PROVIDERS, WEBSEARCH_PROVIDERS, MESSAGING_PROVIDERS, MEMORY_PROVIDERS } from '../lib/settings'
import { loadRegistry, addEntry, removeEntry, setEnabled, listCloudDirs, backupSync, BACKUP_EXTS } from '../lib/backup'
import { apiGet, apiPost } from '../lib/api'
import { loadCredentials, saveCredentials, clearCredentials } from '../lib/auth'
import { ensureClient, requestDeviceCode, pollToken, refreshAccessToken } from '../lib/device-flow'
import type { CommandOptions } from '../lib/runner'

type Json = Record<string, unknown>

interface Request {
  id: number
  cmd: string
  args?: Record<string, unknown>
}

// ---------- P2：UI 确认制双向管道（confirm_request → 壳按钮 → confirm_response） ----------
// 壳对同一 rpcId 发第二条请求 {id, cmd:'confirm_response', args:{value:bool}}，
// 主循环收到后 resolve 这里挂起的 Promise——agent 循环继续。
const pendingConfirms = new Map<number, (v: boolean) => void>()
// #253 登录会话（Device Flow 两段式：start 领码 → 壳轮询 poll；不阻塞 daemon worker）
const loginSession: { clientId: string; deviceCode: string; userCode: string; url: string; interval: number } | null = null

// #253.32：access_token 过期（<60s 余量）自动用 refresh_token 续期+落盘；失败抛出（调用方降级）
async function ensureFreshToken(): Promise<{ accessToken: string; creds: any }> {
  const creds = loadCredentials()
  if (!creds?.accessToken) throw new Error('未登录')
  const exp = creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt).getTime() : 0
  if (exp - Date.now() > 60_000) return { accessToken: creds.accessToken, creds }
  if (!creds.refreshToken) throw new Error('登录态已过期且无 refresh_token，请重新登录')
  const clientId = creds.clientId
  if (!clientId) throw new Error('缺少 clientId，请重新登录')
  const tokens = await refreshAccessToken(clientId, creds.refreshToken)
  const fresh = {
    ...creds,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    refreshToken: tokens.refresh_token ?? creds.refreshToken,
  }
  saveCredentials(fresh)
  return { accessToken: fresh.accessToken, creds: fresh }
}

function requestUiConfirm(
  rpcId: number,
  toolName: string,
  argsJson: string,
  emit: (t: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirms.set(rpcId, resolve)
    emit(`__CONFIRM_REQUEST__${JSON.stringify({ tool: toolName, args: argsJson })}`)
  })
}

/** 把全局 console 换成发 log 事件的通道（执行期），结束恢复。 */
function withCapturedConsole(fn: () => Promise<void>, emit: (text: string) => void): Promise<void> {
  const orig = { log: console.log, error: console.error }
  console.log = (...a: unknown[]) => emit(a.map(String).join(' '))
  console.error = (...a: unknown[]) => emit('[stderr] ' + a.map(String).join(' '))
  return fn().finally(() => {
    console.log = orig.log
    console.error = orig.error
  })
}

function defaultVaultDir(): string {
  return process.env.MOONLYBOX_VAULT || `${process.env.HOME}/MyMoonVault`
}

async function dispatch(req: Request, emit: (text: string) => void): Promise<{ code: number; text: string }> {
  const args = (req.args ?? {}) as Record<string, unknown>
  const dir = typeof args.dir === 'string' && args.dir ? args.dir : defaultVaultDir()
  let code = 0
  let text = ''

  switch (req.cmd) {
    case 'ping':
      text = 'pong'
      break
    case 'xiaoyue': {
      const q = String(args.q ?? '')
      // askOnce 内 console.log 过程行 → emit；最终回答也在 console 输出里，捕获全文为 text
      const parts: string[] = []
      await withCapturedConsole(async () => {
        if (args.tools === true) {
          // P2：桌面壳工具模式（Agent 循环进 UI）——确认制走 confirm_request/confirm_response IPC 双向
          if (!byokReady()) {
            code = 1
            parts.push('工具模式需要 BYOK：在 设置 → 模型 → 平台 API 配置')
          } else {
            const confirm = (toolName: string, argsJson: string) =>
              requestUiConfirm(req.id, toolName, argsJson, emit)
            await runAgentTools(q, confirm, { sessionId: String(args.sessionId ?? 'default') })
          }
        } else {
          await cmdXiaoyue([q, ...(args.cloud ? ['--cloud'] : [])], { dir } as CommandOptions)
        }
      }, (t) => { parts.push(t); emit(t) })
      text = parts.join('\n')
      break
    }
    case 'search': {
      const parts: string[] = []
      await withCapturedConsole(async () => {
        await cmdSearch([String(args.q ?? '')], { dir } as CommandOptions)
      }, (t) => { parts.push(t); emit(t) })
      text = parts.join('\n')
      break
    }
    case 'sync': {
      const parts: string[] = []
      await withCapturedConsole(async () => {
        await cmdSync([], { dir, once: true } as CommandOptions)
      }, (t) => { parts.push(t); emit(t) })
      text = parts.join('\n')
      break
    }
    case 'syncreturn': {
      // #253.49：书房镜像区文件「保存即回传」——复用 /library/import/files 版本管道（与收集箱回传同源）
      try {
        const parts: string[] = []
        await withCapturedConsole(async () => {
          await syncReturnFile(dir, String(args.rel ?? ''))
        }, (t) => { parts.push(t); emit(t) })
        text = parts.join('\n') || '✓ 已回传'
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    case 'memory': {
      const sub = String(args.sub ?? 'search')
      const tail = sub === 'add' ? [String(args.text ?? '')] : sub === 'search' ? [String(args.q ?? '')] : []
      const parts: string[] = []
      await withCapturedConsole(async () => {
        await cmdMemory([sub, ...tail], {} as CommandOptions)
      }, (t) => { parts.push(t); emit(t) })
      text = parts.join('\n')
      break
    }
    case 'auth': {
      // #253：壳端登录（Device Flow 两段式，快调用不阻塞）
      const op2 = String(args.op ?? '')
      try {
        if (op2 === 'start') {
          const creds = loadCredentials() ?? { clientId: '' }
          let clientId = creds.clientId
          if (!clientId) clientId = await ensureClient(undefined)
          const dc = await requestDeviceCode(clientId, undefined)
          text = JSON.stringify({
            ok: true,
            clientId,
            deviceCode: dc.device_code,
            url: dc.verification_uri_complete ?? `${dc.verification_uri ?? 'https://moonlybox.cn/oauth/device'}?user_code=${dc.user_code}`,
            userCode: dc.user_code,
            expiresIn: dc.expires_in,
          })
        } else if (op2 === 'poll') {
          // clientId 从 start 响应透传（args.clientId）——不从 creds 读：退出登录后 creds 已清，
          // 读空 clientId 会导致 client_id 与 device_code 不匹配 → 服务器误判 expired（用户实测死循环根因）
          const clientIdForPoll = String(args.clientId ?? '') || (loadCredentials() ?? { clientId: '' }).clientId
          const result = await pollToken(clientIdForPoll, String(args.deviceCode ?? ''), undefined)
          if (result.status === 'done') {
            const tokens = result.tokens
            const me = await fetch(`https://moonlybox.cn/api/auth/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
            const meBody = (await me.json().catch(() => null)) as any
            const email = meBody?.data?.user?.email ?? meBody?.data?.email
            const userId = meBody?.data?.user?.id ?? meBody?.data?.id
            saveCredentials({
              clientId: clientIdForPoll,
              accessToken: tokens.access_token,
              accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
              refreshToken: tokens.refresh_token,
              accountEmail: email,
              userId,
            })
            text = JSON.stringify({ ok: true, status: 'done', email: email ?? userId ?? 'user' })
          } else {
            text = JSON.stringify({ ok: true, status: result.status })
          }
        } else if (op2 === 'whoami') {
          const creds = loadCredentials()
          text = JSON.stringify({ ok: true, email: creds?.accountEmail ?? null, userId: creds?.userId ?? null, loggedIn: !!creds?.accessToken })
        } else if (op2 === 'profile') {
          // 头像浮窗数据：/auth/me 全量（昵称/签名/头像 URL）——20s 超时
          const creds = loadCredentials()
          if (!creds?.accessToken) {
            code = 1
            text = '未登录'
          } else {
            const meRes = await fetch(`https://moonlybox.cn/api/auth/me`, {
              headers: { Authorization: `Bearer ${creds.accessToken}` },
              signal: AbortSignal.timeout(20_000),
            })
            const meBody = (await meRes.json().catch(() => null)) as any
            const u = meBody?.data?.user
            // avatar 是相对路径（/assets/avatars/…，web 同域直用）——壳端渲染需拼绝对 URL
            const avatarAbs = u?.avatar && !/^https?:\/\//.test(u.avatar) ? `https://moonlybox.cn${u.avatar}` : (u?.avatar ?? null)
            text = JSON.stringify({
              ok: meRes.ok && !!u,
              email: u?.email ?? creds.accountEmail,
              nickname: u?.nickname ?? null,
              signature: u?.signature ?? null,
              avatar: avatarAbs,
              level: u?.level ?? null,
              premiumExpiresAt: u?.premiumExpiresAt ?? null,
            })
          }
        } else if (op2 === 'logout') {
          clearCredentials()
          text = JSON.stringify({ ok: true })
        } else if (op2 === 'byok') {
          // #253.48：BYOK 壳端设置（key 只经 daemon 入钥匙串，绝不回传本体/落 renderer）
          const sub = String(args.sub ?? '')
          if (sub === 'get') {
            const meta = loadByokMeta()
            text = JSON.stringify({ ok: true, baseUrl: meta?.baseUrl ?? '', model: meta?.model ?? '', hasKey: loadByokKey() !== null })
          } else if (sub === 'save') {
            const baseUrl = String(args.baseUrl ?? '').trim().replace(/\/+$/, '')
            const model = String(args.model ?? '').trim()
            const apiKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
                       if (!baseUrl || !model) {
              code = 1
              text = 'BaseUrl 与模型名必填'
            } else if (!/^https?:\/\//.test(baseUrl)) {
              code = 1
              text = 'BaseUrl 需以 http(s):// 开头（如 https://api.bigmodel.cn/api/paas/v4）'
            } else if (apiKey && apiKey.length < 8) {
              code = 1
              text = 'API Key 格式不对（至少 8 位；本地端点留空即可）'
            } else {
              saveByokMeta({ baseUrl, model })
              if (apiKey) saveByokKey(apiKey)
              text = JSON.stringify({ ok: true, hasKey: apiKey ? true : loadByokKey() !== null })
            }
          } else if (sub === 'test') {
            // 最小补全验证连通（20s 超时）；不落盘任何东西，仅验
            const meta = loadByokMeta()
            const apiKey = loadByokKey()
            if (!meta || !apiKey) {
              code = 1
              text = 'BYOK 未配置完整（BaseUrl/模型名/Key）'
            } else {
              const res = await fetch(`${meta.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model: meta.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
                signal: AbortSignal.timeout(20_000),
              })
              if (res.ok) {
                text = JSON.stringify({ ok: true })
              } else {
                code = 1
                const body = await res.text().catch(() => '')
                text = `连通失败 HTTP ${res.status}${body ? `：${body.slice(0, 160)}` : ''}`
              }
          }
          } else if (sub === 'clear') {
            clearByok()
            text = JSON.stringify({ ok: true })
          } else {
            code = 2
            text = `未知 byok sub：${sub}`
          }
        } else {
          code = 2
          text = `未知 auth op：${op2}`
        }
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    case 'backup': {
      // #257 备份目录：list/add/remove/toggle/dirs（云端目录树平铺）/sync（上行到归属目录）
      try {
        const op1 = String(args.op ?? 'list')
        if (op1 === 'list') {
          text = JSON.stringify({ ok: true, entries: loadRegistry().entries, exts: BACKUP_EXTS })
        } else if (op1 === 'add') {
          const localPath = String(args.localPath ?? '').trim()
          const directoryId = args.directoryId ? String(args.directoryId) : null
          const directoryName = String(args.directoryName ?? '书房根目录')
          if (!localPath) { code = 1; text = '本地目录必填' } else {
            const entry = addEntry(localPath, directoryId, directoryName)
            text = JSON.stringify({ ok: true, entry })
          }
        } else if (op1 === 'remove') {
          removeEntry(String(args.id ?? ''))
          text = JSON.stringify({ ok: true })
        } else if (op1 === 'toggle') {
          setEnabled(String(args.id ?? ''), args.enabled === true)
          text = JSON.stringify({ ok: true })
        } else if (op1 === 'dirs') {
          const dirs = await listCloudDirs()
          text = JSON.stringify({ ok: true, dirs })
        } else if (op1 === 'sync') {
          const rep = await backupSync(String(args.id ?? ''))
          text = JSON.stringify({ ok: true, report: rep })
        } else {
          code = 2
          text = `未知 backup op：${op1}`
        }
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    case 'settings': {
      // #256 设置中心：get=全量+提供商清单；save=分节合并（key 类字段只进钥匙串，不入 settings.json）
      try {
        const op1 = String(args.op ?? 'get')
        if (op1 === 'get') {
          const s = loadSettings()
          text = JSON.stringify({
            ok: true,
            settings: s,
            providers: { platform: PLATFORM_PROVIDERS, websearch: WEBSEARCH_PROVIDERS, messaging: MESSAGING_PROVIDERS, memory: MEMORY_PROVIDERS },
          })
        } else if (op1 === 'save') {
          const patch = (args.patch ?? {}) as Record<string, unknown>
          if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
            code = 1
            text = 'patch 不能为空'
          } else {
            // #256.4：模型平台API——provider 表单带 apiKey 时同步到 BYOK 通道（meta+钥匙串；key 绝不落 settings.json）
            const mp = patch.model as Record<string, unknown> | undefined
            if (mp && typeof mp === 'object') {
              const apiKey = typeof mp.apiKey === 'string' ? mp.apiKey.trim() : ''
              const providerId = typeof mp.provider === 'string' ? mp.provider : ''
              const baseUrl = typeof mp.baseUrl === 'string' ? mp.baseUrl.trim() : ''
              const model = typeof mp.model === 'string' ? mp.model.trim() : ''
              if (apiKey) {
                if (!baseUrl || !model) {
                  code = 1
                  text = '平台 API 保存需同时填写 API 地址与模型名'
                  break
                }
                if (!/^https?:\/\//.test(baseUrl)) {
                  code = 1
                  text = 'API 地址需以 http(s):// 开头'
                  break
                }
                saveByokMeta({ baseUrl, model })
                saveByokKey(apiKey)
              }
              // 落 settings.json 的 model 节去掉 key/明文（只存选择状态）
              const clean: Record<string, unknown> = { provider: providerId }
              if (mp.custom && typeof mp.custom === 'object') clean.custom = mp.custom
              if (baseUrl && model) { clean.baseUrl = baseUrl; clean.model = model }
              patch.model = clean
            }
            const s = saveSettings(patch)
            text = JSON.stringify({ ok: true, settings: s })
          }
        } else {
          code = 2
          text = `未知 settings op：${op1}`
        }
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    case 'diagram': {
      // 图示（#252 §8）：list|save|activate|get——壳工作台 ↔ 服务端图示 API（草稿两级制）
      try {
        const op = String(args.op ?? 'list')
        if (op === 'list') {
          const res = await apiGet<any>('/library/diagrams')
          text = JSON.stringify(res)
        } else if (op === 'save') {
          const res = await apiPost<any>('/library/diagrams', {
            id: args.id ?? null,
            title: String(args.title ?? '未命名图示'),
            content: String(args.content ?? ''),
            diagramType: args.diagramType ?? null,
          })
          text = JSON.stringify(res)
        } else if (op === 'activate') {
          const res = await apiPost<any>(`/library/diagrams/${encodeURIComponent(String(args.id ?? ''))}/activate`)
          text = JSON.stringify(res)
        } else if (op === 'get') {
          const res = await apiGet<any>(`/library/diagrams/${encodeURIComponent(String(args.id ?? ''))}`)
          text = JSON.stringify(res)
        } else if (op === 'nav') {
          // #254：云端功能导航 manifest（服务端下发——功能升级/新增零客户端发版）；token 过期自动续
          try {
            const res = await apiGet<any>('/client/nav')
            let token: string | null = null
            try { token = (await ensureFreshToken()).accessToken } catch { token = null }
            text = JSON.stringify({ ok: true, data: res.data, token })
          } catch (e: any) {
            code = 1
            text = String(e?.message ?? e)
          }
        } else if (op === 'ai' || op === 'fix') {
          // T4：AI 生成/修复图示（§8.2 AI 生成=小月 BYOK 通道，错误回喂重试闭环）
          if (!byokReady()) {
            code = 1
            text = 'AI 生成需要 BYOK：在 设置 → 模型 → 平台 API 配置'
            break
          }
          const prompt = String(args.prompt ?? '').trim()
          if (!prompt) {
            code = 2
            text = '描述为空'
            break
          }
          const sys = op === 'ai'
            ? '你是 Mermaid 图表专家。根据用户描述生成一个 Mermaid 图。只输出单个 ```mermaid 代码块，不要任何解释。支持 flowchart/sequence/class/ER/state/甘特/思维导图等。节点文字用中文。'
            : '你是 Mermaid 图表专家。用户的 Mermaid 图渲染报错了。修复语法错误，保持原图意图。只输出修复后的单个 ```mermaid 代码块，不要任何解释。'
          const question = op === 'ai'
            ? prompt
            : `渲染错误信息：\n${String(args.error ?? '')}\n\n当前源码：\n${prompt}`
          const parts: string[] = []
          let aiErr = ''
          await withCapturedConsole(async () => {
            const r = await byokChat(sys, question, 120_000)
            if (r.ok) parts.push(r.text ?? '')
            else aiErr = r.error ?? '未知错误'
          }, (t) => { parts.push(t) })
          if (!parts.length) {
            code = 1
            text = aiErr || 'AI 无回复'
            break
          }
          text = JSON.stringify({ ok: true, source: parts.join('\n') })
        } else {
          code = 2
          text = `未知 diagram op：${op}`
        }
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    default:
      code = 2
      text = `未知命令：${req.cmd}`
  }
  return { code, text }
}

export async function runDaemon(): Promise<void> {
  process.stdout.write(JSON.stringify({ id: 0, event: 'ready' }) + '\n')
  const rl = require('node:readline').createInterface({ input: process.stdin })
  // P2：事件驱动行处理——dispatch await 期间到达的 confirm_response 必须能被处理
  // （for await 顺序迭代会把行缓冲到 dispatch 结束后，确认请求会死锁）。
  const write = (obj: Json) => process.stdout.write(JSON.stringify(obj) + '\n')
  const handleLine = async (raw: unknown) => {
    const lineStr = String(raw).trim()
    if (!lineStr) return
    let req: Request
    try {
      req = JSON.parse(lineStr)
    } catch {
      write({ id: -1, event: 'error', message: 'bad json' })
      return
    }
    // 确认响应：resolve 挂起的 UI 确认（非命令请求）
    if (req.cmd === 'confirm_response') {
      const v = (req.args ?? {}) as Record<string, unknown>
      const resolve = pendingConfirms.get(req.id)
      if (resolve) {
        pendingConfirms.delete(req.id)
        resolve(v.value === true)
      }
      return
    }
    try {
      const { code, text } = await dispatch(req, (t) => write({ id: req.id, event: 'log', text: t }))
      write({ id: req.id, event: 'done', code, text })
    } catch (e) {
      write({ id: req.id, event: 'error', message: String(e instanceof Error ? e.message : e) })
    }
  }
  for await (const raw of rl) {
    // 不 await：dispatch 内部自带顺序语义（同 id 串行由壳侧保证），confirm_response 需要插队处理
    void handleLine(raw)
  }
}

// 直接执行时启动 daemon（bun run src/cli.ts daemon）
if (import.meta.main && process.argv[2] === 'daemon') {
  await runDaemon()
}
