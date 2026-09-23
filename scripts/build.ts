#!/usr/bin/env bun
/**
 * 构建脚本（#246）：按当前平台生成 native-bootstrap 平台绑定，再 bun compile。
 *
 * native-bootstrap.ts 引用 ./native-bindings.ts（gitignore，构建时生成本平台 assets 绑定），
 * 避免 exe 内嵌三平台全部原生库。
 */
import { $ } from 'bun'
import * as fs from 'node:fs'
import * as path from 'node:path'

const p = process.platform // darwin | linux | win32
const arch = process.arch // x64 | arm64
const ortBin = `../../node_modules/onnxruntime-node/bin/napi-v3/${p}/${arch}`

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
if (!sharedRel) throw new Error(`ORT 共享库未找到: ${ortBin}/{${names.join(',')}}`)

const bindingRel = `../../node_modules/onnxruntime-node/bin/napi-v3/${p}/${arch}/onnxruntime_binding.node`
const sharedName = p === 'win32' ? 'onnxruntime.dll' : p === 'darwin' ? 'libonnxruntime.dylib' : 'libonnxruntime.so.1'

const bindingCode = `/**
 * 平台原生绑定（build 时生成，gitignore）。
 * 平台: ${p}-${arch}
 */
// @ts-expect-error bun assets
import sharedLib from '${sharedRel}' with { type: 'file' }
export { sharedLib }
export const SHARED_NAME = ${JSON.stringify(sharedName)}
export const NATIVE_VERSION = '1.21.0'
export const BINDING_PATH = ${JSON.stringify(bindingRel)}
`
fs.writeFileSync(path.join(repoRoot, 'src/lib/native-bindings.ts'), bindingCode)

await $`bun build src/cli.ts --compile --outfile dist/moonlybox`
console.log(`BUILD-OK ${p}-${arch}`)
