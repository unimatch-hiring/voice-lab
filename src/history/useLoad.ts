import { useCallback, useEffect, useRef, useState } from "react";

export type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed" };

/**
 * Loads once on mount and again on `reload`. A newer load aborts the older one, so a slow
 * answer can never overwrite a fresher one. `reload` resolves when its answer is shown.
 * `load` must be stable (useCallback), or every render starts a new request.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await load(controller.signal);
      if (!controller.signal.aborted) setState({ kind: "ready", data });
    } catch {
      if (!controller.signal.aborted) setState({ kind: "failed" });
    }
  }, [load]);

  useEffect(() => {
    void run();
    return () => controllerRef.current?.abort();
  }, [run]);

  return { state, reload: run };
}
