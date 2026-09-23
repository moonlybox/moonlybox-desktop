/**
 * MoonlyBox 桌面壳主进程（M4 T1，D4=Electron 定案）。
 *
 * 架构纪律（§5.15 双层）：
 * - 壳层只做「宿主」：托盘/窗口/热键/协议/更新——业务全在内核（Bun 编译的 moonlybox CLI 单文件）；
 * - 内核经 child_process spawn 通信（stdio JSONL），壳不 import 内核代码——解耦即双层更新前提；
 * - IPC 安全（Hermes Desktop 范式）：contextIsolation=true + nodeIntegration=false + preload 白名单桥；
 * - D12 内存形态：托盘常驻≠窗口常驻，关窗即销毁 renderer。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

let tray = null
let win = null

// ---------- 内核定位：开发=仓根 bun 源；打包=resources/kernel/moonlybox 单文件 ----------
function kernelCmd() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'kernel', 'moonlybox')
    : null
  if (packaged && fs.existsSync(packaged)) return { cmd: packaged, base: [] }
  return { cmd: 'bun', base: ['run', 'src/cli.ts'] } // 开发态（cwd=REPO_ROOT）
}

const REPO_ROOT = path.join(__dirname, '..', '..')

// ---------- daemon 常驻通道（stdio JSONL，协议见 src/commands/daemon.ts） ----------
let daemon = null
const pending = new Map() // id → {resolve}
let nextId = 1
const eventHooks = [] // (id, event, payload) → void（renderer 订阅）

function ensureDaemon() {
  if (daemon && daemon.exitCode === null) return daemon
  const { cmd, base } = kernelCmd()
  daemon = spawn(cmd, [...base, 'daemon'], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MOONLYBOX_VAULT: process.env.MOONLYBOX_VAULT || `${process.env.HOME}/MyMoonVault` },
  })
  let buf = ''
  daemon.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const lineStr = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!lineStr) continue
      let msg
      try { msg = JSON.parse(lineStr) } catch { continue }
      if (msg.event === 'log') {
        eventHooks.forEach((h) => h(msg.id, 'log', msg.text))
      } else if (msg.event === 'done' || msg.event === 'error') {
        const p = pending.get(msg.id)
        if (p) { pending.delete(msg.id); p(msg) }
        eventHooks.forEach((h) => h(msg.id, msg.event, msg))
      }
    }
  })
  daemon.stderr.on('data', (d) => eventHooks.forEach((h) => h(0, 'stderr', d.toString())))
  daemon.on('exit', () => { daemon = null; pending.forEach((p) => p({ event: 'error', message: 'daemon exited' })); pending.clear() })
  return daemon
}

/** RPC：返回 Promise<done/error 消息>；过程行经 onKernelEvent 订阅。 */
function kernelRpc(cmd, args = {}, timeoutMs = 120_000) {
  ensureDaemon()
  const id = nextId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ event: 'error', message: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    daemon.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
  })
}

function createWindow() {
  if (win) { win.show(); win.focus(); return }
  win = new BrowserWindow({
    width: 1080, height: 720, show: false,
    title: '魔力宝盒',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // D12：关窗=隐藏释放显示，renderer 进程随 hide 不销毁——先按「hide 保活」实现（切回秒开），
  // 内存复测超 D12 口径再改 destroy（形态开关留 IPC）。
  win.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); win.hide() }
  })
  win.once('ready-to-show', () => win.show())
}

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGNgGFqg/2VAHdSNKmAIAQDiAQNy9vqrAAAAAElFTkSuQmCC'

app.whenReady().then(() => {
  const icon = nativeImage.createFromDataURL(ICON)
  tray = new Tray(icon)
  tray.setToolTip('魔力宝盒')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: createWindow },
    { type: 'separator' },
    { label: '启动内核', click: () => ensureDaemon() },
    { label: '退出', click: () => { app.isQuiting = true; app.quit() } },
  ]))
  tray.on('click', createWindow)

  // IPC 白名单（preload 对应）
  // daemon RPC：{cmd:'xiaoyue', args:{q}} → 过程行推 renderer，done 返回全文
  ipcMain.handle('kernel:rpc', (_e, { cmd, args, timeoutMs }) => kernelRpc(cmd, args, timeoutMs))
  ipcMain.on('kernel:subscribe', (e) => {
    const hook = (id, event, payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('kernel:event', { id, event, payload })
    }
    eventHooks.push(hook)
    e.sender.once('destroyed', () => {
      const i = eventHooks.indexOf(hook)
      if (i >= 0) eventHooks.splice(i, 1)
    })
  })
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  createWindow()
})

app.on('window-all-closed', () => { /* 托盘常驻 */ })
