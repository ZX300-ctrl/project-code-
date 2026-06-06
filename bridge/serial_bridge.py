#!/usr/bin/env python3
"""
EdgePulse server — dashboard (HTTP :8080) + ESP32 bridge (WebSocket :8765).
Run:  python serial_bridge.py
Open:  http://127.0.0.1:8080/
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import serial
import serial.tools.list_ports

try:
    from websockets.asyncio.server import serve as ws_serve
except ImportError:
    from websockets import serve as ws_serve  # type: ignore

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
FIRMWARE = ROOT / "firmware"
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8080
WS_PORT = 8765

ESP32_VIDS = {0x10C4, 0x1A86, 0x0403, 0x303A, 0x2341}


def find_esp32_port() -> str | None:
    for p in serial.tools.list_ports.comports():
        if p.vid in ESP32_VIDS:
            return p.device
        if p.description and re.search(r"esp|ch340|cp210|usb\s*serial|uart", p.description, re.I):
            return p.device
    return None


def resolve_file(url_path: str) -> Path | None:
    path = unquote(urlparse(url_path).path)
    if path.startswith("/firmware/"):
        target = FIRMWARE / path[len("/firmware/") :].lstrip("/")
    elif path in ("", "/"):
        target = DASHBOARD / "index.html"
    else:
        target = DASHBOARD / path.lstrip("/")
    target = target.resolve()
    try:
        target.relative_to(ROOT.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        if args and str(args[0]).startswith("4"):
            sys.stderr.write(f"[HTTP] {fmt % args}\n")

    def do_GET(self) -> None:
        fp = resolve_file(self.path)
        if not fp:
            self.send_error(404, "Not found")
            return
        data = fp.read_bytes()
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


class SerialSession:
    def __init__(self) -> None:
        self.port: serial.Serial | None = None
        self.lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.out_queue: asyncio.Queue[str] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    def open(self, device: str, baud: int = 115200) -> None:
        self.close()
        self.port = serial.Serial(device, baudrate=baud, timeout=0.1)
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader_thread, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self.port and self.port.is_open:
            try:
                self.port.close()
            except serial.SerialException:
                pass
        self.port = None

    def _reader_thread(self) -> None:
        buf = b""
        while not self._stop.is_set():
            if not self.port or not self.port.is_open:
                break
            try:
                chunk = self.port.read(512)
            except serial.SerialException:
                break
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode(errors="ignore").strip()
                if text and self.out_queue and self.loop:
                    asyncio.run_coroutine_threadsafe(self.out_queue.put(text), self.loop)

    def write_line(self, obj: dict) -> None:
        if not self.port or not self.port.is_open:
            raise RuntimeError("Serial not open")
        line = json.dumps(obj) + "\n"
        with self.lock:
            self.port.write(line.encode())


session = SerialSession()
clients: set = set()
out_queue: asyncio.Queue[str] | None = None


async def broadcast(message: str) -> None:
    if not clients:
        return
    dead = []
    for ws in list(clients):
        try:
            await ws.send(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def queue_pump() -> None:
    while True:
        if out_queue is None:
            await asyncio.sleep(0.1)
            continue
        line = await out_queue.get()
        await broadcast(line)


async def usb_watch_loop() -> None:
    last = None
    while True:
        port = find_esp32_port()
        if port != last:
            last = port
            await broadcast(json.dumps({"bridge": "usb", "present": port is not None, "port": port}))
        await asyncio.sleep(1.0)


async def ws_handler(websocket) -> None:
    clients.add(websocket)
    try:
        port = find_esp32_port()
        await websocket.send(json.dumps({"bridge": "usb", "present": port is not None, "port": port}))
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            action = msg.get("action")
            if action == "connect":
                device = msg.get("port") or find_esp32_port()
                if not device:
                    await websocket.send(json.dumps({"bridge": "error", "msg": "No ESP32 COM port found"}))
                    continue
                try:
                    session.open(device, int(msg.get("baud", 115200)))
                    await websocket.send(json.dumps({"bridge": "connected", "port": device}))
                except serial.SerialException as ex:
                    await websocket.send(json.dumps({"bridge": "error", "msg": str(ex)}))
            elif action == "disconnect":
                session.close()
                await websocket.send(json.dumps({"bridge": "disconnected"}))
            elif action == "cmd":
                try:
                    session.write_line(msg.get("payload", {}))
                except RuntimeError as ex:
                    await websocket.send(json.dumps({"bridge": "error", "msg": str(ex)}))
    except Exception as ex:
        if "ConnectionClosed" not in type(ex).__name__:
            sys.stderr.write(f"[WS] {ex}\n")
    finally:
        clients.discard(websocket)


def start_http() -> None:
    httpd = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), DashboardHandler)
    print(f"Dashboard:  http://{HTTP_HOST}:{HTTP_PORT}/")
    httpd.serve_forever()


async def main() -> None:
    global out_queue
    loop = asyncio.get_running_loop()
    out_queue = asyncio.Queue()
    session.loop = loop
    session.out_queue = out_queue

    threading.Thread(target=start_http, daemon=True).start()
    print(f"WebSocket:  ws://{HTTP_HOST}:{WS_PORT}")
    print("Press Ctrl+C to stop.\n")

    async with ws_serve(ws_handler, HTTP_HOST, WS_PORT):
        await asyncio.gather(usb_watch_loop(), queue_pump())


if __name__ == "__main__":
    if not DASHBOARD.is_dir():
        sys.stderr.write(f"Missing dashboard folder: {DASHBOARD}\n")
        sys.exit(1)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
    except OSError as ex:
        if getattr(ex, "winerror", None) == 10048 or ex.errno in (48, 98):
            sys.stderr.write(
                f"\nPort {HTTP_PORT} or {WS_PORT} is already in use.\n"
                f"Close the other EdgePulse server, then run again.\n"
            )
        else:
            raise
