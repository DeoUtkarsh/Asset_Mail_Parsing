import { useEffect, useRef, useCallback } from "react";

/**
 * Opens an SSE connection to /api/events/{jobId} and calls the provided
 * handler for each event received.
 *
 * @param {string|null} jobId  - The job UUID returned by the backend.
 * @param {function}    onEvent - Called with the parsed JSON event object.
 * @param {function}    [onError] - Called when the stream errors.
 * @param {{ reconnect?: boolean }} [options]
 *   reconnect — keep retrying after disconnect (needed for the "live" bus
 *   behind ALB/CloudFront idle timeouts).
 */
export function useSSE(jobId, onEvent, onError, options = {}) {
  const { reconnect = false } = options;
  const esRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);

  // Keep refs up-to-date without re-running the effect
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    let es = null;
    let retryTimer = null;
    let delayMs = 1000;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`/api/events/${jobId}`);
      esRef.current = es;

      es.onopen = () => {
        delayMs = 1000;
      };

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current?.(data);
        } catch {
          // Heartbeat pings are plain strings — ignore silently
        }
      };

      es.onerror = (e) => {
        onErrorRef.current?.(e);
        es.close();
        esRef.current = null;
        if (!reconnect || cancelled) return;
        retryTimer = setTimeout(() => {
          delayMs = Math.min(Math.round(delayMs * 1.5), 15000);
          connect();
        }, delayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      esRef.current = null;
    };
  }, [jobId, reconnect]);

  const close = useCallback(() => {
    esRef.current?.close();
  }, []);

  return { close };
}
