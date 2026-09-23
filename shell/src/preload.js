/** preload：白名单桥（contextIsolation=true 下 renderer 唯一入口，Hermes Desktop IPC 安全范式）。 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('moonlybox', {
  // 内核调用：{args: ['search', '问题']} → {code, out, err}
  kernelRun: (args) => ipcRenderer.invoke('kernel:run', { args }),
  // 外链（内置 webview T3 接管前的兜底）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 内核常驻进程输出流
  onKernelStdout: (cb) => ipcRenderer.on('kernel:stdout', (_e, d) => cb(d)),
  onKernelStderr: (cb) => ipcRenderer.on('kernel:stderr', (_e, d) => cb(d)),
})
