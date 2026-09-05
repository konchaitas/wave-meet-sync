/**
 * Isolated regression test for the drift watchdog.
 *
 * Runs a stub Wave Link and a deliberately stubborn Meet tab (one that reports a
 * mute state and then ignores every command, the way Meet behaves while macOS
 * reports the mic as muted-by-system). Touches no real hardware and no live tab.
 *
 *   node tests/watchdog-test.mjs
 */
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WAVE_PORT = 18884;
const MEET_PORT = 18777;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- tiny WS server, enough for a stub --- */
function wsServer(port, onConn) {
  const srv = http.createServer((_q, r) => { r.writeHead(426); r.end(); });
  srv.on("upgrade", (req, sock) => {
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64")}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const send = (s) => {
      const p = Buffer.from(s), n = p.length;
      const h = n < 126 ? Buffer.from([0x81, n])
        : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()]);
      sock.write(Buffer.concat([h, p]));
    };
    const peer = { send, onmessage: null };
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const pay = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < pay.length; i++) pay[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        peer.onmessage?.(pay.toString("utf8"));
      }
    });
    onConn(peer);
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}

/* --- stub Wave Link: obeys setInputDevice and broadcasts, like the real one --- */
let waveMuted = false;
const wavePeers = new Set();
const DEV = { id: "Wave:3 STUB", name: "Wave:3", isWaveDevice: true };
wsServer(WAVE_PORT, (peer) => {
  wavePeers.add(peer);
  peer.onmessage = (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "getInputDevices") {
      peer.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {
        inputDevices: [{ ...DEV, inputs: [{ id: "mic1", name: "Wave:3", isMuted: waveMuted }] }] } }));
    } else if (m.method === "setInputDevice") {
      waveMuted = m.params.inputs[0].isMuted;
      peer.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
      for (const p of wavePeers) {
        p.send(JSON.stringify({ jsonrpc: "2.0", method: "inputDeviceChanged",
          params: { id: DEV.id, inputs: [{ id: "mic1", isMuted: waveMuted }] } }));
      }
    }
  };
});

/* --- boot the real daemon against the stubs --- */
const daemon = spawn(process.execPath, [path.join(HERE, "..", "sync.mjs")], {
  env: { ...process.env, WMS_WAVE_PORT: String(WAVE_PORT), WMS_MEET_PORT: String(MEET_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logText = "";
daemon.stdout.on("data", (d) => { logText += d; });
daemon.stderr.on("data", (d) => { logText += d; });
await wait(1500);

/* --- a Meet tab that reports MUTED and then refuses every command --- */
const meet = new WebSocket(`ws://127.0.0.1:${MEET_PORT}`);
await new Promise((r) => { meet.onopen = r; });
let commands = 0;
meet.onmessage = () => { commands++; };            // receives, never complies
meet.send(JSON.stringify({ type: "meet", muted: true }));
await wait(1200);

const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

console.log("\nStubborn Meet tab (reports MUTED, ignores all commands):\n");

// "mute wins": the daemon should pull the Wave to muted to match.
check("daemon converges the Wave to match", waveMuted === true, `stub wave muted=${waveMuted}`);

// Now force real drift: unmute the Wave behind the daemon's back while Meet
// insists it is muted and refuses to move.
waveMuted = false;
for (const p of wavePeers) {
  p.send(JSON.stringify({ jsonrpc: "2.0", method: "inputDeviceChanged",
    params: { id: DEV.id, inputs: [{ id: "mic1", isMuted: false }] } }));
}
await wait(1000);
const beforeCmds = commands;

await wait(17000);   // three watchdog ticks (5s apart) plus slack

check("watchdog noticed the drift", /drift ->/.test(logText),
  logText.match(/drift -> [^\n]*/)?.[0] ?? "no drift line logged");
check("watchdog re-converged the Wave", waveMuted === true, `stub wave muted=${waveMuted}`);
check("watchdog gave up after 3 tries (no infinite fight)",
  (logText.match(/drift ->/g) || []).length <= 4,
  `${(logText.match(/drift ->/g) || []).length} drift lines`);
// "Mute wins" means this drift is absorbed entirely on the Wave side — Meet was
// already muted, so there was nothing to ask it to do. Sending it commands here
// would be the bug, not the fix.
check("resolved without arguing with Meet", commands === beforeCmds,
  `${commands - beforeCmds} pointless command(s) sent`);

/* --- scenario 2: the drift that actually happens in the wild --- */
// Wave muted, Meet stuck live and refusing to mute. Now the daemon *must* push
// to Meet, Meet ignores it, and the watchdog has to give up rather than loop.
console.log("\nMeet stuck live and refusing to mute:\n");
// First let both settle on "live" (the daemon will obligingly unmute the Wave).
meet.send(JSON.stringify({ type: "meet", muted: false }));
await wait(1500);
// Now mute the Wave from the outside — a hardware tap. Meet must follow, and won't.
logText = "";
const cmdsBefore2 = commands;
waveMuted = true;
for (const p of wavePeers) {
  p.send(JSON.stringify({ jsonrpc: "2.0", method: "inputDeviceChanged",
    params: { id: DEV.id, inputs: [{ id: "mic1", isMuted: true }] } }));
}
await wait(18000);   // three ticks plus slack

const drifts2 = (logText.match(/drift ->/g) || []).length;
check("watchdog kept trying", commands > cmdsBefore2, `${commands - cmdsBefore2} command(s) sent to Meet`);
check("watchdog stopped after 3 attempts", drifts2 >= 3 && drifts2 <= 4, `${drifts2} drift lines`);
check("it printed the macOS-mute hint", /wave-input\.swift unmute/.test(logText),
  logText.includes("wave-input") ? "hint shown" : "no hint");

daemon.kill();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed.`);
process.exit(passed === results.length ? 0 : 1);
