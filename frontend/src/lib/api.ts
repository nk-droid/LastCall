// Same-origin JSON client. /api/* is proxied to the FastAPI backend by next.config.ts.

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  correlationId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, correlationId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.correlationId = correlationId;
  }

  /** Field-level validation messages keyed by dotted field path (e.g. "customer.email"). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code === "validation_error" && Array.isArray(this.details)) {
      for (const d of this.details as { field: string; message: string }[]) {
        out[d.field] = d.message;
      }
    }
    return out;
  }
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), opts.timeoutMs ?? 45_000);
  opts.signal?.addEventListener("abort", () => controller.abort(opts.signal?.reason));
  let response: Response;
  try {
    response = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiError(0, timedOut ? "timeout" : "network_error",
      timedOut ? "This is taking longer than expected. Check your connection and try again." : "We couldn't reach LastCall. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown; correlation_id?: string } } | null)?.error;
    throw new ApiError(response.status, err?.code ?? "http_error", err?.message ?? `Request failed (${response.status})`, err?.details, err?.correlation_id);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
