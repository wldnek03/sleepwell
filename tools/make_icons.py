#!/usr/bin/env python3
"""SleepWell 아이콘 생성 (의존성 없음, zlib로 PNG 직접 인코딩).

    python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def smooth_cover(d, edge=1.2):
    """부호 있는 거리 d(<0 = 내부)를 0..1 커버리지로. 간단한 안티앨리어싱."""
    return max(0.0, min(1.0, 0.5 - d / edge))


def render(size):
    px = bytearray()
    cx, cy = size * 0.5, size * 0.5
    moon_r = size * 0.27
    # 초승달 = 원 - 살짝 옮긴 원
    bite_r = moon_r * 0.90
    bx, by = cx + moon_r * 0.42, cy - moon_r * 0.20

    stars = [(0.74, 0.24, 0.016), (0.82, 0.40, 0.011), (0.22, 0.30, 0.013),
             (0.30, 0.72, 0.010), (0.70, 0.78, 0.012)]

    for y in range(size):
        px.append(0)  # PNG filter type 0
        v = y / (size - 1)
        for x in range(size):
            u = x / (size - 1)
            # 배경: 위에서 아래로 깊은 보라 → 거의 검정, 가운데 위쪽 발광
            glow = math.exp(-(((u - 0.5) ** 2) / 0.10 + ((v - 0.30) ** 2) / 0.14))
            r = lerp(12, 5, v) + 36 * glow
            g = lerp(9, 4, v) + 28 * glow
            b = lerp(32, 14, v) + 72 * glow

            # 별
            for sx, sy, sr in stars:
                sd = math.hypot(u - sx, v - sy) - sr
                c = smooth_cover(sd * size, 1.6)
                if c > 0:
                    r = lerp(r, 236, c * 0.75)
                    g = lerp(g, 232, c * 0.75)
                    b = lerp(b, 255, c * 0.75)

            # 초승달
            d_moon = math.hypot(x - cx, y - cy) - moon_r
            d_bite = math.hypot(x - bx, y - by) - bite_r
            cov = smooth_cover(d_moon, 1.6) * (1.0 - smooth_cover(d_bite, 1.6))
            if cov > 0:
                # 아래쪽으로 갈수록 따뜻하게
                mr = lerp(255, 252, v)
                mg = lerp(240, 214, v)
                mb = lerp(206, 160, v)
                r = lerp(r, mr, cov)
                g = lerp(g, mg, cov)
                b = lerp(b, mb, cov)

            px += bytes((int(max(0, min(255, r))), int(max(0, min(255, g))),
                         int(max(0, min(255, b))), 255))
    return bytes(px)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote %s (%d bytes)" % (path, len(png)))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, "icon-192.png"), 192)
    write_png(os.path.join(OUT, "icon-512.png"), 512)
    write_png(os.path.join(OUT, "apple-touch-icon.png"), 180)
