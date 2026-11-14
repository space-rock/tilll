#!/usr/bin/env python3
"""
Builds the demo video from the stills in brand/mainnet-recording/video-src/: one captioned scene after another, with
a short fade between them. No audio: add your own narration on top (the lines are in scripts/demo-video.md).

The logo and the type are the website's: the mark is drawn from brand/tilll-mark.svg, the wordmark and titles are
Manrope ExtraBold, the captions are Inter (both from node_modules/@fontsource-variable, so run `pnpm install` first).

Needs ffmpeg, Pillow, fonttools and brotli (fonttools turns the .woff2 files into fonts Pillow can read):
    python3 -m venv .venv-video && .venv-video/bin/pip install pillow fonttools brotli
    .venv-video/bin/python scripts/video/build.py          # writes brand/mainnet-recording/tilll-demo.mp4

Edit SCENES to change the order, the captions or how long each one stays. A scene is a still, a duration in seconds
(before SPEED is applied), a caption and an optional crop box (left, top, right, bottom) for stills that are mostly
empty. `code:embed` is the integration snippet, drawn here from the README's Embed section.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "brand/mainnet-recording/video-src"
OUT = ROOT / "brand/mainnet-recording/tilll-demo.mp4"
W, H, FPS, FADE = 1920, 1080, 30, 0.3
SPEED = 1.25  # every scene plays this much faster than the durations below
NAVY, INK, MUTED, GREEN = (11, 31, 58), (255, 255, 255), (178, 192, 214), (5, 150, 105)
FONTS = ROOT / "node_modules/@fontsource-variable"

CENTER = (330, 0, 1084, 820)  # the checkout card, out of a 1414 x 820 page
WALLET = (214, 20, 814, 868)  # the Intear column, out of a 1028 x 868 page
SHOP = (419, 173, 995, 647)  # the demo shop's card, out of a 1414 x 820 page

# (file or None for a text card, seconds, caption, crop)
SCENES = [
    (None, 4.5, ("Tilll", "Self-hosted crypto checkout, settled by NEAR Intents", 150), None),
    ("highlights", 8.0, "", None),
    ("code:embed", 7.0, "One script tag and one button add it to your shop.", None),
    ("00b-demo-shop.jpg", 3.5, "Your shop, your page. (A demo shop on a mock network.)", SHOP),
    ("00c-demo-shop-checkout.jpg", 4.5, "The button opens the checkout as a dialog. Or share the hosted payment link.", SHOP),
    ("01-pay-first-screen.jpg", 5.5, "From here on it's real: a customer opens a payment link on mainnet.", CENTER),
    ("02-pay-network.jpg", 3.5, "They pick the network they're paying from…", CENTER),
    ("03-pay-token.jpg", 3.5, "…and the token.", CENTER),
    ("04-pay-refund-address.jpg", 4.5, "One address for refunds. That's all we ask for.", CENTER),
    ("05-pay-send-payment.jpg", 6.0, "One payment address and the exact amount. Scan it or copy it.", CENTER),
    ("06-intear-confirm.jpg", 4.5, "They send it from their own wallet. Here, from NEAR.", WALLET),
    ("07-intear-sent.jpg", 3.0, "Sent.", WALLET),
    ("08-pay-received.jpg", 5.0, "Payment received.", CENTER),
    ("09-dashboard-invoice-paid.jpg", 6.0, "Paid in your dashboard, with NEAR Intents' signature verified.", None),
    ("10-dashboard-overview.jpg", 6.0, "The money lands in your own NEAR Intents balance. No middleman.", None),
    ("11-dashboard-webhook.jpg", 5.5, "Your server is told by a signed webhook.", None),
    ("12-dashboard-invoice-base.jpg", 5.0, "Customers can pay from other chains too. Here, 0.20 USDC from Base.", None),
    ("13-basescan-tx.jpg", 5.0, "On Base: 0.202064 USDC. Settled into USDC on NEAR.", None),
    ("14-dashboard-refund-timeline.jpg", 6.0, "Refunds are approved by your wallet. Tilll holds no spending key.", None),
    ("15-dashboard-refunds.jpg", 4.5, "Refund completed: 0.1 USDC back to the customer.", None),
    ("16-nearblocks-refund-tx.jpg", 5.0, "Real transactions, on mainnet.", None),
    (None, 6.0, ("Open source. Self-hosted.", "Built at NEAR HACKATHON  ·  #NEARHackathon", 104), None),
]


_TTF: dict[str, Path] = {}


def font(family: str, weight: int, size: int) -> ImageFont.FreeTypeFont:
    """A weight of one of the site's variable fonts (`manrope`, `inter` or `jetbrains-mono`)."""
    if family not in _TTF:
        out = Path(tempfile.gettempdir()) / f"tilll-video-{family}.ttf"
        if not out.exists():
            ttf = TTFont(FONTS / family / "files" / f"{family}-latin-wght-normal.woff2")
            ttf.flavor = None
            ttf.save(out)
        _TTF[family] = out
    f = ImageFont.truetype(str(_TTF[family]), size)
    f.set_variation_by_axes([weight])
    return f


CODE = [
    ("c", "<!-- Your server creates the invoice. The page only gets its id. -->"),
    ("t", '<script src="https://pay.example.com/checkout.js"></script>'),
    ("t", '<button data-tilll-invoice="inv_...">Pay with crypto</button>'),
    ("t", ""),
    ("c", "<!-- No site to edit? Share the hosted payment page. -->"),
    ("t", "https://pay.example.com/pay/inv_..."),
]


def code_image() -> Image.Image:
    """The README's embed snippet on a code panel. Strings are green, comments dim."""
    f = font("jetbrains-mono", 500, 34)
    img = Image.new("RGB", (1560, 56 + 56 * len(CODE) + 24), (7, 22, 44))
    d = ImageDraw.Draw(img)
    for row, (kind, text) in enumerate(CODE):
        x, y = 60, 52 + row * 56
        if kind == "c":
            d.text((x, y), text, font=f, fill=(122, 148, 186))
            continue
        for part in re.split(r'("[^"]*")', text):
            d.text((x, y), part, font=f, fill=(110, 231, 183) if part.startswith('"') else INK)
            x += d.textlength(part, font=f)
    return img


# What Tilll offers, as (title, one line). Every line is a claim the README makes or the mainnet run showed. There is
# deliberately nothing about confidential payments: the balance and the deposits are public (see NOTES.md).
HIGHLIGHTS = [
    ("Self-hosted", "One container, your server, your keys"),
    ("Open source", "MIT licensed. Free to change"),
    ("Pay from any chain, with any token", "EVM chains, Solana, NEAR, Bitcoin, Tron and more"),
    ("Settle in the asset you choose", "USDC on NEAR by default, or any asset NEAR Intents lists"),
    ("Paid into your own account", "Your NEAR Intents balance. No middleman"),
    ("No fee of its own", "Tilll adds none. The swap fee is shown up front"),
    ("Refunds on the customer's chain", "Full or partial, in the token they paid with"),
    ("You approve every refund", "Your wallet signs. Tilll holds no spending key"),
    ("Signed webhooks", "HMAC-signed, retried, with resend"),
    ("Easy to integrate", "One script tag, a hosted page, or the API"),
    ("A private checkout", "No account, name, email or cookie"),
    ("Proven on mainnet", "Real payments and a real refund, with the transactions"),
]


def highlights_image() -> Image.Image:
    """The whole product on one screen: 4 x 3 tiles, each a green check, a short title and one line."""
    frame = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(frame)
    wordmark(frame, 56, 40, 52)
    d.text((W / 2, 92), "Everything you need to get paid", font=font("manrope", 800, 56), fill=INK, anchor="mm")
    cols, tile_w, tile_h, gap = 4, 420, 262, 22
    left, top = (W - (cols * tile_w + (cols - 1) * gap)) // 2, 168
    title_f, line_f = font("manrope", 700, 36), font("inter", 400, 25)
    for i, (title, line) in enumerate(HIGHLIGHTS):
        x, y = left + (i % cols) * (tile_w + gap), top + (i // cols) * (tile_h + gap)
        d.rounded_rectangle((x, y, x + tile_w, y + tile_h), 22, fill=(15, 40, 74), outline=(58, 82, 120), width=2)
        cx, cy = x + 52, y + 50  # the check: a green disc with a white tick
        d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), fill=GREEN)
        d.line([(cx - 10, cy), (cx - 3, cy + 8), (cx + 11, cy - 8)], fill=INK, width=5, joint="curve")
        lines = wrap(d, title, title_f, tile_w - 56)
        for n, t in enumerate(lines):
            d.text((x + 28, y + 92 + n * 42), t, font=title_f, fill=INK, anchor="lt")
        desc_top = y + 92 + len(lines) * 42 + 8
        for n, t in enumerate(wrap(d, line, line_f, tile_w - 56)):
            d.text((x + 28, desc_top + n * 32), t, font=line_f, fill=MUTED, anchor="lt")
    return frame


def mark(size: int) -> Image.Image:
    """The Tilll mark (brand/tilll-mark-white.svg), drawn at 8x and scaled down so the edges are smooth."""
    k = size * 8 / 48
    img = Image.new("RGBA", (size * 8, size * 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4 * k, 14 * k, 44 * k, 44 * k), 8 * k, fill=INK)
    d.rounded_rectangle((13 * k, 23 * k, 35 * k, 27 * k), 2 * k, fill=(0, 0, 0, 0))  # the slot is a hole
    d.ellipse((19 * k, 3 * k, 29 * k, 13 * k), fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


def wordmark(frame: Image.Image, x: int, y: int, height: int) -> int:
    """Mark and `tilll` side by side, `y` being the top. Returns the width used."""
    frame.paste(mark(height), (x, y), mark(height))
    size = round(height * 40 / 48)
    f = font("manrope", 800, size)
    d = ImageDraw.Draw(frame)
    cx = x + height + round(height * 8 / 48)
    baseline = y + round(height * 40 / 48)
    for ch in "tilll":  # letter spacing is -0.04 em in the logo
        d.text((cx, baseline), ch, font=f, fill=INK, anchor="ls")
        cx += d.textlength(ch, font=f) - size * 0.04
    return cx - x


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def card(title: str, subtitle: str, size: int) -> Image.Image:
    frame = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(frame)
    height, top = (190, H // 2 - 170) if title == "Tilll" else (90, 230)  # the logo is the title on the first card
    width = int(wordmark(Image.new("RGB", (W, H)), 0, 0, height))
    wordmark(frame, (W - width) // 2, top, height)
    if title != "Tilll":
        ImageDraw.Draw(frame).text((W / 2, H / 2 + 20), title, font=font("manrope", 800, size), fill=INK, anchor="mm")
    ImageDraw.Draw(frame).text((W / 2, H / 2 + (120 if title == "Tilll" else 175)), subtitle, font=font("inter", 400, 46), fill=MUTED, anchor="mm")
    return frame


def scene(path: str, caption: str, crop) -> Image.Image:
    frame = Image.new("RGB", (W, H), NAVY)
    shot = code_image() if path == "code:embed" else Image.open(SRC / path).convert("RGB")
    if crop:
        shot = shot.crop(crop)
    box_w, box_h = W - 220, 820
    scale = min(box_w / shot.width, box_h / shot.height)
    shot = shot.resize((round(shot.width * scale), round(shot.height * scale)), Image.LANCZOS)
    x, y = (W - shot.width) // 2, 50 + (box_h - shot.height) // 2  # short pictures sit in the middle of the space
    shadow = Image.new("RGBA", (shot.width + 80, shot.height + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((40, 50, 40 + shot.width, 50 + shot.height), 18, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    frame.paste(shadow, (x - 40, y - 40), shadow)
    frame.paste(rounded(shot, 14), (x, y), rounded(shot, 14))
    ImageDraw.Draw(frame).rounded_rectangle((x, y, x + shot.width, y + shot.height), 14, outline=(70, 92, 128), width=2)
    d = ImageDraw.Draw(frame)
    wordmark(frame, 56, 40, 52)
    f = font("inter", 500, 46)
    lines = wrap(d, caption, f, W - 360)
    top = 905 + (110 - len(lines) * 58) // 2
    for i, line in enumerate(lines):
        d.text((W / 2, top + i * 58), line, font=f, fill=INK, anchor="mt")
    return frame


def main() -> int:
    missing = [s[0] for s in SCENES if s[0] and s[0] != "highlights" and not s[0].startswith("code:") and not (SRC / s[0]).exists()]
    if missing:
        print("Missing stills:", ", ".join(missing))
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        clips = []
        for i, (path, length, caption, crop) in enumerate(SCENES):
            seconds = length / SPEED
            if path is None:
                frame = card(*caption)
            elif path == "highlights":
                frame = highlights_image()
            else:
                frame = scene(path, caption, crop)
            png, clip = Path(tmp) / f"{i:02d}.png", Path(tmp) / f"{i:02d}.mp4"
            frame.save(png)
            fades = f"fade=t=in:st=0:d={FADE},fade=t=out:st={seconds - FADE}:d={FADE}"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", str(FPS), "-t", str(seconds), "-i", str(png),
                 "-vf", f"{fades},format=yuv420p", "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-r", str(FPS), str(clip)],
                check=True,
            )
            clips.append(clip)
        listing = Path(tmp) / "list.txt"
        listing.write_text("".join(f"file '{c}'\n" for c in clips))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy",
             "-movflags", "+faststart", str(OUT)],
            check=True,
        )
    total = sum(s[1] for s in SCENES) / SPEED
    print(f"{OUT.relative_to(ROOT)}  {total:.0f} s, {W}x{H}, {FPS} fps, no audio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
