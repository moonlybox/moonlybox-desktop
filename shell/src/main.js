/**
 * MoonlyBox 桌面壳主进程（M4 T1，D4=Electron 定案）。
 *
 * 架构纪律（§5.15 双层）：
 * - 壳层只做「宿主」：托盘/窗口/热键/协议/更新——业务全在内核（Bun 编译的 moonlybox CLI 单文件）；
 * - 内核经 child_process spawn 通信（stdio JSONL），壳不 import 内核代码——解耦即双层更新前提；
 * - IPC 安全（Hermes Desktop 范式）：contextIsolation=true + nodeIntegration=false + preload 白名单桥；
 * - D12 内存形态：托盘常驻≠窗口常驻，关窗即销毁 renderer。
 */
const os = require('os')
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, globalShortcut, clipboard, Notification, dialog } = require('electron')
const { initUpdater } = require('./updater')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

// D12 内存优化（T6 卡7 实测偏差治理）：
// - renderer V8 老生代限堆 256MB（UI 场景足够，防单窗膨胀拖累待命基线）
// - 关 GPU shader disk cache（省磁盘写入；GPU 进程常驻为 Chromium 基线，砍掉需关硬件加速=显示性能代价，不做）
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

let tray = null
let win = null

// ---------- 内核定位：开发=仓根 bun 源；打包=resources/kernel/moonlybox 单文件 ----------
function kernelCmd() {
  // 打包态判定用 app.isPackaged（dev 下 electron 也有 resourcesPath——指向 node_modules/electron/dist，
  // 用它判断会把 dev 误判为打包态 →「内核缺失」假警报；0.5.0/0.5.1 dev 首跑即此坑）
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'kernel', process.platform === 'win32' ? 'moonlybox.exe' : 'moonlybox')
    if (fs.existsSync(exe)) return { cmd: exe, base: [] }
    // 内核缺失=打包缺陷，弹可见错误而非静默回退 'bun'（打包态无 bun，ENOENT 用户看不懂）
    const msg = `内核缺失：${exe} 不在安装包内（打包缺陷，请上报 + 附版本号）`
    dialog.showErrorBox('魔力宝盒', msg)
    app.quit()
    return { cmd: 'missing-kernel', base: [] }
  }
  // 开发态：bun 直跑仓内内核源码（cwd=REPO_ROOT）。
  // Windows PATH 坑：改 PATH 后已有进程（explorer/终端/npm 链）不刷新——终端里 bun 可用
  // 而 Electron spawn 仍 ENOENT（用户实测）。不依赖 PATH：先探测 Bun 官方默认安装路径，
  // 再退 PATH 解析，最后 which/where。
  // MOONLYBOX_BUN env 优先（bun 装在非默认位置时的逃生门）
  if (process.env.MOONLYBOX_BUN && fs.existsSync(process.env.MOONLYBOX_BUN)) {
    return { cmd: process.env.MOONLYBOX_BUN, base: ['run', 'src/cli.ts'] }
  }
  const bunExe = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const bunDefault = homeDir() ? path.join(homeDir(), '.bun', 'bin', bunExe) : null
  const bun = bunDefault && fs.existsSync(bunDefault) ? bunDefault : bunExe
  // dev 自愈：native-bindings.ts 是 gitignore 生成物（fresh clone 没有）——bun 静态 import 直接
  // 模块解析失败 → daemon「daemon exited」无解释（用户实测）。缺则自动 --gen-only（幂等）。
  const bindings = path.join(REPO_ROOT, 'src', 'lib', 'native-bindings.ts')
  if (!fs.existsSync(bindings)) {
    try {
      require('child_process').execFileSync(bun, ['run', 'scripts/build.ts', '--gen-only'], {
        cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000,
      })
    } catch {}
  }
  return { cmd: bun, base: ['run', 'src/cli.ts'] }
}

// 跨平台用户目录：Windows=USERPROFILE，unix=HOME（Windows 无 HOME，反之亦然）
function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ''
}

const REPO_ROOT = path.join(__dirname, '..', '..')

// ---------- daemon 常驻通道（stdio JSONL，协议见 src/commands/daemon.ts） ----------
let daemon = null
const pending = new Map() // id → {resolve}
let nextId = 1
const eventHooks = [] // (id, event, payload) → void（renderer 订阅）

// vault 根解析（#253 需求 6）：用户选择持久化 vault.json → 全链（daemon/采集/树）生效
function configuredVault() {
  try {
    const cfgPath = path.join(process.env.MOONLYBOX_CONFIG_HOME || path.join(os.homedir(), '.config', 'moonlybox'), 'vault.json')
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).root || null
  } catch {}
  return process.env.MOONLYBOX_VAULT || path.join(homeDir(), 'MyMoonVault')
}

function ensureDaemon() {
  if (daemon && daemon.exitCode === null) return daemon
  const { cmd, base } = kernelCmd()
  try {
    daemon = spawn(cmd, [...base, 'daemon'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MOONLYBOX_VAULT: configuredVault() },
    })
  } catch (e) {
    dialog.showErrorBox('魔力宝盒', `内核启动失败（${cmd}）：${e.message}\n\n开发模式需要 Bun 运行时：\n1) 确认已安装：dir $env:USERPROFILE\.bun\bin\bun.exe\n2) 装在别处时设环境变量 MOONLYBOX_BUN 指向 bun.exe 绝对路径\n3) 装完重开终端再 npm run dev`)
    app.quit()
    return null
  }
  daemon.on('error', (e) => {
    dialog.showErrorBox('魔力宝盒', `内核启动失败（${cmd}）：${e.message}\n\n开发模式需要 Bun 运行时：\n1) 确认已安装：dir $env:USERPROFILE\.bun\bin\bun.exe\n2) 装在别处时设环境变量 MOONLYBOX_BUN 指向 bun.exe 绝对路径\n3) 装完重开终端再 npm run dev`)
    app.quit()
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
        // P2：确认请求——daemon 把确认请求编码为 log 文本前缀（__CONFIRM_REQUEST__{json}），转独立事件给 renderer
        if (typeof msg.text === 'string' && msg.text.startsWith('__CONFIRM_REQUEST__')) {
          let payload = null
          try { payload = JSON.parse(msg.text.slice('__CONFIRM_REQUEST__'.length)) } catch {}
          eventHooks.forEach((h) => h(msg.id, 'confirm_request', payload ?? { tool: '?', args: '' }))
        } else {
          eventHooks.forEach((h) => h(msg.id, 'log', msg.text))
        }
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
    width: 1240, height: 800, show: false,
    title: '魔力宝盒',
    // #253：自绘标题栏（MDI 页帧切换+升级灯）——隐藏原生标题栏，去系统菜单栏
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // #254：云端功能区 WebView 承载 web SPA（服务端下发 manifest）
    },
  })
  Menu.setApplicationMenu(null)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // D12：关窗=真销毁 renderer（2026-09-24 T6 卡7 实测：hide 保活待命 368MB 超 D12 80-150MB 口径 2.5 倍，
  // 触发预埋的切换条件——destroy 换待命内存达标，代价=重开窗口 ~300ms 重建）
  win.on('close', () => {
    win = null
  })
  win.once('ready-to-show', () => win.show())
}

// ---------- T3a：快速采集——剪贴板文本 → 收集箱 .md（上行走 daemon sync） ----------
function inboxPath() {
  return path.join(configuredVault(), '收集箱')
}

function quickCapture(text, source = 'clipboard') {
  const dir = inboxPath()
  if (!fs.existsSync(dir)) return { ok: false, message: '收集箱不存在（先 sync init）' }
  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const name = `快速记录 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.md`
  const body = [
    '---',
    `moonlybox_capture: {source: '${source}', at: '${stamp.toISOString()}'}`,
    '---',
    '',
    text.trim(),
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, name), body, { encoding: 'utf8' })
  return { ok: true, file: name }
}

let lastClipboard = ''
let clipTimer = null
function startClipboardWatch(intervalMs = 3000) {
  if (clipTimer) return
  lastClipboard = clipboard.readText()
  clipTimer = setInterval(() => {
    try {
      const cur = clipboard.readText()
      if (cur && cur !== lastClipboard && cur.trim().length > 1) {
        lastClipboard = cur
        const r = quickCapture(cur, 'clipboard-watch')
        if (r.ok) {
          new Notification({ title: '魔力宝盒', body: `已采集到收集箱：${r.file}` }).show()
          eventHooks.forEach((h) => h(0, 'capture', r.file))
        }
      }
    } catch { /* 剪贴板读失败忽略本轮 */ }
  }, intervalMs)
}
function stopClipboardWatch() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null }
}
let clipboardWatchOn = false

// ---------- T3b：全局热键 ----------
function registerShortcuts() {
  // Alt+Shift+M：呼出/隐藏主窗口
  globalShortcut.register('Alt+Shift+M', () => {
    if (win && win.isVisible() && win.isFocused()) win.hide()
    else createWindow()
  })
  // Alt+Shift+C：剪贴板快速采集（手动触发，不受监听开关限制）
  globalShortcut.register('Alt+Shift+C', () => {
    const text = clipboard.readText()
    if (!text || !text.trim()) return
    const r = quickCapture(text, 'hotkey')
    if (r.ok) {
      new Notification({ title: '魔力宝盒', body: `已采集：${r.file}` }).show()
      eventHooks.forEach((h) => h(0, 'capture', r.file))
    }
  })
}

// ---------- T3c：moonlybox:// 协议 + 单实例 ----------
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    createWindow()
    // 二次启动带 moonlybox:// 链接 → 处理
    const url = argv.find((a) => a.startsWith('moonlybox://'))
    if (url) handleMoonlinkUrl(url)
  })
}

function handleMoonlinkUrl(url) {
  // moonlybox://open | moonlybox://capture?text=... | moonlybox://search?q=...
  try {
    const u = new URL(url)
    const action = u.host  // moonlybox://capture?text=... → host='capture'
    if (action === 'capture') {
      const text = u.searchParams.get('text') || ''
      if (text.trim()) quickCapture(decodeURIComponent(text), 'protocol')
    }
    createWindow()
  } catch { createWindow() }
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
  // ---------- #253：自绘标题栏窗口控制 + vault 目录选择 + vault 文件树（沙箱内） ----------
  ipcMain.handle('win:min', () => win?.minimize())
  ipcMain.handle('win:max', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize() })
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('upgrade:click', () => { /* renderer 点升级灯：触发检查更新 */ try { require('./updater').checkNow?.() } catch {} return win?.webContents.send('shell:updateReady', {}) })

  ipcMain.handle('vault:get', () => configuredVault())
  ipcMain.handle('vault:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择书房（本地 vault）目录' })
    if (r.canceled || !r.filePaths?.[0]) return { ok: false }
    const root = r.filePaths[0]
    const cfgDir = process.env.MOONLYBOX_CONFIG_HOME || path.join(os.homedir(), '.config', 'moonlybox')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'vault.json'), JSON.stringify({ root }, null, 2) + '\n')
    // 全链生效：daemon env + 采集路径
    process.env.MOONLYBOX_VAULT = root
    return { ok: true, root }
  })
  ipcMain.handle('fs:list', (_e, rel) => {
    // 沙箱：只允许列 vault 根内目录（防路径逃逸）
    const root = configuredVault()
    if (!root || !fs.existsSync(root)) return { ok: false, message: '未选择 vault 目录' }
    const abs = path.resolve(root, String(rel || '.'))
    if (!abs.startsWith(path.resolve(root))) return { ok: false, message: '路径越界' }
    try {
      const items = fs.readdirSync(abs, { withFileTypes: true })
        .filter((x) => !x.name.startsWith('.'))
        .map((x) => ({ name: x.name, dir: x.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'))
      return { ok: true, items }
    } catch (e) { return { ok: false, message: String(e.message ?? e) } }
  })
  ipcMain.handle('fs:write', (_e, rel, content) => {
    const root = configuredVault()
    if (!root) return { ok: false, message: '未选择 vault 目录' }
    const abs = path.resolve(root, String(rel || ''))
    if (!abs.startsWith(path.resolve(root))) return { ok: false, message: '路径越界' }
    try { fs.writeFileSync(abs, String(content ?? '')); return { ok: true } } catch (e) { return { ok: false, message: String(e.message ?? e) } }
  })
  ipcMain.handle('fs:read', (_e, rel) => {
    const root = configuredVault()
    if (!root) return { ok: false, message: '未选择 vault 目录' }
    const abs = path.resolve(root, String(rel || ''))
    if (!abs.startsWith(path.resolve(root))) return { ok: false, message: '路径越界' }
    try { return { ok: true, content: fs.readFileSync(abs, 'utf8') } } catch (e) { return { ok: false, message: String(e.message ?? e) } }
  })

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
  // P2：UI 确认制——renderer 确认/取消按钮回传 → daemon stdin confirm_response（同 rpcId）
  ipcMain.handle('kernel:confirmResponse', (_e, { rpcId, value }) => {
    if (daemon && daemon.stdin.writable) {
      daemon.stdin.write(JSON.stringify({ id: rpcId, cmd: 'confirm_response', args: { value: !!value } }) + '\n')
      return true
    }
    return false
  })
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  // 剪贴板监听开关（默认关，隐私敏感）
  ipcMain.handle('shell:clipboardWatch', (_e, on) => {
    clipboardWatchOn = !!on
    if (on) startClipboardWatch()
    else stopClipboardWatch()
    return clipboardWatchOn
  })
  ipcMain.handle('shell:capture', (_e, text) => quickCapture(String(text ?? ''), 'renderer'))
  ipcMain.handle('shell:protocolState', () => ({
    isDefault: app.isDefaultProtocolClient('moonlybox'),
  }))
  // 版本双轨（§5.15.3：壳版本/内核版本，关于页双版本可见）
  ipcMain.handle('shell:versions', async () => {
    // dev 态 app.getVersion() 返回 electron 版本——显式读 package.json（打包态两者一致）
    const shellVersion = (require(path.join(__dirname, '..', 'package.json')) || {}).version || app.getVersion()
    let kernelVersion = 'unknown'
    try {
      const { cmd, base } = kernelCmd()
      const out = await new Promise((resolve) => {
        let o = ''
        let p
        try {
          p = spawn(cmd, [...base, '--help'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        } catch {
          return resolve('')
        }
        p.on('error', () => resolve('')) // dev 无 bun：内核版本 unknown，不裸崩
        p.stdout.on('data', (d) => { o += d })
        p.on('close', () => resolve(o))
        setTimeout(() => resolve(o), 5000)
      })
      const m = out.match(/moonlybox v([0-9.]+)/)
      if (m) kernelVersion = m[1]
    } catch { /* daemon 未起也允许查 */ }
    return { shellVersion, kernelVersion }
  })

  initUpdater(() => win)

  registerShortcuts()
  if (!app.isDefaultProtocolClient('moonlybox')) {
    // 开发态也注册（失败不影响启动）
    try { app.setAsDefaultProtocolClient('moonlybox') } catch { /* 权限不足时静默 */ }
  }
  // 命令行/首次启动带 moonlybox:// 链接
  const launchUrl = process.argv.find((a) => a.startsWith('moonlybox://'))
  if (launchUrl) handleMoonlinkUrl(launchUrl)

  createWindow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopClipboardWatch()
})

app.on('window-all-closed', () => { /* 托盘常驻 */ })
