import type { AlertPage, Child, ChildFields, ChildSummary, Rule } from "../../shared/parent";

export function parentApi(serverUrl: string, fetchImpl: typeof fetch) {
  async function request<T>(path: string, { signal, ...init }: RequestInit = {}): Promise<T> {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetchImpl(new URL("/api/parent/" + path, serverUrl), {
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...init,
    });
    if (!response.ok) throw new Error("Parent API returned " + response.status);
    if (response.status === 204) return undefined as T;
    return response.json();
  }

  const post = <T,>(path: string, body: unknown) => request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    children: (signal?: AbortSignal) => request<ChildSummary[]>("children", { signal }),
    rules: (signal: AbortSignal) => request<Rule[]>("rules", { signal }),
    child: (id: string) => request<Child>("children/" + id),
    save: (data: ChildFields, id?: string) => post<Child>(id ? "children/" + id : "children", data),
    remove: (id: string) => request<void>("children/" + id, { method: "DELETE" }),
    addRule: (label: string) => post<Rule>("rules", { label }),
    alerts: (childId: string | undefined, cursor: string | null, signal: AbortSignal) => {
      const params = new URLSearchParams();
      if (childId) params.set("childId", childId);
      if (cursor) params.set("cursor", cursor);
      return request<AlertPage>("alerts?" + params, { signal });
    },
    markAlertsSeen: (turnIds: string[]) => post<void>("alerts/read", { turnIds }),
  };
}
