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
  // T3：剪贴板监听开关 / 手动采集 / 协议注册状态
  setClipboardWatch: (on) => ipcRenderer.invoke('shell:clipboardWatch', on),
  capture: (text) => ipcRenderer.invoke('shell:capture', text),
  protocolState: () => ipcRenderer.invoke('shell:protocolState'),
})
