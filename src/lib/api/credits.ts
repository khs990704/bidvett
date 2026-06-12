import { fetchJson } from "./fetcher";
import type { CreditsResponse, CancelSubscriptionResponse } from "@/lib/types/api";

export function getCredits(): Promise<CreditsResponse> {
  return fetchJson<CreditsResponse>("/api/credits", { method: "GET" });
}

export function cancelSubscription(): Promise<CancelSubscriptionResponse> {
  return fetchJson<CancelSubscriptionResponse>("/api/subscription/cancel", {
    method: "POST",
  });
}
