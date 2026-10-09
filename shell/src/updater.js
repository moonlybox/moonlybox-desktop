/**
 * T4：自动更新（electron-updater generic provider → moonlybox.cn/updates/desktop/）。
 * §5.15.2 纪律：未签名阶段警告如实告知；更新动作进关于页版本历史（原则⑥透明）。
 * 更新失败静默（无网/离线场景不骚扰），成功后提示重启安装。
 */
const { autoUpdater } = require('electron-updater')
const { Notification, ipcMain } = require('electron')

let updateState = { checking: false, available: false, version: null, error: null, downloaded: false }
let autoUpdateEnabled = true // #310.7：自动更新开关（设置-帮助；关=不自动下载，仅手动检查）

function initUpdater(getMainWindow) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => { updateState = { ...updateState, checking: true, error: null } })
  autoUpdater.on('update-available', (info) => {
    updateState = { checking: false, available: true, version: info.version, error: null, downloaded: false }
    new Notification({ title: '魔力宝盒', body: `发现新版本 v${info.version}，后台下载中…` }).show()
  })
  autoUpdater.on('update-not-available', () => {
    updateState = { checking: false, available: false, version: null, error: null, downloaded: false }
  })
  autoUpdater.on('error', (e) => {
    // 静默：未签名/无网/离线场景不弹窗，仅记录状态（关于页可查）
    updateState = { ...updateState, checking: false, error: String(e && e.message || e) }
  })
  autoUpdater.on('download-progress', (p) => {
    updateState.progress = Math.round(p.percent)
    updateState.available = true
    updateState.checking = false
    const w = getMainWindow()
    if (w && !w.isDestroyed()) w.webContents.send('shell:updateProgress', { percent: updateState.progress })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateState.downloaded = true
    updateState.progress = 100
    new Notification({
      title: '魔力宝盒',
      body: `v${info.version} 已就绪，重启应用后生效`,
    }).show()
    const w = getMainWindow()
    if (w && !w.isDestroyed()) w.webContents.send('shell:updateReady', { version: info.version })
  })

  // 启动后 30s 首查，之后每 4h（#310.7：自动更新关=不自动查/下载，只保留手动检查）
  setTimeout(() => { if (autoUpdateEnabled) autoUpdater.checkForUpdates().catch(() => {}) }, 30_000)
  setInterval(() => { if (autoUpdateEnabled) autoUpdater.checkForUpdates().catch(() => {}) }, 4 * 3600 * 1000)

  // IPC：关于页手动检查/取状态/重启安装
  ipcMain.handle('shell:updateCheck', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      // autoDownload=true 时 result.downloadPromise 是 floating promise——显式接住下载失败（否则主进程 unhandledRejection，
      // 渲染层关于页在 available 分支渲染进度条期间可能观察到未处理 rejection 报错）
      const dp = result?.downloadPromise
      if (dp && typeof dp.catch === 'function') {
        dp.catch(() => {
          updateState = { ...updateState, checking: false, available: true, error: 'download-failed' }
        })
      }
    } catch { /* 静默：网络抖动等，updateState.error 由 error 事件写入 */ }
    return updateState
  })
  ipcMain.handle('shell:updateState', () => updateState)
  ipcMain.handle('shell:updateInstall', () => { autoUpdater.quitAndInstall() })
  // #310.7：自动更新开关（关=不自动查/下载；手动检查仍可用）
  ipcMain.handle('shell:setAutoUpdate', (_e, on) => {
    autoUpdateEnabled = !!on
    autoUpdater.autoDownload = !!on
    autoUpdater.autoInstallOnAppQuit = !!on
    return true
  })
  // 「有新版本时自动下载」独立开关（只控 autoDownload，不影响检查）
  ipcMain.handle('shell:setAutoDownload', (_e, on) => {
    autoUpdater.autoDownload = !!on
    return true
  })
  // 下载缓存信息（问题5：目录/大小，供设置页展示与清理）
  ipcMain.handle('shell:updateCacheInfo', async () => {
    try {
      const { path: ppath } = require('path')
      const cacheDir = updateCacheDir()
      const fsp = require('fs').promises
      let bytes = 0; let files = 0
      try {
        const names = await fsp.readdir(cacheDir)
        for (const n of names) {
          try { const st = await fsp.stat(ppath.join(cacheDir, n)); if (st.isFile()) { bytes += st.size; files++ } } catch {}
        }
      } catch {}
      return { dir: cacheDir, bytes, files }
    } catch { return { dir: '', bytes: 0, files: 0 } }
  })
  ipcMain.handle('shell:cleanUpdateCache', async () => {
    try {
      const { path: ppath } = require('path')
      const cacheDir = updateCacheDir()
      const fsp = require('fs').promises
      const names = await fsp.readdir(cacheDir).catch(() => [])
      for (const n of names) { try { await fsp.rm(ppath.join(cacheDir, n), { recursive: true, force: true }) } catch {} }
      return { ok: true }
    } catch (e) { return { ok: false, message: String(e?.message ?? e) }
    }
  })
}

function updateCacheDir() {
  const { path: ppath } = require('path')
  const { os } = (() => { try { return { os: require('os') } } catch { return { os: null } } })()
  let base
  try {
    if (process.platform === 'win32') base = process.env.LOCALAPPDATA || ppath.join(os.homedir(), 'AppData', 'Local')
    else if (process.platform === 'darwin') base = ppath.join(os.homedir(), 'Library', 'Caches')
    else base = process.env.XDG_CACHE_HOME || ppath.join(os.homedir(), '.cache')
  } catch { base = process.env.TEMP || '.' }
  let dirName = null
  // updaterCacheDirName 实际值从 app-update.yml 读（构建生成 <name>-updater）；读不到则按惯例兜底
  try {
    const fs = require('fs')
    const ymlPath = ppath.join(process.resourcesPath || '', 'app-update.yml')
    if (fs.existsSync(ymlPath)) {
      const m = fs.readFileSync(ymlPath, 'utf8').match(/updaterCacheDirName:\s*(\S+)/)
      if (m) dirName = m[1]
    }
  } catch {}
  if (!dirName) dirName = 'moonlybox-updater'
  return ppath.join(base, dirName, 'pending')
}

function setAutoDownloadEnabled(on) {
  try { autoUpdater.autoDownload = !!on } catch {}
}

module.exports = { initUpdater, updateState, setAutoDownloadEnabled, get autoUpdateEnabled() { return autoUpdateEnabled } }
