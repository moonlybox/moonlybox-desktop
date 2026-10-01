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
import { saveProviderKey } from '../lib/web-tools'
import { saveMcpKey, resetCatalogCache } from '../lib/mcp-custom'
import {
  listWorkspaces, getWorkspace, createWorkspace, updateWorkspace, deleteWorkspace,
  listChats, listChatsByWorkspace, loadChat, saveChat, createChat, deleteChat, appendTurn,
} from '../lib/workspaces'
import { cmdSync } from '../commands/sync'
import { initVault, syncReturnFile } from '../lib/sync'
import { cmdSearch } from '../commands/search'
import { cmdMemory } from '../commands/memory'
// #316.5：本地任务基建（多入口单执行器）
import { listJobs, getJob, cancelJob, recoverOnBoot, createJob, contentHash, TASK_TYPES } from '../lib/tasks'
import type { TaskType } from '../lib/tasks'
import { runJob } from '../lib/compile-runner'
import { compileModelLabel } from '../lib/compile-model'
import { loadSettings, saveSettings, MESSAGING_PROVIDERS } from '../lib/settings'
import { defaultVaultRoot, configDir } from '../lib/config'
import * as path from 'node:path'
import { resolveProviders } from '../lib/providers'
import { addEntry, listCloudDirs, backupSync, backupSyncAll, BACKUP_EXTS, loadRegistry, setEnabled, removeEntry, setPolicies, checkTwin } from '../lib/backup'
import { apiGet, apiPost, apiDelete } from '../lib/api'
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
            await runAgentTools(q, confirm, {
              sessionId: String(args.sessionId ?? args.chatId ?? 'default'),
              chatId: args.chatId !== undefined ? String(args.chatId) : undefined,
              workspaceId: args.workspaceId !== undefined ? (args.workspaceId === null ? null : String(args.workspaceId)) : undefined,
            })
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
          let creds = loadCredentials()
          // #262：token 过期且有 refresh_token → 懒续期（失败不阻塞，保持本地 loggedIn 态）
          const exp = creds?.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt).getTime() : 0
          if (creds?.accessToken && creds?.refreshToken && exp - Date.now() <= 60_000) {
            try { creds = (await ensureFreshToken()).creds } catch {}
          }
          text = JSON.stringify({ ok: true, email: creds?.accountEmail ?? null, userId: creds?.userId ?? null, loggedIn: !!creds?.accessToken })
        } else if (op2 === 'profile') {
          // 头像浮窗数据：/auth/me 全量（昵称/签名/头像 URL）——20s 超时
          // #262：先 ensureFreshToken（过期自动续期落盘）——修复启动首拉头像/昵称因过期 token 401 降级为字母+邮箱
          let creds: any = null
          try {
            creds = (await ensureFreshToken()).creds
          } catch { creds = loadCredentials() }
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
          } else if (sub === 'test' || sub === 'testId') {
            // 最小补全验证连通（20s 超时）；不落盘任何东西，仅验。#283 testId=按模型注册表实例测（多模型各测各的）
            let meta = loadByokMeta()
            let apiKey = loadByokKey()
            if (sub === 'testId') {
              const { resolveActiveModel } = require('../lib/model-registry') as typeof import('../lib/model-registry')
              const saved = loadSettings()
              // 临时指向指定实例解析（不动 default）——直接从 settings 里找
              const instId = String(args.id ?? '')
              const prov = (saved.model.providers ?? []).find((p) => p.id === instId)
              const cust = (saved.model.custom ?? []).find((c) => c.id === instId)
              if (prov) {
                const { PLATFORM_PROVIDERS } = await import('../lib/settings')
                const pv = PLATFORM_PROVIDERS.find((x) => x.id === prov.providerId)
                meta = { baseUrl: prov.baseUrl || pv?.baseUrl || '', model: prov.model }
                apiKey = new (require('@napi-rs/keyring').Entry)('moonlybox', `llm:${prov.id}`).getPassword() || null
              } else if (cust) {
                meta = { baseUrl: cust.baseUrl, model: cust.model }
                apiKey = new (require('@napi-rs/keyring').Entry)('moonlybox', `llm:${cust.id}`).getPassword() || null
              } else {
                code = 1
                text = '模型实例不存在'
              }
            }
            if (!meta || !apiKey) {
              code = 1
              text = '模型未配置完整（BaseUrl/模型名/Key；本地端点可留空 Key）'
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
    case 'workspace': {
      // #282 工作空间+对话持久化：list|create|update|delete|chats|createChat|chat|deleteChat|appendTurn
      try {
        const op = String(args.op ?? 'list')
        if (op === 'list') {
          text = JSON.stringify({ ok: true, workspaces: listWorkspaces() })
        } else if (op === 'create') {
          const name = String(args.name ?? '').trim()
          const dirs = Array.isArray(args.dirs) ? args.dirs.map(String) : []
          if (!name) { code = 1; text = '工作空间名称必填' }
          else if (dirs.length === 0) { code = 1; text = '至少选择一个工作目录' }
          else {
            const missing = dirs.filter((d) => { try { return !require('node:fs').statSync(d).isDirectory() } catch { return true } })
            const pi = Number(args.primaryIndex ?? 0)
            if (missing.length) { code = 1; text = `目录不存在或不是文件夹：${missing.join('、')}` }
            else text = JSON.stringify({ ok: true, workspace: createWorkspace(name, dirs, Number.isFinite(pi) ? pi : 0) })
          }
        } else if (op === 'update') {
          const ws = updateWorkspace(String(args.id ?? ''), {
            name: args.name !== undefined ? String(args.name) : undefined,
            addDir: args.addDir !== undefined ? String(args.addDir) : undefined,
            removeDir: args.removeDir !== undefined ? String(args.removeDir) : undefined,
            setPrimary: args.setPrimary !== undefined ? Number(args.setPrimary) : undefined,
          })
          if (!ws) { code = 1; text = '工作空间不存在' }
          else text = JSON.stringify({ ok: true, workspace: ws })
        } else if (op === 'delete') {
          text = JSON.stringify({ ok: deleteWorkspace(String(args.id ?? '')) })
        } else if (op === 'chats') {
          const wid = args.workspaceId === null || args.workspaceId === undefined ? undefined : String(args.workspaceId)
          text = JSON.stringify({ ok: true, chats: wid === undefined ? listChats() : listChatsByWorkspace(wid === 'null' ? null : wid) })
        } else if (op === 'createChat') {
          const wid = args.workspaceId === null || args.workspaceId === 'null' ? null : args.workspaceId === undefined ? null : String(args.workspaceId)
          if (wid) {
            const ws = getWorkspace(wid)
            if (!ws) { code = 1; text = '工作空间不存在' }
          }
          if (code === 0) text = JSON.stringify({ ok: true, chat: createChat(wid, args.title !== undefined ? String(args.title) : undefined) })
        } else if (op === 'chat') {
          const rec = loadChat(String(args.id ?? ''))
          if (!rec) { code = 1; text = '对话不存在' }
          else text = JSON.stringify({ ok: true, chat: rec })
        } else if (op === 'deleteChat') {
          text = JSON.stringify({ ok: deleteChat(String(args.id ?? '')) })
        } else if (op === 'appendTurn') {
          const rec = appendTurn(String(args.id ?? ''), args.role === 'user' ? 'user' : 'assistant', String(args.content ?? ''))
          if (!rec) { code = 1; text = '对话不存在' }
          else text = JSON.stringify({ ok: true, chat: rec })
        } else if (op === 'renameChat') {
          const rec = loadChat(String(args.id ?? ''))
          if (!rec) { code = 1; text = '对话不存在' }
          else {
            rec.title = String(args.title ?? '').trim() || rec.title
            text = JSON.stringify({ ok: true, chat: saveChat(rec) })
          }
        } else {
          code = 2
          text = `未知 workspace op：${op}`
        }
      } catch (e: any) {
        code = 1
        text = String(e?.message ?? e)
      }
      break
    }
    case 'skills': {
        // #285 技能清单（设置-技能面板）：书房 .moonlybox/skills/ 扫描
        try {
          const { listSkills } = require('../lib/skills') as typeof import('../lib/skills')
          const skills = listSkills(defaultVaultRoot()).map((s) => ({ name: s.name, description: s.description, files: s.files.length }))
          code = 0
          text = JSON.stringify({ skills })
        } catch (e: any) {
          code = 1
          text = String(e?.message ?? e)
        }
        break
      }
      case 'messaging': {
        // #286 消息网关编排：start=启动全部已配置平台收件循环；status=运行态
        try {
          const op3 = String((args as Record<string, unknown>).op ?? 'status')
          if (op3 === 'start') {
            const { startGateway } = require('../lib/messaging-gateway') as typeof import('../lib/messaging-gateway')
            const st = await startGateway(path.join(configDir(), 'gateway-state'), async (m) => {
              // 无头小月：每平台会话独立 chatId（持久化/上下文隔离），自动确认（消息通道无法逐条弹窗——写操作默认拒绝更安全）
              const { runAgentTools } = await import('../commands/xiaoyue')
              console.log(`（消息网关 ${m.platform} ← ${m.sender ?? m.chatId}：${m.text.slice(0, 60)}）`)
              const r = await runAgentTools(m.text, async () => false, { chatId: `msg:${m.platform}:${m.chatId}` })
              return r.answer
            })
            code = 0
            text = JSON.stringify({ statuses: st })
          } else if (op3 === 'stop') {
            const { stopGateway } = require('../lib/messaging-gateway') as typeof import('../lib/messaging-gateway')
            await stopGateway()
            code = 0
            text = JSON.stringify({ ok: true })
          } else if (op3 === 'wxLoginStart') {
            // #286.4 个人微信扫码登录：取二维码（SVG 本机渲染，零外链）
            const { wxQrLoginStart } = require('../lib/messaging-gateway') as typeof import('../lib/messaging-gateway')
            const q = await wxQrLoginStart()
            code = 0
            text = JSON.stringify({ ok: true, qrcode: q.qrcode, svg: q.svg })
          } else if (op3 === 'wxLoginPoll') {
            // 轮询扫码状态；confirmed 时 token 入钥匙串（msg:weixin:token）+ accountId 落 settings
            const { wxQrLoginPoll } = require('../lib/messaging-gateway') as typeof import('../lib/messaging-gateway')
            const qrcode = String(args.qrcode ?? '')
            const baseUrl = args.baseUrl ? String(args.baseUrl) : undefined
            const st = await wxQrLoginPoll(qrcode, baseUrl)
            if (st.status === 'confirmed') {
              if (!st.token || !st.accountId) throw new Error('扫码已确认但凭据不完整——请重试')
              const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
              new Entry('moonlybox', 'msg:weixin:token').setPassword(st.token)
              const s = loadSettings() as Record<string, any>
              const providers = { ...(s.messaging?.providers ?? {}) }
              const cur = { ...(providers.weixin ?? { enabled: false, config: {} }) }
              cur.enabled = true
              cur.config = { ...(cur.config ?? {}), accountId: st.accountId, 'keychain:token': true }
              providers.weixin = cur
              saveSettings({ messaging: { providers } } as never)
              code = 0
              text = JSON.stringify({ status: 'confirmed', accountId: st.accountId })
            } else {
              code = 0
              text = JSON.stringify({ status: st.status, redirectHost: st.redirectHost ?? '' })
            }
          } else {
            const { gatewayRunning } = require('../lib/messaging-gateway') as typeof import('../lib/messaging-gateway')
            code = 0
            text = JSON.stringify({ running: gatewayRunning() })
          }
        } catch (e: any) {
          code = 1
          text = String(e?.message ?? e)
        }
        break
      }
      case 'candidates': {
        // #289 记忆候选池（云端 candidate 态实体）：list=候选列表；decide=confirm/drop 裁决
        try {
          const op5 = String((args as Record<string, unknown>).op ?? 'list')
          if (op5 === 'list') {
            const status = String(args.status ?? 'candidate')
            const res = await apiGet<any>(`/memory/candidates?status=${encodeURIComponent(status)}`)
            code = 0
            text = JSON.stringify({ ok: true, items: res?.data?.items ?? [] })
          } else if (op5 === 'decide') {
            const res = await apiPost<any>('/memory/correct', {
              id: String(args.id ?? ''),
              action: String(args.action ?? 'confirm'),
            })
            code = 0
            text = JSON.stringify({ ok: !!res?.ok, entity: res?.data?.entity ?? null })
          } else {
            code = 1
            text = `candidates: 未知 op ${op5}`
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
            const entry = addEntry(localPath, directoryId, directoryName, {
              onDelete: args.onDelete === 'keep' ? 'keep' : 'resync',
              onConflict: args.onConflict === 'overwrite' ? 'overwrite' : 'rename', // overwrite 引擎侧拒绝（#259）；UI 只发 rename
              claims: args.claims && typeof args.claims === 'object' && !Array.isArray(args.claims) ? (args.claims as Record<string, string>) : undefined,
            })
            text = JSON.stringify({ ok: true, entry })
          }
        } else if (op1 === 'check') {
          // #260 新建预检：同名清单（重装认领确认用；只读）
          const hits = await checkTwin(String(args.localPath ?? ''), args.directoryId ? String(args.directoryId) : null)
          text = JSON.stringify({ ok: true, hits })
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
          const rep = args.all === true ? null : await backupSync(String(args.id ?? ''))
          if (args.all === true) {
            const reps = await backupSyncAll()
            text = JSON.stringify({ ok: true, reports: reps })
          } else {
            text = JSON.stringify({ ok: true, report: rep })
          }
        } else if (op1 === 'policies') {
          setPolicies(String(args.id ?? ''), {
            onDelete: args.onDelete === 'keep' ? 'keep' : args.onDelete === 'resync' ? 'resync' : undefined,
            onConflict: args.onConflict === 'rename' ? 'rename' : undefined,
          })
          const e = loadRegistry().entries.find((x) => x.id === String(args.id ?? ''))
          text = JSON.stringify({ ok: true, entry: e })
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
          // #276：providers 云端优先（登录拉取+24h 缓存）→ 缓存 → 内置兜底；messaging 恒本地
          const providers = await resolveProviders()
          text = JSON.stringify({
            ok: true,
            settings: s,
            providers,
          })
        } else if (op1 === 'save') {
          const patch = (args.patch ?? {}) as Record<string, unknown>
          if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
            code = 1
            text = 'patch 不能为空'
          } else {
            // #283：模型注册表——providers[]/custom[] 实例带明文 apiKey 时入钥匙串（account=llm:<id>），
            // settings.json 只存非敏感元数据；旧单模型表单（provider/baseUrl/model/apiKey）兼容保留
            const mp = patch.model as Record<string, unknown> | undefined
            if (mp && typeof mp === 'object') {
              const stripInst = (arr: unknown, kind: 'platform' | 'custom'): unknown => {
                if (!Array.isArray(arr)) return arr
                return arr.map((raw) => {
                  const inst = raw as Record<string, unknown>
                  const k = typeof inst.apiKey === 'string' ? inst.apiKey.trim() : ''
                  const clean = { ...inst } as Record<string, unknown>
                  delete clean.apiKey
                  if (k) {
                    const { saveModelKey } = require('../lib/model-registry') as typeof import('../lib/model-registry')
                    saveModelKey(String(inst.id), k)
                    clean.hasKey = true
                  }
                  if (kind === 'custom' && inst.baseUrl && !/^https?:\/\//.test(String(inst.baseUrl))) {
                    throw new Error('自定义模型 API 地址需以 http(s):// 开头')
                  }
                  return clean
                })
              }
              const clean: Record<string, unknown> = { ...mp }
              try {
                if (mp.providers !== undefined) clean.providers = stripInst(mp.providers, 'platform')
                if (mp.custom !== undefined && Array.isArray(mp.custom)) clean.custom = stripInst(mp.custom, 'custom')
              } catch (e: any) {
                code = 1
                text = String(e?.message ?? e)
                break
              }
              // 旧单模型表单兼容（platformAPI 面板旧版提交形态）
              const apiKey = typeof mp.apiKey === 'string' ? mp.apiKey.trim() : ''
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
              delete clean.apiKey
              delete clean.baseUrl
              delete clean.model
              patch.model = clean
            }
            // #279：搜索/URL 提取——节带 apiKey 时入钥匙串，settings.json 只落非敏感 config
            for (const sec of ['websearch', 'urlextract'] as const) {
              const sp = patch[sec] as Record<string, unknown> | undefined
              if (sp && typeof sp === 'object') {
                const apiKey = typeof sp.apiKey === 'string' ? sp.apiKey.trim() : ''
                if (apiKey) saveProviderKey(sec, apiKey)
                const clean: Record<string, unknown> = { ...sp }
                delete clean.apiKey
                patch[sec] = clean
              }
            }
            // #287：文档处理——config.apiKey（真明文）剥入 docproc-key 钥匙串；旧哨兵 keychain:docproc 形态=保持已存标记不动
            {
              const dp = patch.docproc as Record<string, any> | undefined
              if (dp && typeof dp === 'object' && dp.config && typeof dp.config === 'object') {
                const apiKey = typeof dp.config.apiKey === 'string' ? dp.config.apiKey.trim() : ''
                if (apiKey && !apiKey.startsWith('keychain:')) {
                  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
                  new Entry('moonlybox', 'docproc-key').setPassword(apiKey)
                }
                const cleanCfg: Record<string, unknown> = { ...dp.config }
                if (apiKey && !apiKey.startsWith('keychain:')) {
                  cleanCfg.keyStored = true
                  delete cleanCfg.apiKey
                } else if (apiKey.startsWith('keychain:')) {
                  cleanCfg.keyStored = true
                  delete cleanCfg.apiKey
                }
                dp.config = cleanCfg
              }
            }
            // #286：消息平台——secret 字段（token 类）剥入钥匙串（account=msg:<platform>:<key>），
            // settings.json 只落非敏感 config + keyStored 标记；明文/旧哨兵形态都处理
            const mg = patch.messaging as Record<string, unknown> | undefined
            if (mg && typeof mg === 'object' && mg.providers && typeof mg.providers === 'object') {
              const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
              const MSG_SECRET_KEYS: Record<string, string[]> = { feishu: ['appSecret'], wecom: ['secret'], weixin: ['token'], dingtalk: ['appSecret'], telegram: ['botToken'], qqbot: ['appSecret'], slack: ['botToken', 'appToken'], email: ['password'] }
              for (const [pid, pv] of Object.entries(mg.providers as Record<string, any>)) {
                if (!pv || typeof pv !== 'object') continue
                const cfgIn = (pv.config ?? {}) as Record<string, unknown>
                const clean: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(cfgIn)) {
                  const isSecret = (MSG_SECRET_KEYS[pid] ?? []).includes(k)
                  if (!isSecret) {
                    clean[k] = v
                    continue
                  }
                  const s = typeof v === 'string' ? v.trim() : ''
                  if (s && !s.startsWith('keychain:')) {
                    new Entry('moonlybox', `msg:${pid}:${k}`).setPassword(s)
                    clean[`keychain:${k}`] = true
                  } else if (s.startsWith('keychain:')) {
                    clean[`keychain:${k}`] = true // 旧哨兵形态：保持已存标记（钥匙串值可能已存过）
                  }
                }
                pv.config = clean
              }
            }
            // #280：自定义 MCP——条目带 apiKey 时入钥匙串（account=mcp:<name>），settings.json 只落 keyStored 布尔
            const mc = patch.mcp as Record<string, unknown> | undefined
            if (mc && typeof mc === 'object' && Array.isArray(mc.custom)) {
              resetCatalogCache() // #280.1：配置改动立即生效（清 60s 清单缓存）
              mc.custom = (mc.custom as Array<Record<string, unknown>>).map((entry) => {
                const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : ''
                const name = String(entry.name ?? '')
                if (apiKey && name) {
                  saveMcpKey(name, apiKey)
                  return { ...entry, apiKey: null, keyStored: true }
                }
                const { apiKey: _drop, ...rest } = entry
                return rest
              })
            }
            const s = saveSettings(patch)
            text = JSON.stringify({ ok: true, settings: s })
          }
        } else if (op1 === 'deleteModelInst') {
          // #283.9：删除模型实例时清理钥匙串残留 key（llm:<id>）——否则残留明文密钥永久留在系统钥匙串
          try {
            const kind = String((args as Record<string, unknown>).kind ?? '')
            const instId = String((args as Record<string, unknown>).id ?? '')
            if ((kind !== 'platform' && kind !== 'custom') || !instId) {
              code = 1
              text = 'deleteModelInst 需要 kind(platform|custom) 与 id'
              break
            }
            const { deleteModelKey } = require('../lib/model-registry') as typeof import('../lib/model-registry')
            deleteModelKey(instId)
            code = 0
            text = 'ok'
          } catch (e: any) {
            code = 1
            text = String(e?.message ?? e)
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
        } else if (op === 'delete') {
          // #300：删除图示=复用书房文档删除（DELETE /library/{id}，软删进回收站 30 天可恢复）
          const res = await apiDelete<any>(`/library/${encodeURIComponent(String(args.id ?? ''))}`)
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
            const { resolveActiveModel } = await import('../lib/model-registry')
            const active = resolveActiveModel()
            const r = await byokChat(sys, question, 120_000, active ? { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey } : undefined)
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
    case 'tasks': {
      // #316.5：本地任务基建——list/get/create_compile/cancel（多入口单执行器；任务类型白名单收敛）
      try {
        const op = String((args as Record<string, unknown>).op ?? 'list')
        if (op === 'list') {
          text = JSON.stringify({ ok: true, jobs: listJobs() })
        } else if (op === 'get') {
          const job = getJob(String((args as Record<string, unknown>).id ?? ''))
          if (!job) { code = 1; text = '任务不存在' } else { text = JSON.stringify({ ok: true, job }) }
        } else if (op === 'cancel') {
          const job = cancelJob(String((args as Record<string, unknown>).id ?? ''))
          if (!job) { code = 1; text = '任务不存在' } else { text = JSON.stringify({ ok: true, job }) }
        } else if (op === 'create_compile') {
          // #310.21：paths 可选——不传=自动全量未整理（listUncompiled−ledger）；传=指定清单。上限 500
          let paths = (args as Record<string, unknown>).paths as string[] | undefined
          if (!Array.isArray(paths) || paths.length === 0) {
            const { listUncompiled } = await import('../lib/local-tasks-tool')
            paths = listUncompiled().uncompiled
          }
          if (!paths.length) {
            code = 1
            text = '没有未整理的文档（或书房为空）'
            break
          }
          if (paths.length > 500) paths = paths.slice(0, 500)
          const items = (paths as string[]).map((p) => ({ path: String(p) }))
          const label = compileModelLabel()
          const job = createJob('compile', `知识整理 · ${items.length} 篇`, items, label ?? undefined)
          // fire-and-forget：执行器异步跑（进度回写 jobs.json；本 RPC 立即返回 jobId）
          void runJob(job.id).catch(() => {})
          text = JSON.stringify({ ok: true, job })
        } else if (op === 'pages') {
          // #316 骨架批配套：知识页产物列表（任务页「知识页」tab 数据源）
          const { defaultVaultRoot } = await import('../lib/config')
          const { listPages } = await import('../lib/tasks')
          text = JSON.stringify({ ok: true, pages: listPages(defaultVaultRoot()) })
        } else if (op === 'delete_pages') {
          // 批量删除产物+ledger 重置（白名单防误删；确认制在 renderer 层）
          const paths = (args as Record<string, unknown>).paths as string[] | undefined
          if (!Array.isArray(paths) || paths.length === 0) { code = 1; text = 'paths 为空' } else {
            const { defaultVaultRoot } = await import('../lib/config')
            const { deletePages } = await import('../lib/tasks')
            const root = defaultVaultRoot()
            // #310.32b：rel 形态（树节点「知识页/xx.md」）归一为 abs——白名单匹配以 abs 为键
            const norm = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p))
            const r = deletePages(root, paths.map(String).slice(0, 500).map(norm))
            text = JSON.stringify({ ok: true, ...r })
          }
        } else if (op === 'backfill_push') {
          // #310.39：存量产物补传（编译/同步解耦）——幂等，返回统计
          const { backfillPushAll } = await import('../lib/compile-runner')
          const r = await backfillPushAll()
          text = JSON.stringify({ ok: true, ...r })
        } else {
          code = 2
          text = `未知 tasks op：${op}`
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
  // #310.31c：启动即确保书房结构（幂等）——含根 README 升级判定（此前只在 CLI sync/inbox 调用，桌面端 daemon 从不触发→用户拉码后 README 不升级）
  try { initVault(defaultVaultRoot()) } catch {}
  // #310.39：启动补传存量产物（编译/同步解耦——登录态+开关开才实际动作；内部三闸留痕，幂等）
  void import('../lib/compile-runner').then((m) => m.backfillPushAll()).catch(() => {})
  // #316.5：启动恢复——daemon 重启后 running/queued 任务 → queued（items 断点保留；执行由 tasks op 触发或任务页「继续」）
  const recovered = recoverOnBoot()
  if (recovered) console.log(`（任务恢复：${recovered} 个任务待续）`)
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
