import { fetchJson } from "./fetcher";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AnalysesListResponse,
  ReportScamRequest,
  ReportScamResponse,
} from "@/lib/types/api";

export function analyzeJob(
  body: AnalyzeRequest,
  opts?: { idempotencyKey?: string },
): Promise<AnalyzeResponse> {
  return fetchJson<AnalyzeResponse>("/api/analyze", {
    method: "POST",
    body,
    idempotencyKey: opts?.idempotencyKey,
  });
}

export function listAnalyses(args?: {
  limit?: number;
  cursor?: string;
}): Promise<AnalysesListResponse> {
  const params = new URLSearchParams();
  if (args?.limit) params.set("limit", String(args.limit));
  if (args?.cursor) params.set("cursor", args.cursor);
  const qs = params.toString();
  return fetchJson<AnalysesListResponse>(
    `/api/analyses${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

export function getAnalysis(id: string): Promise<AnalyzeResponse> {
  return fetchJson<AnalyzeResponse>(`/api/analyses/${id}`, { method: "GET" });
}

export function reportScam(body: ReportScamRequest): Promise<ReportScamResponse> {
  return fetchJson<ReportScamResponse>("/api/report-scam", {
    method: "POST",
    body,
  });
}
