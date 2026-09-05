#!/usr/bin/env node
/**
 * Verifies the whole bridge without needing a real meeting.
 *
 * Impersonates a Meet tab against the running daemon and drives the Wave from
 * the outside, exactly the way a hardware tap does. Restores your original
 * mute state on exit.
 *
 * Usage:  node selftest.mjs      (the daemon must already be running)
 */

const DAEMON = "ws://127.0.0.1:8777";
const WAVE_PORTS = Array.from({ length: 10 }, (_, i) => 1884 + i);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---- connect to Wave Link ---- */
async function openWave() {
  for (const p of WAVE_PORTS) {
    const ws = await new Promise((res) => {
      let s;
      try {
        s = new WebSocket(`ws://127.0.0.1:${p}`, { headers: { Origin: "streamdeck://" } });
      } catch { return res(null); }
      const t = setTimeout(() => { try { s.close(); } catch {} res(null); }, 1200);
      s.onopen = () => { clearTimeout(t); res(s); };
      s.onerror = () => { clearTimeout(t); res(null); };
    });
    if (ws) return { ws, port: p };
  }
  return {};
}

const { ws: wl, port } = await openWave();
if (!wl) {
  console.error("\n  Wave Link is not reachable on 1884-1893. Open Wave Link and retry.\n");
  process.exit(1);
}
console.log(`\nWave Link: connected on ${port}`);

let rpcId = 0;
const pending = new Map();
wl.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const rpc = (method, params) =>
  new Promise((res) => {
    const id = ++rpcId;
    pending.set(id, res);
    const f = { id, jsonrpc: "2.0", method };
    if (params !== undefined) f.params = params;
    wl.send(JSON.stringify(f));
    setTimeout(() => { if (pending.delete(id)) res({}); }, 3000);
  });

const readDevice = async () => {
  const { result } = await rpc("getInputDevices");
  const d = result?.inputDevices?.find((x) => x.isWaveDevice);
  const i = d?.inputs?.find((x) => typeof x.isMuted === "boolean");
  return d && i ? { id: d.id, name: d.name, inputId: i.id, muted: i.isMuted } : null;
};

const dev = await readDevice();
if (!dev) {
  console.error("\n  No Wave device found in Wave Link. Is the Wave:3 plugged in?\n");
  process.exit(1);
}
console.log(`Wave device: "${dev.name}" input "${dev.inputId}" (currently ${dev.muted ? "muted" : "live"})`);
const ORIGINAL = dev.muted;
const setWave = (v) => rpc("setInputDevice", { id: dev.id, inputs: [{ id: dev.inputId, isMuted: v }] });
const waveMuted = async () => (await readDevice()).muted;

/* ---- impersonate a Meet tab ---- */
const meet = await new Promise((res) => {
  const s = new WebSocket(DAEMON);
  s.onopen = () => res(s);
  s.onerror = () => res(null);
  setTimeout(() => res(null), 2500);
});
if (!meet) {
  console.error(`\n  Daemon not reachable on ${DAEMON}.`);
  console.error("  Start it with:  node sync.mjs      (or ./install.sh)\n");
  process.exit(1);
}
console.log("Daemon:    connected");

// This test drives the daemon, and the daemon broadcasts to every connected Meet
// tab — including a real one. Refuse to toggle someone's live call by accident.
try {
  const st = await (await fetch("http://127.0.0.1:8777/status")).json();
  if (st.meetTabsConnected > 1 && !process.argv.includes("--force")) {
    console.error(
      `\n  A real Meet tab is connected (${st.meetTabsConnected - 1} besides this test).\n` +
      "  Running now would mute/unmute your actual call several times.\n" +
      "  Close the Meet tab and retry, or pass --force if you're sure.\n"
    );
    process.exit(1);
  }
} catch { /* no status endpoint: older daemon, carry on */ }
console.log("");

let meetMuted = false;
let inbound = 0;
meet.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type !== "set") return;
  inbound++;
  if (m.muted !== meetMuted) {
    meetMuted = m.muted;                     // same as the extension clicking the button
    meet.send(JSON.stringify({ type: "meet", muted: meetMuted }));
  }
};

async function cleanup(code) {
  await setWave(ORIGINAL);
  await wait(400);
  console.log(`\nRestored the Wave:3 to ${ORIGINAL ? "muted" : "live"}.`);
  process.exit(code);
}

console.log("Running tests…\n");

// Start from a known baseline: both live.
await setWave(false); await wait(400);
meetMuted = false;
meet.send(JSON.stringify({ type: "meet", muted: false }));
await wait(700);

// 1. Hardware path: a mute originating outside the daemon must reach Meet.
await setWave(true);
await wait(1200);
check("Wave muted  -> Meet mutes", meetMuted === true);

// 2. and back again.
await setWave(false);
await wait(1200);
check("Wave live   -> Meet unmutes", meetMuted === false);

// 3. Meet-initiated mute must reach the hardware.
meetMuted = true;
meet.send(JSON.stringify({ type: "meet", muted: true }));
await wait(1200);
let w = await waveMuted();
check("Meet muted  -> Wave mutes", w === true, `Wave isMuted=${w}`);

// 4. and back again.
meetMuted = false;
meet.send(JSON.stringify({ type: "meet", muted: false }));
await wait(1200);
w = await waveMuted();
check("Meet live   -> Wave unmutes", w === false, `Wave isMuted=${w}`);

// 5. No feedback loop: nothing should still be bouncing between the two sides.
const before = inbound;
await wait(2500);
check("no echo loop", inbound === before, `${inbound - before} stray message(s)`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed.`);
await cleanup(passed === results.length ? 0 : 1);
