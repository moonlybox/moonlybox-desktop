/**
 * 原生模块 bootstrap（#246，四轮）。
 *
 * 问题：bun compile 单文件把 onnxruntime 的 binding（.node）内嵌进 exe，但其共享库
 * （libonnxruntime.so.1 / onnxruntime.dll）按 dlopen/LoadLibrary 搜索链解析——binding 的
 * $ORIGIN 在 bunfs 虚拟路径下失效：
 *   - Linux/macOS：搜不到 → ERR_DLOPEN_FAILED
 *   - Windows：可能命中系统搜索链上的**旧版** onnxruntime.dll → 推理时报 API version 错
 *   - bunfs 虚拟路径的文件不能直接传给 ORT create(path)（C 层真实文件 API 读不到）
 *
 * 方案（四轮收敛）：
 *   1. 编译期把当前平台 ORT 共享库作为 bun assets 内嵌（.node 不重复内嵌——双实例破坏 backend 注册）
 *   2. 健康检查=真跑一次最小推理（smoke 模型以 Buffer 传入，不落虚拟路径）
 *   3. 不健康 → 解压共享库 → 重新 exec 自身：
 *      Windows: 首选复制到 exe 同目录（LoadLibrary 应用目录第一顺位），失败回落 tmpdir+PATH；
 *               引导后的子进程用 LoadLibraryExW(绝对路径) 预加载，锁定同名模块句柄（loader 对
 *               已加载同名模块直接复用，彻底绕开搜索链）
 *      Linux/macOS: tmpdir + LD_LIBRARY_PATH / DYLD_LIBRARY_PATH
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { sharedLib, smokeModel, bindingLib, SHARED_NAME, BINDING_NAME, NATIVE_VERSION } from './native-bindings'

const ENV_KEY = 'MOONLYBOX_NATIVE_BOOTSTRAP'

function nativeDir(): string {
  const dir = path.join(os.tmpdir(), `moonlybox-native-${NATIVE_VERSION}-${process.platform}-${process.arch}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extractNative(destDir?: string): string {
  const dir = destDir ?? nativeDir()
  fs.mkdirSync(dir, { recursive: true })
  const marker = path.join(dir, `.ok-${NATIVE_VERSION}`)
  const target = path.join(dir, SHARED_NAME)
  const bindingTarget = path.join(dir, BINDING_NAME)
  // 完整性判据=marker 且 共享库+binding 都存在（用户/清理工具可能删除部分文件）
  if (!fs.existsSync(marker) || !fs.existsSync(target) || !fs.existsSync(bindingTarget)) {
    for (const f of fs.readdirSync(dir)) {
      if (f === SHARED_NAME || f === BINDING_NAME) continue
      try { fs.unlinkSync(path.join(dir, f)) } catch { /* 非本组件文件跳过 */ }
    }
    fs.writeFileSync(target, fs.readFileSync(sharedLib as string))
    fs.writeFileSync(bindingTarget, fs.readFileSync(bindingLib as string))
    fs.writeFileSync(marker, 'ok')
  }
  return dir
}

/** exe 所在目录（Windows LoadLibrary 第一顺位搜索） */
function exeDir(): string {
  return path.dirname(process.execPath)
}

function canWrite(dir: string): boolean {
  try {
    const probe = path.join(dir, `.moonlybox-write-probe-${Date.now()}`)
    fs.writeFileSync(probe, '1')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * Windows：DLL 搜索链最终修正。
 *
 * 背景：binding（.node）在 bunfs 虚拟路径上，「应用目录」语义失效；System32 里若有旧版
 * onnxruntime.dll（如 1.17.1），静态导入解析会命中它（PATH 前置也输给 System32）。
 *
 * 解法（Win32 标准）：SetDefaultDllDirectories 切换到显式搜索语义
 * （应用目录 | 用户目录 | System32），再 AddDllDirectory 把内置引擎目录插入
 * USER_DIRS——**UserDirs 优先于 System32**，内嵌 1.21.0 必定压制系统旧版。
 */
export function lockNativeDir(): void {
  if (process.platform !== 'win32') return
  const dir = process.env.MOONLYBOX_NATIVE_DIR
  const bindingPath = dir ? path.join(dir, BINDING_NAME) : ''
  if (!bindingPath || !fs.existsSync(bindingPath)) return
  // ①先从真实目录 dlopen binding：依赖 onnxruntime.dll 按 binding 真实目录解析（ALTERED 语义）
  //   → 命中同目录内嵌 1.21.0；NAPI 模块注册表按模块注册名去重 →
  //   bundle 内 bunfs binding 的后续 require 复用已注册实例（不双实例）。
  //   binding 从 assets blob 写出（.blob 后缀避开 bun 对 .node 的编译期预加载——那会双实例）。
  try {
    const m = { exports: {} as Record<string, unknown> }
    process.dlopen(m, bindingPath)
    // CJS 模块可能整体替换 exports——以 dlopen 后的最终对象为准
    const exports = m.exports as Record<string, unknown>
    if (typeof exports.InferenceSession !== 'function') {
      console.error('警告: 引擎绑定预加载后导出不完整')
    }
  } catch (e) {
    console.error(`警告: 引擎绑定预加载失败: ${String(e).slice(0, 120)}`)
  }
  // ②双保险：显式 DLL 搜索语义（UserDirs 优先于 System32）
  try {
    const { dlopen, FFIType } = require('bun:ffi')
    const wide = Buffer.from(`${dir}\0`, 'utf16le')
    const kernel32 = dlopen('kernel32.dll', {
      AddDllDirectory: { args: [FFIType.ptr], returns: FFIType.ptr },
      SetDefaultDllDirectories: { args: [FFIType.u32], returns: FFIType.i32 },
    }).symbols
    // LOAD_LIBRARY_SEARCH_APPLICATION_DIR=0x200 | LOAD_LIBRARY_SEARCH_USER_DIRS=0x400 | LOAD_LIBRARY_SEARCH_SYSTEM32=0x800
    const ok = kernel32.SetDefaultDllDirectories(0x200 | 0x400 | 0x800)
    const cookie = kernel32.AddDllDirectory(wide)
    if (!ok || !cookie || Number(cookie) === 0) {
      console.error('警告: DLL 搜索目录配置未生效（将回落系统搜索链）')
    }
  } catch (e) {
    console.error(`警告: DLL 搜索目录配置异常（将回落系统搜索链）: ${String(e).slice(0, 120)}`)
  }
}

/**
 * ORT 原生层健康检查：
 * 仅 import 成功不算数——dlopen 可能命中旧版共享库（Windows「API version 21 vs 1.17.1」即此因）。
 * 必须真跑一次最小推理；smoke 模型以 Buffer 传入（bunfs 虚拟路径 ORT C 层读不到）。
 * 版本不匹配/注册损坏时 create/run 抛错 → 视为不健康 → 走引导。
 */
async function ortHealthy(): Promise<boolean> {
  try {
    const ort = await import('onnxruntime-node')
    const modelBytes = fs.readFileSync(smokeModel as string)
    const session = await ort.InferenceSession.create(modelBytes)
    const feed = new ort.Tensor('float32', new Float32Array([1]), [1])
    const out = await session.run({ x: feed })
    return Boolean(out.y)
  } catch {
    return false
  }
}

/**
 * 入口调用：ORT 原生层不健康时解压共享库并 exec 自身（注入平台库搜索路径）。
 * 返回 true=已重新 exec（本进程应立即退出）；false=环境就绪（或引导后仍失败，交上层报错）。
 */
export async function ensureNativeOrt(): Promise<boolean> {
  // Windows：先无条件部署+按真实目录预加载 binding（此顺序保证首次 import ORT 就命中内嵌 1.21.0，
  // 不触发对 System32 旧 DLL 的探测——探测本身会让 ORT C++ 层向 stderr 打 API version 噪音）
  if (process.platform === 'win32') {
    let dir: string
    if (canWrite(exeDir())) {
      dir = extractNative(exeDir())
    } else {
      dir = extractNative()
      console.error(`提示: exe 目录不可写（安装版？），引擎库部署在 ${dir}`)
    }
    const env: Record<string, string> = { ...process.env, MOONLYBOX_NATIVE_DIR: dir }
    if (process.env[ENV_KEY] !== '1') {
      // 未引导过：注入环境并 lock（预加载真实目录 binding，NAPI 注册去重使后续 import 复用）
      env[ENV_KEY] = '1'
      process.env.MOONLYBOX_NATIVE_DIR = dir
      lockNativeDir()
      if (await ortHealthy()) {
        const deployed = path.join(dir, SHARED_NAME)
        const size = fs.statSync(deployed).size
        console.error(`内置引擎 ${NATIVE_VERSION} 就绪 → ${deployed}（${(size / 1024 / 1024).toFixed(1)}MB）`)
        return false
      }
      // 预加载后仍不健康（理论上不应发生）：exec 自身走 PATH 兜底
      env.PATH = `${dir};${process.env.PATH ?? ''}`
      const child = cp.spawn(process.execPath, process.argv.slice(2), { env, stdio: 'inherit', windowsHide: true })
      await new Promise<void>((resolve) => child.on('exit', (code) => {
        process.exitCode = code ?? 1
        resolve()
      }))
      return true
    }
    // 已引导过（bootstrap=1）：lock 后正常探测
    lockNativeDir()
    if (await ortHealthy()) return false
    console.error(`警告: 引擎引导后仍不健康（onnxruntime 版本校验失败），检索功能不可用`)
    return false
  }

  // Linux/macOS：探测 → 不健康则解压+exec-self（环境变量搜索链）
  if (await ortHealthy()) return false
  if (process.env[ENV_KEY] === '1') return false
  const dir = extractNative()
  const env: Record<string, string> = { ...process.env, [ENV_KEY]: '1' }
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = `${dir}:${env.DYLD_LIBRARY_PATH ?? ''}`
  } else {
    env.LD_LIBRARY_PATH = `${dir}:${env.LD_LIBRARY_PATH ?? ''}`
  }
  const child = cp.spawn(process.execPath, process.argv.slice(2), { env, stdio: 'inherit', windowsHide: true })
  await new Promise<void>((resolve) => child.on('exit', (code) => {
    process.exitCode = code ?? 1
    resolve()
  }))
  return true
}

