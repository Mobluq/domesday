"""Builds the demo media: sample footage per room, label shots, and the evidence
frames of the demo walk of 3 October. Run from the repo root:

    python3 apps/web/scripts/make_media.py <image-library-dir> <fonts-dir>

Writes apps/web/public/media/. The clips are slow pans over still photos, standing in
for phone footage so the full pipeline (fingerprint, frame picking, recognition) can
be shown on a laptop.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LIB = Path(sys.argv[1])
FONTS = Path(sys.argv[2])
OUT = Path(__file__).resolve().parents[1] / "public" / "media"
W, H, FPS = 1280, 720, 24


def load(name):
    return Image.open(LIB / name).convert("RGB")


def sticker(tag="FA-0412"):
    """A printed asset tag: header, number and a barcode, at 4x then reduced for crisp edges."""
    s = 4
    w, h = 132 * s, 62 * s
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=5 * s, fill=(250, 250, 246, 255), outline=(40, 44, 40, 255), width=2 * s)
    small = ImageFont.truetype(str(FONTS / "atk-700.ttf"), 8 * s)
    big = ImageFont.truetype(str(FONTS / "atkm-500.ttf"), 19 * s)
    d.text((8 * s, 5 * s), "ASSET TAG", font=small, fill=(60, 64, 60, 255))
    d.text((8 * s, 15 * s), tag, font=big, fill=(20, 24, 21, 255))
    x = 8 * s
    pattern = [2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 1, 2, 3, 1]
    for i, bw in enumerate(pattern):
        if i % 2 == 0:
            d.rectangle((x, 41 * s, x + bw * s - 1, 56 * s), fill=(20, 24, 21, 255))
        x += bw * s
        if x > w - 10 * s:
            break
    return im.resize((132, 62), Image.LANCZOS)


def with_tag(img, at, scale=1.0, angle=0.0):
    tag = sticker()
    if scale != 1.0:
        tag = tag.resize((int(tag.width * scale), int(tag.height * scale)), Image.LANCZOS)
    if angle:
        tag = tag.rotate(angle, resample=Image.BICUBIC, expand=True)
    out = img.copy()
    shadow = Image.new("RGBA", tag.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 70), mask=tag.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(2))
    out.paste(shadow, (at[0] + 2, at[1] + 2), shadow)
    out.paste(tag, at, tag)
    return out


def ease(t):
    return t * t * (3 - 2 * t)


def frame(img, box):
    x, y, w, h = box
    return img.crop((int(x), int(y), int(x + w), int(y + h))).resize((W, H), Image.LANCZOS)


def segment(img, start, end, seconds):
    n = max(2, int(seconds * FPS))
    for i in range(n):
        t = ease(i / (n - 1))
        box = [a + (b - a) * t for a, b in zip(start, end)]
        yield frame(img, box)


def clip(name, segments, fade=6):
    """segments: list of (image, start_box, end_box, seconds). Short crossfades between them."""
    path = OUT / "samples" / f"{name}.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-profile:v", "main",
        "-movflags", "+faststart", "-an", str(path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    prev_tail = []
    poster = None
    for si, (img, a, b, secs) in enumerate(segments):
        frames = list(segment(img, a, b, secs))
        if si == 1 and poster is None:
            poster = frames[0]
        if prev_tail:
            for k in range(min(fade, len(frames))):
                alpha = (k + 1) / (fade + 1)
                frames[k] = Image.blend(prev_tail[k], frames[k], alpha)
        body = frames[:-fade] if si < len(segments) - 1 else frames
        for f in body:
            proc.stdin.write(f.tobytes())
        prev_tail = frames[-fade:]
    proc.stdin.close()
    proc.wait()
    # A VP9 copy for browsers without H.264 (some Linux builds of Chromium).
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0",
                    "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-an", str(path.with_suffix(".webm"))], check=True)
    if poster is None:
        poster = frame(segments[0][0], segments[0][1])
    poster.resize((480, 270), Image.LANCZOS).save(OUT / "samples" / f"{name}.jpg", quality=82)
    print(name, path.stat().st_size // 1024, "KB")


def full(img, aspect=16 / 9):
    """The largest centred box of the given aspect."""
    w, h = img.size
    if w / h > aspect:
        bw, bh = h * aspect, h
    else:
        bw, bh = w, w / aspect
    return [(w - bw) / 2, (h - bh) / 2, bw, bh]


def zoom(box, f, cx=0.5, cy=0.5):
    x, y, w, h = box
    nw, nh = w / f, h / f
    return [x + (w - nw) * cx, y + (h - nh) * cy, nw, nh]


def evidence(name, img, size=(960, 720)):
    path = OUT / "walk-2026-10-03" / f"{name}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    w, h = img.size
    target = size[0] / size[1]
    box = full(img, target)
    img.crop([int(v) for v in (box[0], box[1], box[0] + box[2], box[1] + box[3])]).resize(size, Image.LANCZOS).save(path, quality=84)


def main():
    proj_after = with_tag(load("f-projector-2.jpg"), (36, 176), scale=1.0, angle=-4)
    proj_before = with_tag(load("f-projector.jpg"), (30, 190), scale=1.0, angle=-3)
    wide = load("room204-wide.jpg")

    # Sample footage for the current walk.
    clip("room-204", [
        (wide, [0, 120, 840, 472], [340, 150, 840, 472], 4.0),
        (load("f-armchair.jpg"), full(load("f-armchair.jpg")), zoom(full(load("f-armchair.jpg")), 1.25, 0.4, 0.6), 2.4),
        (load("f-floorlamp.jpg"), full(load("f-floorlamp.jpg")), zoom(full(load("f-floorlamp.jpg")), 1.2, 0.3, 0.3), 2.2),
        (load("f-wallart.jpg"), full(load("f-wallart.jpg")), zoom(full(load("f-wallart.jpg")), 1.2, 0.5, 0.3), 2.0),
        (load("f-tv-after.jpg"), full(load("f-tv-after.jpg")), zoom(full(load("f-tv-after.jpg")), 1.15), 2.4),
        (load("f-bed.jpg"), full(load("f-bed.jpg")), zoom(full(load("f-bed.jpg")), 1.2, 0.5, 0.6), 2.4),
        (load("f-bedlamp.jpg"), full(load("f-bedlamp.jpg")), zoom(full(load("f-bedlamp.jpg")), 1.2, 0.4, 0.5), 1.8),
    ])
    clip("room-112", [
        (load("f-ac-worse.jpg"), full(load("f-ac-worse.jpg")), zoom(full(load("f-ac-worse.jpg")), 1.2, 0.5, 0.35), 4.0),
        (load("f-ac-badge.jpg"), full(load("f-ac-badge.jpg")), zoom(full(load("f-ac-badge.jpg")), 1.3, 0.25, 0.5), 2.6),
        (load("f-ac.jpg"), zoom(full(load("f-ac.jpg")), 1.1, 0.5, 0.2), zoom(full(load("f-ac.jpg")), 1.25, 0.6, 0.25), 1.6),
    ])
    clip("boardroom", [
        (load("f-meeting.jpg"), full(load("f-meeting.jpg")), zoom(full(load("f-meeting.jpg")), 1.25, 0.6, 0.6), 4.2),
        (proj_after, full(proj_after), zoom(full(proj_after), 1.3, 0.15, 0.75), 3.4),
    ])
    clip("training-room", [
        (load("f-chairs-after.jpg"), full(load("f-chairs-after.jpg")), zoom(full(load("f-chairs-after.jpg")), 1.08, 0.5, 0.6), 3.4),
        (load("f-chairs-after.jpg"), zoom(full(load("f-chairs-after.jpg")), 1.08, 0.5, 0.6), zoom(full(load("f-chairs-after.jpg")), 1.3, 0.85, 0.7), 3.0),
    ])
    clip("corridor-2", [
        (load("f-extinguisher.jpg"), full(load("f-extinguisher.jpg")), zoom(full(load("f-extinguisher.jpg")), 1.3, 0.4, 0.3), 3.4),
        (load("f-gauge-red.jpg"), full(load("f-gauge-red.jpg")), zoom(full(load("f-gauge-red.jpg")), 1.25, 0.3, 0.4), 3.0),
    ])
    clip("plant-room", [
        (load("f-generator.jpg"), full(load("f-generator.jpg")), zoom(full(load("f-generator.jpg")), 1.3, 0.5, 0.5), 5.0),
    ])

    # Label shot for Room 112: the rating plate, as a high-resolution still.
    label = load("f-label.jpg")
    label.resize((1280, 960), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=2, percent=60)).save(
        OUT / "samples" / "room-112-label.jpg", quality=90)

    # Evidence frames of the demo walk of 3 October.
    evidence("television", load("f-tv-before.jpg"))
    evidence("bed", load("f-bed.jpg"))
    evidence("armchair", load("f-armchair.jpg"))
    evidence("framed-print", load("f-wallart.jpg"))
    evidence("bedside-lamps", load("f-bedlamp.jpg"))
    evidence("air-conditioner", load("f-ac.jpg"))
    evidence("ac-badge", load("f-ac-badge.jpg"), size=(960, 720))
    evidence("ac-label", label)
    evidence("meeting-room", load("f-meeting.jpg"))
    evidence("projector", proj_before)
    evidence("training-room", load("f-chairs-before.jpg"))
    evidence("extinguisher", load("f-extinguisher.jpg"))
    evidence("generator", load("f-generator.jpg"))
    print("done")


if not (len(sys.argv) > 3 and sys.argv[3] == 'cctv'):
    main()


def cctv_still(src_name, label, stamp, out_name, crop=None):
    """A camera still for the demo: wide-angle look, flat colour, noise and the recorder's caption."""
    import random
    img = load(src_name)
    if crop:
        img = img.crop(crop)
    img = img.resize((1280, 720), Image.LANCZOS)
    # Barrel distortion by remapping rows and columns (a cheap wide-lens look).
    import math
    w, h = img.size
    src = img.load()
    out = Image.new("RGB", (w, h))
    dst = out.load()
    k = 0.12
    for y in range(h):
        ny = (y - h / 2) / (h / 2)
        for x in range(w):
            nx = (x - w / 2) / (w / 2)
            r2 = nx * nx + ny * ny
            f = 1 + k * r2
            sx = int((nx / f) * (w / 2) * 0.94 + w / 2)
            sy = int((ny / f) * (h / 2) * 0.94 + h / 2)
            dst[x, y] = src[min(w - 1, max(0, sx)), min(h - 1, max(0, sy))]
    grey = out.convert("L").convert("RGB")
    out = Image.blend(out, grey, 0.7)
    tint = Image.new("RGB", (w, h), (30, 44, 38))
    out = Image.blend(out, tint, 0.08)
    rnd = random.Random(out_name)
    noise = Image.effect_noise((w, h), 18).convert("RGB")
    out = Image.blend(out, noise, 0.06)
    vign = Image.new("L", (w, h), 0)
    vd = ImageDraw.Draw(vign)
    vd.ellipse((-w * 0.15, -h * 0.25, w * 1.15, h * 1.25), fill=255)
    vign = vign.filter(ImageFilter.GaussianBlur(120))
    out = Image.composite(out, Image.new("RGB", (w, h), (8, 10, 9)), vign)
    d = ImageDraw.Draw(out)
    font = ImageFont.truetype(str(FONTS / "atkm-500.ttf"), 26)
    for (tx, ty, text) in [(28, 22, label), (w - 28, 22, stamp)]:
        bbox = d.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        x = tx if tx < w / 2 else tx - tw
        d.text((x + 2, ty + 2), text, font=font, fill=(0, 0, 0))
        d.text((x, ty), text, font=font, fill=(236, 240, 232))
    _ = rnd
    path = OUT / "cctv" / out_name
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path, quality=84)
    print("cctv", out_name)


if len(sys.argv) > 3 and sys.argv[3] == "cctv":
    cctv_still("f-generator.jpg", "CAM 02  PLANT ROOM", "2026-11-04  02:00:07", "cam-02-plant-room.jpg")
    cctv_still("f-meeting.jpg", "CAM 01  BOARDROOM", "2026-11-04  02:00:04", "cam-01-boardroom.jpg")
    cctv_still("f-chairs-after.jpg", "CAM 03  TRAINING ROOM", "2026-11-04  02:00:11", "cam-03-training-room.jpg")
