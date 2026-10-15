# MoonlyBox 品牌资产包 v2 · 图标定稿 D8「正中构图」

> 定稿：2026-10-16 · LOGO「涌月漩」v4（2026-09-26）× 产品图标 D8（视觉居中定稿）
> 图标源：`../moonlybox_logo_icon_v4d/moonlybox-icon-D8-*.svg`（D8 构图：主体 alpha bbox 视觉居中，涡心 (280,242)）
> 本包为 v1（`../moonlybox_brand_pack/`）的 D8 重制版：目录结构、命名、引用方式完全兼容，可直接整包替换。

## 相对 v1 的变化

1. **图标全部换为 D8**：主体（漩+月）视觉居中——v1 涌月漩原图构图偏上，D8 为正中构图；星芒错落（金星上左/白星右中/白点左下）。
2. **favicon 48px 起即带金星**；16/32 用 D8 减法档（32=0.75 圈漩+月牙、16=实心月+0.75 圈外弧）。
3. **`svg/mask-icon.svg` 重制**：去掉 v1 遗留的旧「匣」U 形元素，剪影=D8 漩带+真月牙轮廓（两圆求交生成，无 evenodd 误填）。
4. **新增 `svg/icon-48.svg`**（48px 减法档：漩+月+金星）。
5. 裸图形 viewBox 重测：D8 内容 bbox `40 38 461 414`（v1 为 132 72 236 343——旧构图裸图形高瘦，D8 满幅方正）。

## 目录结构

```
moonlybox_brand_pack_v2/
├── favicon/               网页标签页图标（ico 七帧 + PNG 16/32/48）
├── apple/                 iOS 收藏/主屏/App Store（57–1024 全出血方形）
├── android/               Android/PWA（chrome 192/512 + maskable 192/512）
├── share/                 分享封面（og-image 1200×630 / 1200×1200）
├── logo/                  Logo PNG（徽章 mark / 组合稿 / 裸图形深浅双轨）
├── client/                Windows（ico 七帧+PNG）/ macOS（iconset 82% 留边）/ Linux（16–512）
├── svg/                   SVG 母版（logo-primary / favicon / icon-48/32/16 / maskable / mask-icon）
├── site.webmanifest       PWA 清单（同 v1）
├── icons-preview.html     全套预览页
├── _contact/              关键位图抽查表
└── _build/build_pack_v2.py  重建脚本
```

## 网站 `<head>` 引用片段（与 v1 完全一致）

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="mask-icon" href="/mask-icon.svg" color="#9A78FF">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#201A4D">
<meta property="og:image" content="https://你的域名/og-image-1200x630.png">
```

## 客户端图标用法

- **Windows**：`client/windows/icon.ico`（16–256 七帧）作 exe/安装包图标资源。
- **macOS**：`client/macos/` 改名 `MoonlyBox.iconset` 后 `iconutil -c icns MoonlyBox.iconset -o MoonlyBox.icns`。
- **Linux**：复制到 `/usr/share/icons/hicolor/{尺寸}/apps/moonlybox.png`。

## 底色双轨规则（沿用 v1 定稿）

- **icon/app/桌面图标** → 圆角徽章深底版（favicon、apple、android、client 全套）。
- **LOGO 用途** → 透明底裸图形稿：`*-transparent*`（深底原色）/ `*-light`（浅底反色：线条 #201A4D、漩上段 #7B5CFF；香槟金仅深底版）。

## 重建

`_build/build_pack_v2.py`（resvg-py + Pillow，字体在 `_fonts/`，源 SVG 在 `../moonlybox_logo_icon_v4d/`）。
