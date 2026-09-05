# wave-meet-sync

One button. Tap the Wave:3 → Google Meet mutes. Click Meet's mic (or ⌘+D) → the Wave:3's ring goes red.

## Why it has to work this way

- The Wave:3 exposes **no HID interface** — `hidutil list` shows nothing, and its only
  USB interfaces are `Elgato Wave:3 Controls` (vendor-specific) and `DFU`. So macOS never
  sees the capacitive tap as a key event, and nothing can hook it at the OS level.
  **Wave Link is the only supported way to read that button.**
- Muting the *system* input device does not change Meet's state — Meet tracks its own
  `MediaStreamTrack.enabled`, which is why every "global mic mute" utility leaves Meet
  showing you as unmuted.
- Meet's `⌘+D` only fires when the Meet tab has keyboard focus, so a global hotkey can't
  drive it. Clicking Meet's own button from a content script works with the tab in the
  background — that's what the extension does.

## How it works

```
Wave:3 button ──► Wave Link 3 ──ws://127.0.0.1:1884──► sync.mjs ──ws://127.0.0.1:8777──► Chrome ──► Meet mic button
                  (inputDeviceChanged)                (bridge)                          (content script)
      ◄──────────────────────────────────────────────────────────────────────────────────────────────
                                    (setInputDevice: isMuted)
```

Verified against Wave Link 3.2.2 on this machine:

- Wave Link's local JSON-RPC listens on **1884** (it falls back to scanning 1884–1893 —
  its own Stream Deck plugin logs `Failed to read ws-info.json` then `Connected on 1884`,
  because the documented `ws-info.json` is Windows-only).
- The handshake **requires `Origin: streamdeck://`**; without it Wave Link closes the
  socket with code 1006.
- `params: null` returns `Invalid params` — the key must be **omitted** entirely.
- The Wave:3 appears as device `Wave:3 <serial>` with input `mic1` carrying `isMuted`.
- State changes **broadcast to every connected client** as `inputDeviceChanged`, which is
  what makes bidirectional sync possible.

## Install

**1. Daemon**

```bash
./install.sh
```

Starts now and at every login. `./install.sh uninstall` removes it.
Log: `tail -f ~/Library/Logs/wave-meet-sync.log`

**2. Chrome extension**

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Reload any open Meet tab

Keep Wave Link running (it can live in the menu bar).

## Test it without joining a meeting

With the daemon running:

```bash
node selftest.mjs
```

It impersonates a Meet tab against the real daemon and drives the Wave from the outside
exactly the way a hardware tap does, then restores your original mute state:

```
  PASS  Wave muted  -> Meet mutes
  PASS  Wave live   -> Meet unmutes
  PASS  Meet muted  -> Wave mutes
  PASS  Meet live   -> Wave unmutes
  PASS  no echo loop
```

It refuses to run while a real Meet tab is connected (it would toggle your actual call);
pass `--force` to override.

There's also an isolated regression test that needs no hardware and no browser — it runs
the daemon against a stub Wave Link and a Meet tab that deliberately ignores commands:

```bash
node tests/watchdog-test.mjs
```

To check the Meet half specifically, join a call, run
`tail -f ~/Library/Logs/wave-meet-sync.log`, and click Meet's mic button — you should see
`meet -> MUTED` and the Wave's ring turn red.

## Behaviour

| You do | Result |
|---|---|
| Tap the Wave:3 | Meet mutes/unmutes to match; ring goes red |
| Click Meet's mic / ⌘+D | Wave:3 mutes/unmutes to match |
| Join a call already muted in Meet | Both end up muted (safe direction) |
| Leave the call | Wave:3 keeps its current state |
| Wave Link quits | Daemon retries every 3s; Meet keeps working normally |

`MUTE_WINS_ON_FIRST_SYNC` at the top of `sync.mjs` controls that third row. Set it to
`false` if you'd rather the Wave's state win when a call starts.

## Troubleshooting

Start here:

```bash
curl -s http://127.0.0.1:8777/status
```

```json
{ "wavePort": 1884, "waveConnected": true, "waveMuted": false,
  "meetMuted": null, "meetTabsConnected": 0 }
```

- `waveConnected: false` — Wave Link isn't running, or isn't on 1884-1893.
- **`meetTabsConnected: 0` while a Meet call is open** — the extension isn't reaching
  the daemon. Almost always it simply isn't loaded: check `chrome://extensions` for
  "Wave Meet Sync", and remember Chrome must be on the profile you actually use.
  After loading it, **reload the Meet tab** — content scripts are only injected on
  page load.
- `meetMuted: null` with `meetTabsConnected: 1` — the extension is connected but can't
  find Meet's mic button; see the next section.

If the extension is loaded and the Meet tab is reloaded but nothing connects, open
DevTools on the Meet tab. `[wave-meet-sync] content script loaded` should appear
immediately. If it's followed by a connection error while `curl` above works, Chrome's
**Local Network Access** is blocking the socket — see Notes.

## Meet says "Microphone muted by the system"

macOS keeps its **own** mute flag on the Wave:3 audio device, separate from Wave Link's
mute. Nothing in the Meet or Wave Link UI shows it, and it survives reboots. When it is
stuck on, Chrome reports the device as muted and Meet nags no matter what Wave Link says.

Check and clear it:

```bash
swift tools/wave-input.swift          # show state
swift tools/wave-input.swift unmute   # clear it
```

Then reload the Meet tab.

**Ignore the "increase its level" half of that message.** On the Wave:3 the macOS input
level *is* the mic gain Wave Link shows — they are one control with a non-linear mapping
(0.28 here == gain 0.525 == ~21 dB; 0.90 == gain 0.95 == ~38 dB). Turning it up to satisfy
Meet will drive the preamp into clipping. Set gain in Wave Link, not in System Settings.

## If Meet stops responding

Google renames Meet's `jsname` attributes every year or so. Open the console on a live
Meet tab and run:

```js
document.querySelectorAll('[data-is-muted]')
```

The mic button is the one whose `textContent` is `mic` or `mic_off`. Put its selector at
the top of `micButton()` in `extension/content.js`. The current selectors track
[ChrisRegado/streamdeck-googlemeet](https://github.com/ChrisRegado/streamdeck-googlemeet),
which is maintained and is the fastest place to see a fix after a Meet redesign.

## Notes

- Wave Link 3.2.2 will refuse new connections after a handful of failed handshakes and
  leaves the dead sockets in `CLOSED`. The daemon therefore holds **one** long-lived
  connection and backs off rather than reconnecting in a tight loop. If it ever wedges,
  quit and reopen Wave Link.
- **Local Network Access (Chrome 142+).** Chrome now gates requests from a public page
  to loopback. Extensions are exempt only if they hold host permissions for the target,
  so `manifest.json` lists `http://127.0.0.1/*` and `http://localhost/*` next to
  `meet.google.com`. (Chrome had a bug where host permissions didn't grant the exemption;
  it was fixed in 144.0.7512.0, so make sure Chrome is current.) After editing the
  manifest you must hit **Reload** on the extension *and* reload the Meet tab.
- Everything is loopback-only and there are no dependencies to install.
