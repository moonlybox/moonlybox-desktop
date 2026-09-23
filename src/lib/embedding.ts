/**
 * 本地 embedding 服务（#231 M2.5，D7/§5.16.5）。
 *
 * 模型：bge-small-zh-v1.5（q8 int8 量化，~33MB，512 维）——CPU 推理实测 13ms/条。
 * 网络纪律：模型首跑从 HF 官方下载，失败自动回落 hf-mirror.com（大陆网络）；下载完成后
 * 全部离线（缓存 ~/.cache/huggingface 或项目 models/）。向量永不出本机（D7 砍单纪律）。
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBEDDING_DIM = 512
export const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod = await import('@huggingface/transformers')
      mod.env.allowLocalModels = false
      const hosts = ['https://hf-mirror.com', 'https://huggingface.co']
      let lastErr: unknown = null
      for (const host of hosts) {
        try {
          mod.env.remoteHost = host
          // pipeline 重载联合过复杂（TS2590），调用面收敛为 any 后由本模块出口强类型化
          const make = (mod as any).pipeline as (
            task: string,
            model: string,
            opts?: Record<string, unknown>,
          ) => Promise<(text: string | string[], opts?: Record<string, unknown>) => Promise<{ data: ArrayLike<number>; dims: number[] }>>
          return (await make('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8', device: 'cpu' })) as unknown as FeatureExtractionPipeline
        } catch (e) {
          lastErr = e
        }
      }
      throw new Error(`embedding 模型加载失败（已尝试 ${hosts.join(' / ')}）：${String(lastErr)}`)
    })()
  }
  return extractorPromise
}

/** 诊断：onnxruntime-node 原生层实际解析到的版本（单文件编译不内嵌原生模块，运行时按 exe 旁 node_modules 解析） */
export async function ortRuntimeVersion(): Promise<string> {
  try {
    const ort: unknown = await import('onnxruntime-node')
    const versions = (ort as { env?: { versions?: { node?: string; common?: string } } }).env?.versions
    return versions?.node ?? versions?.common ?? 'unknown'
  } catch (e) {
    return `load-failed: ${String(e).slice(0, 120)}`
  }
}

/** 单文本 → 512 维归一化向量 */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getExtractor()
  const out = await (extractor as unknown as (
    text: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ data: ArrayLike<number>; dims: number[] }>)(text.slice(0, 2000), { pooling: 'cls', normalize: true })
  return Float32Array.from(out.data as ArrayLike<number>)
}

/** 批量（pipeline 内部并行批处理，比逐条快） */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getExtractor()
  const call = extractor as unknown as (
    text: string[],
    opts?: Record<string, unknown>,
  ) => Promise<{ data: ArrayLike<number>; dims: number[] }>
  const out = await call(
    texts.map((t) => t.slice(0, 2000)),
    { pooling: 'cls', normalize: true },
  )
  const dim = EMBEDDING_DIM
  const result: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) {
    result.push(Float32Array.from((out.data as ArrayLike<number>), Number).slice(i * dim, (i + 1) * dim))
  }
  return result
}
