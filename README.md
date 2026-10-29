# web — Live Stream Viewer (Next.js + WebRTC)

A low-latency **WebRTC** live video viewer built with **Next.js 16, React 19, TypeScript and Tailwind CSS**.
It connects to the Go streaming server **[Tayyab-Ali-786/web_stream](https://github.com/Tayyab-Ali-786/web_stream)**
and plays its H.264 feed in the browser, adapting to the network in real time.

---

## Highlights

- **Custom `useStreamSession` React hook** that owns the whole WebRTC lifecycle — `RTCPeerConnection` setup,
  SDP offer/answer signaling, ICE candidate queuing, connection-state tracking and auto-reconnect
- **Adaptive quality controller** — samples `RTCPeerConnection.getStats()` every 2 s, computes the
  packet-loss *rate* and tunes the receiver jitter buffer:

  | Packet loss | Quality | Jitter buffer target |
  |---|---|---|
  | < 1% | good | 200 ms |
  | 1–5% | fair | 400 ms |
  | > 5% | poor | 800 ms |

- **Codec preferencing** — prefers H.264 Constrained Baseline (`42e01f`), then other H.264 profiles, VP8 and VP9,
  while keeping RTX/FEC so the browser can still request retransmits. Baseline has no B-frames, so a lost packet
  causes a short blip instead of macroblocking
- **SDP bandwidth shaping** — injects `b=AS` into the video section so the encoder is never starved
- **Freeze detector** — if `video.currentTime` stops advancing for 3 s, it re-attaches the `MediaStream` to reset the
  decoder *without* tearing down the WebRTC connection (skips hidden tabs to avoid false positives)
- **Live status UI** — connection state and network quality badges, start/stop controls

## How it works

```
useStreamSession()
  ├─ new RTCPeerConnection (max-bundle, rtcp-mux)
  ├─ addTransceiver("video", recvonly) + setCodecPreferences()
  ├─ createOffer → cap bandwidth → POST /api/offer → setRemoteDescription(answer)
  ├─ ontrack → attach stream, set jitterBufferTarget / playoutDelayHint
  ├─ every 2s: getStats() → loss rate → good / fair / poor → adjust buffer
  └─ freeze guard + auto-reconnect on failure
```

Key file: [`src/hooks/useStreamSession.ts`](src/hooks/useStreamSession.ts) · UI: [`src/app/page.tsx`](src/app/page.tsx)

## Getting started

**Requirements:** Node.js 20+, and the [web_stream](https://github.com/Tayyab-Ali-786/web_stream) server running on
`localhost:8080`.

```bash
git clone https://github.com/Tayyab-Ali-786/web.git
cd web
npm install
npm run dev
```

Open `http://localhost:3000` — the stream starts automatically.

| Script | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run dev:safe` | Dev server wrapped in a watchdog that logs and kills it on RAM spikes or freezes |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` | ESLint |

## Tech stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · WebRTC (RTCPeerConnection, getStats, setCodecPreferences) · lucide-react

## Status

Prototype. The signaling URL is currently hardcoded to `http://localhost:8080/api/offer` in the hook.

---

Built by **[Tayyab Ali Rashid](https://www.linkedin.com/in/tayyab-ali-rashid-a471a7309/)**
