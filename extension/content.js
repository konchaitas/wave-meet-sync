/**
 * Wave Meet Sync — Meet side.
 *
 * Reports Meet's mic state to the local daemon and applies mute commands coming
 * back from it. Everything is done by clicking Meet's own button, so it works
 * with the tab in the background — no keyboard focus needed.
 *
 * Chrome 142+ gates requests from a public page to loopback behind Local Network
 * Access. Extensions are exempt *if* they hold host permissions for the target,
 * which is why manifest.json lists http://127.0.0.1/* alongside meet.google.com.
 */

const DAEMON = "ws://127.0.0.1:8777";
const RECONNECT_MS = 2000;
const TAG = "[wave-meet-sync]";

console.info(`${TAG} content script loaded on ${location.href}`);

/**
 * Meet's mic button, newest markup first. The `jsname` values track the
 * (actively maintained) streamdeck-googlemeet extension. The last fallback keys
 * off the Material Symbols ligature inside the button ("mic" / "mic_off"), which
 * is locale-independent — aria-labels are translated.
 */
function micButton() {
  return (
    document.querySelector('button[jsname="hw0c9"]') ||
    document.querySelector('div[role="button"][jsname="hw0c9"]') ||
    document.querySelector('div[jsname="Dg9Wp"] [jsname="BOHaEe"]') ||
    [...document.querySelectorAll("[data-is-muted]")].find((el) =>
      /(^|\s)mic(_off)?(\s|$)/.test(el.textContent || "")
    ) ||
    null
  );
}

const isMuted = (el) => el.dataset.isMuted === "true";

let socket = null;
let lastSent;      // undefined until we've reported once
let sawButton = false;

function report(force = false) {
  const el = micButton();
  const muted = el ? isMuted(el) : null;

  if (el && !sawButton) {
    sawButton = true;
    console.info(`${TAG} found Meet's mic button:`, el);
  }

  if (!force && muted === lastSent) return;
  lastSent = muted;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "meet", muted }));
    console.debug(`${TAG} reported ${muted === null ? "no call" : muted ? "MUTED" : "live"}`);
  }
}

function applyMute(target) {
  const el = micButton();
  if (!el) return console.warn(`${TAG} asked to set mute but no mic button on this page`);
  if (typeof target !== "boolean" || isMuted(el) === target) return;
  el.click();
  console.info(`${TAG} clicked Meet's mic -> ${target ? "MUTED" : "live"}`);
  // Meet flips data-is-muted asynchronously; nudge in case the mutation coalesces.
  setTimeout(() => report(true), 150);
}

function connect() {
  console.debug(`${TAG} connecting to ${DAEMON}`);
  socket = new WebSocket(DAEMON);

  socket.onopen = () => {
    console.info(`${TAG} connected to daemon`);
    report(true);
  };
  socket.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "set") applyMute(m.muted);
  };
  socket.onerror = () => {
    console.error(
      `${TAG} could not reach the daemon at ${DAEMON}.\n` +
      "  1. Is it running?   curl -s http://127.0.0.1:8777/status\n" +
      "  2. If curl works but this keeps failing, Chrome's Local Network Access is\n" +
      "     blocking it — reload the extension at chrome://extensions so the new\n" +
      "     http://127.0.0.1/* host permission takes effect."
    );
    try { socket.close(); } catch {}
  };
  socket.onclose = () => {
    socket = null;
    lastSent = undefined;
    setTimeout(connect, RECONNECT_MS);
  };
}

// Meet rebuilds its control bar on every call transition, so watch the whole
// body for data-is-muted flips rather than binding to one element.
new MutationObserver(() => report()).observe(document.body, {
  attributes: true,
  attributeFilter: ["data-is-muted"],
  subtree: true,
});

// Safety net: catches the button appearing/disappearing (join, leave, layout
// changes), which is a childList change rather than an attribute flip.
setInterval(() => report(), 2000);

connect();
