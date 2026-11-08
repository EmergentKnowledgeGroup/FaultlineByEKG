"""Effects decided from the definition. Each of these says something the definition table might get wrong."""
import io
import json
import os
import sqlite3
import socket
import subprocess
import tempfile
import time
import asyncio
import threading
import queue
import urllib.request
import http.client
import shutil
from pathlib import Path


# E1 opened for reading, mode from a variable
def e1_open_mode_variable(p, m='r'):
    with open(p, m) as f:
        return f.read()


# E2 sqlite in memory, SELECT only: "does store" by Connection.execute
def e2_sqlite_select():
    c = sqlite3.connect(':memory:')
    return c.execute('SELECT 1').fetchone()


# case 3: cursor execute SELECT on real file
def e3_sqlite_select_file(p):
    c = sqlite3.connect(p)
    cur = c.cursor()
    cur.execute('SELECT * FROM t')
    return cur.fetchall()


# E4 StringIO write
def e4_stringio_write():
    b = io.StringIO()
    b.write('x')
    return b.getvalue()


# E5 json.dump to rebound name
def e5_rebind(p):
    with open(p, 'w') as f:
        f = io.StringIO()
        json.dump({}, f)
        return f.getvalue()


# E6 json.dump with a read-mode open: raises, never writes
def e6_read_mode_dump(p):
    with open(p, 'r') as f:
        json.dump({}, f)


# E7 subprocess.run is a real wait
def e7_subprocess_list():
    return subprocess.run(['echo', 'x'], capture_output=True)


# E8 un-awaited asyncio.sleep: no wait at all
async def e8_unawaited_sleep():
    asyncio.sleep(10)
    return 1


# E9 lock non blocking
def e9_nonblocking_acquire(l: threading.Lock):
    return l.acquire(blocking=False)


# E10 queue.get_nowait: not a wait
def e10_get_nowait(q: queue.Queue):
    return q.get_nowait()


# E11 queue get block=False
def e11_get_noblock(q: queue.Queue):
    return q.get(block=False)


# E12 Thread.join(0)
def e12_join_zero(t: threading.Thread):
    t.join(0)


# E13 time.sleep(0)
def e13_sleep_zero():
    time.sleep(0)


# E14 urllib Request: constructor, no network
def e14_request_ctor(u):
    return urllib.request.Request(u)


# E15 HTTPConnection: constructor, no network
def e15_http_ctor(h):
    return http.client.HTTPConnection(h)


# E16 socket constructor: no network yet
def e16_socket_ctor():
    return socket.socket()


# E17 os.write to stdout, "store"
def e17_os_write_stdout():
    os.write(1, b'x')


# E18 write under a constant false guard
def e18_path_touch_guard(p: Path):
    if False:
        p.write_text('x')


# E19 rmtree ignore_errors
def e19_rmtree(p):
    shutil.rmtree(p, ignore_errors=True)


# E20 shadowed module: local class named os-like
class FakeOs:
    def remove(self, p):
        return p


def e20_fake_os(p):
    os = FakeOs()
    return os.remove(p)


# E21 shadowed parameter
def e21_param_shutil(shutil, p):
    return shutil.rmtree(p)


# E22 local import alias to something pure
def e22_alias():
    import math as os2
    return os2.floor(1.5)


# E23 tempfile.TemporaryFile, nothing written
def e23_tempfile_read():
    with tempfile.TemporaryFile() as f:
        return f.tell()


# E24 sqlite commit with nothing to commit
def e24_commit(c: sqlite3.Connection):
    c.commit()


# E25 print into a StringIO: "does print" tells nobody
def e25_print_to_buffer():
    b = io.StringIO()
    print('x', file=b)
    return b.getvalue()


# E26 open in binary read
def e26_open_rb(p):
    return open(p, 'rb').read()


# E27 open positional mode via kwargs
def e27_open_kwargs(p):
    kw = {'mode': 'w'}
    with open(p, **kw) as f:
        f.write('x')
