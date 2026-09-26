# -*- coding: utf-8 -*-
"""
MoonlyBox 品牌资产打包器
把定稿 LOGO「涌月漩」渲染为：网站 favicon 全套 / Apple touch 图标 / Android Chrome 图标 /
分享封面 / Logo PNG 导出 / Windows·macOS·Linux 客户端图标。
输出双格式：PNG/ICO（本脚本）+ SVG（设计母版复制）。
"""
import os, io, shutil

BASE = r"D:/AIProjects/MoonlyBox-workplace"
PACK = os.path.join(BASE, "moonlybox_brand_pack")
LOGO = os.path.join(BASE, "moonlybox_logo")
FONTS = os.path.join(PACK, "_fonts")
QUICK = os.path.join(FONTS, "quicksand-400.ttf")

import resvg_py
from PIL import Image, ImageDraw, ImageFont

# ---------------- resvg 渲染适配层 ----------------
def _adapt(rp):
    for n in ("svg_to_bytes", "svg_to_png"):
        if hasattr(rp, n):
            fn = getattr(rp, n)
            def f(s, w, h=None, _fn=fn):
                h = h or w
                for kw in (dict(svg_string=s, width=w, height=h),
                           dict(svg_string=s, width_to_be_used=w, height_to_be_used=h),
                           dict(svg_string=s, size=(w, h))):
                    try:
                        out = _fn(**kw); break
                    except TypeError:
                        out = None
                if out is None:
                    out = _fn(s, w, h)
                return bytes(out) if isinstance(out, (bytes, bytearray)) else bytes(out)
            return f
    raise RuntimeError("unknown resvg_py API: %s" % [x for x in dir(rp) if not x.startswith("_")])

render = _adapt(resvg_py)

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

def save_png(svg, w, path, h=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(render(svg, w, h or w))
    return path

def to_img(svg, w, h=None):
    return Image.open(io.BytesIO(render(svg, w, h or w))).convert("RGBA")

# ---------------- 母版与变体 ----------------
primary = read(os.path.join(LOGO, "moonlybox-logo-primary.svg"))
icon32  = read(os.path.join(LOGO, "moonlybox-logo-icon-32.svg"))
icon16  = read(os.path.join(LOGO, "moonlybox-logo-icon-16.svg"))

BG_LINE = '<rect width="512" height="512" rx="112" fill="url(#pBg)"/>'

def fullbleed(svg):
    """去掉圆角 → 全出血方形（iOS/Android 标准图标用）"""
    return svg.replace('rx="112"', 'rx="0"')

def maskable(svg):
    """全出血 + 内容缩至 75.5%（Android maskable 安全区）"""
    s = svg.replace(BG_LINE, "@@BG@@")
    i = s.index("</defs>") + len("</defs>")
    head, tail = s[:i], s[i:]
    j = tail.rindex("</svg>")
    inner, end = tail[:j], tail[j:]
    inner = inner.replace("@@BG@@", "")
    return (head
            + '<rect width="512" height="512" fill="url(#pBg)"/>'
            + '<g transform="translate(62.75 62.75) scale(0.755)">' + inner + "</g>" + end)

# ---------------- 1. favicon 全套 ----------------
fav = os.path.join(PACK, "favicon")
save_png(icon16, 16, os.path.join(fav, "favicon-16x16.png"))
save_png(icon32, 32, os.path.join(fav, "favicon-32x32.png"))
save_png(primary, 48, os.path.join(fav, "favicon-48x48.png"))

ico_frames = [to_img(icon16, 16), to_img(icon32, 24), to_img(icon32, 32),
              to_img(primary, 48), to_img(primary, 64), to_img(primary, 128), to_img(primary, 256)]
sizes_ico = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
ico_frames[-1].save(os.path.join(fav, "favicon.ico"), format="ICO",
                    append_images=ico_frames[:-1], sizes=sizes_ico)

# ---------------- 2. Apple touch 图标（全出血方形） ----------------
fb = fullbleed(primary)
apple = os.path.join(PACK, "apple")
for s in (57, 60, 72, 76, 114, 120, 144, 152, 167, 180, 1024):
    save_png(fb, s, os.path.join(apple, f"apple-touch-icon-{s}x{s}.png"))
shutil.copyfile(os.path.join(apple, "apple-touch-icon-180x180.png"),
                os.path.join(apple, "apple-touch-icon.png"))

# ---------------- 3. Android Chrome 图标 ----------------
andr = os.path.join(PACK, "android")
save_png(fb, 192, os.path.join(andr, "android-chrome-192x192.png"))
save_png(fb, 512, os.path.join(andr, "android-chrome-512x512.png"))
mk = maskable(primary)
save_png(mk, 192, os.path.join(andr, "maskable-192x192.png"))
save_png(mk, 512, os.path.join(andr, "maskable-512x512.png"))
with open(os.path.join(PACK, "svg", "maskable.svg"), "w", encoding="utf-8") as f:
    f.write(mk)

# ---------------- 4. Logo PNG 导出 ----------------
CN_FONT = "C:/Windows/Fonts/msyhl.ttc" if os.path.exists("C:/Windows/Fonts/msyhl.ttc") else "C:/Windows/Fonts/msyh.ttc"

def seg_w(d, s, f, ls):
    return sum(d.textlength(c, font=f) for c in s) + ls * (len(s) - 1)

def wordmark(d, x, baseline, size, ls, align="left", c1="#EAF1FF", c2="#BFD4FF"):
    f = ImageFont.truetype(QUICK, size)
    total = seg_w(d, "Moonly", f, ls) + ls + seg_w(d, "Box", f, ls)
    xx = x if align == "left" else x - total / 2
    for ch in "Moonly":
        d.text((xx, baseline), ch, font=f, fill=c1, anchor="ls"); xx += d.textlength(ch, font=f) + ls
    for ch in "Box":
        d.text((xx, baseline), ch, font=f, fill=c2, anchor="ls"); xx += d.textlength(ch, font=f) + ls
    return total

def spaced_cn(d, x, baseline, text, size, ls, align="center", fill="#BFD4FF"):
    f = ImageFont.truetype(CN_FONT, size)
    total = sum(d.textlength(c, font=f) for c in text) + ls * (len(text) - 1)
    xx = x if align == "left" else x - total / 2
    for c in text:
        d.text((xx, baseline), c, font=f, fill=fill, anchor="ls"); xx += d.textlength(c, font=f) + ls

logo = os.path.join(PACK, "logo")
save_png(primary, 512, os.path.join(logo, "logo-mark-512.png"))
save_png(primary, 1024, os.path.join(logo, "logo-mark-1024.png"))

# 水平标 1420×512（透明底，深色场景使用）
img = Image.new("RGBA", (1420, 512), (0, 0, 0, 0))
img.alpha_composite(to_img(primary, 399), (20, 56))
wordmark(ImageDraw.Draw(img), 480, 308, 150, 9, align="left")
img.save(os.path.join(logo, "logo-horizontal.png"))

# 垂直标 640×800（透明底，含中文副标）
img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img(primary, 512), (64, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5)
img.save(os.path.join(logo, "logo-vertical.png"))

# ---------------- 4b. 透明底 LOGO（裸图形，无徽章底） ----------------
# 规则：icon/app/桌面图标用徽章底版；LOGO（贴网站、文档、物料）用透明底版。
NakedBox = 'viewBox="132 72 236 343"'  # 内容 bbox x144-356 / y84-403，各留 12px

def naked(svg):
    """去徽章底与辉光层 → 裸图形，viewBox 与固有尺寸同步收紧至内容
    （resvg 会尊重 SVG 根的 width/height 固有属性，必须一并改掉，否则 height 参数失效）"""
    s = svg.replace(BG_LINE, "")
    s = s.replace('<circle cx="256" cy="196" r="130" fill="url(#pGlow)"/>', "")
    s = s.replace('viewBox="0 0 512 512" width="512" height="512"',
                  'viewBox="132 72 236 343" width="236" height="343"')
    return s

def light_variant(svg):
    """浅底反色：银蓝→深空蓝，紫→#7B5CFF，金星转紫（香槟金仅深底版使用）"""
    s = naked(svg)
    s = s.replace("#BFD4FF", "#201A4D")
    s = s.replace("#9A78FF", "#7B5CFF")
    s = s.replace("#EAF1FF", "#201A4D")
    s = s.replace("#F2E4BE", "#7B5CFF")
    return s

nk = naked(primary)
lt = light_variant(primary)

# 裸图形 mark：高 512/1024，宽按内容比例 236:343
save_png(nk, 352, os.path.join(logo, "logo-mark-transparent-512.png"), 512)
save_png(nk, 704, os.path.join(logo, "logo-mark-transparent-1024.png"), 1024)
save_png(lt, 352, os.path.join(logo, "logo-mark-transparent-light-512.png"), 512)
save_png(lt, 704, os.path.join(logo, "logo-mark-transparent-light-1024.png"), 1024)

# 水平锁定稿（裸图形 + 字标）：1240×512，透明底
img = Image.new("RGBA", (1240, 512), (0, 0, 0, 0))
img.alpha_composite(to_img(nk, 275, 400), (40, 56))
wordmark(ImageDraw.Draw(img), 375, 308, 150, 9, align="left")
img.save(os.path.join(logo, "logo-horizontal-transparent.png"))

img = Image.new("RGBA", (1240, 512), (0, 0, 0, 0))
img.alpha_composite(to_img(lt, 275, 400), (40, 56))
wordmark(ImageDraw.Draw(img), 375, 308, 150, 9, align="left", c1="#201A4D", c2="#7B5CFF")
img.save(os.path.join(logo, "logo-horizontal-light.png"))

# 垂直锁定稿（裸图形 + 英文 + 中文副标）：640×800，透明底
img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img(nk, 352, 512), (144, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5)
img.save(os.path.join(logo, "logo-vertical-transparent.png"))

img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img(lt, 352, 512), (144, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center", c1="#201A4D", c2="#7B5CFF")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5, fill="#201A4D")
img.save(os.path.join(logo, "logo-vertical-light.png"))

# ---------------- 5. 分享封面（含苹果/微信/Twitter 卡片预览） ----------------
def gradient(w, h, c1, c2):
    base = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1)
        base.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)))
    return base.resize((w, h)).convert("RGBA")

STAR = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-26 -26 52 52">'
        '<path d="M0 -22 C3.5 -7 7 -3.5 22 0 C7 3.5 3.5 7 0 22 C-3.5 7 -7 3.5 -22 0 '
        'C-7 -3.5 -3.5 -7 0 -22 Z" fill="{c}"/></svg>')
gold_star = to_img(STAR.format(c="#F2E4BE"), 128)
white_star = to_img(STAR.format(c="#EAF1FF"), 128)

share = os.path.join(PACK, "share")
os.makedirs(share, exist_ok=True)
# 横版封面 1200×630（og:image / 苹果 iMessage / Twitter 大卡片）
img = gradient(1200, 630, (42, 35, 96), (32, 26, 77))
img.alpha_composite(to_img(primary, 410), (90, 110))
d = ImageDraw.Draw(img)
wordmark(d, 578, 348, 100, 9, align="left")
spaced_cn(d, 578, 428, "魔力宝盒 · 个人 AI 知识工作台", 38, 5, align="left")
img.alpha_composite(gold_star.resize((56, 56)), (1108, 58))
img.convert("RGB").save(os.path.join(share, "og-image-1200x630.png"))

# 方版封面 1200×1200（方图分享 / App Store 宣传）
img = gradient(1200, 1200, (42, 35, 96), (32, 26, 77))
img.alpha_composite(to_img(primary, 560), (320, 130))
d = ImageDraw.Draw(img)
wordmark(d, 600, 880, 100, 6, align="center")
spaced_cn(d, 600, 995, "魔力宝盒 · 个人 AI 知识工作台", 42, 8)
img.alpha_composite(gold_star.resize((64, 64)), (140, 130))
img.alpha_composite(white_star.resize((44, 44)), (1000, 130))
img.convert("RGB").save(os.path.join(share, "og-image-square-1200x1200.png"))

# ---------------- 6. 客户端图标 ----------------
# Windows：圆角徽章原样 + 多尺寸 ICO
win = os.path.join(PACK, "client", "windows")
for s in (16, 24, 32, 48, 64, 128, 256):
    save_png(primary, s, os.path.join(win, f"moonlybox-{s}x{s}.png"))
ico_frames[-1].save(os.path.join(win, "icon.ico"), format="ICO",
                    append_images=ico_frames[:-1], sizes=sizes_ico)

# macOS：Big Sur 风格留边 82%，透明底；icns 需在 mac 上用 iconutil 转换
mac = os.path.join(PACK, "client", "macos")
os.makedirs(mac, exist_ok=True)
iconset = [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32), ("icon_32x32.png", 32),
           ("icon_32x32@2x.png", 64), ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
           ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512), ("icon_512x512.png", 512),
           ("icon_512x512@2x.png", 1024)]
for name, s in iconset:
    inner = to_img(primary, round(s * 0.82))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(inner, ((s - inner.width) // 2, (s - inner.height) // 2))
    canvas.save(os.path.join(mac, name))

# Linux：圆角徽章全尺寸
lnx = os.path.join(PACK, "client", "linux")
for s in (16, 24, 32, 48, 64, 128, 256, 512):
    save_png(primary, s, os.path.join(lnx, f"{s}x{s}.png"))

# ---------------- 7. SVG 母版复制 ----------------
svgs = os.path.join(PACK, "svg")
for src, dst in [("moonlybox-logo-primary.svg", "logo-primary.svg"),
                 ("moonlybox-logo-horizontal.svg", "logo-horizontal.svg"),
                 ("moonlybox-logo-vertical.svg", "logo-vertical.svg"),
                 ("moonlybox-logo-primary.svg", "favicon.svg"),
                 ("moonlybox-logo-icon-32.svg", "icon-32.svg"),
                 ("moonlybox-logo-icon-16.svg", "icon-16.svg")]:
    shutil.copyfile(os.path.join(LOGO, src), os.path.join(svgs, dst))

# ---------------- 8. 验证报告 ----------------
report, total = [], 0
for root, _, files in os.walk(PACK):
    for fn in sorted(files):
        p = os.path.join(root, fn)
        rel = os.path.relpath(p, PACK)
        if "_fonts" in rel:
            continue
        report.append((rel, os.path.getsize(p)))
        total += 1

checks = [("favicon/favicon-32x32.png", (32, 32)),
          ("apple/apple-touch-icon-180x180.png", (180, 180)),
          ("android/maskable-512x512.png", (512, 512)),
          ("share/og-image-1200x630.png", (1200, 630)),
          ("logo/logo-horizontal.png", (1420, 512)),
          ("client/macos/icon_512x512@2x.png", (1024, 1024))]
for rel, expect in checks:
    im = Image.open(os.path.join(PACK, rel))
    ok = im.size == expect
    print(("PASS " if ok else "FAIL ") + rel, im.size, "expect", expect)

for rel, sz in sorted(report):
    print(f"{sz:>9,}  {rel}")
print(f"BUILD OK — {total} files")
