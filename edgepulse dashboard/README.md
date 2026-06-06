# EdgePulse — Temperature + Oximeter (ESP32)

Dashboard and firmware for **DHT22 temperature** and **MAX30102 pulse oximeter** (heart rate BPM + SpO₂).

## Wiring

| Sensor | Module | Connection |
|--------|--------|------------|
| Temperature | DHT22 | Data → **GPIO 4**, 3.3V, GND |
| Heart rate / SpO₂ | MAX30102 | **I2C** SDA → **GPIO 21**, SCL → **GPIO 22**, 3.3V, GND |

Place the oximeter finger clip on the sensor; keep still for stable BPM and SpO₂.

## Flash firmware (Thonny)

Copy to ESP32:

- `firmware/main.py`
- `firmware/sensor_lib.py`
- `firmware/signal_proc.py`
- `firmware/tinyml.py`

Run `main.py`.



Open **http://127.0.0.1:8080/**

If the page won’t load, the server is not running — start `start_server.bat` first.

## Serial events

- `{"e":"reading","s":"temp","v":24.5}`
- `{"e":"reading","s":"hr","v":72}`
- `{"e":"spo2","v":98}`

Sensors: `temp`, `hr` only (vibration and audio removed).
