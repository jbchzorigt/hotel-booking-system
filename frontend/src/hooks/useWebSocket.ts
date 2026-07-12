"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/lib/axios";
import { useAuthStore } from "@/store/authStore";

export type WebSocketStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

interface UseWebSocketOptions<TEvent> {
  /** Called for every parsed JSON frame from the server. */
  onEvent?: (event: TEvent) => void;
  /** Set false to hold the connection (e.g. while auth is hydrating). */
  enabled?: boolean;
}

/** 1008 = policy violation — the server rejected our token. Reconnecting
 *  with the same credentials would just hammer the endpoint. */
const WS_POLICY_VIOLATION = 1008;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function wsUrl(path: string, token: string): string {
  // WS endpoints are mounted at the server ROOT ("WS paths are not
  // API-versioned"), so strip any path (e.g. /api/v1) that
  // NEXT_PUBLIC_API_URL carries and keep only protocol + host.
  const origin = new URL(API_BASE_URL).origin.replace(/^http/, "ws");
  return `${origin}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * Authenticated, auto-reconnecting WebSocket subscription.
 *
 * The backend endpoints (`/ws/reception`, `/ws/restaurant/orders`,
 * `/ws/police/alerts`) are server-push only: the JWT rides in `?token=`,
 * the topic is derived server-side from the token's scope, and client
 * frames are ignored — so this hook exposes events, not a send channel.
 *
 * Reconnection: exponential backoff with jitter, reset on a successful
 * open. A 1008 close (auth rejection) stops the loop for good; a token
 * change tears down and reconnects with the new credentials.
 */
export function useWebSocket<TEvent = unknown>(
  path: string,
  { onEvent, enabled = true }: UseWebSocketOptions<TEvent> = {}
) {
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<WebSocketStatus>("idle");
  const [lastEvent, setLastEvent] = useState<TEvent | null>(null);

  // The handler lives in a ref so a new inline callback each render
  // doesn't tear the socket down.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      // Neutralize handlers so this close doesn't schedule a reconnect.
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }, []);

  useEffect(() => {
    if (!enabled || !token) {
      disconnect();
      setStatus("idle");
      return;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const socket = new WebSocket(wsUrl(path, token));
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setStatus("open");
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        let parsed: TEvent;
        try {
          parsed = JSON.parse(message.data) as TEvent;
        } catch {
          return; // non-JSON frame — not ours to handle
        }
        setLastEvent(parsed);
        onEventRef.current?.(parsed);
      };

      socket.onclose = (event: CloseEvent) => {
        socketRef.current = null;
        if (disposed) return;

        if (event.code === WS_POLICY_VIOLATION) {
          setStatus("closed");
          return;
        }

        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * 2 ** attemptRef.current,
          MAX_RECONNECT_DELAY_MS
        );
        attemptRef.current += 1;
        setStatus("reconnecting");
        reconnectTimerRef.current = setTimeout(
          connect,
          delay + Math.random() * 500 // jitter: don't stampede on recovery
        );
      };

      // onerror always precedes onclose — reconnect logic lives there.
      socket.onerror = () => socket.close();
    };

    attemptRef.current = 0;
    connect();

    return () => {
      disposed = true;
      disconnect();
    };
  }, [path, token, enabled, disconnect]);

  return { status, lastEvent };
}
