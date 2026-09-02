// fetch() only rejects on network failure - a 400, 403 or 500 resolves
// normally. Code that updates the screen first and calls the server second
// has to check the status, or a rejected change stays visible as though it
// had saved. Use this instead of calling fetch directly for writes.

export async function sendJSON<T = any>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }

  return res.json().catch(() => ({} as T));
}
