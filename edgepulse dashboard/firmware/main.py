# EdgePulse main.py — Temperature + MAX30102 oximeter (HR / SpO2)
import gc
import sys
import utime
import ujson
import uselect
from machine import Pin

from sensor_lib import TempSensor, OximeterSensor
from signal_proc import LMSFilter, FFTProcessor, Normalizer
from tinyml import EdgeInference

LED_PIN = 2
SAMPLE_MS = 500

led = Pin(LED_PIN, Pin.OUT)
temp_sensor = TempSensor(4)
oxi_sensor = OximeterSensor()

lms_t = LMSFilter(0.01)
lms_hr = LMSFilter(0.02)
norm = Normalizer()
fft = FFTProcessor(32)
engine = EdgeInference()

enabled = {"temp": False, "hr": False}
buf = {"temp": [], "hr": []}
cmd_buf = b""
_poll = uselect.poll()
_poll.register(sys.stdin, uselect.POLLIN)


def emit(obj):
    try:
        sys.stdout.write(ujson.dumps(obj) + "\n")
    except OSError:
        pass


def sensor_map():
    return {
        "temp": temp_sensor.connected,
        "hr": oxi_sensor.connected,
    }


def refresh_hardware():
    temp_sensor._probe()
    oxi_sensor._probe()
    return sensor_map()


def handle_command(line):
    global enabled
    line = line.strip()
    if not line:
        return
    try:
        msg = ujson.loads(line)
    except ValueError:
        return
    cmd = msg.get("cmd")
    if cmd == "ping":
        emit({"e": "pong", "mp": sys.implementation.name})
        return
    if cmd == "status":
        sm = refresh_hardware()
        emit({"e": "status", "sensors": sm, "enabled": enabled})
        return
    if cmd == "set_sensor":
        sid = msg.get("id")
        on = bool(msg.get("on"))
        sm = sensor_map()
        if sid in enabled and sm.get(sid):
            enabled[sid] = on
            emit({"e": "sensor_ack", "id": sid, "on": on})
        else:
            emit({"e": "error", "msg": "sensor unavailable: " + str(sid)})
        return
    if cmd == "deploy":
        name = msg.get("file", "main.py")
        content = msg.get("content", "")
        try:
            with open(name, "w") as f:
                f.write(content)
            emit({"e": "deploy_ok", "file": name})
        except OSError as ex:
            emit({"e": "error", "msg": str(ex)})
        return
    if cmd == "reset":
        emit({"e": "info", "msg": "rebooting"})
        utime.sleep_ms(200)
        import machine

        machine.reset()


def process_sample():
    sm = sensor_map()
    readings = {}

    if enabled["temp"] and sm["temp"]:
        raw = temp_sensor.read()
        if raw is not None:
            readings["temp"] = round(lms_t.update(raw), 2)

    if enabled["hr"] and sm["hr"]:
        oxi = oxi_sensor.read()
        if oxi and oxi.get("bpm") is not None:
            bpm = lms_hr.update(oxi["bpm"])
            readings["hr"] = round(bpm, 0)
            if oxi.get("spo2") is not None:
                emit({"e": "spo2", "v": oxi["spo2"]})

    if not readings:
        return

    for k, v in readings.items():
        buf[k].append(v)
        if len(buf[k]) > 64:
            buf[k].pop(0)
        emit({"e": "reading", "s": k, "v": v})

    feats = []
    if readings.get("temp") is not None:
        feats.append(norm.scale(readings["temp"], -10, 60))
    if readings.get("hr") is not None:
        feats.append(norm.scale(readings["hr"], 40, 180))

    if len(feats) >= 2:
        mags = fft.magnitudes(feats)
        emit({"e": "fft", "bins": mags[:32]})
        result = engine.infer(readings.get("temp"), readings.get("hr"))
        if result["alert"]:
            led.on()
            emit({"e": "alert", "data": result})
        else:
            led.off()

    gc.collect()


def poll_commands():
    global cmd_buf
    if not _poll.poll(0):
        return
    try:
        chunk = sys.stdin.readline()
    except OSError:
        return
    if not chunk:
        return
    if isinstance(chunk, str):
        chunk = chunk.encode()
    cmd_buf += chunk
    while b"\n" in cmd_buf:
        line, cmd_buf = cmd_buf.split(b"\n", 1)
        try:
            handle_command(line.decode())
        except (UnicodeError, ValueError):
            pass


emit({"e": "hello", "v": "1.1", "board": "ESP32", "sensors": refresh_hardware()})
last_status = utime.ticks_ms()
last_sample = utime.ticks_ms()

while True:
    poll_commands()
    now = utime.ticks_ms()
    if utime.ticks_diff(now, last_status) > 3000:
        emit({"e": "status", "sensors": refresh_hardware(), "enabled": enabled})
        last_status = now
    if utime.ticks_diff(now, last_sample) >= SAMPLE_MS:
        process_sample()
        last_sample = now
    utime.sleep_ms(10)
