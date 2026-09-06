"""Generate our own tiny compressed PNG fixture with dimensions requiring resize."""
import struct
import zlib
from pathlib import Path

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

width, height = 2200, 1200
header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
pixels = (b"\x00" + b"\x40\x80\xc0" * width) * height
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
target = Path("dist/pi-bun/fixtures/large.png")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(png)
