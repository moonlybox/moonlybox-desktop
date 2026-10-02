/**
 * #317.6b 子任务准入判定器：按当前对话模型（实例）判定 sub_agent 是否可用/给提示。
 * 兜底链（用户定案）：云端 API 默认开 → 本地默认关 → 无法判断默认关 → 用户手工设置兜底。
 * 判定结果只是「默认值+提示」，永远可被实例覆盖字段/总闸手工覆盖。
 */
import { pickModelInstance } from './model-registry'

export interface SubAgentVerdict {
  /** 自动判定：该模型是否建议开启 */
  allow: boolean
  /** 提示文案（空=无提示，如 >14B 云端） */
  hint: string
  /** 判定依据（调试/设置页展示）：'cloud' | 'param:<n>B' | 'unknown' */
  basis: string
}

/** 从模型名解析参数量（B=十亿）：qwen3:4b→4 / llama3.1:8b-instruct-q4→8 / qwen2.5:14b→14 / gpt-4o→null */
export function parseParamB(model: string): number | null {
  if (!model) return null
  const m = model.match(/:\s*(\d+(?:\.\d+)?)\s*b(?:i|ill(?:ion)?)?\b/i)
  if (m) return Number(m[1])
  // 形态2：名字本身带 7B/13B（无冒号）
  const m2 = model.match(/\b(\d+(?:\.\d+)?)\s*b\b/i)
  return m2 ? Number(m2[1]) : null
}

/**
 * 判定（总闸已开前提下调用）：
 * - platform/custom（云端 API）→ 默认开（算力在服务商侧）
 * - local → 解析参数量：<8B 关+提示 / 8-14B 可开+提示 / >14B 开 / 解析不出=无法判断→关+提示
 * - legacy → 视作云端（用户已配的 byok 通常是云端端点）
 */
export function subAgentVerdict(modelRef: string): SubAgentVerdict {
  const inst = pickModelInstance(modelRef)
  if (!inst) return { allow: false, hint: '未配置模型，子任务不可用', basis: 'unknown' }
  if (inst.kind === 'platform' || inst.kind === 'custom' || inst.kind === 'legacy') {
    return { allow: true, hint: '', basis: 'cloud' }
  }
  // local：
  const b = parseParamB(inst.model)
  if (b === null) {
    return { allow: false, hint: `无法判断该模型规模，子任务默认关闭；可手动开启后观察效果`, basis: 'unknown' }
  }
  if (b < 8) {
    return { allow: false, hint: `该模型参数量较小（约 ${b}B），子任务会把上下文拆分给小模型，路由出错概率高，不建议开启`, basis: `param:${b}B` }
  }
  if (b <= 14) {
    return { allow: true, hint: `该模型约 ${b}B，可支撑子任务，但复杂任务建议用云端模型`, basis: `param:${b}B` }
  }
  return { allow: true, hint: '', basis: `param:${b}B` }
}
