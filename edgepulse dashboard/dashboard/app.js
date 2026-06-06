/* EdgePulse — real ESP32 USB + sensor hardware integration */

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playBeep(freq = 880, dur = 0.15, type = "sine", vol = 0.3) {
  if (!freq) return;
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch (_) {}
}

function playConnect() {
  [440, 554, 659, 880].forEach((f, i) => setTimeout(() => playBeep(f, 0.1, "sine", 0.25), i * 100));
}

function playSensorOn(sensor) {
  const freqs = { temp: [523, 659, 784], hr: [392, 494, 587] };
  (freqs[sensor] || [440, 550, 660]).forEach((fr, i) => setTimeout(() => playBeep(fr, 0.12, "sine", 0.25), i * 120));
}

function playAlert() {
  [880, 0, 880].forEach((f, i) => {
    if (f) setTimeout(() => playBeep(f, 0.15, "square", 0.2), i * 200);
  });
}

const state = {
  connected: false,
  useBridge: false,
  usbPresent: false,
  bridgePort: null,
  serialPort: null,
  serialReader: null,
  serialWriter: null,
  readLoopAbort: null,
  ws: null,
  sensors: { temp: false, hr: false },
  hardware: { temp: false, hr: false },
  data: { temp: [], hr: [], spo2: [], fft: [] },
  samples: [],
  startTime: null,
  uptimeInterval: null,
  activeChart: "temp",
  simMode: false,
};

const ESP32_USB_FILTERS = [
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x303a },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x2341 },
];

/* ===== Clock ===== */
setInterval(() => {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("en-GB");
}, 1000);

function startUptime() {
  state.startTime = Date.now();
  clearInterval(state.uptimeInterval);
  state.uptimeInterval = setInterval(() => {
    const s = Math.floor((Date.now() - state.startTime) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    document.getElementById("uptime").textContent = `${h}:${m}:${sec}`;
  }, 1000);
}

/* ===== USB presence (bridge or prior Web Serial grant) ===== */
function setConnectButtonEnabled(enabled, hint) {
  const btn = document.getElementById("main-connect-btn");
  btn.disabled = !enabled;
  btn.title = hint || "";
  const usbHint = document.getElementById("usb-hint");
  if (usbHint && hint) usbHint.textContent = hint;
  if (!enabled && !state.connected) {
    btn.classList.remove("connected");
  }
}

async function refreshUsbPresence() {
  if ("serial" in navigator) {
    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        state.usbPresent = true;
        setConnectButtonEnabled(true, "ESP32 USB detected — click to connect");
        return;
      }
    } catch (_) {}
  }
  if (state.usbPresent && !state.useBridge) {
    setConnectButtonEnabled(true, "Plug ESP32 via USB, then connect");
  } else if (!state.usbPresent) {
    setConnectButtonEnabled(false, "Plug ESP32 via USB (run bridge for auto-detect)");
  }
}

function connectBridge() {
  if (state.ws) return;
  try {
    state.ws = new WebSocket("ws://127.0.0.1:8765");
    state.useBridge = true;
    state.ws.onopen = () => addLog("SYS", "info", "Bridge connected — watching USB ports");
    state.ws.onclose = () => {
      state.ws = null;
      state.useBridge = false;
      setTimeout(connectBridge, 3000);
    };
    state.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.bridge === "usb") {
        state.usbPresent = !!msg.present;
        state.bridgePort = msg.port;
        if (state.usbPresent) {
          setConnectButtonEnabled(true, `ESP32 on ${msg.port} — click Connect`);
        } else if (!state.connected) {
          setConnectButtonEnabled(false, "Plug ESP32 via USB");
        }
        return;
      }
      if (msg.bridge === "connected") {
        onConnected();
        sendCommand({ cmd: "status" });
        return;
      }
      if (msg.bridge === "disconnected") {
        if (state.connected) disconnect();
        return;
      }
      if (msg.bridge === "error") {
        addLog("SYS", "err", msg.msg || "bridge error");
        showToast("Bridge error", msg.msg, "amber");
        return;
      }
      if (msg.bridge) return;
      try {
        handleDeviceLine(typeof msg === "string" ? JSON.parse(msg) : msg);
      } catch (_) {
        handleDeviceLine(msg);
      }
    };
  } catch (_) {
    state.useBridge = false;
  }
}

async function sendCommand(obj) {
  const line = JSON.stringify(obj) + "\n";
  if (state.useBridge && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ action: "cmd", payload: obj }));
    return true;
  }
  if (state.serialWriter) {
    const enc = new TextEncoder();
    await state.serialWriter.write(enc.encode(line));
    return true;
  }
  return false;
}

async function openWebSerial() {
  const port = await navigator.serial.requestPort({ filters: ESP32_USB_FILTERS });
  await port.open({ baudRate: 115200 });
  state.serialPort = port;
  const dec = new TextDecoder();
  const writer = port.writable.getWriter();
  state.serialWriter = {
    write: async (chunk) => {
      await writer.write(chunk);
    },
  };
  const reader = port.readable.getReader();
  state.serialReader = reader;
  let buffer = "";
  state.readLoopAbort = false;
  (async () => {
    while (!state.readLoopAbort) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          handleDeviceLine(JSON.parse(line));
        } catch (_) {}
      }
    }
  })();
}

async function toggleConnection() {
  if (state.connected) {
    await disconnect();
    return;
  }
  if (!state.usbPresent && !("serial" in navigator)) {
    showToast("⚠ No USB", "Run bridge: python bridge/serial_bridge.py", "amber");
    playAlert();
    return;
  }
  try {
    if (state.useBridge && state.ws && state.ws.readyState === 1) {
      if (!state.bridgePort) {
        showToast("No ESP32", "Plug board via USB — waiting for COM port", "amber");
        return;
      }
      state.ws.send(JSON.stringify({ action: "connect", port: state.bridgePort, baud: 115200 }));
      return;
    } else if ("serial" in navigator) {
      await openWebSerial();
    } else {
      showToast("⚠ Web Serial", "Use Chrome/Edge or start the Python bridge", "amber");
      return;
    }
    onConnected();
    await sendCommand({ cmd: "ping" });
    await sendCommand({ cmd: "status" });
  } catch (err) {
    addLog("SYS", "err", "Connect failed: " + err.message);
    showToast("Connection failed", err.message, "amber");
    await disconnect();
  }
}

function onConnected() {
  state.connected = true;
  state.simMode = false;
  const btn = document.getElementById("main-connect-btn");
  btn.textContent = "✅ Connected";
  btn.classList.add("connected");
  btn.disabled = false;
  document.getElementById("conn-dot").classList.remove("offline");
  document.getElementById("conn-label").textContent = "LIVE";
  document.getElementById("sig-wave").style.opacity = "1";
  playConnect();
  startUptime();
  addLog("SYS", "ok", "ESP32 connected over USB");
  showToast("⚡ ESP32 Connected", "Board online — checking sensors…", "cyan");
  animateStats(35, 28, 22, 82);
}

async function disconnect() {
  state.connected = false;
  state.readLoopAbort = true;
  if (state.serialReader) {
    try {
      await state.serialReader.cancel();
    } catch (_) {}
    state.serialReader = null;
  }
  if (state.serialPort) {
    try {
      await state.serialPort.close();
    } catch (_) {}
    state.serialPort = null;
  }
  if (state.useBridge && state.ws) {
    state.ws.send(JSON.stringify({ action: "disconnect" }));
  }
  Object.keys(state.sensors).forEach((s) => {
    if (state.sensors[s]) setSensorActive(s, false, true);
  });
  const btn = document.getElementById("main-connect-btn");
  btn.textContent = "⚡ Connect Device";
  btn.classList.remove("connected");
  document.getElementById("conn-dot").classList.add("offline");
  document.getElementById("conn-label").textContent = "DISCONNECTED";
  document.getElementById("sig-wave").style.opacity = "0.2";
  clearInterval(state.uptimeInterval);
  animateStats(0, 0, 0, 0);
  refreshUsbPresence();
  addLog("SYS", "warn", "Device disconnected");
}

function applyHardwareMap(map) {
  state.hardware = { ...state.hardware, ...map };
  const hint = document.getElementById("usb-hint");
  const found = Object.values(state.hardware).filter(Boolean).length;
  if (hint && state.connected) {
    hint.textContent = found
      ? `${found} sensor(s) detected on board`
      : "Connected — wire sensors to enable channels";
  }
  ["temp", "hr"].forEach((id) => {
    const btn = document.getElementById("btn-" + id);
    const avail = state.hardware[id];
    btn.classList.toggle("unavailable", !avail);
    const badge = document.getElementById("badge-" + id);
    if (!avail) {
      if (state.sensors[id]) setSensorActive(id, false, true);
      badge.className = "sensor-status-badge badge-off";
      badge.textContent = "NO HW";
      document.getElementById("val-" + id).textContent = sensorDefault(id);
    } else if (!state.sensors[id]) {
      badge.className = "sensor-status-badge badge-off";
      badge.textContent = "READY";
    }
  });
}

function handleDeviceLine(msg) {
  const e = msg.e;
  if (e === "hello" || e === "status") {
    if (msg.sensors) applyHardwareMap(msg.sensors);
    if (e === "hello") addLog("SYS", "ok", "Firmware " + (msg.v || "?") + " ready");
    return;
  }
  if (e === "reading") {
    applyReading(msg.s, msg.v);
    return;
  }
  if (e === "spo2") {
    applySpo2(msg.v);
    return;
  }
  if (e === "fft" && Array.isArray(msg.bins)) {
    state.data.fft = msg.bins;
    if (state.activeChart === "fft") updateChart();
    return;
  }
  if (e === "alert") {
    addLog("AI", "warn", "Anomaly: " + JSON.stringify(msg.data && msg.data.alerts));
    playAlert();
    showToast("🚨 Alert", "Edge AI detected anomaly", "amber");
    return;
  }
  if (e === "sensor_ack") {
    setSensorActive(msg.id, msg.on, false);
    return;
  }
  if (e === "deploy_ok") {
    addLog("THONNY", "ok", "Deployed " + msg.file);
    showToast("⌨ Deployed", msg.file + " written on ESP32", "green");
    return;
  }
  if (e === "error") {
    addLog("SYS", "err", msg.msg || "device error");
    showToast("Device error", msg.msg, "amber");
  }
}

function applySpo2(value) {
  const el = document.getElementById("val-spo2");
  if (!el) return;
  const v = Math.round(Number(value));
  el.textContent = String(v);
  state.data.spo2.push(v);
  if (state.data.spo2.length > 60) state.data.spo2.shift();
  if (state.activeChart === "spo2") updateChart();
  state.samples.push({ ts: new Date().toISOString(), sensor: "spo2", value: v });
}

function applyReading(id, value) {
  const disp = id === "temp" ? Number(value).toFixed(1) : String(Math.round(value));
  document.getElementById("val-" + id).textContent = disp;
  const badge = document.getElementById("badge-" + id);
  if (id === "temp" && value > 38) {
    badge.className = "sensor-status-badge badge-warn";
    badge.textContent = "HIGH";
  } else if (id === "hr" && (value > 120 || value < 50)) {
    badge.className = "sensor-status-badge badge-warn";
    badge.textContent = value > 120 ? "HIGH" : "LOW";
  } else if (state.sensors[id]) {
    badge.className = "sensor-status-badge badge-on";
    badge.textContent = "LIVE";
  }
  state.data[id].push(parseFloat(value));
  if (state.data[id].length > 60) state.data[id].shift();
  state.samples.push({ ts: new Date().toISOString(), sensor: id, value: parseFloat(value) });
  if (state.samples.length > 5000) state.samples.shift();
  if (state.activeChart === id || state.activeChart === "fft") updateChart();
  updateDynamicStats();
  runPipeline(id);
}

function toggleSensor(id) {
  if (!state.hardware[id]) {
    showToast("⚠ Not detected", "Wire " + sensorName(id) + " to the board first", "amber");
    playAlert();
    return;
  }
  if (!state.connected) {
    showToast("⚠ Not Connected", "Connect ESP32 via USB first", "amber");
    playAlert();
    return;
  }
  const next = !state.sensors[id];
  sendCommand({ cmd: "set_sensor", id, on: next });
}

function setSensorActive(id, active, silent) {
  state.sensors[id] = active;
  const btn = document.getElementById("btn-" + id);
  const badge = document.getElementById("badge-" + id);
  if (active) {
    btn.classList.add("active");
    badge.className = "sensor-status-badge badge-on";
    badge.textContent = "LIVE";
    if (!silent) {
      playSensorOn(id);
      addLog(id.toUpperCase(), "ok", sensorName(id) + " streaming from ESP32");
      showToast(sensorEmoji(id) + " " + sensorName(id), "Live hardware data", sensorColor(id));
      updateAlgos();
    }
  } else {
    btn.classList.remove("active");
    badge.className = "sensor-status-badge badge-off";
    badge.textContent = state.hardware[id] ? "READY" : "NO HW";
    document.getElementById("val-" + id).textContent = sensorDefault(id);
    if (id === "hr") {
      const spo2 = document.getElementById("val-spo2");
      if (spo2) spo2.textContent = "--";
    }
    state.data[id] = [];
    if (!silent) addLog(id.toUpperCase(), "warn", sensorName(id) + " stopped");
    updateAlgos();
    updateChart();
  }
}

function sensorEmoji(s) {
  return { temp: "🌡️", hr: "❤️" }[s];
}
function sensorName(s) {
  return { temp: "Temperature", hr: "Heart Rate (Oximeter)" }[s];
}
function sensorColor(s) {
  return { temp: "amber", hr: "purple" }[s];
}
function sensorDefault(s) {
  return { temp: "--.-", hr: "---" }[s];
}

/* Pipeline + algos (visual feedback on real data) */
const pipeSteps = ["acq", "noise", "norm", "mem", "feat", "ai", "out"];
let pipeRunning = false;

function runPipeline(sensor) {
  if (pipeRunning) return;
  pipeRunning = true;
  pipeSteps.forEach((s) => {
    document.getElementById("step-" + s).classList.remove("active-step", "done-step");
    document.getElementById("prog-" + s).style.width = "0%";
  });
  pipeSteps.forEach((s, i) => {
    setTimeout(() => {
      const el = document.getElementById("step-" + s);
      el.classList.add("active-step");
      const bar = document.getElementById("prog-" + s);
      let w = 0;
      const prog = setInterval(() => {
        w += 12;
        bar.style.width = Math.min(w, 100) + "%";
        if (w >= 100) {
          clearInterval(prog);
          el.classList.remove("active-step");
          el.classList.add("done-step");
          if (s === "out") pipeRunning = false;
        }
      }, 35);
    }, i * 500);
  });
}

function updateAlgos() {
  const any = Object.values(state.sensors).some(Boolean);
  ["lms", "fft", "quant", "tinyml", "rls"].forEach((a, i) => {
    const el = document.getElementById("algo-" + a);
    const stat = el.querySelector(".algo-stat");
    if (!any) {
      el.className = "algo-item";
      stat.textContent = "IDLE";
      return;
    }
    setTimeout(() => {
      el.className = "algo-item running";
      stat.textContent = "RUNNING";
      setTimeout(() => {
        el.className = "algo-item done";
        stat.textContent = "✓ OK";
      }, 1200 + i * 200);
    }, i * 150);
  });
}

/* Chart */
function setChart(type, btn) {
  document.querySelectorAll(".chart-tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.activeChart = type;
  updateChart();
}

function updateChart() {
  const canvas = document.getElementById("signal-chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.offsetWidth;
  const H = canvas.parentElement.offsetHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const type = state.activeChart;
  const data = state.data[type];
  if (!data || data.length < 2) {
    ctx.fillStyle = "rgba(122,133,153,0.3)";
    ctx.font = "14px 'JetBrains Mono'";
    ctx.textAlign = "center";
    ctx.fillText(state.connected ? "Enable sensor for live data" : "Connect ESP32 first", W / 2, H / 2);
    return;
  }
  const colors = { temp: "#ff6b35", hr: "#ff4466", spo2: "#00ff88", fft: "#00d4ff" };
  const col = colors[type] || "#00d4ff";
  const pad = 20;
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < 5; i++) {
    const y = (H * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rng = mx - mn || 1;
  if (type === "fft") {
    const bw = (W - pad * 2) / data.length;
    data.forEach((v, i) => {
      const bh = (v / 30) * (H - pad * 2);
      const x = pad + i * bw;
      const grad = ctx.createLinearGradient(0, H - pad - bh, 0, H - pad);
      grad.addColorStop(0, col);
      grad.addColorStop(1, col + "22");
      ctx.fillStyle = grad;
      ctx.fillRect(x, H - pad - bh, bw - 2, bh);
    });
    return;
  }
  const grad = ctx.createLinearGradient(0, pad, 0, H - pad);
  grad.addColorStop(0, col + "44");
  grad.addColorStop(1, col + "00");
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - mn) / rng) * (H - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(W - pad, H - pad);
  ctx.lineTo(pad, H - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  data.forEach((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - mn) / rng) * (H - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function animateStats(ram, cpu, buf, sig) {
  document.getElementById("ram-bar").style.width = ram + "%";
  document.getElementById("ram-val").textContent = ram + "%";
  document.getElementById("cpu-bar").style.width = cpu + "%";
  document.getElementById("cpu-val").textContent = cpu + "%";
  document.getElementById("buf-bar").style.width = buf + "%";
  document.getElementById("buf-val").textContent = buf + "%";
  document.getElementById("sig-val").textContent = sig ? sig + "%" : "—";
  document.getElementById("sig-bar").style.width = sig + "%";
}

function updateDynamicStats() {
  const active = Object.values(state.sensors).filter(Boolean).length;
  animateStats(
    Math.round(35 + active * 12 + Math.random() * 5),
    Math.round(28 + active * 10 + Math.random() * 8),
    Math.round(22 + active * 8 + Math.random() * 6),
    Math.round(85 + active * 4)
  );
}

function addLog(tag, type, msg) {
  const feed = document.getElementById("log-feed");
  const t = new Date().toLocaleTimeString("en-GB");
  const tagClass = { ok: "tag-ok", warn: "tag-warn", info: "tag-info", err: "tag-err" }[type] || "tag-info";
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="log-time">${t}</span><span class="log-tag ${tagClass}">${tag}</span><span class="log-msg">${msg}</span>`;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
  while (feed.children.length > 80) feed.removeChild(feed.firstChild);
}

function showToast(title, msg, color = "cyan") {
  const colorMap = {
    cyan: "var(--accent-cyan)",
    amber: "var(--accent-amber)",
    purple: "var(--accent-purple)",
    green: "var(--accent-green)",
  };
  const c = colorMap[color] || colorMap.cyan;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.style.borderColor = c;
  toast.innerHTML = `<div style="width:6px;height:36px;background:${c};border-radius:3px"></div><div><div style="font-weight:700;color:${c}">${title}</div><div style="color:var(--text-secondary);font-size:11px">${msg}</div></div>`;
  document.getElementById("toasts").appendChild(toast);
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function clearLog() {
  document.getElementById("log-feed").innerHTML = "";
  addLog("SYS", "info", "Log cleared");
}

function exportData() {
  if (!state.samples.length) {
    showToast("No data", "Connect sensors and collect readings first", "amber");
    return;
  }
  const rows = ["timestamp,sensor,value"];
  state.samples.forEach((r) => rows.push(`${r.ts},${r.sensor},${r.value}`));
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "edgepulse_export_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".csv";
  a.click();
  addLog("SYS", "ok", "Exported " + state.samples.length + " samples");
  showToast("⬇ Export Complete", a.download, "green");
}

function runCalibration() {
  if (!state.connected) {
    showToast("⚠ Not Connected", "Connect ESP32 first", "amber");
    return;
  }
  addLog("CAL", "info", "Calibration requested on device");
  [523, 659, 784].forEach((f, i) => setTimeout(() => playBeep(f, 0.08), i * 80));
  sendCommand({ cmd: "status" });
}

function resetAll() {
  Object.keys(state.sensors).forEach((s) => {
    if (state.sensors[s]) sendCommand({ cmd: "set_sensor", id: s, on: false });
  });
  state.data = { temp: [], hr: [], spo2: [], fft: [] };
  state.samples = [];
  const spo2 = document.getElementById("val-spo2");
  if (spo2) spo2.textContent = "--";
  updateChart();
  addLog("SYS", "warn", "Sensors stopped · buffers cleared");
}

/* Thonny-style code deploy */
const codeFiles = {};
let activeCodeKey = "main";

async function loadCodeFiles() {
  const names = ["main", "sensor", "signal", "tinyml"];
  const paths = {
    main: "/firmware/main.py",
    sensor: "/firmware/sensor_lib.py",
    signal: "/firmware/signal_proc.py",
    tinyml: "/firmware/tinyml.py",
  };
  for (const k of names) {
    try {
      const res = await fetch(paths[k]);
      if (res.ok) codeFiles[k] = await res.text();
    } catch (_) {}
  }
}

function openModal() {
  const overlay = document.getElementById("code-modal");
  overlay.classList.add("open");
  const tab =
    document.querySelector(`.modal-tab[data-key="${activeCodeKey}"]`) ||
    document.querySelector('.modal-tab[data-key="main"]');
  switchCode(activeCodeKey, tab);
  playBeep(660, 0.1);
}

function closeModal() {
  document.getElementById("code-modal").classList.remove("open");
}

function switchCode(key, btn) {
  activeCodeKey = key;
  document.querySelectorAll(".modal-tab").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const map = { main: "main.py", sensor: "sensor_lib.py", signal: "signal_proc.py", tinyml: "tinyml.py" };
  const editor = document.getElementById("code-editor");
  editor.value = codeFiles[key] || "# Loading…\n";
  document.getElementById("deploy-filename").textContent = map[key] || "main.py";
}

async function deployCode() {
  const btn = document.getElementById("deploy-btn");
  if (btn?.disabled) return;

  const map = { main: "main.py", sensor: "sensor_lib.py", signal: "signal_proc.py", tinyml: "tinyml.py" };
  const file = map[activeCodeKey] || "main.py";
  const editor = document.getElementById("code-editor");
  const content = editor ? editor.value : "";

  playBeep(520, 0.06);
  addLog("THONNY", "info", "Deploy clicked → " + file);

  if (!state.connected) {
    showToast("⚠ Not Connected", "Click Connect Device first, then Deploy again", "amber");
    playAlert();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("deploying");
  }

  try {
    codeFiles[activeCodeKey] = content;
    const sent = await sendCommand({ cmd: "deploy", file, content });
    if (!sent) {
      showToast("Deploy failed", "Serial link lost — reconnect ESP32", "amber");
      addLog("THONNY", "err", "No serial channel for deploy");
      return;
    }
    addLog("THONNY", "info", "Sending " + file + " (" + content.length + " bytes)…");
    showToast("⌨ Deploying", file + " → ESP32…", "cyan");
  } catch (err) {
    showToast("Deploy error", err.message || String(err), "amber");
    addLog("THONNY", "err", "Deploy failed: " + (err.message || err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("deploying");
    }
  }
}

function setupCodeModal() {
  const overlay = document.getElementById("code-modal");
  const panel = overlay?.querySelector(".modal");
  if (panel) {
    panel.addEventListener("click", (e) => e.stopPropagation());
  }
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  const deployBtn = document.getElementById("deploy-btn");
  deployBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    deployCode();
  });

  document.querySelectorAll(".modal-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = tab.getAttribute("data-key");
      if (key) switchCode(key, tab);
    });
  });
}

/* Init */
window.toggleConnection = toggleConnection;
window.toggleSensor = toggleSensor;
window.setChart = setChart;
window.clearLog = clearLog;
window.exportData = exportData;
window.runCalibration = runCalibration;
window.resetAll = resetAll;
window.openModal = openModal;
window.closeModal = closeModal;
window.switchCode = switchCode;
window.deployCode = deployCode;

window.addEventListener("resize", updateChart);

(async function init() {
  setupCodeModal();
  setConnectButtonEnabled(false, "Start bridge or plug ESP32 USB");
  addLog("SYS", "info", "EdgePulse hardware mode — simulation disabled");
  if (!("serial" in navigator)) {
    addLog("SYS", "warn", "Web Serial unavailable — use Python bridge");
  }
  connectBridge();
  await loadCodeFiles();
  await refreshUsbPresence();
  setInterval(refreshUsbPresence, 5000);
  updateChart();
})();
