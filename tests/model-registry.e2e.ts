/**
 * #283：模型注册表 e2e——settings.model 多实例结构迁移+resolveActiveModel 解析+钥匙串 key。
 * 钥匙串在 Linux CI 无 Secret Service 时 keychainKey 返回 null（getPassword catch）——apiKey 断言按 null 容忍。
 */
import { describe, test, expect, afterAll } from 'bun:test'
import * as fs from 'node:fs'

const tmpCfg = '/tmp/e2e_modelreg_' + Date.now()
process.env.XDG_CONFIG_HOME = tmpCfg
fs.mkdirSync(tmpCfg + '/moonlybox', { recursive: true })

const { loadSettings, saveSettings } = await import('../src/lib/settings')
const { resolveActiveModel, saveModelKey, deleteModelKey } = await import('../src/lib/model-registry')
const sp = tmpCfg + '/moonlybox/settings.json'

afterAll(() => { fs.rmSync(tmpCfg, { recursive: true, force: true }) })

describe('#283 settings.model 迁移', () => {
  test('旧单模型 provider 形态 → providers[0]+default 指向', () => {
    fs.writeFileSync(sp, JSON.stringify({ model: { provider: 'zhipu', model: 'glm-4.5' } }))
    const s = loadSettings() as any
    expect(s.model.providers.length).toBe(1)
    expect(s.model.providers[0].providerId).toBe('zhipu')
    expect(s.model.providers[0].enabled).toBe(true)
    expect(s.model.default).toBe(`platform:${s.model.providers[0].id}`)
  })

  test('旧 custom 对象形态 → custom[0]+default 指向', () => {
    fs.writeFileSync(sp, JSON.stringify({ model: { custom: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } } }))
    const s = loadSettings() as any
    expect(s.model.custom.length).toBe(1)
    expect(s.model.custom[0].baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(s.model.default).toBe(`custom:${s.model.custom[0].id}`)
  })

  test('已迁移结构不重复迁移（providers/custom 数组存在=权威）', () => {
    fs.writeFileSync(sp, JSON.stringify({ model: { providers: [{ id: 'p1', providerId: 'deepseek', enabled: false, model: 'deepseek-chat' }], custom: [], default: '' } }))
    const s = loadSettings() as any
    expect(s.model.providers.length).toBe(1)
    expect(s.model.providers[0].id).toBe('p1')
    expect(s.model.default).toBe('')
  })
})

describe('#283 resolveActiveModel', () => {
  test('无配置 → null（无 byok.json）', () => {
    fs.rmSync(tmpCfg + '/moonlybox/byok.json', { force: true })
    expect(resolveActiveModel()).toBeNull()
  })

  test('default 指向已启用自定义实例 → 解析出 baseUrl/model', () => {
    try { saveModelKey('c1', 'sk-e2e-key-12345678') } catch {}
    saveSettings({ model: { custom: [{ id: 'c1', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', enabled: true }], default: 'custom:c1' } })
    const a = resolveActiveModel()
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('custom')
    expect(a!.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(a!.model).toBe('qwen3:8b')
  })

  test('停用的实例不被解析（default 指向停用实例→回落）', () => {
    saveSettings({ model: { custom: [{ id: 'c1', name: 'x', baseUrl: 'http://x/v1', model: 'm', enabled: false }], default: 'custom:c1' } })
    expect(resolveActiveModel()).toBeNull() // 无 byok 回落时
  })

  test('平台实例缺 key → null（key 必填门，防 byokReady 语义分裂 #283）', () => {
    saveSettings({ model: { providers: [{ id: 'p_nokey', providerId: 'zhipu', enabled: true, model: 'glm-4.5' }], default: 'platform:p_nokey', custom: [] } })
    // 本环境可能无 Secret Service——先删一次确保无 key
    try { deleteModelKey('p_nokey') } catch {}
    expect(resolveActiveModel()).toBeNull()
  })

  test('平台实例：baseUrl 取 PLATFORM_PROVIDERS 映射', () => {
    try { saveModelKey('p1', 'sk-e2e-key-12345678') } catch {}
    saveSettings({ model: { providers: [{ id: 'p1', providerId: 'zhipu', enabled: true, model: 'glm-4.5' }], default: 'platform:p1', custom: [] } })
    const a = resolveActiveModel()
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('platform')
    expect(a!.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(a!.label).toContain('智谱')
  })

  test('key 钥匙串 roundtrip（无 Secret Service 环境容忍 null）', () => {
    try { saveModelKey('c_e2e', 'sk-test-12345678') } catch {}
    saveSettings({ model: { custom: [{ id: 'c_e2e', name: 'kt', baseUrl: 'http://x/v1', model: 'm', enabled: true }], default: 'custom:c_e2e' } })
    const a = resolveActiveModel()
    expect(a!.apiKey === null || a!.apiKey === 'sk-test-12345678').toBe(true)
    try { deleteModelKey('c_e2e') } catch {}
  })
})
