/**
 * 编译模型解析（#316.7）：功能级偏好散装字段（model.compileDefault），解析收敛单源。
 * - resolveCompileModel()：读 model.compileDefault → pickModelInstance（model-registry 单源）→ 回落 model.default → legacy（resolveActiveModel 内置）
 * - 执行器禁自摸 settings——编译取模型只许走本函数（单源纪律锁在解析层）。
 */
import { loadSettings } from './settings'
import { resolveActiveModel, pickModelInstance } from './model-registry'
import type { ActiveModel } from './model-registry'

/**
 * 编译模型解析（#316.7 定案）：compileDefault → 回落对话默认 → 回落 legacy（resolveActiveModel 内置回落链）。
 * 空返回=无可用模型（执行器拒启动，对话侧引导先接入）。
 */
export function resolveCompileModel(): ActiveModel | null {
  const m = loadSettings().model as { compileDefault?: string }
  // ① 编译偏好（空/实例已删失效→自动落 ②③）
  if (m.compileDefault) {
    const hit = pickModelInstance(m.compileDefault)
    if (hit) return hit
  }
  // ② 回落对话默认 → ③ legacy
  return resolveActiveModel()
}

/** 编译偏好标签（任务确认卡/执行器展示用）：'Ollama · qwen3:4b' 形态 */
export function compileModelLabel(): string | null {
  const hit = resolveCompileModel()
  return hit ? `${hit.label} · ${hit.model}` : null
}
