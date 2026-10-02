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

// ---------- #256 设置（main 侧轻量直读 ~/.config/moonlybox/settings.json——启动早期就要用，不经 daemon） ----------
function readSettings() {
  const cfgDir = process.env.MOONLYBOX_CONFIG_HOME || path.join(os.homedir(), '.config', 'moonlybox')
  try {
    return JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'))
  } catch { return {} }
}
// 开机启动（#256.1）：loginItemSettings 按 closeToTray/launchMinimized 语义统一 openAsHidden
function applyLaunchAtLogin() {
  try {
    const s = (readSettings().general) || {}
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, openAsHidden: !!s.launchAtLogin })
    }
    return { launchAtLogin: !!s.launchAtLogin, applied: app.isPackaged ? 'loginItemSettings' : 'dev-跳过（仅打包态生效）' }
  } catch (e) { return { error: String(e.message ?? e) } }
}
// 关闭行为（#256.1/#268）：closeToTray 默认 true → close 事件拦截为 hide（托盘常驻）；false → 真退出
let closeToTrayOn = false
let silentLaunch = false // #267：静默启动态（托盘保活依据之一）
// keepAwake（#256.1）：powerSaveBlocker 阻止系统休眠（运行任务期间）
let psbId = null
function setKeepAwake(on) {
  const { powerSaveBlocker } = require('electron')
  if (on && psbId === null) psbId = powerSaveBlocker.start('prevent-app-suspension')
  else if (!on && psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null }
  return psbId !== null
}

// ---------- 内核定位：开发=仓根 bun 源；打包=resources/kernel/moonlybox 单文件 ----------
// #310.11：Ollama HTTP 探测（/api/version）——服务在跑即返回版本
async function probeOllamaHttp() {
  const base = process.env.MOONLYBOX_OLLAMA_URL || 'http://127.0.0.1:11434'
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 1200)
  try {
    const res = await fetch(base + '/api/version', { signal: ctl.signal })
    if (!res.ok) return null
    const j = await res.json().catch(() => null)
    return j && j.version ? { version: String(j.version) } : null
  } finally {
    clearTimeout(t)
  }
}
// #310.11：Ollama CLI 三级探测（官方默认路径→MOONLYBOX_OLLAMA env→PATH 解析）——kernelCmd 同款范式
function findOllamaCli() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  const defaults = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
        path.join(process.env['ProgramFiles'] || '', 'Ollama', 'ollama.exe'),
      ]
    : ['/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama', path.join(homeDir(), '.local', 'bin', 'ollama')]
  for (const p of defaults) {
    if (p && fs.existsSync(p)) return p
  }
  if (process.env.MOONLYBOX_OLLAMA && fs.existsSync(process.env.MOONLYBOX_OLLAMA)) return process.env.MOONLYBOX_OLLAMA
  try {
    const hit = require('child_process').execFileSync(process.platform === 'win32' ? 'where' : 'which', [exe], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split(/\r?\n/)[0].trim()
    return hit || null
  } catch {
    return null
  }
}
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
  // dev 自愈：native-bindings.ts 与 assets/ort-binding.blob 都是 gitignore 生成物（fresh clone 没有）
  // ——bun 静态 import 失败 → daemon exit(1)。任一缺失即重跑 gen-only（幂等；只查 ts 会漏 blob——
  // 旧版自愈先跑过时 ts 已在而 blob 缺，daemon 持续崩，用户实测踩坑）。
  const bindings = path.join(REPO_ROOT, 'src', 'lib', 'native-bindings.ts')
  const blob = path.join(REPO_ROOT, 'assets', 'ort-binding.blob')
  if (!fs.existsSync(bindings) || !fs.existsSync(blob)) {
    try {
      require('child_process').execFileSync(bun, ['run', 'scripts/build.ts', '--gen-only'], {
        cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000,
      })
    } catch (e) {
      // 自愈失败必须可见（静默=daemon 照崩且用户无从得知原因——#253.11 后仍崩的教训）
      const detail = e && e.stderr ? e.stderr.toString().slice(-300) : String(e && e.message ? e.message : e)
      dialog.showErrorBox('魔力宝盒', `开发环境自愈失败（bun run scripts/build.ts --gen-only）：\n${detail}\n\n请在仓库根手动执行并检查输出：\n  bun run scripts/build.ts --gen-only`)
    }
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
  let stderrTail = ''
  daemon.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
    eventHooks.forEach((h) => h(0, 'stderr', d.toString()))
  })
  daemon.on('exit', (code) => {
    daemon = null
    const tail = stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
    const msg = `daemon exited (${code})${tail ? '：' + tail : ''}`
    pending.forEach((p) => p({ event: 'error', message: msg }))
    pending.clear()
  })
  return daemon
}

/** RPC：返回 Promise<done/error 消息>；过程行经 onKernelEvent 订阅。 */
function kernelRpc(cmd, args = {}, timeoutMs = 120_000) {
  ensureDaemon()
  const id = nextId++
  // #317.F2：广播 rpc-start（带 id+cmd）——renderer 门控 xiaoyue 活动流行（旧 RPC 的迟到行不再串扰新会话视图）
  try { if (win && !win.isDestroyed()) win.webContents.send('kernel:event', { id, event: 'rpc-start', payload: cmd }) } catch {}
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
  // #253.28：窗口状态变化推 renderer（最大化按钮切「最大化/还原」图标）——绑定在 createWindow 内（win 就绪）
  const pushWinState = () => { try { win?.webContents.send('shell:winState', { maximized: win.isMaximized() }) } catch {} }
  win.on('maximize', pushWinState)
  win.on('unmaximize', pushWinState)
  // D12：关窗=真销毁 renderer（2026-09-24 T6 卡7 实测：hide 保活待命 368MB 超 D12 80-150MB 口径 2.5 倍，
  // 触发预埋的切换条件——destroy 换待命内存达标，代价=重开窗口 ~300ms 重建）
  // #256.1：closeToTray=true 时 close 拦截为 hide（托盘常驻）——优先级高于 D12（用户显式选择保活）
  win.on('close', (e) => {
    if (closeToTrayOn && !app.isQuiting) {
      e.preventDefault()
      win.hide()
      return
    }
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

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEbUlEQVR42sWXXWxURRTHfzNzd1m27XbLR1ugLFtoSwGBrUEiQUUwih/RliggYGJfTDSGGOXFRx59U16MJhp5MREicR/Q+BFADB8aNCwYQ0uh37SlhdJtS7u79M7xoRV4ML23SQv/yXmZe+bMmTPn/M8dxX1IJOqjuWHeA+oQEkwnFCkgGcznQCp1cODe9ARWVdbXY+VjgSgzCAUDaPX+P00HDwIYgFXL6uutla8EQswwBEIi1JXMqWnru5VKqUSiPpobtC0zffL/i0QwosvNnPCaDwV5fqoGtFIorVBKoQBBpmoiZLNkHRFq/SxduCCfru5hjDYopdFK38sgASUWEYtr3ak4UasFmwBhMtn0ZIxPD7zAlk3lGGNwjIMxDqFgHo4JYIwzMTf+rap6CV42x2NmE44fN3871c7oiEvq7xsEndk8uvw5lpSuJuCEMCZI941GTl/8lkxuhLXrlrGmppKmxjZEvGOrlpfv8dRyjMHoAOHZEV55ei8NrWdp724kkxkGIFpYzLOPv8nhHz8ieydDOC9IOp1mzPW+Do0Ik4kCFJpQMI/tL+4jeewTLjf/SS47SlFRIeG8MIODN/n59JfUbd2LRnN7KINCj6eIh33tGSI1nulPbdzGr38cQqHR2uHtD15FoXGzgtEOQ7fTdPVdZmn56rtrlFLeERAmH0qBKEW8vIp0updIpIhnXnqMxfFiMiMuxgTQWqO1ZkyyzJtXAkohSo2v9RjaR7ISiUTpH+omkx1l5+53KS4pYn5JEeH80ASbKwIBh9HMEE7Q+CmAu6I9S0WEoYF+AiGDYOnsauSvs03kF4TYt38H1asXUbO+gvzILOYvKKGv/xpgJ3jB2wMzJ7pqvxd7V1bHCYULQODqlUts2LyVr784TNmSYuIVpZw/10C8cg0mYDh3+iSuuFjr4toxT4b0TEIrQl7BbH4/c4K1G9bT19vDse+T1GzcQmsbNLe4PLJuI6OZYX45+t345uJisVg/PFAZ2+GppbXG0QEihUXseectjn5zhIGb/ZTFyzGOpre7h3R/P66d2NwdY8zewVo7PQ4AGG0w2qE0VsbLu1/DcRzamlq4eO481zu6EGuxuFh3PPR+e4KqiG33dGBWKEQoHGJoYBCtHLTWLIrHWBxfTGdbB9daOxGxWGuxMkZBNEJmJEM2k/HBhD5qpWJlFbVv7JxIrByum6Oj+SpnTpykvbkZ183iujlcm8Nal9o9O6hcWeWrDp0ptXEBEcHF9aXrx7bj50fifuby6advfc1DhoOPWr3e2UVsaZwFZQs9G4yIEFsW54dDR/BjWy0t2+YrrvGqCp7YuoV5xSWT6t3ovc6pn47TevmKvzL068BMQYNcmFL7ml654ABJEdY+jNMrRVIl4nXR9BitiBQ+4N3ThQ5x0zPQkJlbWN0jInUP9O612nWpPZkyALcGG1LRyIo2YDMyw+9DpdJovaulI5m8+zgFGBhqSEXnrvgMV7IoKQJKp/kxeAHU5wT1663tydR/0/8CK0dxAWA3M5IAAAAASUVORK5CYII=' // 涌月漩 32px（brand/client/windows/moonlybox-32x32.png 内联——托盘需运行时可用，无文件 IO）

// #267：托盘按需创建——closeToTray（#268 默认 true）开启或静默启动（launchMinimized 无窗可点）时创建；
// 用户显式关闭后关窗=退出应用，不留托盘
function ensureTray() {
  if (tray) return
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
}
function destroyTray() {
  if (!tray) return
  tray.destroy()
  tray = null
}

app.whenReady().then(() => {
  // 托盘初始创建在启动设置读取后决定（见下方通用设置应用段）

  // IPC 白名单（preload 对应）
  // daemon RPC：{cmd:'xiaoyue', args:{q}} → 过程行推 renderer，done 返回全文
  // ---------- #253：自绘标题栏窗口控制 + vault 目录选择 + vault 文件树（沙箱内） ----------
  ipcMain.handle('win:min', () => win?.minimize())
  ipcMain.handle('win:max', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize() })
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('upgrade:click', () => { /* renderer 点升级灯：触发检查更新 */ try { require('./updater').checkNow?.() } catch {} return win?.webContents.send('shell:updateReady', {}) })

  ipcMain.handle('vault:get', () => configuredVault())
  // #257 通用目录选择（不落 vault 配置——备份目录等场景）
  ipcMain.handle('shell:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择目录' })
    if (r.canceled || !r.filePaths?.[0]) return { ok: false }
    return { ok: true, path: r.filePaths[0] }
  })
  // #310.3：打开本机目录/文件（技能目录等）
  ipcMain.handle('shell:openPath', async (_e, p) => {
    try { return await shell.openPath(String(p || '')) } catch (e) { return String(e?.message ?? e) }
  })
  // #310.7：调试日志——debug.enabled 时 daemon stdout 全量镜像落 userData/mb-debug.log；导出=打开日志目录
  ipcMain.handle('shell:debugLog', (_e, line) => {
    try {
      const fs = require('fs')
      const dir = app.getPath('userData')
      if (!fs.existsSync(dir)) return
      fs.appendFileSync(path.join(dir, 'mb-debug.log'), `[${new Date().toISOString()}] ${String(line ?? '')}\n`)
    } catch {}
  })
  ipcMain.handle('shell:openLogDir', async () => {
    try {
      const dir = app.getPath('userData')
      await shell.openPath(dir)
      return ''
    } catch (e) { return String(e?.message ?? e) }
  })
  ipcMain.handle('shell:envInfo', () => ({
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    locale: app.getLocale(),
  }))
  // #307：原生模态确认框（替换 renderer window.confirm——同步阻塞弄脏焦点系统）
  ipcMain.handle('shell:confirmBox', async (_e, { message, title }) => {
    if (!win) return false
    const r = await dialog.showMessageBox(win, {
      type: 'question', message: String(message || ''), title: String(title || '魔力宝盒'),
      buttons: ['取消', '确定'], defaultId: 1, cancelId: 0, noLink: true,
    })
    return r.response === 1
  })
  // #310.10：书房迁移——老目录内容整体复制到新目录（目标已存在任何内容=阻断，不支持覆盖）；完成后写 vault.json+env+重启内核
  ipcMain.handle('vault:migrate', async (_e, target) => {
    const from = configuredVault()
    const to = String(target || '').trim()
    if (!from) return { ok: false, message: '当前未配置书房目录' }
    if (!to) return { ok: false, message: '目标目录为空' }
    const absTo = path.resolve(to)
    if (absTo === path.resolve(from)) return { ok: false, message: '目标目录与当前目录相同' }
    if (absTo.startsWith(path.resolve(from) + path.sep) || path.resolve(from).startsWith(absTo + path.sep)) return { ok: false, message: '目标目录不能是当前目录的子/父目录' }
    try {
      if (fs.existsSync(absTo)) {
        const entries = fs.readdirSync(absTo)
        if (entries.length) return { ok: false, message: `目标目录已存在且非空（${entries.length} 项）——不支持覆盖迁移，请选择空目录` }
      }
      fs.mkdirSync(absTo, { recursive: true })
      fs.cpSync(from, absTo, { recursive: true, verbatimSymlinks: false })
      const copied = fs.readdirSync(absTo)
      if (!copied.length) return { ok: false, message: '迁移后新目录为空——源目录可能不可读' }
      const cfgDir = process.env.MOONLYBOX_CONFIG_HOME || path.join(os.homedir(), '.config', 'moonlybox')
      fs.mkdirSync(cfgDir, { recursive: true })
      fs.writeFileSync(path.join(cfgDir, 'vault.json'), JSON.stringify({ root: absTo }, null, 2) + '\n')
      process.env.MOONLYBOX_VAULT = absTo
      // 内核重启：杀旧 daemon（下次 RPC ensureDaemon 以新 env 拉起）
      try { if (daemon && daemon.exitCode === null) daemon.kill() } catch {}
      return { ok: true, root: absTo, files: copied.length }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  })
  // #310.11：Ollama 四态探测（服务在跑/装了没跑/没装/失效修复由 renderer 侧对话失败触发）
  ipcMain.handle('ollama:probe', async (_e, cliOverride) => {
    const running = await probeOllamaHttp().catch(() => null)
    if (running && running.version) {
      // #317.F15：running 态顺带读运行时 context（/api/ps 首个已加载模型；未加载=null——renderer 据此提示）
      let context = null
      try {
        const base = process.env.MOONLYBOX_OLLAMA_URL || 'http://127.0.0.1:11434'
        const ps = await fetch(base + '/api/ps', { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
        context = ps?.models?.[0]?.context ?? null
      } catch {}
      return { state: 'running', version: running.version, context }
    }
    // #310.12：手工定位的 cli 优先（renderer 从 settings.general.ollamaCli 读出传入）
    const cli = (cliOverride && fs.existsSync(cliOverride)) ? cliOverride : findOllamaCli()
    if (!cli) return { state: 'not_found' }
    let version = null
    try {
      // #317.F16/P3e：版本号提纯——新版 ollama CLI --version 会在 stdout 先打「Warning: could not connect...」
      // 等诊断行（探活失败），直接 trim 会把警告一起带给 UI；只取 x.y.z
      version = (require('child_process').execFileSync(cli, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().match(/(\d+\.\d+\.\d+)/) ?? [''])[1] || '未知'
    } catch {}
    return { state: 'installed_stopped', cli, version }
  })
  // #310.12：手工定位 Ollama 可执行文件——文件选择框 + --version 校验（不落盘，存储走 renderer settings.general.ollamaCli）
  ipcMain.handle('ollama:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '定位 Ollama 可执行文件',
      filters: process.platform === 'win32' ? [{ name: 'ollama.exe', extensions: ['exe'] }] : undefined,
    })
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true }
    const cli = r.filePaths[0]
    try {
      const version = require('child_process').execFileSync(cli, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim()
      if (!version) return { ok: false, error: '校验失败（无版本输出）' }
      return { ok: true, cli, version }
    } catch (e) {
      return { ok: false, error: '所选文件不是可用的 Ollama：' + String(e && e.message ? e.message.split('\n')[0] : e) }
    }
  })
  // #310.13：唤起系统终端执行 ollama pull——过程用户完全可见，终端不自动关（win: cmd /k；mac: Terminal do script；linux: bash -c 尾 exec bash）
  ipcMain.handle('ollama:pullTerm', async (_e, payload) => {
    const cli = String(payload?.cli || findOllamaCli() || 'ollama')
    const model = String(payload?.model || '').trim()
    if (!/^[A-Za-z0-9._:\/-]+$/.test(model)) return { ok: false, error: '模型名不合法' }
    const cp = require('child_process')
    try {
      if (process.platform === 'win32') {
        // start 新窗口标题占位；/k 执行后保留窗口
        cp.spawn('cmd.exe', ['/c', 'start', 'Ollama pull', 'cmd', '/k', cli, 'pull', model], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      } else if (process.platform === 'darwin') {
        const script = `tell application "Terminal"\n  do script ${JSON.stringify(`${JSON.stringify(cli)} pull ${JSON.stringify(model)}`)}\n  activate\nend tell`
        cp.spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      } else {
        const inner = `${JSON.stringify(cli)} pull ${JSON.stringify(model)}; exec bash`
        const candidates = [
          ['gnome-terminal', ['--', 'bash', '-c', inner]],
          ['konsole', ['-e', 'bash', '-c', inner]],
          ['xterm', ['-e', 'bash', '-c', inner]],
        ]
        const hit = candidates.find(([bin]) => {
          try { cp.execFileSync('which', [bin], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); return true } catch { return false }
        })
        if (!hit) return { ok: false, error: '未找到系统终端（gnome-terminal/konsole/xterm）' }
        cp.spawn(hit[0], hit[1], { detached: true, stdio: 'ignore' }).unref()
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  })
  // #310.13.5：主进程代理 /api/tags（renderer 直连 fetch 会被 Ollama CORS 白名单拦——origin 非 localhost）
  ipcMain.handle('ollama:tags', async () => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3000)
      const res = await fetch((process.env.MOONLYBOX_OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/tags', { signal: ctl.signal })
      clearTimeout(t)
      if (!res.ok) return { ok: false }
      return { ok: true, tags: await res.json() }
    } catch { return { ok: false } }
  })
  // #310.11：启动系统级 Ollama 服务（spawn 分离，不随应用退出被杀）
  // #310.16：Windows 弹窗根因修复——detached:true（DETACHED_PROCESS）使 serve 无 console，
  // Ollama 启动时 spawn 的 runner 探测子进程（GPU 发现，日志可见数个 starting runner）各自新建可见 console=「连续数个弹窗」。
  // 改：win32 去 detached（保留 CREATE_NO_WINDOW 隐藏 console，runner 继承之无窗）；Unix 保留 detached（SIGHUP 隔离）。
  // Windows 下 Electron 父退出不会级联杀子进程，serve 存活不受影响。
  ipcMain.handle('ollama:serve', async (_e, cli) => {
    try {
      const isWin = process.platform === 'win32'
      // #317.F4：脱离客户端生命周期独立存活（否则客户端退出连带杀掉 ollama serve，每次重启都「服务未运行」）
      // Windows：detached=true 会以 DETACHED_PROCESS 启动——ollama.exe（console 程序）自行 AllocConsole 弹黑窗，
      // windowsHide 对 detached 无效（libuv 行为）。改走 `cmd /c start /b`：无窗口+父退出不回收；引号路径安全由 cmd start 处理。
      // #317.F15：启动即带上下文默认值——Ollama 默认 num_ctx=4096 静默截断超长 prompt（29 工具 schema
      // ≈4.2k token + system 必超），/v1 端点又不接受 options.num_ctx（运行时无救）→ 只能在 serve 层解决。
      // 档位按物理内存自适应（F15b 用户定案：不硬编码）——KV 缓存≈147KB/token(qwen3:4b fp16)：
      //   ≥14G→32768(KV≈4.7G) / ≥7G→16384(≈2.4G) / ≥3.5G→8192(≈1.2G，工具表 4.2k+system 刚好放下) / 否则不覆盖
      const gb = (os.totalmem?.() ?? 0) / 2 ** 30
      const ctxLen = gb >= 14 ? 32768 : gb >= 7 ? 16384 : gb >= 3.5 ? 8192 : null
      const serveEnv = { ...process.env, ...(ctxLen ? { OLLAMA_CONTEXT_LENGTH: String(ctxLen) } : {}) }
      // #317.F16/P3d：serve 失败可见化——stdio:ignore 下启动失败无任何线索（真机：用户启动失败无日志可查）。
      // 输出重定向到日志文件，失败时把尾部读给用户。
      // #317.F16/P3g：Windows 回退 F4b 纯净 start /b——P3d 的 `> log 2>&1` 重定向在 start /b 语义下
      // 作用于 cmd 外层而非 ollama 进程，且可能干扰 console 程序输出（真机 0.32.14 启动回归）。
      // 失败可见性改读 Ollama 自身日志（%LOCALAPPDATA%\Ollama\server.log）。
      const winLog = path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'server.log')
      const logFile = isWin ? winLog : path.join(os.tmpdir(), 'moonlybox-ollama-serve.log')
      if (isWin) {
        // #317.F16/P3i：start /b 在真机 0.32.14 失效（手动 PowerShell serve 可起=start /b 无 console 环境
        // 与新版 ollama 不兼容；F4 时代成功=旧版行为）。改 powershell Start-Process -WindowStyle Hidden：
        // 真隐藏窗+独立于客户端+运行环境最接近手动 PowerShell（用户实证可行）。
        // 引号：-FilePath/-ArgumentList 路径含空格由内层引号处理；ps 命令串整体经 -Command 传递。
        const ps = `Start-Process -FilePath '${cli.replace(/'/g, "''")}' -ArgumentList 'serve' -WindowStyle Hidden`
        const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, shell: false, env: serveEnv })
        child.unref()
      } else {
        const out = fs.openSync(logFile, 'a')
        const child = require('child_process').spawn(cli, ['serve'], { detached: true, stdio: ['ignore', out, out], env: serveEnv })
        child.unref()
      }
      // 等 HTTP 就绪（最多 8s）——记录探测历程，失败时给用户可行动的线索而非空白
      const probeLog = []
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const v = await probeOllamaHttp().catch((e) => ({ err: String(e && e.message ? e.message : e).slice(0, 60) }))
        if (v && v.version) return { ok: true, version: v.version, contextLength: ctxLen ?? null }
        if (i % 4 === 0) probeLog.push(v && v.err ? `#${i}:${v.err}` : `#${i}:无响应`)
      }
      // 日志尾（Win=Ollama 自身 server.log；Unix=自落日志）低位读，不整读大文件
      let tail = ''
      try {
        const st = fs.statSync(logFile)
        const fd = fs.openSync(logFile, 'r')
        const buf = Buffer.alloc(Math.min(400, st.size))
        fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - 400))
        fs.closeSync(fd)
        tail = buf.toString('utf-8')
      } catch {}
      const cmdHint = isWin ? `手动复现（PowerShell）："${cli}" serve` : `手动复现：${cli} serve`
      return { ok: false, error: `启动超时（${probeLog.join(' ')}）${tail ? '——日志：' + tail.replace(/\s+/g, ' ').slice(-200) : ''}。${cmdHint}` }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  })
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
    // #280.3：同 sender 去重——重复 subscribe 会把同一 webContents 推 N 份 kernel:event
    if (eventHooks.some((h) => h.sender === e.sender)) return
    const hook = (id, event, payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('kernel:event', { id, event, payload })
    }
    hook.sender = e.sender
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
  // #256.1：设置保存后 main 侧行为同步（closeToTray/keepAwake/clipboardWatch/login 项）——daemon 管 settings.json，main 只收行为
  ipcMain.handle('shell:applyGeneral', (_e, general) => {
    const g = general || {}
    // #268：默认 true（renderer 落盘后字段必在，此处兜底仅防异常调用）
    closeToTrayOn = g.closeToTray === undefined ? true : !!g.closeToTray
    // #267 托盘跟随开关实时增减
    if (closeToTrayOn) ensureTray()
    else if (!silentLaunch) destroyTray()
    setKeepAwake(!!g.keepAwake)
    if (g.clipboardWatch && !clipboardWatchOn) { clipboardWatchOn = true; startClipboardWatch() }
    else if (!g.clipboardWatch && clipboardWatchOn) { clipboardWatchOn = false; stopClipboardWatch() }
    return applyLaunchAtLogin()
  })
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

  // #256.1：应用通用设置（开机启动/关闭到托盘/保持唤醒/剪贴板监听）——createWindow 前定行为
  try {
    const st = readSettings()
    const g = st.general || {}
    applyLaunchAtLogin()
    // #268：closeToTray 默认 true（与 settings.ts DEFAULTS 对齐）——settings.json 缺字段/首次安装时 undefined→true
    closeToTrayOn = g.closeToTray === undefined ? true : !!g.closeToTray
    if (g.keepAwake) setKeepAwake(true)
    if (g.clipboardWatch) { clipboardWatchOn = true; startClipboardWatch() }
    // 启动时最小化到托盘：命令行/协议唤起（带参数）除外，静默启动不弹窗
    const silent = !!g.launchMinimized && !launchUrl && !process.argv.slice(1).some((a) => !a.startsWith('-'))
    silentLaunch = silent
    // #267 托盘按需：静默启动（无窗可点必须有托盘唤回）或 closeToTray 开启
    if (silent || closeToTrayOn) ensureTray()
    if (!silent) createWindow()
  } catch { createWindow() }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopClipboardWatch()
})

// #267：默认（closeToTray=false）关窗=退出应用（托盘不残留）；closeToTray=true 时窗口只 hide 不销毁，本事件不触发
app.on('window-all-closed', () => {
  if (!closeToTrayOn) app.quit()
})
