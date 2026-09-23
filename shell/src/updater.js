/**
 * T4：自动更新（electron-updater generic provider → moonlybox.cn/updates/desktop/）。
 * §5.15.2 纪律：未签名阶段警告如实告知；更新动作进关于页版本历史（原则⑥透明）。
 * 更新失败静默（无网/离线场景不骚扰），成功后提示重启安装。
 */
const { autoUpdater } = require('electron-updater')
const { Notification, ipcMain } = require('electron')

let updateState = { checking: false, available: false, version: null, error: null }

function initUpdater(getMainWindow) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => { updateState = { ...updateState, checking: true, error: null } })
  autoUpdater.on('update-available', (info) => {
    updateState = { checking: false, available: true, version: info.version, error: null }
    new Notification({ title: '魔力宝盒', body: `发现新版本 v${info.version}，后台下载中…` }).show()
  })
  autoUpdater.on('update-not-available', () => {
    updateState = { checking: false, available: false, version: null, error: null }
  })
  autoUpdater.on('error', (e) => {
    // 静默：未签名/无网/离线场景不弹窗，仅记录状态（关于页可查）
    updateState = { ...updateState, checking: false, error: String(e && e.message || e) }
  })
  autoUpdater.on('download-progress', (p) => {
    updateState.progress = Math.round(p.percent)
  })
  autoUpdater.on('update-downloaded', (info) => {
    new Notification({
      title: '魔力宝盒',
      body: `v${info.version} 已就绪，重启应用后生效`,
    }).show()
    const w = getMainWindow()
    if (w && !w.isDestroyed()) w.webContents.send('shell:updateReady', { version: info.version })
  })

  // 启动后 30s 首查，之后每 4h
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 30_000)
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 4 * 3600 * 1000)

  // IPC：关于页手动检查/取状态/重启安装
  ipcMain.handle('shell:updateCheck', async () => {
    try { await autoUpdater.checkForUpdates() } catch { /* 静默 */ }
    return updateState
  })
  ipcMain.handle('shell:updateState', () => updateState)
  ipcMain.handle('shell:updateInstall', () => { autoUpdater.quitAndInstall() })
}

module.exports = { initUpdater, updateState }
