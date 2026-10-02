/**
 * #317.F16/P1：本地模型库+硬件画像+fit 分级（设计稿 docs/local-deploy-model-catalog-plan.md 审定版）
 * 单一数据源：名单/硬件/适配判定都在此；daemon IPC 与 renderer 只消费。
 * 定位纪律：主体是「模型本身」，Ollama 只是运行时依赖（F16 用户定案）。
 */
import * as os from 'node:os'

export interface LocalModelSpec {
  id: string // Ollama 模型 tag（'qwen3:4b'）
  family: 'qwen3' | 'llama' | 'embed'
  title: string
  tagline: string // 一句话定位
  sizeGB: number // 磁盘占用（实测 ollama list）
  minMemGB: number // 最低可用内存（8192 ctx 档可跑）
  recMemGB: number // 推荐内存（16384+ ctx 舒适跑）
  ctxDefault: number // 推荐上下文（与 F15b 档位表同源逻辑）
  caps: Array<'tools' | 'thinking' | 'vision' | 'embed'>
  notes?: string // 已知坑（如实展示）
  /** #317.F16/P3：推荐默认参数（用户可见可改；只含 OpenAI /v1 标准字段——top_k/repeat_penalty 是
   *  Ollama 原生 options，/v1 对未知字段会 400（#17499 同因），不发） */
  params?: { temperature: number; maxTokens: number }
}

/** 默认参数基线（对话场景；F7 本地降档同源） */
export function defaultParams(spec: LocalModelSpec): { temperature: number; maxTokens: number } {
  if (spec.family === 'embed') return { temperature: 0, maxTokens: 32 }
  return { temperature: 0.3, maxTokens: 4096 } // F7：本地 4096 封顶（qwen3:4b 8tok/s → 生成窗口 ≤8.5 分钟）
}

/** 首发名单（用户审定 2026-10-02：qwen3 三档+llama 对照+嵌入模型；扩展位待 P4 云端热更） */
export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: 'qwen3:8b',
    family: 'qwen3',
    title: 'Qwen3 8B',
    tagline: '16G 内存机的推荐档：工具遵循与指令跟随明显好于 4B，Agent 循环首选',
    sizeGB: 5.2,
    minMemGB: 8,
    recMemGB: 14,
    ctxDefault: 16384,
    caps: ['tools', 'thinking'],
  },
  {
    id: 'qwen3:4b',
    family: 'qwen3',
    title: 'Qwen3 4B',
    tagline: '轻量档：低配机可跑；Agent 工具循环较弱（客户端已多层兜底）',
    sizeGB: 2.5,
    minMemGB: 4,
    recMemGB: 8,
    ctxDefault: 8192,
    caps: ['tools', 'thinking'],
    notes: '关思考时可能把分析过程写进回复（客户端已兜底自纠）；上下文过小会截断工具表（客户端已自动配置）',
  },
  {
    id: 'qwen3:14b',
    family: 'qwen3',
    title: 'Qwen3 14B',
    tagline: '32G 内存档：本地可跑的最强推理，速度约 2-4 tok/s（纯 CPU）',
    sizeGB: 9.3,
    minMemGB: 16,
    recMemGB: 24,
    ctxDefault: 16384,
    caps: ['tools', 'thinking'],
  },
  {
    id: 'llama3.1:8b',
    family: 'llama',
    title: 'Llama 3.1 8B',
    tagline: '生态对照：英文强中文弱；无思考模式，响应直接',
    sizeGB: 4.9,
    minMemGB: 8,
    recMemGB: 14,
    ctxDefault: 8192,
    caps: ['tools'],
  },
  {
    id: 'bge-m3',
    family: 'embed',
    title: 'BGE-M3（嵌入）',
    tagline: '本地语义检索引擎：中英多语言；配合书房「本地轨」检索，向量不出本机',
    sizeGB: 1.2,
    minMemGB: 2,
    recMemGB: 4,
    ctxDefault: 8192,
    caps: ['embed'],
  },
]

export interface HardwareProfile {
  memTotalGB: number
  memFreeGB: number
  gpuName: string | null
  gpuMemGB: number | null
  diskFreeGB: number | null
}

/** 硬件画像（用户定案：内存+GPU；GPU 缺失=null 走纯内存 fit）。daemon 侧执行。 */
export async function hardwareProfile(vaultRoot?: string): Promise<HardwareProfile> {
  const memTotalGB = os.totalmem() / 2 ** 30
  const memFreeGB = os.freemem() / 2 ** 30
  // 进程级缓存 60s——设置页反复进出不再重复 powershell/statfs（P3f 体感：骨架后秒出）
  const cacheKey = vaultRoot || '~'
  const g = globalThis as unknown as { __mbHwCache?: { at: number; key: string; v: HardwareProfile } }
  if (g.__mbHwCache && g.__mbHwCache.key === cacheKey && Date.now() - g.__mbHwCache.at < 60_000) return g.__mbHwCache.v
  let gpuName: string | null = null
  let gpuMemGB: number | null = null
  try {
    if (process.platform === 'win32') {
      // 显卡名+显存（AdapterRAM 是 32 位有符号，>4G 会溢出——只取名字，显存档位按 Name 粗判）
      const { execFile } = require('node:child_process') as typeof import('node:child_process')
      const out = await new Promise<string>((res) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'], { timeout: 5000 }, (e: unknown, so: string) => res(e ? '' : String(so ?? '')))
      })
      const name = out.trim()
      if (name) {
        gpuName = name
        // 粗判档位：型号名含显存暗示（RTX 4060=8G 等）不可靠——首版不猜显存，只报名字
        gpuMemGB = null
      }
    } else if (process.platform === 'linux') {
      try {
        const fs = require('node:fs') as typeof import('node:fs')
        if (fs.existsSync('/proc/driver/nvidia/version')) gpuName = 'NVIDIA'
      } catch { /* 忽略 */ }
    }
  } catch { /* GPU 检测失败不阻断 */ }
  let diskFreeGB: number | null = null
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const checkRoot = vaultRoot || os.homedir()
    // node:fs statfs（Node 18.15+）；失败回落 null
    const st = await (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bsize: number; bavail: number }> }).statfs?.(checkRoot)
    if (st) diskFreeGB = (st.bavail * st.bsize) / 2 ** 30
  } catch { /* 磁盘检测失败不阻断 */ }
  const v: HardwareProfile = { memTotalGB, memFreeGB, gpuName, gpuMemGB, diskFreeGB }
  g.__mbHwCache = { at: Date.now(), key: cacheKey, v }
  return v
}

export type FitLevel = 'recommended' | 'ok' | 'warn' | 'blocked'

export interface FitResult {
  level: FitLevel
  reason?: string
  /** 与 F15b 同源的推荐上下文（按本机内存对该模型给的档） */
  ctxSuggest: number
}

/** fit 分级（§四）：recommended/ok/warn/blocked；磁盘不足=warn（安装时再硬拦）；内存不足=blocked */
export function fitFor(spec: LocalModelSpec, hw: HardwareProfile, installedSizeGB?: number): FitResult {
  // 嵌入模型很轻：内存够即 recommended
  const usable = hw.memTotalGB // 判定基准=物理内存（F15b 同源；freemem 瞬时波动大不作 fit 依据）
  const ctxSuggest = usable >= 14 ? 32768 : usable >= 7 ? 16384 : usable >= 3.5 ? 8192 : 4096
  if (spec.family === 'embed') {
    if (usable < spec.minMemGB) return { level: 'blocked', reason: `内存 ${usable.toFixed(0)}GB 低于最低要求 ${spec.minMemGB}GB`, ctxSuggest }
    if (hw.diskFreeGB != null && (installedSizeGB ?? spec.sizeGB) * 1.2 > hw.diskFreeGB) return { level: 'warn', reason: `磁盘余量不足（需约 ${(spec.sizeGB * 1.2).toFixed(1)}GB，余 ${hw.diskFreeGB.toFixed(0)}GB）`, ctxSuggest }
    return { level: usable >= spec.recMemGB ? 'recommended' : 'ok', ctxSuggest }
  }
  if (usable < spec.minMemGB) {
    return { level: 'blocked', reason: `内存 ${usable.toFixed(0)}GB 低于最低要求 ${spec.minMemGB}GB（${spec.title} 无法稳定运行）`, ctxSuggest }
  }
  if (hw.diskFreeGB != null && (installedSizeGB ?? spec.sizeGB) * 1.2 > hw.diskFreeGB) {
    return { level: 'warn', reason: `磁盘余量不足（需约 ${(spec.sizeGB * 1.2).toFixed(1)}GB，余 ${hw.diskFreeGB.toFixed(0)}GB）`, ctxSuggest }
  }
  if (usable >= spec.recMemGB) return { level: 'recommended', ctxSuggest }
  return { level: 'ok', reason: `可用（低于推荐 ${spec.recMemGB}GB 内存：长上下文时较慢，建议关思考档）`, ctxSuggest }
}

/** F15b 档位（serve env 用；与 fitFor.ctxSuggest 同公式，单一出处原则） */
export function ctxForMem(totalGB: number): number | null {
  return totalGB >= 14 ? 32768 : totalGB >= 7 ? 16384 : totalGB >= 3.5 ? 8192 : null
}
