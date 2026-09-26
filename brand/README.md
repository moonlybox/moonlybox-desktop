# MoonlyBox 品牌资产包 · LOGO 定稿「涌月漩」

> 主推方案「涌月漩」（外涌）
> 本包为 PNG/ICO + SVG 双格式交付（品牌资产源文件夹，纳入版本跟踪）

## 目录结构

```
moonlybox_brand_pack/
├── favicon/               网页标签页图标
│   ├── favicon.ico            多尺寸合一（16/24/32/48/64/128/256）
│   ├── favicon-16x16.png      16px（减法版母版渲染）
│   ├── favicon-32x32.png      32px（减法版母版渲染）
│   ├── favicon-48x48.png      48px
│   └── (favicon.svg 见 svg/)
├── apple/                 iOS 收藏 / 主屏图标（全出血方形，系统自裁圆角）
│   ├── apple-touch-icon.png   默认引用（=180x180）
│   └── apple-touch-icon-{57…180,1024}.png
├── android/               Android / PWA
│   ├── android-chrome-192x192.png / 512x512.png
│   └── maskable-192x192.png / maskable-512x512.png（内容缩至 75.5% 安全区）
├── share/                 分享封面（苹果 iMessage / 微信 / Twitter 卡片）
│   ├── og-image-1200x630.png        横版
│   └── og-image-square-1200x1200.png 方版
├── logo/                  Logo PNG 导出（徽章组合稿 + 透明底裸图形稿）
│   ├── logo-mark-512.png / logo-mark-1024.png      圆角徽章 mark（icon 性质）
│   ├── logo-horizontal.png 1420×512 / logo-vertical.png 640×800   徽章组合稿（透明底）
│   ├── logo-mark-transparent-512.png / -1024.png   裸图形 · 深底色（352×512 / 704×1024）
│   ├── logo-mark-transparent-light-512.png / -1024.png   裸图形 · 浅底反色
│   ├── logo-horizontal-transparent.png 1240×512    裸图形+字标 · 深底色
│   ├── logo-horizontal-light.png       1240×512    裸图形+字标 · 浅底
│   ├── logo-vertical-transparent.png   640×800     含中文副标 · 深底色
│   └── logo-vertical-light.png         640×800     含中文副标 · 浅底
├── client/                客户端图标
│   ├── windows/  icon.ico（八档合一）+ moonlybox-{16…256}.png
│   ├── macos/    iconset 命名规范、82% 留边（Big Sur 风格）
│   └── linux/    16–512 全尺寸
├── svg/                   SVG 母版（favicon.svg / logo-primary / horizontal / vertical / maskable / mask-icon / icon-32 / icon-16）
├── site.webmanifest       PWA 清单
└── _build/build_pack.py   重建脚本（resvg-py + Pillow）
```

## 网站 `<head>` 引用片段

```html
<!-- favicon -->
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<!-- Safari 钉选（color 由浏览器注入剪影） -->
<link rel="mask-icon" href="/mask-icon.svg" color="#9A78FF">
<!-- iOS 收藏 / 添加到主屏 -->
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<!-- PWA -->
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#201A4D">
<!-- 分享封面 -->
<meta property="og:image" content="https://你的域名/og-image-1200x630.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://你的域名/og-image-1200x630.png">
```

**部署**：把 `favicon/`、`apple/`、`android/`、`share/` 中被引用的文件放到站点根目录（或按实际路径修改引用）。`site.webmanifest` 内为相对路径，默认与图标同目录部署。

## 客户端图标用法

- **Windows**：`client/windows/icon.ico`（16–256 八档合一）直接作为 exe / 安装包图标资源；PNG 为备用。
- **macOS**：`client/macos/` 已按 iconset 规范命名。生成 .icns：把该目录改名为 `MoonlyBox.iconset` 后在 mac 上执行
  `iconutil -c icns MoonlyBox.iconset -o MoonlyBox.icns`
- **Linux**：按 FreeDesktop 惯例复制到 `/usr/share/icons/hicolor/{尺寸}/apps/moonlybox.png`。

## 字体与转曲

- 英文字标原型 **Quicksand Regular**（SIL OFL 许可，`_fonts/quicksand-400.ttf`），字距 +0.06em。
- PNG 已定格渲染；**SVG 母版中的文字未转曲**——正式对外分发 SVG 前请将文字转为轮廓（outline）。
- 中文副标 PNG 以微软雅黑 Light 渲染；SVG 在无该字体的环境会回退。

## 设计规格速查（延伸物料必读）

- 统一笔制：14px@512 圆头等线宽；六色色板 `#2A2360 / #201A4D / #EAF1FF / #BFD4FF / #9A78FF / #F2E4BE`（香槟金全画面仅一颗星，<1%）。
- 小尺寸减法表（不可直接缩母版）：48px 全要素；32px 盒+月+1圈螺旋+金星（线宽 20、螺旋纯色）；16px 盒+月+0.5圈外弧（线宽 28、仅三色）→ 已交付 `svg/icon-32.svg`、`svg/icon-16.svg`，favicon 16/32 即按此渲染。
- 平行线条中心距 ≥ 2.2×线宽；关键元素全部位于中心 r200 内切圆（圆形头像裁切安全）。
- **底色双轨规则（2026-09-27 定稿）**：
  - **icon/app/桌面图标** → 一律用圆角徽章深底版（favicon、apple、android、client 全套）。
  - **LOGO 用途**（贴网站、文档、合作物料）→ 用透明底裸图形稿，分两版：
    - `*-transparent*`（深底色版）：银蓝+梦幻紫原色，贴 `#0F172A`/`#201A4D` 等深底；
    - `*-light`（浅底反色版）：线条转深空蓝 `#201A4D`、漩涡上段转 `#7B5CFF`、星转紫（香槟金仅深底版使用），贴白/浅灰底。

## 重建

设计修改后重跑：`_build/build_pack.py`（依赖 resvg-py、Pillow，字体在 `_fonts/`）。
