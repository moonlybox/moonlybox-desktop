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
import { sharedLib, smokeModel, SHARED_NAME, NATIVE_VERSION } from './native-bindings'

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
  // 完整性判据=marker 且 dll 都存在（用户/清理工具可能删 dll 留 marker）
  if (!fs.existsSync(marker) || !fs.existsSync(target)) {
    for (const f of fs.readdirSync(dir)) {
      if (f === SHARED_NAME) continue
      try { fs.unlinkSync(path.join(dir, f)) } catch { /* 非本组件文件跳过 */ }
    }
    fs.writeFileSync(target, fs.readFileSync(sharedLib as string))
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
 * Windows：用 LoadLibraryExW 按绝对路径预加载共享库。
 * 之后 binding 的静态导入 onnxruntime.dll 会命中已加载的同名模块（loader 复用），
 * 完全绕开 DLL 搜索链（System32/PATH 里任何旧版 dll 都不再参与）。
 */
function preloadWindowsDll(dir: string): void {
  try {
    const { dlopen, FFIType } = require('bun:ffi')
    const dllPath = path.join(dir, SHARED_NAME)
    const wide = Buffer.from(`${dllPath}\0`, 'utf16le')
    // LoadLibraryExW(lpLibFileName: ptr, hFile: 0, dwFlags: LOAD_WITH_ALTERED_SEARCH_PATH=8)
    const { LoadLibraryExW } = dlopen('kernel32.dll', {
      LoadLibraryExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    }).symbols
    const handle = LoadLibraryExW(wide, 0, 8)
    if (!handle || Number(handle) === 0) {
      console.error(`警告: 预加载 ${dllPath} 失败（将回落系统搜索链）`)
    }
  } catch (e) {
    console.error(`警告: DLL 预加载异常（将回落系统搜索链）: ${String(e).slice(0, 120)}`)
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
  if (await ortHealthy()) return false
  if (process.env[ENV_KEY] === '1') return false // 已引导过仍失败——不循环，让上层报真实错误

  let dir: string
  let deployed = ''
  if (process.platform === 'win32') {
    // Windows：exe 同目录是 LoadLibrary 第一顺位（高于 System32），必须尽力复制到位
    if (canWrite(exeDir())) {
      dir = extractNative(exeDir())
      deployed = path.join(exeDir(), SHARED_NAME)
    } else {
      dir = extractNative()
      deployed = path.join(dir, SHARED_NAME)
      console.error(`提示: exe 目录不可写（安装版？），引擎库部署在 ${dir}（PATH 方案）`)
    }
  } else {
    dir = extractNative()
  }
  if (deployed) {
    const size = fs.statSync(deployed).size
    console.error(`已部署内置引擎 ${NATIVE_VERSION} → ${deployed}（${(size / 1024 / 1024).toFixed(1)}MB）；此前若报 API version 1.17.1，旧 DLL 来自系统目录`)
  }
  const env: Record<string, string> = { ...process.env, [ENV_KEY]: '1' }
  if (process.platform === 'win32') {
    env.PATH = `${dir};${env.PATH ?? ''}`
    env.MOONLYBOX_NATIVE_DIR = dir
  } else if (process.platform === 'darwin') {
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

/**
 * 引导后的子进程在首次 import ORT 前调用：Windows 用 LoadLibraryExW 锁定内嵌版本。
 * （必须在 import('onnxruntime-node') 之前；Linux/macOS 由环境变量覆盖搜索链，无需此步）
 */
export function lockNativeDir(): void {
  if (process.platform !== 'win32') return
  const dir = process.env.MOONLYBOX_NATIVE_DIR
  if (dir && fs.existsSync(path.join(dir, SHARED_NAME))) preloadWindowsDll(dir)
}
