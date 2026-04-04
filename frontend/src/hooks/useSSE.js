import { useEffect, useRef, useCallback } from "react";

/**
 * Opens an SSE connection to /api/events/{jobId} and calls the provided
 * handler for each event received.
 *
 * @param {string|null} jobId  - The job UUID returned by the backend.
 * @param {function}    onEvent - Called with the parsed JSON event object.
 * @param {function}    [onError] - Called when the stream errors.
 */
export function useSSE(jobId, onEvent, onError) {
  const esRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);

  // Keep refs up-to-date without re-running the effect
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/events/${jobId}`);
    esRef.current = es;

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
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [jobId]);

  const close = useCallback(() => {
    esRef.current?.close();
  }, []);

  return { close };
}
