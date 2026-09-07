#!/usr/bin/python3
"""Executor-only admin bridge. Input/output contain state, never credentials or desktop images."""
import http.client
import json
import os
import socket
import sys

if os.getuid() != 0:
    raise SystemExit('DESKTOP_ADMIN_REQUIRED')
class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(15)
        self.sock.connect('/run/companions-desktop/agent.sock' if len(sys.argv)==1 else '/run/companions-desktop-admin/control.sock')

connection = UnixConnection('localhost', timeout=15)
if len(sys.argv) == 1:
    connection.request('GET', '/state')
else:
    if len(sys.argv) != 3 or not sys.argv[1].isdigit() or sys.argv[2] not in ('true', 'false'):
        raise SystemExit('INVALID_DESKTOP_STATE')
    body = json.dumps({'generation': int(sys.argv[1]), 'taken': sys.argv[2] == 'true'})
    connection.request('PUT', '/state', body, {'Content-Type': 'application/json'})
response = connection.getresponse()
if response.status != 200:
    raise SystemExit('DESKTOP_STATE_NOT_CONFIRMED')
value = json.loads(response.read(8192))
print(json.dumps({key: value.get(key) for key in ['generation', 'taken', 'confirmed', 'bootId']}))
