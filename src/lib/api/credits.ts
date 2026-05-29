import { fetchJson } from "./fetcher";
import type { CreditsResponse } from "@/lib/types/api";

export function getCredits(): Promise<CreditsResponse> {
  return fetchJson<CreditsResponse>("/api/credits", { method: "GET" });
}
