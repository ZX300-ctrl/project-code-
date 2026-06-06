# sensor_lib.py — Temperature (DHT22) + Pulse oximeter (MAX30102)
from machine import Pin, I2C
import utime
import math

try:
    from dht import DHT22
except ImportError:
    DHT22 = None


class TempSensor:
    """DHT22 on GPIO4."""

    def __init__(self, pin=4):
        self.connected = False
        self.last_temp = None
        self._sensor = None
        if DHT22 is None:
            return
        try:
            self._sensor = DHT22(Pin(pin))
            self._probe()
        except OSError:
            self._sensor = None

    def _probe(self, retries=3):
        if not self._sensor:
            self.connected = False
            return
        for _ in range(retries):
            try:
                self._sensor.measure()
                t = self._sensor.temperature()
                if t is not None and -40 < t < 85:
                    self.last_temp = float(t)
                    self.connected = True
                    return
            except OSError:
                pass
            utime.sleep_ms(200)
        self.connected = False

    def read(self):
        if not self._sensor:
            return None
        try:
            self._sensor.measure()
            t = self._sensor.temperature()
            if t is not None:
                self.last_temp = float(t)
                self.connected = True
                return self.last_temp
        except OSError:
            self.connected = False
        return self.last_temp


class OximeterSensor:
    """
    MAX30102 pulse oximeter — heart rate (BPM) + SpO2 estimate.
    I2C address 0x57, SDA=21, SCL=22 (shared bus with other I2C devices).
    """

    ADDR = 0x57
    REG_PART_ID = 0xFF
    REG_MODE_CONFIG = 0x09
    REG_SPO2_CONFIG = 0x0A
    REG_LED1_PA = 0x0C
    REG_LED2_PA = 0x0D
    REG_FIFO_WR_PTR = 0x04
    REG_FIFO_RD_PTR = 0x06
    REG_FIFO_DATA = 0x07

    MODE_SPO2 = 0x03
    SAMPLE_AVG_4 = 0x02
    SPO2_SR_100 = 0x03

    def __init__(self, i2c=None, sda=21, scl=22):
        self.connected = False
        self.last_bpm = None
        self.last_spo2 = None
        self._ir_buf = []
        self._red_buf = []
        self._peak_times = []
        self._last_peak_ms = 0
        self.i2c = i2c
        if self.i2c is None:
            try:
                self.i2c = I2C(0, sda=Pin(sda), scl=Pin(scl), freq=400000)
            except OSError:
                self.i2c = None
        if self.i2c:
            self._probe()

    def _w(self, reg, val):
        self.i2c.writeto_mem(self.ADDR, reg, bytes([val]))

    def _r(self, reg, n=1):
        return self.i2c.readfrom_mem(self.ADDR, reg, n)

    def _probe(self):
        try:
            if self.ADDR not in self.i2c.scan():
                self.connected = False
                return
            part = self._r(self.REG_PART_ID)[0]
            if part not in (0x15, 0x11):
                self.connected = False
                return
            self._init_chip()
            self.connected = True
        except OSError:
            self.connected = False

    def _init_chip(self):
        self._w(self.REG_MODE_CONFIG, 0x40)
        utime.sleep_ms(20)
        self._w(self.REG_FIFO_WR_PTR, 0)
        self._w(self.REG_FIFO_RD_PTR, 0)
        self._w(self.REG_MODE_CONFIG, self.MODE_SPO2)
        self._w(self.REG_SPO2_CONFIG, (self.SAMPLE_AVG_4 << 5) | (self.SPO2_SR_100 << 2) | 0x03)
        self._w(self.REG_LED1_PA, 0x24)
        self._w(self.REG_LED2_PA, 0x24)
        utime.sleep_ms(100)

    def _read_fifo_sample(self):
        raw = self._r(self.REG_FIFO_DATA, 6)
        red = (raw[0] << 16) | (raw[1] << 8) | raw[2]
        ir = (raw[3] << 16) | (raw[4] << 8) | raw[5]
        red &= 0x3FFFF
        ir &= 0x3FFFF
        return red, ir

    def _estimate_bpm(self, now_ms):
        if len(self._ir_buf) < 50:
            return self.last_bpm
        buf = self._ir_buf[-80:]
        mean = sum(buf) / len(buf)
        threshold = mean * 1.02
        peaks = 0
        last_peak = self._last_peak_ms
        for i in range(2, len(buf) - 2):
            if buf[i] > threshold and buf[i] > buf[i - 1] and buf[i] >= buf[i + 1]:
                if now_ms - last_peak > 350:
                    peaks += 1
                    last_peak = now_ms
                    self._last_peak_ms = now_ms
        if peaks >= 1 and len(self._peak_times) >= 2:
            intervals = [
                self._peak_times[i] - self._peak_times[i - 1]
                for i in range(1, len(self._peak_times))
                if 400 < self._peak_times[i] - self._peak_times[i - 1] < 1500
            ]
            if intervals:
                avg = sum(intervals) / len(intervals)
                bpm = 60000.0 / avg
                if 40 <= bpm <= 200:
                    return bpm
        return self.last_bpm

    def _estimate_spo2(self):
        if len(self._red_buf) < 20 or len(self._ir_buf) < 20:
            return self.last_spo2
        red_ac = max(self._red_buf[-40:]) - min(self._red_buf[-40:])
        ir_ac = max(self._ir_buf[-40:]) - min(self._ir_buf[-40:])
        red_dc = sum(self._red_buf[-40:]) / 40
        ir_dc = sum(self._ir_buf[-40:]) / 40
        if red_dc < 1 or ir_dc < 1 or ir_ac < 1:
            return self.last_spo2
        r = (red_ac / red_dc) / (ir_ac / ir_dc)
        spo2 = 110.0 - 25.0 * r
        return max(70.0, min(100.0, spo2))

    def read(self):
        """Returns dict {bpm, spo2} or None if not connected."""
        if not self.connected:
            return None
        try:
            samples = 8
            for _ in range(samples):
                red, ir = self._read_fifo_sample()
                self._red_buf.append(red)
                self._ir_buf.append(ir)
                if len(self._red_buf) > 100:
                    self._red_buf.pop(0)
                if len(self._ir_buf) > 100:
                    self._ir_buf.pop(0)
                utime.sleep_ms(10)

            now = utime.ticks_ms()
            if len(self._ir_buf) >= 5:
                v = self._ir_buf[-3]
                if v > (sum(self._ir_buf[-10:]) / min(10, len(self._ir_buf))) * 1.03:
                    self._peak_times.append(now)
                    if len(self._peak_times) > 8:
                        self._peak_times.pop(0)

            bpm = self._estimate_bpm(now)
            spo2 = self._estimate_spo2()
            if bpm is not None:
                self.last_bpm = round(bpm, 0)
            if spo2 is not None:
                self.last_spo2 = round(spo2, 0)
            if self.last_bpm is not None:
                self.connected = True
                return {"bpm": self.last_bpm, "spo2": self.last_spo2}
        except OSError:
            self.connected = False
        return None
