"""Wait for durable supervisor ownership before replacing this process with a service."""
import os
import sys

gate = int(sys.argv[1])
try:
    permitted = os.read(gate, 1) == b'1'
finally:
    os.close(gate)
if permitted:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
