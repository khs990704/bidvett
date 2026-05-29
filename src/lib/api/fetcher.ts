import type { ApiErrorEnvelope, ApiErrorCode } from "@/lib/types/api";

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode | "ERR_NETWORK";
  public readonly details?: Record<string, unknown>;

  constructor(args: {
    status: number;
    code: ApiErrorCode | "ERR_NETWORK";
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
  }
}

export interface FetchJsonOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  idempotencyKey?: string;
}

export async function fetchJson<T>(
  path: string,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const { body, idempotencyKey, headers, ...rest } = opts;

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };

  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (idempotencyKey) {
    finalHeaders["Idempotency-Key"] = idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError({
      status: 0,
      code: "ERR_NETWORK",
      message: err instanceof Error ? err.message : "Network error",
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const envelope = parsed as Partial<ApiErrorEnvelope> | undefined;
    const code = envelope?.error?.code ?? "ERR_INTERNAL";
    const message = envelope?.error?.message ?? response.statusText;
    throw new ApiError({
      status: response.status,
      code,
      message,
      details: envelope?.error?.details,
    });
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
