/** A passive compatibility stream; tool responses continue to use POST. */
export function agentKeepAliveStream(
  signal: AbortSignal,
  isAuthorized: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (close: boolean) => {
        if (stopped) return;
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (close) controller.close();
      };
      const abort = () => cleanup(true);
      stop = () => cleanup(false);
      const tick = async () => {
        try {
          const authorized = await isAuthorized();
          if (stopped) return;
          if (!authorized) return cleanup(true);
          // A slow/disconnected reader must not accumulate heartbeat frames.
          if ((controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          timer = setTimeout(() => void tick(), 15000);
        } catch {
          if (stopped) return;
          cleanup(false);
          controller.error(new Error("MCP stream authorization check failed."));
        }
      };
      if (signal.aborted) return cleanup(true);
      signal.addEventListener("abort", abort, { once: true });
      controller.enqueue(encoder.encode("retry: 5000\n: connected\n\n"));
      timer = setTimeout(() => void tick(), 15000);
    },
    cancel() {
      stop();
    },
  });
}
