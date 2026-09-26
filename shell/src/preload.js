/** preload：白名单桥（contextIsolation=true 下 renderer 唯一入口，Hermes Desktop IPC 安全范式）。 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('moonlybox', {
  // daemon RPC：kernelRpc('xiaoyue', {q}) → Promise<done>；过程行走 onKernelEvent
  rpc: (cmd, args, timeoutMs) => ipcRenderer.invoke('kernel:rpc', { cmd, args, timeoutMs }),
  // 订阅过程事件：cb({id, event, payload})
  subscribe: () => ipcRenderer.send('kernel:subscribe'),
  onKernelEvent: (cb) => ipcRenderer.on('kernel:event', (_e, msg) => cb(msg)),
  // 外链（内置 webview T3 接管前的兜底）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 版本双轨
  versions: () => ipcRenderer.invoke('shell:versions'),
  // T4：更新（手动检查/状态/重启安装）
  updateCheck: () => ipcRenderer.invoke('shell:updateCheck'),
  updateState: () => ipcRenderer.invoke('shell:updateState'),
  updateInstall: () => ipcRenderer.invoke('shell:updateInstall'),
  onUpdateReady: (cb) => ipcRenderer.on('shell:updateReady', (_e, msg) => cb(msg)),
  // P2：UI 确认制——renderer 对挂起的 confirm_request 回传结果
  confirmResponse: (rpcId, value) => ipcRenderer.invoke('kernel:confirmResponse', { rpcId, value }),
  // #253：自绘标题栏窗口控制 + vault 选择/读取 + vault 文件树（沙箱）
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  onWinState: (cb) => { const h = (_e, st) => cb(st); ipcRenderer.on('shell:winState', h); return () => ipcRenderer.removeListener('shell:winState', h) },
  winClose: () => ipcRenderer.invoke('win:close'),
  vaultGet: () => ipcRenderer.invoke('vault:get'),
  vaultPick: () => ipcRenderer.invoke('vault:pick'),
  fsList: (rel) => ipcRenderer.invoke('fs:list', rel),
  fsRead: (rel) => ipcRenderer.invoke('fs:read', rel),
  fsWrite: (rel, content) => ipcRenderer.invoke('fs:write', rel, content),
  // T3：剪贴板监听开关 / 手动采集 / 协议注册状态
  setClipboardWatch: (on) => ipcRenderer.invoke('shell:clipboardWatch', on),
  capture: (text) => ipcRenderer.invoke('shell:capture', text),
  protocolState: () => ipcRenderer.invoke('shell:protocolState'),
  // #256：通用设置保存后同步 main 行为（托盘/唤醒/剪贴板/开机启动）
  applyGeneral: (general) => ipcRenderer.invoke('shell:applyGeneral', general),
  // #257：通用目录选择（备份目录场景——不落 vault 配置）
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder'),
})
