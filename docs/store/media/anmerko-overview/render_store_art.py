#!/usr/bin/env python3
"""Render the existing store-promo composition with the product's native vector palette."""
from pathlib import Path
import argparse
import skia
from PIL import Image

BLUE = skia.Color(52, 94, 233)
WHITE = skia.ColorWHITE
FONT_MANAGER = skia.FontMgr.RefDefault()

def typeface(weight):
    style = skia.FontStyle(weight, skia.FontStyle.kNormal_Width, skia.FontStyle.kUpright_Slant)
    return FONT_MANAGER.matchFamilyStyle("SF Pro Display", style) or FONT_MANAGER.matchFamilyStyle("Helvetica Neue", style)

def label(canvas, value, x, y, size, weight=400):
    canvas.drawString(value, x, y, skia.Font(typeface(weight), size), skia.Paint(Color=WHITE, AntiAlias=True))

def arrow(canvas, x, y, scale):
    path = skia.Path()
    path.moveTo(x + 35 * scale, y + 86 * scale); path.lineTo(x + 86 * scale, y + 35 * scale)
    path.moveTo(x + 40 * scale, y + 35 * scale); path.lineTo(x + 86 * scale, y + 35 * scale); path.lineTo(x + 86 * scale, y + 81 * scale)
    paint = skia.Paint(Color=WHITE, AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=12 * scale)
    paint.setStrokeCap(skia.Paint.kRound_Cap); paint.setStrokeJoin(skia.Paint.kRound_Join)
    canvas.drawPath(path, paint)

def save(surface, path, jpeg=False):
    image = Image.fromarray(surface.makeImageSnapshot().toarray()[:, :, :3])
    image.save(path, quality=95, subsampling=0) if jpeg else image.save(path)

def render(out):
    promo = skia.Surface(440, 280); c = promo.getCanvas(); c.clear(BLUE)
    arrow(c, 185, 58, .58)
    name = "anmerko"; font = skia.Font(typeface(700), 38); x = (440 - font.measureText(name)) / 2
    label(c, name, x, 187, 38, 700); label(c, "Website feedback, ready to share.", 97, 219, 17)
    save(promo, out / "promo-440x280.png")

    marquee = skia.Surface(1400, 560); c = marquee.getCanvas()
    shader = skia.GradientShader.MakeRadial((700, 265), 820, [skia.Color(40, 92, 245), BLUE], [0, 1])
    c.drawPaint(skia.Paint(Shader=shader))
    arrow(c, 146, 97, 2.89)
    label(c, name, 493, 257, 120, 700)
    label(c, "Turn website feedback", 495, 331, 56, 500)
    label(c, "into an AI prompt.", 495, 399, 56, 500)
    save(marquee, out / "marquee-1400x560.jpg", jpeg=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True); render(args.output_dir)
