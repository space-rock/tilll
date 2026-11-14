#!/usr/bin/env python3
"""
Draws the share image (site/public/og.png, 1200 x 630) that X and other apps show when someone posts a link to the
site or the live demo. It uses the landing page's own logo, fonts and colours (the helpers come from build.py), and
the checkout picture is the one in the page's hero, QR code included, read from site/index.html.

Same setup as build.py (Pillow, fonttools, brotli, and `pnpm install` for the fonts):
    .venv-video/bin/python scripts/video/og.py
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import FONTS, GREEN, INK, MUTED, NAVY, ROOT, font, mark, wordmark  # noqa: E402,F401

OUT = ROOT / "site/public/og.png"
W, H, S = 1200, 630, 2  # drawn at 2x and scaled down, so the edges are smooth
DEEP, MINT = (7, 20, 38), (110, 231, 183)
LINE, SLATE, SLATE_50 = (226, 232, 240), (71, 85, 105), (248, 250, 252)


def s(v: float) -> int:
    return round(v * S)


def background() -> Image.Image:
    """Navy fading to a deeper navy, with a soft mint glow behind the checkout card."""
    ramp = Image.linear_gradient("L").resize((W * S, H * S))
    img = Image.composite(Image.new("RGB", (W * S, H * S), DEEP), Image.new("RGB", (W * S, H * S), NAVY), ramp)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((s(700), s(120), s(1240), s(680)), fill=MINT + (46,))
    img.paste(glow.filter(ImageFilter.GaussianBlur(s(90))), (0, 0), glow.filter(ImageFilter.GaussianBlur(s(90))))
    return img


def qr_squares() -> list[tuple[int, int, int]]:
    """The hero's QR code as (x, y, width) runs of one module, read from the path in site/index.html."""
    html = (ROOT / "site/index.html").read_text()
    path = re.search(r'class="fill-navy"\s+d="([^"]+)"', html)
    if not path:
        raise SystemExit("site/index.html: the QR path was not found")
    runs = [(int(x), int(y), int(w)) for x, y, w in re.findall(r"M(\d+)\s(\d+)h(\d+)v1h-\d+z", path.group(1))]
    if not runs:
        raise SystemExit("site/index.html: the QR path has no runs")
    return runs


def centered(d: ImageDraw.ImageDraw, cx: float, y: float, text: str, f, fill) -> None:
    d.text((s(cx), s(y)), text, font=f, fill=fill, anchor="ms")


def checkout_card() -> Image.Image:
    """A picture of the hero's checkout window: 298 x 490, the way the landing page shows it."""
    w, h = 298, 490
    card = Image.new("RGBA", (s(w), s(h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, s(w) - 1, s(h) - 1), s(28), fill=(255, 255, 255, 255))
    # the footer band, rounded only at the bottom
    d.rounded_rectangle((0, s(h - 40), s(w) - 1, s(h) - 1), s(28), fill=SLATE_50, corners=(False, False, True, True))
    d.line((0, s(h - 40), s(w), s(h - 40)), fill=LINE, width=S)
    d.line((0, s(52), s(w), s(52)), fill=LINE, width=S)

    centered(d, w / 2, 33, "Send payment", font("inter", 600, s(17)), NAVY)
    centered(d, w / 2, 90, "SEND EXACTLY", font("inter", 700, s(12)), SLATE)
    centered(d, w / 2, 126, "5.0511 USDC", font("jetbrains-mono", 800, s(30)), NAVY)
    centered(d, w / 2, 152, "on Base", font("inter", 400, s(16)), SLATE)

    # the QR code, in a bordered box
    box = 176
    bx = (w - box) / 2
    d.rounded_rectangle((s(bx), s(170), s(bx + box), s(170 + box)), s(12), outline=LINE, width=s(1.5), fill=(255, 255, 255, 255))
    module = (box - 16) / 25
    for x, y, run in qr_squares():
        d.rectangle(
            (s(bx + 8 + x * module), s(178 + y * module), s(bx + 8 + (x + run) * module) - 1, s(178 + (y + 1) * module) - 1),
            fill=NAVY,
        )

    # the deposit address and its Copy button
    d.rounded_rectangle((s(24), s(366), s(w - 24), s(404)), s(10), fill=SLATE_50, outline=LINE, width=S)
    d.text((s(36), s(390)), "0x… deposit address", font=font("jetbrains-mono", 500, s(12)), fill=SLATE, anchor="ls")
    d.rounded_rectangle((s(w - 84), s(373), s(w - 32), s(397)), s(7), fill=(255, 255, 255, 255), outline=LINE, width=S)
    centered(d, w - 58, 390, "Copy", font("inter", 600, s(12)), NAVY)

    d.ellipse((s(52), s(425), s(62), s(435)), fill=GREEN)
    d.text((s(72), s(436)), "Waiting for your payment…", font=font("inter", 600, s(15)), fill=NAVY, anchor="ls")
    centered(d, w / 2, h - 15, "Powered by Tilll · Settled by NEAR Intents", font("inter", 500, s(11.5)), SLATE)
    return card


def main() -> int:
    img = background().convert("RGBA")

    # the card, with a soft shadow
    card = checkout_card()
    cx, cy = s(826), s(70)
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((cx, cy + s(18), cx + card.width, cy + card.height + s(18)), s(28), fill=(0, 0, 0, 120))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(s(26))))
    img.alpha_composite(card, (cx, cy))

    d = ImageDraw.Draw(img)
    wordmark(img, s(72), s(64), s(56))

    # the headline: the landing page's, with the key words in mint
    head = font("manrope", 800, s(66))
    lines = [[("Get paid in crypto,", INK)], [("from ", INK), ("any chain", MINT), (".", INK)]]
    y = s(262)
    for line in lines:
        x = s(72)
        for text, fill in line:
            d.text((x, y), text, font=head, fill=fill, anchor="ls")
            x += d.textlength(text, font=head)
        if x > s(780):
            raise SystemExit(f"the headline is {x / S:.0f}px wide and runs into the card")
        y += s(80)

    sub = font("inter", 400, s(27))
    for i, text in enumerate(["A free, open-source checkout you run yourself.", "Powered by NEAR Intents."]):
        d.text((s(72), s(406) + i * s(40)), text, font=sub, fill=MUTED, anchor="ls")

    # a quiet strip of the chains, under the copy
    chips = font("inter", 600, s(17))
    x = s(72)
    for name in ["Ethereum", "Base", "Solana", "Bitcoin", "NEAR"]:
        wd = d.textlength(name, font=chips)
        d.rounded_rectangle((x, s(494), x + wd + s(28), s(532)), s(19), outline=(60, 86, 122), width=S)
        d.text((x + s(14), s(519)), name, font=chips, fill=MUTED, anchor="ls")
        x += wd + s(28) + s(10)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
