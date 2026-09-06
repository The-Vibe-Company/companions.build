#!/usr/bin/python3
"""One bounded screenshot of the shared X display; only the GUI broker can invoke it."""
import ctypes
import os
import re

display = os.environ.get('DISPLAY', ':0')
if not re.fullmatch(r':\d+(?:\.\d+)?', display):
    raise SystemExit('INVALID_DESKTOP_DISPLAY')
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
connection = x.XOpenDisplay(display.encode())
if not connection:
    raise SystemExit('DESKTOP_UNAVAILABLE')
for name in ['XDisplayWidth', 'XDisplayHeight']:
    getattr(x, name).argtypes = [ctypes.c_void_p, ctypes.c_int]
    getattr(x, name).restype = ctypes.c_int
width, height = x.XDisplayWidth(connection, 0), x.XDisplayHeight(connection, 0)
if width < 1 or height < 1 or width * height > 16_000_000:
    raise SystemExit('DESKTOP_SIZE_UNSUPPORTED')
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
x.XCloseDisplay(connection)
os.execvp('ffmpeg', ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', f'{width}x{height}',
    '-i', display, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'])
