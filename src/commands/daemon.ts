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
import { cmdSync } from '../commands/sync'
import { cmdSearch } from '../commands/search'
import { cmdMemory } from '../commands/memory'
import type { CommandOptions } from '../lib/runner'

type Json = Record<string, unknown>

interface Request {
  id: number
  cmd: string
  args?: Record<string, unknown>
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
        await cmdXiaoyue([q, ...(args.cloud ? ['--cloud'] : [])], { dir } as CommandOptions)
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
    default:
      code = 2
      text = `未知命令：${req.cmd}`
  }
  return { code, text }
}

export async function runDaemon(): Promise<void> {
  process.stdout.write(JSON.stringify({ id: 0, event: 'ready' }) + '\n')
  const rl = require('node:readline').createInterface({ input: process.stdin })
  for await (const raw of rl) {
    const lineStr = String(raw).trim()
    if (!lineStr) continue
    let req: Request
    try {
      req = JSON.parse(lineStr)
    } catch {
      process.stdout.write(JSON.stringify({ id: -1, event: 'error', message: 'bad json' }) + '\n')
      continue
    }
    const write = (obj: Json) => process.stdout.write(JSON.stringify(obj) + '\n')
    try {
      const { code, text } = await dispatch(req, (t) => write({ id: req.id, event: 'log', text: t }))
      write({ id: req.id, event: 'done', code, text })
    } catch (e) {
      write({ id: req.id, event: 'error', message: String(e instanceof Error ? e.message : e) })
    }
  }
}

// 直接执行时启动 daemon（bun run src/cli.ts daemon）
if (import.meta.main && process.argv[2] === 'daemon') {
  await runDaemon()
}
