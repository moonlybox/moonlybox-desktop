/**
 * #269：general.toolsEnabled → mcp.builtinEnabled 升格迁移（老落盘值不丢）。
 */
import { describe, test, expect } from 'bun:test'

process.env.XDG_CONFIG_HOME = '/tmp/mf-mig-' + Date.now()
const fs = require('node:fs')
fs.mkdirSync(process.env.XDG_CONFIG_HOME + '/moonlybox', { recursive: true })
const { loadSettings, saveSettings } = await import('../src/lib/settings')
const sp = process.env.XDG_CONFIG_HOME + '/moonlybox/settings.json'

describe('#269 settings 迁移', () => {
  test('老结构 general.toolsEnabled=false → mcp.builtinEnabled=false', () => {
    fs.writeFileSync(sp, JSON.stringify({ general: { toolsEnabled: false } }))
    const s = loadSettings() as any
    expect(s.mcp.builtinEnabled).toBe(false)
  })
  test('老结构 true 同理', () => {
    fs.writeFileSync(sp, JSON.stringify({ general: { toolsEnabled: true } }))
    const s = loadSettings() as any
    expect(s.mcp.builtinEnabled).toBe(true)
  })
  test('新结构显式 mcp.builtinEnabled 优先（不被老字段覆盖）', () => {
    fs.writeFileSync(sp, JSON.stringify({ general: { toolsEnabled: false }, mcp: { builtinEnabled: true } }))
    const s = loadSettings() as any
    expect(s.mcp.builtinEnabled).toBe(true)
  })
  test('全新安装：默认 true，且不再落 general.toolsEnabled', () => {
    fs.rmSync(sp, { force: true })
    const s = loadSettings() as any
    expect(s.mcp.builtinEnabled).toBe(true)
    expect(s.general.toolsEnabled).toBeUndefined()
  })
  test('save mcp.builtinEnabled 落盘后 load 读回', () => {
    fs.rmSync(sp, { force: true })
    saveSettings({ mcp: { builtinEnabled: false } })
    expect((loadSettings() as any).mcp.builtinEnabled).toBe(false)
  })
})
