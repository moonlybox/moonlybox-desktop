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
let kernel = null

// ---------- 内核定位：开发=shell/kernel-dev 指向仓根 Bun 源；打包=resources/kernel/moonlybox ----------
function kernelPath() {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'kernel', 'moonlybox')
    : null
  if (packaged && fs.existsSync(packaged)) return packaged
  // 开发态：直接跑 Bun 源（bun run src/cli.ts），环境无 bun 时报明确错误
  return 'bun'
}

function kernelArgs() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'kernel', 'moonlybox'))) {
    return [] // 打包单文件
  }
  return ['run', 'src/cli.ts'] // 开发态
}

// 开发态内核 cwd=仓根（bun run src/cli.ts 相对路径）；打包态=单文件无 cwd 依赖
const REPO_ROOT = path.join(__dirname, '..', '..')

// ---------- 内核进程：一次常驻，stdio JSONL（M4 T2 细化协议，T1 先保活+ping） ----------
function startKernel() {
  if (kernel) return kernel
  const cmd = kernelPath()
  const args = [...kernelArgs(), '--help'] // T1 探针：--help 零依赖不联网
  kernel = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT })
  kernel.stdout.on('data', (d) => {
    if (win && !win.isDestroyed()) win.webContents.send('kernel:stdout', d.toString())
  })
  kernel.stderr.on('data', (d) => {
    if (win && !win.isDestroyed()) win.webContents.send('kernel:stderr', d.toString())
  })
  kernel.on('exit', () => { kernel = null })
  return kernel
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
    { label: '启动内核（tools list）', click: () => startKernel() },
    { label: '退出', click: () => { app.isQuiting = true; app.quit() } },
  ]))
  tray.on('click', createWindow)

  // IPC 白名单（preload 对应）
  ipcMain.handle('kernel:run', (_e, { args }) => new Promise((resolve) => {
    const p = spawn(kernelPath(), [...kernelArgs(), ...(args || [])], { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  }))
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  createWindow()
})

app.on('window-all-closed', () => { /* 托盘常驻 */ })
