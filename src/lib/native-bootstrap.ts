/**
 * 原生模块 bootstrap（#246）。
 *
 * 问题：bun compile 单文件把 onnxruntime 的 binding（.node）内嵌进 exe，但其共享库
 * （libonnxruntime.so.1 / onnxruntime.dll）按 dlopen 搜索链解析——binding 的 $ORIGIN 在
 * bunfs 虚拟路径下失效，用户机器上命中不到（或命中旧版 DLL，报 API version 错误）。
 *
 * 方案：编译期把当前平台的 ORT 共享库作为 bun assets 内嵌（.node binding 不重复内嵌——
 * bundle 里 onnxruntime-node 自带；重复内嵌会双实例破坏 backend 注册）；运行时检测 ORT 加载，
 * 失败则解压共享库到持久目录并重新 exec 自身（Linux: LD_LIBRARY_PATH / Windows: PATH 前置）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { sharedLib, SHARED_NAME, NATIVE_VERSION } from './native-bindings'

function nativeDir(): string {
  const dir = path.join(os.tmpdir(), `moonlybox-native-${NATIVE_VERSION}-${process.platform}-${process.arch}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extractNative(): string {
  const dir = nativeDir()
  const marker = path.join(dir, `.ok-${NATIVE_VERSION}`)
  if (!fs.existsSync(marker)) {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.writeFileSync(path.join(dir, SHARED_NAME), fs.readFileSync(sharedLib as string))
    fs.writeFileSync(marker, 'ok')
  }
  return dir
}

/** ORT 原生层当前是否可加载（不实际跑推理） */
async function ortLoadable(): Promise<boolean> {
  try {
    await import('onnxruntime-node')
    return true
  } catch {
    return false
  }
}

/**
 * 入口调用：若 ORT 原生层不可加载，解压共享库并 exec 自身（注入平台库搜索路径）。
 * 返回 true=已重新 exec（本进程应立即退出）；false=环境就绪。
 */
export async function ensureNativeOrt(): Promise<boolean> {
  if (await ortLoadable()) return false
  const dir = extractNative()
  const envKey = 'MOONLYBOX_NATIVE_BOOTSTRAP'
  if (process.env[envKey] === '1') return false // 已引导过仍失败——不循环，让上层报真实错误
  const env: Record<string, string> = { ...process.env, [envKey]: '1' }
  if (process.platform === 'win32') {
    env.PATH = `${dir};${env.PATH ?? ''}`
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
