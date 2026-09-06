#!/usr/bin/python3
"""Release input left by an interrupted automation before acknowledging human takeover."""
import ctypes as C
import os

x = C.CDLL('libX11.so.6'); xt = C.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[C.c_char_p]; x.XOpenDisplay.restype=C.c_void_p
display=x.XOpenDisplay(os.environ.get('DISPLAY',':0').encode())
if not display:
    raise SystemExit('DESKTOP_UNAVAILABLE')
x.XQueryKeymap.argtypes=[C.c_void_p,C.c_void_p]
x.XSync.argtypes=[C.c_void_p,C.c_int]
x.XCloseDisplay.argtypes=[C.c_void_p]
xt.XTestFakeKeyEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
xt.XTestFakeButtonEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
keys=(C.c_ubyte*32)(); x.XQueryKeymap(display,keys)
for code in range(8,256):
    if keys[code//8] & (1 << (code%8)):
        xt.XTestFakeKeyEvent(display,code,0,0)
for button in range(1,8):
    xt.XTestFakeButtonEvent(display,button,0,0)
x.XSync(display,0)
x.XCloseDisplay(display)
