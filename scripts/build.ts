#!/usr/bin/env bun
/**
 * 构建脚本（#246）：按当前平台生成 native-bootstrap 平台绑定，再 bun compile。
 *
 * native-bootstrap.ts 引用 ./native-bindings.ts（gitignore，构建时生成本平台 assets 绑定），
 * 避免 exe 内嵌三平台全部原生库。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const p = process.platform // darwin | linux | win32
const arch = process.arch // x64 | arm64

// 各平台共享库文件名
const sharedNames: Record<string, string[]> = {
  linux: ['libonnxruntime.so.1'],
  darwin: ['libonnxruntime.1.21.0.dylib', 'libonnxruntime.dylib'],
  win32: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'],
}
const names = sharedNames[p]
if (!names) throw new Error(`不支持的平台: ${p}`)

// 找实际存在的共享库文件
const repoRoot = path.resolve(import.meta.dir, '..')
let sharedRel: string | null = null
for (const n of names) {
  const cand = path.join(repoRoot, 'node_modules/onnxruntime-node/bin/napi-v3', p, arch, n)
  if (fs.existsSync(cand)) {
    sharedRel = `../../node_modules/onnxruntime-node/bin/napi-v3/${p}/${arch}/${n}`
    break
  }
}
if (!sharedRel) throw new Error(`ORT 共享库未找到: napi-v3/${p}/${arch}/{${names.join(',')}}`)

const bindingRel = `../../node_modules/onnxruntime-node/bin/napi-v3/${p}/${arch}/onnxruntime_binding.node`
const sharedName = p === 'win32' ? 'onnxruntime.dll' : p === 'darwin' ? 'libonnxruntime.dylib' : 'libonnxruntime.so.1'

const bindingCode = `/**
 * 平台原生绑定（build 时生成，gitignore）。
 * 平台: ${p}-${arch}
 */
// @ts-expect-error bun assets
import sharedLib from '${sharedRel}' with { type: 'file' }
// @ts-expect-error bun assets
import smokeModel from '../../assets/ort-smoke.onnx' with { type: 'file' }
// @ts-expect-error bun assets
import bindingLib from '../../assets/ort-binding.blob' with { type: 'file' }
export { sharedLib, smokeModel, bindingLib }
export const SHARED_NAME = ${JSON.stringify(sharedName)}
export const BINDING_NAME = 'onnxruntime_binding.node'
export const NATIVE_VERSION = '1.21.0'
export const BINDING_PATH = ${JSON.stringify(bindingRel)}
`
// --gen-only：只生成绑定不 compile（CI typecheck 前置步——native-bindings.ts 是 gitignore 生成物，
// fresh clone 没有，typecheck 的 TS2307 是 ci(main) 长期红根因 #251.4）
if (process.argv.includes('--gen-only')) {
  fs.writeFileSync(path.join(repoRoot, 'src/lib/native-bindings.ts'), bindingCode)
  console.log('GEN-ONLY: native-bindings.ts 已生成（跳过 compile）')
  process.exit(0)
}
// binding 复制为 .blob（避开 bun 对 .node 后缀的 native 模块预加载特判——双实例根源）
fs.copyFileSync(
  path.join(repoRoot, 'node_modules/onnxruntime-node/bin/napi-v3', p, arch, 'onnxruntime_binding.node'),
  path.join(repoRoot, 'assets/ort-binding.blob'),
)
fs.writeFileSync(path.join(repoRoot, 'src/lib/native-bindings.ts'), bindingCode)

try {
  await Bun.$`bun build src/cli.ts --compile --outfile dist/moonlybox`
} catch (e) {
  const msg = String(e)
  if (msg.includes('EPERM') || msg.includes(' Permission denied')) {
    console.error('编译成功但无法替换 dist/moonlybox.exe：文件被占用（Windows）——上一次运行的 moonlybox.exe 进程还没退出。')
    console.error('处理：任务管理器结束所有 moonlybox.exe 进程，或运行： taskkill /F /IM moonlybox.exe ，然后重跑 bun run build。')
    process.exit(1)
  }
  throw e
}
console.log(`BUILD-OK ${p}-${arch}`)
