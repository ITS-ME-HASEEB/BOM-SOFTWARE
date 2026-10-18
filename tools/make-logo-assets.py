#!/usr/bin/env python3
"""make-logo-assets.py — derive app logo assets from the source logo image.

Reads assets/demo-logo-raw.png (the designed mark on a plain background),
trims the empty margin, re-centres it on a square white canvas and writes:

  * app/logo.png    — 512x512 RGBA png (window icon, favicon, sidebar, invoice)
  * build/icon.ico  — multi-size Windows icon (256 png + 128/64/48/32/16 bmp)

Pure standard library: PNG decode/encode (zlib) + box-filter resampling.
Usage: python3 tools/make-logo-assets.py [source.png]
"""
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'assets' / 'demo-logo-raw.png'


# ---------------------------------------------------------------- png decode
def read_png(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a png: %s' % path)
    pos, idat, meta = 8, b'', None
    while pos < len(data):
        (ln,) = struct.unpack('>I', data[pos:pos + 4])
        typ, chunk = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, _c, _f, inter = struct.unpack('>IIBBBBB', chunk)
            if bd != 8 or inter:
                raise SystemExit('unsupported png (bit depth %d, interlace %d)' % (bd, inter))
            meta = (w, h, {0: 1, 2: 3, 4: 2, 6: 4}[ct])
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    w, h, ch = meta
    raw = zlib.decompress(idat)
    stride = w * ch
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    rgba = bytearray(w * h * 4)
    for i in range(w * h):
        if ch == 4:
            rgba[i * 4:i * 4 + 4] = out[i * 4:i * 4 + 4]
        elif ch == 3:
            rgba[i * 4:i * 4 + 3] = out[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
        elif ch == 2:
            v = out[i * 2]
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v
            rgba[i * 4 + 3] = out[i * 2 + 1]
        else:
            v = out[i]
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v
            rgba[i * 4 + 3] = 255
    return w, h, rgba


# ---------------------------------------------------------------- png encode
def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, payload):
        c = struct.pack('>I', len(payload)) + typ + payload
        return c + struct.pack('>I', zlib.crc32(typ + payload) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp)
    png += chunk(b'IEND', b'')
    path.write_bytes(png)


# ------------------------------------------------------------------- helpers
def resample(px, w, h, nw, nh):
    out = bytearray(nw * nh * 4)
    for y in range(nh):
        y0 = y * h // nh
        y1 = max(y0 + 1, (y + 1) * h // nh)
        for x in range(nw):
            x0 = x * w // nw
            x1 = max(x0 + 1, (x + 1) * w // nw)
            r = g = b = a = n = 0
            for yy in range(y0, y1):
                base = yy * w * 4
                for xx in range(x0, x1):
                    i = base + xx * 4
                    r += px[i]
                    g += px[i + 1]
                    b += px[i + 2]
                    a += px[i + 3]
                    n += 1
            o = (y * nw + x) * 4
            out[o] = r // n
            out[o + 1] = g // n
            out[o + 2] = b // n
            out[o + 3] = a // n
    return out


def trim_and_square(px, w, h):
    """Crop to the mark's bounding box and paste on a square white canvas."""
    bg = (px[0], px[1], px[2])
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        base = y * w * 4
        for x in range(w):
            i = base + x * 4
            if px[i + 3] > 24 and (abs(px[i] - bg[0]) + abs(px[i + 1] - bg[1]) + abs(px[i + 2] - bg[2])) > 60:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        raise SystemExit('source image looks empty')
    cw, chh = x1 - x0 + 1, y1 - y0 + 1
    pad = max(4, int(max(cw, chh) * 0.06))
    side = max(cw, chh) + pad * 2
    canvas = bytearray(side * side * 4)
    for i in range(0, len(canvas), 4):
        canvas[i] = canvas[i + 1] = canvas[i + 2] = 255
        canvas[i + 3] = 255
    ox, oy = (side - cw) // 2, (side - chh) // 2
    for y in range(chh):
        src = ((y0 + y) * w + x0) * 4
        dst = ((oy + y) * side + ox) * 4
        canvas[dst:dst + cw * 4] = px[src:src + cw * 4]
    return side, canvas


def ico_entry_bmp(size, px):
    stride = size * 4
    xor = bytearray()
    for y in range(size - 1, -1, -1):          # bottom-up
        row = px[y * stride:(y + 1) * stride]
        for x in range(size):                 # RGBA -> BGRA
            i = x * 4
            xor += bytes((row[i + 2], row[i + 1], row[i], row[i + 3]))
    mask_row = b'\x00' * (((size + 31) // 32) * 4)
    and_mask = mask_row * size
    payload = xor + and_mask
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(payload), 0, 0, 0, 0)
    return header + payload


def write_ico(path, sizes, master, msize):
    entries = []
    for s in sizes:
        px = master if s == msize else resample(master, msize, msize, s, s)
        if s == 256:
            entries.append((s, png_bytes(s, px), True))
        else:
            entries.append((s, ico_entry_bmp(s, px), False))
    out = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b''
    for s, payload, _ in entries:
        directory += struct.pack('<BBBBHHII', s & 255, s & 255, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
    path.write_bytes(out + directory + b''.join(p for _, p, _ in entries))


def png_bytes(size, px):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(typ, payload):
        c = struct.pack('>I', len(payload)) + typ + payload
        return c + struct.pack('>I', zlib.crc32(typ + payload) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))


def main():
    w, h, px = read_png(SRC)
    side, square = trim_and_square(px, w, h)
    logo512 = resample(square, side, side, 512, 512)
    write_png(ROOT / 'app' / 'logo.png', 512, 512, logo512)
    print('app/logo.png 512x512 written')
    master = resample(square, side, side, 256, 256)
    write_ico(ROOT / 'build' / 'icon.ico', [256, 128, 64, 48, 32, 16], master, 256)
    print('build/icon.ico written:', (ROOT / 'build' / 'icon.ico').stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
