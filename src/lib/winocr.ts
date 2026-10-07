/**
 * winocr——Windows 本机 OCR 引擎（#332）：PowerShell 子进程调 Windows.Media.Ocr（WinRT）。
 * 设计纪律：
 * - 零 npm 依赖、零安装、离线可用（Windows 10+ 自带 WinRT OCR 与中文语言包）
 * - 调用形态与 local-models.ts 的 execFile('powershell.exe',…) 先例同款（仓内既有模式）
 * - 仅 Windows 可用：detect() 返回 false 时调用方回落原行为（builtin/pdfjs 报错文案）
 * - PS 5.1（Windows 自带）加载 WinRT：[Windows.Runtime.InteropServices.WindowsRuntime,..]::AsTypes 方式
 *   ——不用 PS7 专属语法；OCR 结果按行拼接（OcrLine.Text）
 * - 无页数限制（A2 裁决：不限制；调用方按 PDF 分页逐页调，单页失败不中断整体）
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OCR_PS_TIMEOUT = 60_000 // 单张图 OCR 上限 60s（扫描教材整页留足余量）

/** PowerShell 脚本：加载 WinRT 类型→读文件字节→解码 Bitmap→OcrEngine 识别→按行输出文本 */
function buildOcrScript(imgPath: string): string {
  // 路径单引号转义（PowerShell 单引号串内 '' =字面单引号）
  const p = imgPath.replace(/'/g, "''")
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
    '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
    '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]',
    '$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]',
    // WinRT IAsyncOperation 转 Task 的辅助（PS5.1 通用写法）
    '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]',
    'Function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }',
    '$path = \'' + p + '\'',
    '$file = [System.IO.File]::ReadAllBytes($path)',
    '$ms = New-Object System.IO.MemoryStream(,$file)',
    '$ra = Await ([Windows.Storage.Streams.RandomAccessStream]::FromStreamAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms))) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ra)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    'if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("zh-Hans-CN")) }',
    'if (-not $engine) { Write-Output "__OCR_ENGINE_UNAVAILABLE__"; exit 0 }',
    '$result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])',
    'foreach ($line in $result.Lines) { Write-Output $line.Text }',
  ].join('; ')
}

/** 异步探测（唯一入口）：Windows + OCR 引擎可用 */
export async function winocrDetect(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    return await new Promise<boolean>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null; if ([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()) { "ok" } else { "no-engine" }'], { timeout: 15_000 }, (e, so) => {
        resolve(!e && String(so ?? '').trim() === 'ok')
      })
    })
  } catch {
    return false
  }
}

/** 识别单张图片→文本（按 OCR 行拼接）。失败返回 null（调用方决定回落文案）。 */
export async function winocrRecognize(imgPath: string): Promise<string | null> {
  if (process.platform !== 'win32' || !fs.existsSync(imgPath)) return null
  try {
    const out = await new Promise<string | null>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildOcrScript(path.resolve(imgPath))], { timeout: OCR_PS_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (e, so, se) => {
        if (e && !so) return resolve(null)
        const text = String(so ?? '')
        if (text.includes('__OCR_ENGINE_UNAVAILABLE__')) return resolve(null)
        resolve(text.replace(/\r/g, '').trim() || null)
      })
    })
    return out
  } catch {
    return null
  }
}

/** 支持的图片扩展（与 docproc mimeMap 对齐） */
export const WINOCR_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff'])
