"""Generate README illustrations for dsh-boot-animation-plus (Pillow, no assets).

Run: python docs/images/generate.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ORANGE = (255, 122, 26)
INK = (232, 236, 240)
DIM = (139, 148, 158)
BG = (13, 17, 23)
PANEL = (22, 27, 34)
LINE = (48, 54, 61)
CJK = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc"]
MONO = [r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\consolab.ttf"]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default(size)


def mono(size):
    return font(MONO, size)


def cjk(size):
    return font(CJK, size)


def footer(img):
    ImageDraw.Draw(img).text((28, img.size[1] - 44), "illustration - not a screenshot", font=mono(20), fill=(255, 255, 255, 80))


def scanlines(img, alpha=20):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for y in range(0, img.size[1], 3):
        draw.line([(0, y), (img.size[0], y)], fill=(255, 255, 255, alpha))
    img.alpha_composite(layer)


def splash():
    w, h = 1600, 900
    img = Image.new("RGBA", (w, h), (5, 6, 8, 255))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        draw.line([(0, y), (w, y)], fill=(int(8 + 26 * t), int(9 + 18 * t), int(12 + 14 * t)))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([int(w * 0.42), -int(h * 0.35), int(w * 1.25), int(h * 0.95)], fill=(255, 122, 26, 26))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120)))
    pad = int(w * 0.045)
    draw.text((pad, int(h * 0.055)), "DSH // BOOT", font=mono(26), fill=ORANGE)
    right = "STARTUP INTRO"
    draw.text((w - pad - draw.textlength(right, font=mono(20)), int(h * 0.055)), right, font=mono(20), fill=(*DIM, 200))
    draw.text((int(w * 0.09), int(h * 0.36)), "DEEPSEEK HARNESS", font=mono(int(h * 0.082)), fill=(244, 248, 252, 255))
    draw.text((int(w * 0.09), int(h * 0.46)), "EPISODE // 01", font=mono(int(h * 0.03)), fill=ORANGE)
    draw.line([(int(w * 0.09), int(h * 0.525)), (int(w * 0.36), int(h * 0.525))], fill=ORANGE, width=2)
    draw.text((int(w * 0.09), int(h * 0.555)), "每次打开 DSH 播一段片头，然后淡出进入工作区。", font=cjk(int(h * 0.026)), fill=(*INK, 210))
    draw.text((int(w * 0.09), int(h * 0.60)), "Press Esc to skip", font=mono(int(h * 0.022)), fill=(*DIM, 190))
    bx, by, bw = int(w * 0.09), int(h * 0.84), int(w * 0.28)
    draw.rectangle([bx, by, bx + bw, by + 4], fill=(255, 255, 255, 30))
    draw.rectangle([bx, by, bx + int(bw * 0.62), by + 4], fill=(*ORANGE, 240))
    draw.text((bx + bw + 18, by - 12), "62%", font=mono(20), fill=(*DIM, 200))
    footer(img)
    scanlines(img)
    return img.convert("RGB")


def library():
    w, h = 1280, 820
    img = Image.new("RGBA", (w, h), (*BG, 255))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([40, 40, w - 40, h - 40], radius=16, fill=(*PANEL, 255), outline=LINE, width=2)
    draw.text((72, 70), "片库 / Clip library", font=cjk(34), fill=INK)
    draw.text((72, 118), "内置片头不可删除；你自己加入的视频会同步删除文件。", font=cjk(20), fill=DIM)
    rows = [
        ("DeepSeek 品牌片头", "内置", False, False),
        ("DeepSeek 赛博朋克片头", "内置", False, False),
        ("DeepSeek 数字角色苏醒", "内置", False, False),
        ("DeepSeek 启动片头", "内置", False, False),
        ("我的片头 A.mp4", "你的视频", True, True),
        ("我的片头 B.mp4", "你的视频", True, True),
    ]
    y = 170
    for name, badge, writable, checked in rows:
        draw.rounded_rectangle([72, y, w - 72, y + 62], radius=10, fill=(17, 22, 28, 255), outline=LINE)
        if writable:
            draw.rectangle([96, y + 19, 118, y + 41], outline=ORANGE, width=2)
            if checked:
                draw.line([(101, y + 30), (107, y + 37), (115, y + 23)], fill=ORANGE, width=3)
        draw.text((140, y + 17), name, font=cjk(24), fill=INK)
        badge_fill = (60, 66, 74) if badge == "内置" else (80, 52, 20)
        draw.rounded_rectangle([w - 300, y + 16, w - 110, y + 46], radius=8, fill=badge_fill)
        draw.text((w - 282, y + 21), badge, font=cjk(18), fill=INK if badge == "内置" else ORANGE)
        draw.text((w - 150, y + 21), "已选中" if (writable and checked) else "选择", font=cjk(18), fill=DIM)
        y += 78
    ty = h - 160
    x = 72
    for text, danger in [("全选", False), ("清空", False), ("删除所选 (2)", True), ("确认删除", True)]:
        f = cjk(22)
        bw = int(draw.textlength(text, font=f)) + 44
        fill = (92, 30, 30) if danger else (34, 40, 48)
        draw.rounded_rectangle([x, ty, x + bw, ty + 50], radius=10, fill=fill, outline=(150, 60, 60) if danger else LINE)
        draw.text((x + 22, ty + 12), text, font=f, fill=(255, 200, 200) if danger else INK)
        x += bw + 14
    draw.text((w - 330, ty + 14), "二次确认后才会真正删除", font=cjk(18), fill=DIM)
    footer(img)
    return img.convert("RGB")


if __name__ == "__main__":
    splash().save(os.path.join(HERE, "splash.png"), optimize=True)
    library().save(os.path.join(HERE, "library.png"), optimize=True)
    print("wrote splash.png, library.png into", HERE)
