# -*- coding: utf-8 -*-
"""
MoonlyBox 品牌资产打包器 v2 —— 图标定稿 D8「正中构图」
以 moonlybox_logo_icon_v4d/moonlybox-icon-D8-*.svg 为源，输出：
网站 favicon 全套 / Apple touch / Android Chrome + maskable / 分享封面 /
Logo PNG（徽章 + 透明底裸图形 深浅双版）/ Windows·macOS·Linux 客户端 / SVG 母版 / 预览页
输出目录：moonlybox_brand_pack_v2/
"""
import os, io, math, shutil, struct

BASE = r"D:/AIProjects/MoonlyBox-workplace"
SRC = os.path.join(BASE, "moonlybox_logo_icon_v4d")
PACK = os.path.join(BASE, "moonlybox_brand_pack_v2")
OLD = os.path.join(BASE, "moonlybox_brand_pack")
FONTS = os.path.join(PACK, "_fonts")
QUICK = os.path.join(FONTS, "quicksand-400.ttf")

import resvg_py
from PIL import Image, ImageDraw, ImageFont

os.makedirs(FONTS, exist_ok=True)
shutil.copyfile(os.path.join(OLD, "_fonts", "quicksand-400.ttf"), QUICK)

render = resvg_py.svg_to_bytes

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

def save_png(svg, w, path, h=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    png = render(svg_string=svg, width=w, height=h or w)
    with open(path, "wb") as f:
        f.write(bytes(png))
    return path

def to_img(svg, w, h=None):
    return Image.open(io.BytesIO(bytes(render(svg_string=svg, width=w, height=h or w)))).convert("RGBA")

# ---------------- 源：D8 四档 ----------------
d8 = {t: read(os.path.join(SRC, "moonlybox-icon-D8-%d.svg" % t)) for t in (512, 48, 32, 16)}
BG_RECT = '<rect width="512" height="512" rx="112" fill="url(#d8_512Bg)"/>'
GLOW = '<circle cx="256" cy="252" r="299" fill="url(#d8_512Glow)"/>'

def fullbleed(svg):
    return svg.replace('rx="112"', 'rx="0"')

def maskable(svg):
    s = svg.replace(BG_RECT, "@@BG@@")
    i = s.index("</defs>") + len("</defs>")
    head, tail = s[:i], s[i:]
    j = tail.rindex("</svg>")
    inner, end = tail[:j], tail[j:]
    inner = inner.replace("@@BG@@", "")
    return (head + '<rect width="512" height="512" fill="url(#d8_512Bg)"/>'
            + '<g transform="translate(62.75 62.75) scale(0.755)">' + inner + "</g>" + end)

def naked(svg):
    """去徽章底与辉光 → 裸图形；viewBox 收紧至内容实测 alpha bbox ±12"""
    s = svg.replace(BG_RECT, "").replace(GLOW, "")
    im = to_img(s, 512)
    b = im.split()[3].getbbox()
    x0, y0 = b[0] - 12, b[1] - 12
    w, h = b[2] - b[0] + 24, b[3] - b[1] + 24
    return s.replace('viewBox="0 0 512 512" width="512" height="512"',
                     'viewBox="%d %d %d %d" width="%d" height="%d"' % (x0, y0, w, h, w, h)), (x0, y0, w, h)

def light_variant(svg):
    s = svg.replace("#BFD4FF", "#201A4D")
    s = s.replace("#9A78FF", "#7B5CFF")
    s = s.replace("#EAF1FF", "#201A4D")
    s = s.replace("#F2E4BE", "#7B5CFF")
    return s

nk, NK_BOX = naked(d8[512])
lt = light_variant(nk)
print("naked viewBox:", NK_BOX)

# ---------------- 1. favicon 全套 ----------------
fav = os.path.join(PACK, "favicon")
save_png(d8[16], 16, os.path.join(fav, "favicon-16x16.png"))
save_png(d8[32], 32, os.path.join(fav, "favicon-32x32.png"))
save_png(d8[48], 48, os.path.join(fav, "favicon-48x48.png"))

def make_ico(jobs, out):
    """jobs: [(png_bytes_path_size, size)] → 手写多尺寸 PNG 容器"""
    imgs = [open(p, "rb").read() for p, _ in jobs]
    n = len(imgs)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries = b""
    body = b""
    for (p, sz), data in zip(jobs, imgs):
        w = 0 if sz >= 256 else sz
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data
    open(out, "wb").write(header + entries + body)

# 临时渲染各帧 PNG
tmp = os.path.join(PACK, "_tmp_ico")
os.makedirs(tmp, exist_ok=True)
ico_jobs = []
for sz, svg in [(16, d8[16]), (24, d8[32]), (32, d8[32]), (48, d8[48]),
                (64, d8[512]), (128, d8[512]), (256, d8[512])]:
    p = os.path.join(tmp, "f%d.png" % sz)
    save_png(svg, sz, p)
    ico_jobs.append((p, sz))
make_ico(ico_jobs, os.path.join(fav, "favicon.ico"))

# ---------------- 2. Apple touch（全出血方形） ----------------
fb = fullbleed(d8[512])
apple = os.path.join(PACK, "apple")
for s in (57, 60, 72, 76, 114, 120, 144, 152, 167, 180, 1024):
    save_png(fb, s, os.path.join(apple, "apple-touch-icon-%dx%d.png" % (s, s)))
shutil.copyfile(os.path.join(apple, "apple-touch-icon-180x180.png"),
                os.path.join(apple, "apple-touch-icon.png"))

# ---------------- 3. Android Chrome ----------------
andr = os.path.join(PACK, "android")
save_png(fb, 192, os.path.join(andr, "android-chrome-192x192.png"))
save_png(fb, 512, os.path.join(andr, "android-chrome-512x512.png"))
mk = maskable(d8[512])
save_png(mk, 192, os.path.join(andr, "maskable-192x192.png"))
save_png(mk, 512, os.path.join(andr, "maskable-512x512.png"))
os.makedirs(os.path.join(PACK, "svg"), exist_ok=True)
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
save_png(d8[512], 512, os.path.join(logo, "logo-mark-512.png"))
save_png(d8[512], 1024, os.path.join(logo, "logo-mark-1024.png"))

img = Image.new("RGBA", (1420, 512), (0, 0, 0, 0))
img.alpha_composite(to_img(d8[512], 399), (20, 56))
wordmark(ImageDraw.Draw(img), 480, 308, 150, 9, align="left")
img.save(os.path.join(logo, "logo-horizontal.png"))

img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img(d8[512], 512), (64, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5)
img.save(os.path.join(logo, "logo-vertical.png"))

nw, nh = NK_BOX[2], NK_BOX[3]   # 裸图形固有宽高
def to_img_naked(svg, target_h):
    return to_img(svg, round(nw * target_h / nh), target_h)

# 裸图形 mark：高 512/1024，宽按内容比例
for H in (512, 1024):
    save_png(nk, round(nw * H / nh), os.path.join(logo, "logo-mark-transparent-%d.png" % H), H)
    save_png(lt, round(nw * H / nh), os.path.join(logo, "logo-mark-transparent-light-%d.png" % H), H)

img = Image.new("RGBA", (1240, 512), (0, 0, 0, 0))
img.alpha_composite(to_img_naked(nk, 400), (40, 56))
wordmark(ImageDraw.Draw(img), 375, 308, 150, 9, align="left")
img.save(os.path.join(logo, "logo-horizontal-transparent.png"))

img = Image.new("RGBA", (1240, 512), (0, 0, 0, 0))
img.alpha_composite(to_img_naked(lt, 400), (40, 56))
wordmark(ImageDraw.Draw(img), 375, 308, 150, 9, align="left", c1="#201A4D", c2="#7B5CFF")
img.save(os.path.join(logo, "logo-horizontal-light.png"))

img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img_naked(nk, 512), (144, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5)
img.save(os.path.join(logo, "logo-vertical-transparent.png"))

img = Image.new("RGBA", (640, 800), (0, 0, 0, 0))
img.alpha_composite(to_img_naked(lt, 512), (144, 40))
d = ImageDraw.Draw(img)
wordmark(d, 320, 648, 76, 4.5, align="center", c1="#201A4D", c2="#7B5CFF")
spaced_cn(d, 320, 731, "魔力宝盒", 33, 8.5, fill="#201A4D")
img.save(os.path.join(logo, "logo-vertical-light.png"))

# ---------------- 5. 分享封面 ----------------
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
img = gradient(1200, 630, (42, 35, 96), (32, 26, 77))
img.alpha_composite(to_img(d8[512], 410), (90, 110))
d = ImageDraw.Draw(img)
wordmark(d, 578, 348, 100, 9, align="left")
spaced_cn(d, 578, 428, "魔力宝盒 · 个人 AI 知识工作台", 38, 5, align="left")
img.alpha_composite(gold_star.resize((56, 56)), (1108, 58))
img.convert("RGB").save(os.path.join(share, "og-image-1200x630.png"))

img = gradient(1200, 1200, (42, 35, 96), (32, 26, 77))
img.alpha_composite(to_img(d8[512], 560), (320, 130))
d = ImageDraw.Draw(img)
wordmark(d, 600, 880, 100, 6, align="center")
spaced_cn(d, 600, 995, "魔力宝盒 · 个人 AI 知识工作台", 42, 8)
img.alpha_composite(gold_star.resize((64, 64)), (140, 130))
img.alpha_composite(white_star.resize((44, 44)), (1000, 130))
img.convert("RGB").save(os.path.join(share, "og-image-square-1200x1200.png"))

# ---------------- 6. 客户端图标 ----------------
win = os.path.join(PACK, "client", "windows")
for s, svg in [(16, d8[16]), (24, d8[32]), (32, d8[32]), (48, d8[48]),
               (64, d8[512]), (128, d8[512]), (256, d8[512])]:
    save_png(svg, s, os.path.join(win, "moonlybox-%dx%d.png" % (s, s)))
make_ico(ico_jobs, os.path.join(win, "icon.ico"))

mac = os.path.join(PACK, "client", "macos")
os.makedirs(mac, exist_ok=True)
iconset = [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32), ("icon_32x32.png", 32),
           ("icon_32x32@2x.png", 64), ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
           ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512), ("icon_512x512.png", 512),
           ("icon_512x512@2x.png", 1024)]
for name, s in iconset:
    inner = to_img(d8[512], round(s * 0.82))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(inner, ((s - inner.width) // 2, (s - inner.height) // 2))
    canvas.save(os.path.join(mac, name))

lnx = os.path.join(PACK, "client", "linux")
for s, svg in [(16, d8[16]), (24, d8[32]), (32, d8[32]), (48, d8[48]),
               (64, d8[512]), (128, d8[512]), (256, d8[512]), (512, d8[512])]:
    save_png(svg, s, os.path.join(lnx, "%dx%d.png" % (s, s)))

# ---------------- 7. SVG 母版 ----------------
svgs = os.path.join(PACK, "svg")
shutil.copyfile(os.path.join(SRC, "moonlybox-icon-D8-512.svg"), os.path.join(svgs, "logo-primary.svg"))
shutil.copyfile(os.path.join(SRC, "moonlybox-icon-D8-512.svg"), os.path.join(svgs, "favicon.svg"))
shutil.copyfile(os.path.join(SRC, "moonlybox-icon-D8-48.svg"), os.path.join(svgs, "icon-48.svg"))
shutil.copyfile(os.path.join(SRC, "moonlybox-icon-D8-32.svg"), os.path.join(svgs, "icon-32.svg"))
shutil.copyfile(os.path.join(SRC, "moonlybox-icon-D8-16.svg"), os.path.join(svgs, "icon-16.svg"))
shutil.copyfile(os.path.join(OLD, "site.webmanifest"), os.path.join(PACK, "site.webmanifest"))

# Safari mask-icon 单色剪影（漩带 stroke + 真月牙轮廓）
def crescent_d(CV, RV, CV2, r2):
    dx, dy = CV2[0] - CV[0], CV2[1] - CV[1]
    dist = math.hypot(dx, dy)
    a = (dist * dist + RV * RV - r2 * r2) / (2 * dist)
    h = math.sqrt(RV * RV - a * a)
    ux, uy = dx / dist, dy / dist
    bx, by = CV[0] + a * ux, CV[1] + a * uy
    p1 = (bx + h * uy, by - h * ux)
    p2 = (bx - h * uy, by + h * ux)
    fmt = lambda p: "%.2f %.2f" % p
    return ("M%s A%d %d 0 1 1 %s A%d %d 0 0 0 %s Z"
            % (fmt(p1), RV, RV, fmt(p2), r2, r2, fmt(p1))), p1, p2

moon_d, _, _ = crescent_d((256, 196), 40, (271, 185), 36)
mask_icon = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
             'role="img" aria-label="MoonlyBox 钉选图标（Safari mask-icon 剪影版）">\n'
             '  <g fill="none" stroke="#000000" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">\n'
             '    <path d="M256 288 C205 288 166 246 166 196 C166 146 213 118 256 118 '
             'C299 118 322 159 322 196 C322 233 288 254 256 254 C224 254 198 228 198 196"/>\n'
             '  </g>\n'
             '  <path fill="#000000" d="%s"/>\n</svg>' % moon_d)
with open(os.path.join(svgs, "mask-icon.svg"), "w", encoding="utf-8") as f:
    f.write(mask_icon)

# ---------------- 8. 验证报告 ----------------
report, total = [], 0
for root, _, files in os.walk(PACK):
    for fn in sorted(files):
        p = os.path.join(root, fn)
        rel = os.path.relpath(p, PACK)
        if "_fonts" in rel or "_tmp_ico" in rel:
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

# ICO 回读校验
data = open(os.path.join(fav, "favicon.ico"), "rb").read()
_, typ, n = struct.unpack("<HHH", data[:6])
frames = []
for i in range(n):
    w, h = struct.unpack("<BB", data[6 + 16 * i: 8 + 16 * i])
    frames.append(256 if w == 0 else w)
print("favicon.ico frames:", frames)

for rel, sz in sorted(report):
    print("%9s  %s" % ("{:,}".format(sz), rel))
print("BUILD OK — %d files" % total)
