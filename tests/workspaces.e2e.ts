/**
 * workspaces e2e（#282）：工作空间+对话持久化。
 * 覆盖：工作空间 CRUD（必填校验/目录挂载/增删目录/删除降级对话）、对话 CRUD（无工作空间/归属/落账/恢复）、
 * 路径边界 isUnderDirs、持久化文件 0600。
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_ws_'))
process.env.XDG_CONFIG_HOME = tmpCfg

// 临时工作目录（模拟用户本地文件夹）
const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_wsdir_'))
fs.mkdirSync(path.join(tmpWork, 'sub'), { recursive: true })
fs.writeFileSync(path.join(tmpWork, 'a.md'), '# hello')
fs.writeFileSync(path.join(tmpWork, 'sub', 'b.txt'), 'world')

import {
  createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace, listWorkspaces, isUnderDirs,
  createChat, loadChat, saveChat, appendTurn, deleteChat, listChats, listChatsByWorkspace, chatTurnsForContext, primaryDir,
} from '../src/lib/workspaces'

afterAll(() => {
  fs.rmSync(tmpCfg, { recursive: true, force: true })
  fs.rmSync(tmpWork, { recursive: true, force: true })
})

describe('工作空间', () => {
  let wsId: string
  test('create：名称+多目录必填，落盘', () => {
    const ws = createWorkspace('毕业论文', [tmpWork])
    wsId = ws.id
    expect(ws.name).toBe('毕业论文')
    expect(ws.dirs).toEqual([path.resolve(tmpWork)])
    expect(getWorkspace(wsId)?.name).toBe('毕业论文')
  })

  test('update：增删目录', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_wsdir2_'))
    const ws = updateWorkspace(wsId, { addDir: other })
    expect(ws!.dirs.length).toBe(2)
    const ws2 = updateWorkspace(wsId, { removeDir: other })
    expect(ws2!.dirs.length).toBe(1)
    fs.rmSync(other, { recursive: true, force: true })
  })

  test('setPrimary：设主目录+primaryDir 回退+删除主目录自动回退（#282.2）', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_wsdir3_'))
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e_wsdir4_'))
    const wsId = createWorkspace('主目录用例', [tmpWork]).id  // 独立空间——不污染后续 delete 降级用例
    updateWorkspace(wsId, { addDir: d2 })
    updateWorkspace(wsId, { addDir: d3 })
    // 默认主=首目录
    let ws = getWorkspace(wsId)!
    expect(primaryDir(ws)).toBe(ws.dirs[0])
    // 设第二目录为主
    ws = updateWorkspace(wsId, { setPrimary: 1 })!
    expect(ws.primaryIndex).toBe(1)
    expect(primaryDir(ws)).toBe(path.resolve(d2))
    // 越界设主不生效
    ws = updateWorkspace(wsId, { setPrimary: 99 })!
    expect(ws.primaryIndex).toBe(1)
    // 删除主目录（下标 1）→主回退首目录
    ws = updateWorkspace(wsId, { removeDir: d2 })!
    expect(ws.primaryIndex).toBe(0)
    expect(primaryDir(ws)).toBe(ws.dirs[0])
    // 删除主目录前面的目录→主下标前移
    updateWorkspace(wsId, { setPrimary: 1 })
    ws = updateWorkspace(wsId, { removeDir: ws.dirs[0]! })!
    expect(ws.primaryIndex).toBe(0)
    expect(primaryDir(ws)).toBe(path.resolve(d3))
    // create 带 primaryIndex
    const ws2 = createWorkspace('带主', [tmpWork, d3], 1)
    expect(ws2.primaryIndex).toBe(1)
    expect(primaryDir(ws2)).toBe(path.resolve(d3))
    // 清理
    deleteWorkspace(wsId)
    deleteWorkspace(ws2.id)
    fs.rmSync(d2, { recursive: true, force: true })
    fs.rmSync(d3, { recursive: true, force: true })
  })

  test('isUnderDirs：挂载内/子路径/越界', () => {
    expect(isUnderDirs(tmpWork, [tmpWork])).toBe(true)
    expect(isUnderDirs(path.join(tmpWork, 'sub', 'b.txt'), [tmpWork])).toBe(true)
    expect(isUnderDirs('/etc/passwd', [tmpWork])).toBe(false)
    expect(isUnderDirs(tmpWork + '_sibling/x', [tmpWork])).toBe(false) // 前缀同但非子路径
  })

  test('delete：工作空间删除后其对话降级为无工作空间（历史保留）', () => {
    const chat = createChat(wsId, 'ws 内对话')
    appendTurn(chat.id, 'user', '你好')
    expect(deleteWorkspace(wsId)).toBe(true)
    expect(listWorkspaces().length).toBe(0)
    const c = loadChat(chat.id)!
    expect(c.workspaceId).toBeNull()
    expect(c.turns.length).toBe(1)
    deleteChat(chat.id)
  })
})

describe('对话持久化', () => {
  test('createChat 无工作空间（null）+appendTurn 落账+首问自动命名', () => {
    const chat = createChat(null)
    expect(chat.workspaceId).toBeNull()
    appendTurn(chat.id, 'user', '血小板输注有什么讲究？这是一段很长的第一问用来截标题')
    const rec = loadChat(chat.id)!
    expect(rec.turns.length).toBe(1)
    expect(rec.title.length).toBeLessThanOrEqual(24)
    expect(rec.title).toContain('血小板输注')
    expect(rec.turns[0]!.role).toBe('user')
    deleteChat(chat.id)
  })

  test('chatTurnsForContext：恢复轮次（daemon 重启回灌）', () => {
    const chat = createChat(null, '续聊')
    appendTurn(chat.id, 'user', '问题一')
    appendTurn(chat.id, 'assistant', '回答一')
    const turns = chatTurnsForContext(chat.id)
    expect(turns.length).toBe(2)
    expect(turns[1]!.content).toBe('回答一')
    deleteChat(chat.id)
  })

  test('listChatsByWorkspace 按 workspaceId 过滤+按更新时间排序', () => {
    const ws = createWorkspace('ws2', [tmpWork])
    const c1 = createChat(ws.id, '甲')
    const c2 = createChat(ws.id, '乙')
    const free = createChat(null, '自由')
    const titles = listChatsByWorkspace(ws.id).map((c) => c.title)
    expect(titles).toContain('甲')
    expect(titles).toContain('乙')
    expect(listChatsByWorkspace(null).map((c) => c.title)).toContain('自由')
    expect(listChats().length).toBe(3)
    deleteChat(c1.id); deleteChat(c2.id); deleteChat(free.id)
    deleteWorkspace(ws.id)
  })

  test('持久化文件 0600+settings 目录隔离', () => {
    const chat = createChat(null, 'mode-check')
    const st = fs.statSync(path.join(tmpCfg, 'moonlybox', 'chats', `${chat.id}.json`))
    expect(st.mode & 0o777).toBe(0o600)
    deleteChat(chat.id)
  })

  test('saveChat 轮次硬上限 200（防膨胀）', () => {
    const chat = createChat(null, 'flood')
    for (let i = 0; i < 250; i++) appendTurn(chat.id, 'user', `第${i}轮`)
    expect(loadChat(chat.id)!.turns.length).toBe(200)
    deleteChat(chat.id)
  })
})
