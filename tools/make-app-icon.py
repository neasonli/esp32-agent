"""生成 L-CODE 应用图标（**像素风**，Windows .ico 多尺寸 + 通用 .png）。

设计要点（像素风的正确做法）：
1. 只在 **16×16 逻辑网格**上画（putpixel 级别），所有字形都是手写点阵；
2. 各尺寸用 **整数倍最近邻放大**（×1/×2/×3/×4/×8/×16）→ 硬边像素，绝不出现抗锯齿灰边；
   因此 ICO 里只放 16/32/48/64/128/256（不生成 24，它不是 16 的整数倍，缩放会出现半个像素）。
3. 调色板取自品牌字标（`图标\截图20260913105201.png` 的 "LCode"）：**蓝 #0E4598 底 + 白 #FFFFFF 字标**
   （另留品牌黄 #FDCF21 常量备用；字标里黄只占 ~11%，是点缀，图标当前**不使用**它）。
   图标构成：蓝底 + 深蓝描边 + 居中的白色 "LC"，无其它装饰。

为什么用脚本生成：图标是二进制，直接塞进仓库无法审阅也不能改配色；这份脚本 = 唯一源，
改几个常量就能重出三平台图标。界面顶栏的品牌标记也由它生成（`assets/lcodeMark.ts` 的 data URL），
两处不会走样。

产物：
    lcode/desktop/build/icon.ico          多尺寸（16/32/48/64/128/256）：Windows 安装包 + 任务栏 + 窗口
    lcode/desktop/build/icon.png          1024×1024：Linux（AppImage/deb）；macOS 据此生成 icns
    lcode/desktop/build/icon-256.png      开发模式窗口图标（BrowserWindow.icon）
    lcode/desktop/src/renderer/src/assets/lcodeMark.ts   16×16 data URL（顶栏品牌标记用）

依赖（仅生成时需要，不属于产品依赖）：
    python -m pip install pillow
    python tools/make-app-icon.py
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("需要 Pillow：python -m pip install pillow")
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "lcode" / "desktop" / "build"

# ── 调色板：取自品牌字标 图标\截图20260913105201.png（"LCode"，深蓝+金黄）──────
# 实测该图主色：蓝 (14,69,152)=#0E4598（占墨迹 ~86%）、黄 (253,207,33)=#FDCF21（点缀 ~11%）。
# 图标把关系反过来：蓝底 + 白字 + 黄点缀（白底图标在浅色任务栏上会"消失"）。
BG = (14, 69, 152, 255)       # 品牌蓝 #0E4598
EDGE = (10, 52, 116, 255)     # 深一号的蓝，勾轮廓
FG = (255, 255, 255, 255)     # 字标白
ACCENT = (253, 207, 33, 255)  # 品牌黄 #FDCF21（预留：字标里的点缀色，图标当前不用）

BASE = 16                     # 逻辑网格边长
SCALES = [16, 32, 48, 64, 128, 256]   # ICO 各档（均为 16 的整数倍）

# ── 点阵字形（5×7，'#' = 字标像素）────────────────────────────────────────
GLYPH_L = [
    "#....",
    "#....",
    "#....",
    "#....",
    "#....",
    "#....",
    "#####",
]
GLYPH_C = [
    ".###.",
    "#...#",
    "#....",
    "#....",
    "#....",
    "#...#",
    ".###.",
]

# 布局（16×16 网格内）——"LC" 居中：
#   水平：字形 5 + 字距 2 + 字形 5 = 12，格子内侧可用 14（列 1..14）→ 左右各留 1px 等边距；
#   垂直：字形高 7，可用 14 行 → 上 3 下 4（奇数高字形不可能绝对对称，取视觉居中）。
# 早先版本在字下画过一条品牌黄"光标条"，按用户要求去掉（LC 居中即可）。
L_XY = (2, 4)
C_XY = (9, 4)
# 切角（像素风圆角）：两处 1px/2px 组合
CUT_CORNERS = {
    (0, 0), (1, 0), (0, 1),
    (15, 0), (14, 0), (15, 1),
    (0, 15), (1, 15), (0, 14),
    (15, 15), (14, 15), (15, 14),
}


def build_base() -> Image.Image:
    """在 16×16 网格上画底图（唯一真源，之后只做整数倍放大）。"""
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    px = img.load()

    # 1) 方块底 + 1px 描边 + 切角
    for y in range(BASE):
        for x in range(BASE):
            if (x, y) in CUT_CORNERS:
                continue
            px[x, y] = EDGE if (x in (0, BASE - 1) or y in (0, BASE - 1)) else BG

    # 2) 字标
    def blit(glyph: list[str], ox: int, oy: int, color: tuple) -> None:
        for i, row in enumerate(glyph):
            for j, ch in enumerate(row):
                if ch in ("#", "o"):
                    px[ox + j, oy + i] = color

    blit(GLYPH_L, *L_XY, FG)
    blit(GLYPH_C, *C_XY, FG)
    return img


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = build_base()

    # 最近邻整数倍放大：保证每个逻辑像素变成规整的 N×N 方块
    def scaled(size: int) -> Image.Image:
        factor = size // BASE
        if factor * BASE != size:
            raise SystemExit(f"{size} 不是 {BASE} 的整数倍，像素风会糊")
        return base.resize((size, size), Image.NEAREST)

    ico = OUT_DIR / "icon.ico"
    frames = [scaled(s) for s in SCALES]
    frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in SCALES], append_images=frames[:-1])

    png = OUT_DIR / "icon.png"          # Linux AppImage/deb；macOS 由 electron-builder 生成 icns
    scaled(1024).save(png, format="PNG")

    png256 = OUT_DIR / "icon-256.png"   # 开发模式窗口图标（BrowserWindow.icon）
    scaled(256).save(png256, format="PNG")

    # 渲染层品牌标记：16×16 原尺寸的 data URL（顶栏用它，配合 image-rendering: pixelated 保持硬边）
    ts_dir = ROOT / "lcode" / "desktop" / "src" / "renderer" / "src" / "assets"
    ts_dir.mkdir(parents=True, exist_ok=True)
    ts_file = ts_dir / "lcodeMark.ts"
    import base64
    import io

    buf = io.BytesIO()
    base.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    ts_file.write_text(
        "/**\n"
        " * LCode 像素标记（16×16，data URL）。\n"
        " *\n"
        " * 本文件由 tools/make-app-icon.py 生成，不要手改；改图标请改脚本里的点阵/调色板后重跑。\n"
        " * 渲染时请用 16 的整数倍尺寸 + image-rendering: pixelated，否则像素风会被插值糊掉。\n"
        " */\n"
        f"export const LCODE_MARK_PNG =\n  'data:image/png;base64,{b64}'\n\n"
        "export const LCODE_MARK_SIZE = 16\n",
        encoding="utf-8",
    )

    # 自检：像素风的关键指标 = 各尺寸颜色数恒等于调色板大小（含透明）
    palette = {BG, EDGE, FG, ACCENT, (0, 0, 0, 0)}
    for s in (16, 32, 256):
        colors = set(scaled(s).convert("RGBA").getdata())
        if not colors <= palette:
            extra = len(colors - palette)
            raise SystemExit(f"[失败] {s}px 出现了 {extra} 种调色板外颜色 → 有抗锯齿，不是纯像素")
    print(f"[ok] 调色板自检通过：各尺寸仅含 {len(palette)} 种颜色（无抗锯齿）")

    for f in (ico, png, png256):
        print(f"[ok] {f.relative_to(ROOT)}  {f.stat().st_size / 1024:.1f} KB")
    print("下一步：electron-builder 自动取 build/icon.ico（win）/ icon.png（linux、mac 生成 icns）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
