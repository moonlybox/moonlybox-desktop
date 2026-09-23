/**
 * 本地 embedding 服务（#231 M2.5 → #246 重构：去 transformers 化，D7/§5.16.5）。
 *
 * 模型：bge-small-zh-v1.5（q8 int8 量化，~23MB，512 维）——CPU 推理实测 7ms/条。
 *
 * #246：bun compile 单文件对原生依赖（transformers 内嵌的 sharp/onnxruntime 原生层）运行时解析不可靠
 * （DLOPEN/require.resolve 全走 exe 旁 node_modules，用户机器必然踩坑）。重写为：
 *   - 手写 BERT WordPiece tokenizer（tokenizer.json 同源词表，与 transformers 输出 cosine=1.000000）
 *   - 直接 onnxruntime-node InferenceSession 推理（q8 onnx）
 *   - CLS pooling + L2 归一化（与 pooling:'cls', normalize:true 逐位一致）
 * transformers.js / sharp 依赖移除。模型文件运行时下载（hf-mirror 优先），缓存 <configDir>/models/。
 * 向量永不出本机（D7 砍单纪律）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'

export const EMBEDDING_DIM = 512
export const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'
const MAX_LEN = 512

/* ---------- 模型文件管理（下载 + 缓存） ---------- */

function modelsDir(): string {
  const { configDir } = require('./config') as { configDir: () => string }
  const dir = path.join(configDir(), 'models', 'bge-small-zh-v1.5')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
}

const MODEL_FILES = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'] as const

async function ensureModelFiles(): Promise<string> {
  const dir = modelsDir()
  const onnxPath = path.join(dir, 'onnx', 'model_quantized.onnx')
  const tokPath = path.join(dir, 'tokenizer.json')
  if (fs.existsSync(onnxPath) && fs.existsSync(tokPath)) return dir
  const base = 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/'
  const baseFallback = 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/'
  for (const host of [base, baseFallback]) {
    try {
      for (const f of MODEL_FILES) {
        const dest = path.join(dir, f)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        await downloadTo(host + f, dest)
      }
      return dir
    } catch {
      /* 下一镜像 */
    }
  }
  throw new Error('embedding 模型下载失败（hf-mirror.com / huggingface.co 均不可达）')
}

/* ---------- BERT WordPiece tokenizer（与 tokenizer.json 同源语义） ---------- */

interface Tokenizer {
  vocab: Record<string, number>
  unkId: number
  clsId: number
  sepId: number
  added: Map<string, number>
  maxChars: number
}

let tokenizerPromise: Promise<Tokenizer> | null = null

async function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const dir = await ensureModelFiles()
      const tj = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'))
      const vocab = tj.model.vocab as Record<string, number>
      const added = new Map<string, number>()
      for (const t of tj.added_tokens as Array<{ content: string; id: number }>) added.set(t.content, t.id)
      return {
        vocab,
        unkId: vocab['[UNK]'] ?? 100,
        clsId: vocab['[CLS]'] ?? 101,
        sepId: vocab['[SEP]'] ?? 102,
        added,
        maxChars: tj.model.max_input_chars_per_word ?? 100,
      }
    })()
  }
  return tokenizerPromise
}

/** BertNormalizer：clean_text + handle_chinese_chars（lowercase=false 与 BAAI/bge-small-zh 一致） */
function normalize(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0 || cp === 0xfffd || cp < 0x20) continue
    if (/\s/.test(ch)) {
      out += ' '
      continue
    }
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) out += ` ${ch} `
    else out += ch
  }
  return out
}

/** BertPreTokenizer：空白切分 + 标点隔离 */
function preTokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => w.match(/[\p{P}\p{S}]|[^\p{P}\p{S}]+/gu) ?? [])
}

function wordpiece(tk: Tokenizer, word: string): number[] {
  if (tk.added.has(word)) return [tk.added.get(word)!]
  const tokens: number[] = []
  let start = 0
  while (start < word.length) {
    if (word.length - start > tk.maxChars) return [tk.unkId]
    let end = word.length
    let id: number | undefined
    while (start < end) {
      let sub = word.slice(start, end)
      if (start > 0) sub = `##${sub}`
      const v = tk.vocab[sub]
      if (v !== undefined) {
        id = v
        break
      }
      end--
    }
    if (id === undefined) return [tk.unkId]
    tokens.push(id)
    start = end
  }
  return tokens
}

function encode(tk: Tokenizer, text: string): { inputIds: number[]; attentionMask: number[]; tokenTypeIds: number[] } {
  const words = preTokenize(normalize(text))
  const ids: number[] = [tk.clsId]
  for (const w of words) {
    const wp = wordpiece(tk, w)
    if (ids.length + wp.length + 1 > MAX_LEN) break
    ids.push(...wp)
  }
  ids.push(tk.sepId)
  return {
    inputIds: ids,
    attentionMask: ids.map(() => 1),
    tokenTypeIds: ids.map(() => 0),
  }
}

/* ---------- ORT 推理 ---------- */

let sessionPromise: Promise<InferenceSession> | null = null

async function getSession(): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const dir = await ensureModelFiles()
      const ort = await import('onnxruntime-node')
      return ort.InferenceSession.create(path.join(dir, 'onnx', 'model_quantized.onnx'), {
        graphOptimizationLevel: 'all',
      })
    })()
  }
  return sessionPromise
}

function tensorFrom(ort: typeof import('onnxruntime-node'), ids: number[]): Tensor {
  return new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
}

function clsPoolNormalize(hidden: Float32Array): Float32Array {
  const emb = new Float32Array(EMBEDDING_DIM)
  emb.set(hidden.slice(0, EMBEDDING_DIM))
  let norm = 0
  for (const x of emb) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] /= norm
  return emb
}

/** 单文本 → 512 维归一化向量 */
export async function embed(text: string): Promise<Float32Array> {
  const [tk, session] = await Promise.all([getTokenizer(), getSession()])
  const ort = await import('onnxruntime-node')
  const enc = encode(tk, text.slice(0, 2000))
  const results = await session.run({
    input_ids: tensorFrom(ort, enc.inputIds),
    attention_mask: tensorFrom(ort, enc.attentionMask),
    token_type_ids: tensorFrom(ort, enc.tokenTypeIds),
  })
  const out = results[session.outputNames[0]]
  return clsPoolNormalize(out.data as Float32Array)
}

/** 批量（逐条推理；q8 CPU 单条 ~7ms，批间共享 session） */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const [tk, session] = await Promise.all([getTokenizer(), getSession()])
  const ort = await import('onnxruntime-node')
  const result: Float32Array[] = []
  for (const text of texts) {
    const enc = encode(tk, text.slice(0, 2000))
    const results = await session.run({
      input_ids: tensorFrom(ort, enc.inputIds),
      attention_mask: tensorFrom(ort, enc.attentionMask),
      token_type_ids: tensorFrom(ort, enc.tokenTypeIds),
    })
    const out = results[session.outputNames[0]]
    result.push(clsPoolNormalize(out.data as Float32Array))
  }
  return result
}

/** 诊断：onnxruntime-node 原生层实际解析到的版本 */
export async function ortRuntimeVersion(): Promise<string> {
  try {
    const ort: unknown = await import('onnxruntime-node')
    const versions = (ort as { env?: { versions?: { node?: string; common?: string } } }).env?.versions
    return versions?.node ?? versions?.common ?? 'unknown'
  } catch (e) {
    return `load-failed: ${String(e).slice(0, 120)}`
  }
}
