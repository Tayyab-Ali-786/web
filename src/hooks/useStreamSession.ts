export interface StreamSession {
  sessionId: string;
  wsUrl: string;
  iceServers: any[];
}
import { useCallback, useEffect, useRef, useState } from "react";

interface UseStreamSessionProps {
  payload: { type: "monitoring" | "incident"; cameraId: string; incidentId?: string };
  autoStart?: boolean;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

// ─── Auth token exchange ─────────────────────────────────────────────────────
async function fetchStreamToken(viewerSubject: string): Promise<string> {
  const url = `${import.meta.env.VITE_AUTH_TOKEN_EXCHANGE_URL}/token`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service: "web-stream",
      apiKey: import.meta.env.VITE_WEB_STREAM_API_KEY,
      subject: viewerSubject,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Stream token exchange failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.token as string;
}

// ─── Create stream session ───────────────────────────────────────────────────
async function createStreamSession(
  token: string,
  payload: UseStreamSessionProps["payload"]
): Promise<StreamSession> {
  const body: Record<string, unknown> = {
    type: payload.type,
    cameraId: payload.cameraId,
  };
  if (payload.incidentId) body.incidentId = payload.incidentId;
  if (payload.type === "incident") body.ttlSeconds = 30;

  const resp = await fetch(import.meta.env.VITE_STREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Session creation failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<StreamSession>;
}

// ─── Codec preference ────────────────────────────────────────────────────────
// "Clusters of pixels" (macroblocking) are caused by the decoder missing
// reference frames.  This happens more with H.264 High Profile under packet
// loss.  Constrainted Baseline (42e01f) uses only I/P frames — no B frames —
// so a missing packet causes a brief blip instead of a catastrophic cascade.
// We also accept VP8 as a strong fallback since its delta-coding is resilient.
function applyCodecPreferences(transceiver: RTCRtpTransceiver): void {
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps) return;

    // Priority order:
    //  1. H.264 Constrained Baseline 3.1  (payload id 42e01f) – most resilient
    //  2. H.264 any baseline/main              – still tolerable
    //  3. VP8                                  – good packet-loss resilience
    //  4. VP9                                  – keep as last resort
    const prioritised = [
      ...caps.codecs.filter(
        (c) =>
          c.mimeType.toLowerCase() === "video/h264" &&
          c.sdpFmtpLine?.includes("profile-level-id=42e0")
      ),
      ...caps.codecs.filter(
        (c) =>
          c.mimeType.toLowerCase() === "video/h264" &&
          !c.sdpFmtpLine?.includes("profile-level-id=42e0")
      ),
      ...caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/vp8"),
      ...caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/vp9"),
      // retain RTX and ULPFEC entries so the browser can still request retransmits
      ...caps.codecs.filter(
        (c) =>
          c.mimeType.toLowerCase() === "video/rtx" ||
          c.mimeType.toLowerCase() === "video/ulpfec" ||
          c.mimeType.toLowerCase() === "video/flexfec-03"
      ),
    ];

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const deduped = prioritised.filter((c) => {
      const key = `${c.mimeType}|${c.sdpFmtpLine ?? ""}|${c.clockRate}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (deduped.length > 0) {
      transceiver.setCodecPreferences(deduped);
      console.log("[Stream] Codec preference set:", deduped[0].mimeType, deduped[0].sdpFmtpLine ?? "");
    }
  } catch (e) {
    // setCodecPreferences not available in all browsers — silently continue
    console.warn("[Stream] setCodecPreferences not supported:", e);
  }
}

// ─── SDP bandwidth shaper ────────────────────────────────────────────────────
// Inject `b=AS:<kbps>` into the video m-section of the SDP.  Set high enough
// so the encoder is never artificially starved. ABR will do the real limiting.
function capSdpBandwidth(sdp: string, maxKbps = 8000): string {
  return sdp.replace(
    /(m=video [^\r\n]+\r\n)/,
    `$1b=AS:${maxKbps}\r\n`
  );
}

// ─── Video freeze detector ───────────────────────────────────────────────────
// If currentTime stops advancing for more than `thresholdMs` we reattach the
// MediaStream object which resets the decoder without tearing down WebRTC.
function attachFreezeGuard(
  videoEl: HTMLVideoElement,
  getStream: () => MediaStream | null,
  thresholdMs = 3000
): () => void {
  let lastTime = -1;
  let frozenSince: number | null = null;

  const id = window.setInterval(() => {
    if (videoEl.paused || videoEl.readyState < 2) return;

    const now = videoEl.currentTime;
    if (now === lastTime) {
      // currentTime is not advancing
      if (frozenSince === null) frozenSince = Date.now();
      if (Date.now() - frozenSince >= thresholdMs) {
        console.warn("[Stream] Freeze detected — resetting decoder");
        const stream = getStream();
        if (stream) {
          videoEl.srcObject = null;
          videoEl.srcObject = stream;
          videoEl.play().catch(() => {});
        }
        frozenSince = null;
      }
    } else {
      lastTime = now;
      frozenSince = null;
    }
  }, 1000);

  return () => window.clearInterval(id);
}

// ─── Adaptive Quality Controller ─────────────────────────────────────────────
// Monitors packet loss rate and dynamically adjusts the browser's jitter buffer.
// On slow networks the buffer grows (more latency, fewer freezes).
// On fast networks the buffer shrinks back (low latency, smooth playback).
type NetworkQuality = "good" | "fair" | "poor";

// ─── Hook ────────────────────────────────────────────────────────────────────
export function useStreamSession({
  payload,
  autoStart = true,
  videoRef,
}: UseStreamSessionProps) {
  const [session, setSession]               = useState<StreamSession | null>(null);
  const [isConnected, setIsConnected]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("good");

  const pcRef        = useRef<RTCPeerConnection | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const startedRef   = useRef(false);
  const stopFreezeRef = useRef<(() => void) | null>(null);
  const adaptiveRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopStream = useCallback(() => {
    stopFreezeRef.current?.();
    if (adaptiveRef.current) clearInterval(adaptiveRef.current);
    const pc = pcRef.current as (RTCPeerConnection & { _statsInterval?: ReturnType<typeof setInterval> }) | null;
    if (pc?._statsInterval) clearInterval(pc._statsInterval);
    wsRef.current?.close();
    pcRef.current?.close();
    wsRef.current      = null;
    pcRef.current      = null;
    streamRef.current  = null;
    startedRef.current = false;
    adaptiveRef.current = null;
    setIsConnected(false);
    setSession(null);
    setNetworkQuality("good");
  }, []);

  const startStream = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    try {
      console.log("[Stream] Bypassing auth config, connecting directly to local backend…");
      const sessionData: StreamSession = {
        sessionId: payload.incidentId || payload.cameraId,
        wsUrl: "ws://localhost:8080/stream",
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      };
      setSession(sessionData);

      // ── RTCPeerConnection ──────────────────────────────────────────────────
      const pc = new RTCPeerConnection({
        iceServers:       sessionData.iceServers,
        iceTransportPolicy: "all",
        bundlePolicy:     "max-bundle",
        rtcpMuxPolicy:    "require",
      });
      pcRef.current = pc;

      // ── Add video transceiver BEFORE createOffer so codec prefs apply ──────
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      applyCodecPreferences(transceiver);

      // ── ICE candidate queue (drain after remote desc is set) ───────────────
      const iceQueue: RTCIceCandidateInit[] = [];
      let remoteDescriptionSet = false;

      const drainIceQueue = async () => {
        while (iceQueue.length > 0) {
          const c = iceQueue.shift();
          if (c) await pc.addIceCandidate(c).catch((e) => console.error("[Stream] Queued ICE error:", e));
        }
      };

      // ── Track received ─────────────────────────────────────────────────────
      pc.ontrack = (e) => {
        const videoEl =
          videoRef?.current ??
          document.querySelector<HTMLVideoElement>("video#live");
        if (!videoEl) return;

        const stream = e.streams[0];
        streamRef.current = stream;

        // Apply an initial jitter buffer target of 200ms immediately
        if (e.receiver) {
          if ("playoutDelayHint" in e.receiver) {
            (e.receiver as RTCRtpReceiver & { playoutDelayHint: number }).playoutDelayHint = 0.2;
          }
          if ("jitterBufferTarget" in e.receiver) {
            (e.receiver as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 200;
          }
        }

        // ── Adaptive Quality Controller ────────────────────────────────────
        // Every 2 seconds, read the inbound-rtp stats and compute the packet
        // loss RATE (not cumulative total).  Based on the rate:
        //   < 1%  → "good":  playoutDelayHint = 0.2    (200ms buffer for base network jitter)
        //   1-5%  → "fair":  playoutDelayHint = 0.4    (400ms buffer)
        //   > 5%  → "poor":  playoutDelayHint = 0.8    (800ms buffer)
        // The browser's jitter buffer expands/contracts automatically,
        // absorbing network variance so the video doesn't freeze.
        let prevPacketsReceived = 0;
        let prevPacketsLost = 0;

        const adaptiveInterval = setInterval(async () => {
          if (pc.connectionState !== "connected") return;
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && (report as RTCInboundRtpStreamStats).kind === "video") {
              const r = report as RTCInboundRtpStreamStats & {
                jitterBufferDelay?: number;
                jitterBufferEmittedCount?: number;
                framesDropped?: number;
                framesDecoded?: number;
              };

              // ── Compute delta loss rate since last check ──
              const totalReceived = r.packetsReceived ?? 0;
              const totalLost     = r.packetsLost ?? 0;
              const deltaReceived = totalReceived - prevPacketsReceived;
              const deltaLost     = totalLost - prevPacketsLost;
              prevPacketsReceived = totalReceived;
              prevPacketsLost     = totalLost;

              const lossRate = deltaReceived > 0
                ? deltaLost / (deltaReceived + deltaLost)
                : 0;

              // ── Decide quality tier and jitter buffer size ──
              let quality: NetworkQuality;
              let delayHint: number;

              if (lossRate < 0.01) {
                quality   = "good";
                delayHint = 0.2;     // 200ms extra latency buffer for internet jitter
              } else if (lossRate < 0.05) {
                quality   = "fair";
                delayHint = 0.4;    // 400ms safety buffer
              } else {
                quality   = "poor";
                delayHint = 0.8;     // 800ms — absorb heavy jitter
              }

              // Apply playoutDelayHint and jitterBufferTarget to the receiver
              if (e.receiver) {
                if ("playoutDelayHint" in e.receiver) {
                  (e.receiver as RTCRtpReceiver & { playoutDelayHint: number }).playoutDelayHint = delayHint;
                }
                if ("jitterBufferTarget" in e.receiver) {
                  (e.receiver as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = delayHint * 1000;
                }
              }

              setNetworkQuality(quality);

              // ── Log diagnostics ──
              const jitterMs =
                r.jitterBufferDelay != null && r.jitterBufferEmittedCount
                  ? ((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000).toFixed(1)
                  : "n/a";

              console.log("[Stream Health]", {
                quality,
                lossRate:      (lossRate * 100).toFixed(1) + "%",
                delayHint:     delayHint * 1000 + "ms",
                packetsLost:   totalLost,
                jitterBufferMs: jitterMs,
                framesDropped: r.framesDropped ?? "n/a",
                framesDecoded: r.framesDecoded ?? "n/a",
                jitter:        ((r.jitter ?? 0) * 1000).toFixed(1) + " ms",
              });
            }
          });
        }, 2000);

        adaptiveRef.current = adaptiveInterval;

        videoEl.srcObject = stream;
        videoEl.play().catch(() => {});
        setIsConnected(true);

        // Attach freeze-guard (resets decoder on stall > 2s — tighter than before)
        stopFreezeRef.current?.();
        stopFreezeRef.current = attachFreezeGuard(
          videoEl,
          () => streamRef.current,
          2000
        );
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log("[Stream] Connection state:", state);
        if (state === "connected")   setIsConnected(true);
        if (state === "failed" || state === "disconnected") setIsConnected(false);
      };

      pc.onicecandidate = (e) => {
        // The backend uses a GatheringCompletePromise and sends all ICE candidates
        // inside the SDP Answer, so we don't need to trickle ICE candidates to it.
        if (e.candidate) {
          console.log("[Stream] Local ICE candidate gathered");
        }
      };

      // ── HTTP signalling (Backend Prototype) ────────────────────────────────
      // First, get our mock authentication token
      const authResp = await fetch("http://localhost:8080/api/auth/login", {
        method: "POST",
      });
      if (!authResp.ok) {
        throw new Error("Failed to authenticate with stream backend");
      }
      const { token } = await authResp.json();

      // Create offer with generous bandwidth cap — pacing is done server-side
      const offer = await pc.createOffer();
      const cappedSdp = capSdpBandwidth(offer.sdp ?? "", 8000);
      await pc.setLocalDescription({ type: "offer", sdp: cappedSdp });
      console.log("[Stream] Offer sent to local backend");

      const resp = await fetch("http://localhost:8080/api/offer", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}` 
        },
        body: JSON.stringify({ type: "offer", sdp: cappedSdp }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Signaling failed (${resp.status}): ${text}`);
      }

      const answer = await resp.json();
      if (answer.type === "answer" && answer.sdp) {
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        remoteDescriptionSet = true;
        await drainIceQueue();
      }

    } catch (err) {
      console.error("[Stream] Failed to start stream:", err);
      setError(err instanceof Error ? err.message : "Failed to start stream");
      startedRef.current = false;
    }
  // Payload primitives listed individually — prevents callback recreation on
  // every render when a new payload object is passed with the same values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.type, payload.cameraId, payload.incidentId, videoRef]);

  useEffect(() => {
    if (autoStart) startStream();
    return stopStream;
  }, [autoStart, startStream, stopStream]);

  return { session, isConnected, error, networkQuality, startStream, stopStream };
}

