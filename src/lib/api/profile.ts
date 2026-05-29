import { fetchJson } from "./fetcher";
import type {
  ProfileExtractRequest,
  ProfileExtractResponse,
  ProfileResponse,
  ProfileUpdateRequest,
} from "@/lib/types/api";

export function extractProfile(
  body: ProfileExtractRequest,
): Promise<ProfileExtractResponse> {
  return fetchJson<ProfileExtractResponse>("/api/profile/extract", {
    method: "POST",
    body,
  });
}

export function getProfile(): Promise<ProfileResponse> {
  return fetchJson<ProfileResponse>("/api/profile", { method: "GET" });
}

export function saveProfile(
  body: ProfileUpdateRequest,
): Promise<ProfileResponse> {
  return fetchJson<ProfileResponse>("/api/profile", {
    method: "PUT",
    body,
  });
}
