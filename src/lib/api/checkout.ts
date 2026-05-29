import { fetchJson } from "./fetcher";
import type { CheckoutRequest, CheckoutResponse } from "@/lib/types/api";

export function createCheckoutSession(
  body: CheckoutRequest,
  opts?: { idempotencyKey?: string },
): Promise<CheckoutResponse> {
  return fetchJson<CheckoutResponse>("/api/checkout", {
    method: "POST",
    body,
    idempotencyKey: opts?.idempotencyKey,
  });
}
