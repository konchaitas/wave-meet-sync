#!/usr/bin/env node
/**
 * wave-meet-sync — keeps the Elgato Wave:3 hardware mute button and the
 * Google Meet mute button in lockstep.
 *
 * Wave side : Wave Link 3's local JSON-RPC WebSocket (127.0.0.1:1884-1893).
 *             Requires the `Origin: streamdeck://` header — Wave Link rejects
 *             the handshake without it.
 * Meet side : a tiny Chrome content script (see ./extension) that connects to
 *             the WebSocket server this process hosts on 127.0.0.1:8777.
 *
 * Zero dependencies: Node's built-in WebSocket client + a hand-rolled RFC6455
 * server, so nothing here breaks when asdf switches your Node version.
 */

import http from "node:http";
import crypto from "node:crypto";

// Ports are overridable so tests can run against stubs instead of the real
// Wave:3 and a live Meet tab.
const MEET_PORT = Number(process.env.WMS_MEET_PORT) || 8777;
const WAVE_PORTS = process.env.WMS_WAVE_PORT
  ? [Number(process.env.WMS_WAVE_PORT)]
  : Array.from({ length: 10 }, (_, i) => 1884 + i);
const WAVE_ORIGIN = "streamdeck://";

// On first sync of a call, the muted side wins. Prevents joining a meeting
// hot because the Wave happened to be open.
const MUTE_WINS_ON_FIRST_SYNC = true;

const log = (...a) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ *
 * Minimal RFC6455 server (text frames only — our messages are tiny)
 * ------------------------------------------------------------------ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wrapSocket(socket) {
  const api = { onmessage: null, onclose: null, send, close, ping, alive: true, lastSeen: Date.now() };
  let buf = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      api.lastSeen = Date.now();
      if (opcode === 0x8) return close();
      if (opcode === 0x9) return writeFrame(0xa, payload); // ping -> pong
      if (opcode === 0xa) continue;                        // pong -> lastSeen above
      if (opcode === 0x1 && api.onmessage) api.onmessage(payload.toString("utf8"));
    }
  });

  const done = () => {
    if (!api.alive) return;
    api.alive = false;
    api.onclose?.();
  };
  // Sockets handed over by http's "upgrade" event have allowHalfOpen = true, so
  // a client going away emits ONLY "end" — never "close" or "error". Listening
  // for those two alone leaks a peer on every disconnect.
  socket.on("end", () => { try { socket.destroy(); } catch {} done(); });
  socket.on("close", done);
  socket.on("error", done);

  function writeFrame(opcode, payload) {
    if (!api.alive) return;
    const n = payload.length;
    const head =
      n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    try { socket.write(Buffer.concat([head, payload])); } catch { done(); }
  }
  function send(str) { writeFrame(0x1, Buffer.from(str, "utf8")); }
  function ping() { writeFrame(0x9, Buffer.alloc(0)); }
  function close() { try { writeFrame(0x8, Buffer.alloc(0)); socket.end(); } catch {} done(); }

  return api;
}

function startMeetServer(onConnection) {
  const server = http.createServer((req, res) => {
    // Diagnostics: `curl -s http://127.0.0.1:8777/status`. Also handy from the
    // Meet page console — if fetch() to it works there, Local Network Access
    // isn't the problem.
    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify({
        wavePort,
        waveConnected: waveSend !== null,
        waveMuted,
        meetMuted,
        meetTabsConnected: meetPeers.size,
        inSync: waveMuted === null || meetMuted === null ? null : waveMuted === meetMuted,
      }, null, 2) + "\n");
    }
    res.writeHead(426); res.end("upgrade required");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    onConnection(wrapSocket(socket));
  });
  server.on("error", (e) => log("meet server error:", e.message));
  server.listen(MEET_PORT, "127.0.0.1", () =>
    log(`listening for the Meet extension on ws://127.0.0.1:${MEET_PORT}`)
  );
}

/* ------------------------------------------------------------------ *
 * Shared state
 * ------------------------------------------------------------------ */

let wavePort = null;    // Wave Link port we actually connected on
let waveMuted = null;   // last known Wave:3 state (null = Wave Link not connected)
let meetMuted = null;   // last known Meet state  (null = no call / no mic button)
let waveSend = null;    // (muted:boolean) => void
let meetPeers = new Set();

const pushToMeet = (muted) => {
  const msg = JSON.stringify({ type: "set", muted });
  for (const p of meetPeers) p.send(msg);
};

function onWaveState(v, { initial = false } = {}) {
  if (v === waveMuted) return;
  const had = waveMuted !== null;
  waveMuted = v;
  log(`wave  -> ${v ? "MUTED" : "live"}`);
  if (meetMuted === null) return;                 // not in a call, nothing to mirror
  if (!had && initial) return;                    // first read; reconcile() handles it
  if (meetMuted !== v) pushToMeet(v);
}

function onMeetState(v) {
  if (v === meetMuted) return;
  const wasUnknown = meetMuted === null;
  meetMuted = v;
  log(`meet  -> ${v === null ? "no call" : v ? "MUTED" : "live"}`);
  if (v === null || waveMuted === null) return;
  if (wasUnknown) return reconcile();             // just joined a call
  if (waveMuted !== v) waveSend?.(v);
}

/**
 * Re-aligns the two sides. Called when a call starts, and by the watchdog below
 * if they ever drift apart. Muting wins, so this always converges even when one
 * side is refusing to unmute (Meet does exactly that while macOS reports the
 * device as muted-by-system).
 */
let driftAttempts = 0;
function reconcile() {
  if (waveMuted === null || meetMuted === null) return;
  if (waveMuted === meetMuted) return;
  const target = MUTE_WINS_ON_FIRST_SYNC ? true : waveMuted;
  log(`sync  -> reconciling both to ${target ? "MUTED" : "live"}`);
  if (waveMuted !== target) waveSend?.(target);
  if (meetMuted !== target) pushToMeet(target);
}

/* ------------------------------------------------------------------ *
 * Wave Link client
 * ------------------------------------------------------------------ */

function openWave(port) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: WAVE_ORIGIN } });
    } catch { return resolve(null); }
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 1500);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); resolve(null); };
  });
}

async function connectWaveLink() {
  let ws = null, port = null;
  for (const p of WAVE_PORTS) {
    ws = await openWave(p);
    if (ws) { port = p; break; }
  }
  if (!ws) {
    waveMuted = null; waveSend = null;
    setTimeout(connectWaveLink, 3000);
    return;
  }
  wavePort = port;
  log(`connected to Wave Link on ws://127.0.0.1:${port}`);

  let rpcId = 0;
  const pending = new Map();
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = ++rpcId;
      pending.set(id, res);
      const frame = { id, jsonrpc: "2.0", method };
      if (params !== undefined) frame.params = params;   // NB: `params: null` => "Invalid params"
      ws.send(JSON.stringify(frame));
      setTimeout(() => { if (pending.delete(id)) res({}); }, 3000);
    });

  let deviceId = null;
  let inputId = "mic1";

  waveSend = (muted) => {
    if (!deviceId) return;
    log(`wave  <- setting ${muted ? "MUTED" : "live"}`);
    rpc("setInputDevice", { id: deviceId, inputs: [{ id: inputId, isMuted: muted }] });
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "inputDeviceChanged" && m.params?.id === deviceId) {
      const input = m.params.inputs?.find((i) => i.id === inputId);
      if (input && typeof input.isMuted === "boolean") onWaveState(input.isMuted);
    } else if (m.method === "inputDevicesChanged") {
      const dev = pickWave(m.params?.inputDevices);
      if (dev) { const i = dev.inputs.find((x) => typeof x.isMuted === "boolean"); if (i) onWaveState(i.isMuted); }
    }
  };
  ws.onclose = () => {
    log("Wave Link disconnected — retrying");
    waveMuted = null; waveSend = null; wavePort = null;
    setTimeout(connectWaveLink, 3000);
  };
  ws.onerror = () => {};

  const { result } = await rpc("getInputDevices");
  const dev = pickWave(result?.inputDevices);
  if (!dev) { log("!! no Wave device found in Wave Link"); return; }
  deviceId = dev.id;
  const input = dev.inputs.find((i) => typeof i.isMuted === "boolean") ?? dev.inputs[0];
  inputId = input.id;
  log(`Wave device: "${dev.name}" (${deviceId}) input "${inputId}"`);
  onWaveState(Boolean(input.isMuted), { initial: true });
  reconcile();
}

const pickWave = (devices) =>
  devices?.find((d) => d.isWaveDevice) ?? devices?.find((d) => /^Wave/i.test(d.name ?? ""));

/**
 * Watchdog. Every event-driven sync can drop a beat — a click that Meet ignores,
 * a notification that arrives while the other side is mid-transition. Without
 * this the two sides would sit out of step indefinitely, because nothing else
 * fires until the next user action.
 *
 * Bounded on purpose: if three nudges don't take, something is actively refusing
 * (almost always the macOS device mute — see `tools/wave-input.swift`), and
 * retrying forever would just fight it in a loop.
 */
const PEER_TIMEOUT_MS = 70000;
setInterval(() => {
  for (const p of meetPeers) {
    if (Date.now() - p.lastSeen > PEER_TIMEOUT_MS) {
      log("Meet tab timed out — dropping");
      p.close();
    } else {
      p.ping();
    }
  }
}, 25000);

const MAX_DRIFT_FIXES = 3;
setInterval(() => {
  if (waveMuted === null || meetMuted === null || waveMuted === meetMuted) {
    driftAttempts = 0;
    return;
  }
  if (driftAttempts >= MAX_DRIFT_FIXES) return;
  driftAttempts++;
  log(`drift -> wave=${waveMuted ? "MUTED" : "live"} meet=${meetMuted ? "MUTED" : "live"}; fixing (${driftAttempts}/${MAX_DRIFT_FIXES})`);
  reconcile();
  if (driftAttempts === MAX_DRIFT_FIXES) {
    log("drift -> still out of step. If Meet says \"Microphone muted by the system\", run: swift tools/wave-input.swift unmute");
  }
}, 5000);

/* ------------------------------------------------------------------ *
 * Wire it up
 * ------------------------------------------------------------------ */

startMeetServer((peer) => {
  meetPeers.add(peer);
  log(`Meet tab connected (${meetPeers.size} open)`);
  peer.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "meet") onMeetState(typeof m.muted === "boolean" ? m.muted : null);
  };
  peer.onclose = () => {
    meetPeers.delete(peer);
    log(`Meet tab disconnected (${meetPeers.size} open)`);
    if (meetPeers.size === 0) meetMuted = null;
  };
});

connectWaveLink();
process.on("SIGINT", () => { log("bye"); process.exit(0); });
