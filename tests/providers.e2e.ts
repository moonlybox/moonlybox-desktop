/**
 * #276：providers 云端源——登录拉取+缓存/未登录兜底/缓存优先。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

process.env.XDG_CONFIG_HOME = '/tmp/mf-pv-' + Date.now()
const fs = require('node:fs')
fs.mkdirSync(process.env.XDG_CONFIG_HOME + '/moonlybox', { recursive: true })

const cloudManifest = {
  platform: [{ id: 'deepseek', label: 'DeepSeek(云端)', baseUrl: 'https://x/v1', models: ['m1'], docs: 'd' }],
  websearch: [{ id: 'bocha', label: '博查(云端)', baseUrl: 'u', needs: ['apiKey'] }],
  urlextract: [{ id: 'jina', label: 'Jina(云端)', baseUrl: 'u' }],
  memory: [{ id: 'builtin', label: '内置(云端)', note: 'n' }],
}
let fail = false
mock.module('../src/lib/api', () => ({
  apiGet: async () => {
    if (fail) throw new Error('net down')
    return { ok: true, status: 200, data: { schemaVersion: 1, providers: cloudManifest, localOnly: ['messaging'] } }
  },
}))

const { resolveProviders } = await import('../src/lib/providers')
const cachePath = process.env.XDG_CONFIG_HOME + '/moonlybox/providers-cache.json'

describe('#276 providers 云端源', () => {
  beforeEach(() => { fs.rmSync(cachePath, { force: true }); fail = false })

  test('已登录：云端清单覆盖内置，并写缓存', async () => {
    fs.writeFileSync(process.env.XDG_CONFIG_HOME + '/moonlybox/credentials.json', JSON.stringify({ accessToken: 't' }))
    const p = await resolveProviders()
    expect(p.platform[0].label).toBe('DeepSeek(云端)')
    expect(p.messaging.length).toBe(5) // messaging 恒本地
    expect(fs.existsSync(cachePath)).toBe(true)
  })
  test('缓存新鲜（<24h）：不再发请求，直接用缓存', async () => {
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), providers: { platform: [{ id: 'x', label: '缓存版', baseUrl: '', models: [], docs: '' }] } }))
    fail = true // 网络坏也无所谓——不应发起
    const p = await resolveProviders()
    expect(p.platform[0].label).toBe('缓存版')
  })
  test('未登录+无缓存：内置兜底', async () => {
    fs.rmSync(process.env.XDG_CONFIG_HOME + '/moonlybox/credentials.json', { force: true })
    const p = await resolveProviders()
    expect(p.platform.length).toBeGreaterThanOrEqual(6)
    expect(p.platform[0].label).toBe('DeepSeek') // 内置表
  })
  test('已登录但网络失败：过期缓存兜底→无缓存内置', async () => {
    fs.writeFileSync(process.env.XDG_CONFIG_HOME + '/moonlybox/credentials.json', JSON.stringify({ accessToken: 't' }))
    fail = true
    const p = await resolveProviders()
    expect(p.platform.length).toBeGreaterThanOrEqual(6)
  })
})
