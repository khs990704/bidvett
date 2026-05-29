/**
 * System prompt loader.
 * Source: _workspace/01_architecture.md §6.5, _workspace/02_api_spec.md §7/§8.
 *
 * Loads `is_active=true` row from `system_prompts` for the given name.
 * Cached in Vercel KV with 60s TTL (`prompt:cache:{name}`), with a
 * per-worker in-memory fallback to absorb cold-start spikes.
 *
 * Hardcoding the prompt body is forbidden. If both DB and KV fail and
 * no env fallback is configured, ERR_PROMPT_NOT_FOUND is thrown.
 */
import { supabaseAdmin } from '@/lib/supabase/admin';
import { kvGetJson, kvSetJsonEx } from '@/lib/rate-limit/kv';
import { ApiError, ErrorCode } from '@/lib/errors';
import { serverEnv } from '@/lib/env';

export type PromptName = 'analyze.v1' | 'profile_extract.v1';

export interface LoadedPrompt {
  name: PromptName;
  version: number;
  content: string;
}

interface InMemoryEntry {
  expiresAt: number;
  prompt: LoadedPrompt;
}

const TTL_SEC = 60;
const memCache = new Map<string, InMemoryEntry>();

function kvKey(name: PromptName): string {
  return `prompt:cache:${name}`;
}

export async function getActivePrompt(name: PromptName): Promise<LoadedPrompt> {
  // 1) In-memory (per-worker) cache
  const now = Date.now();
  const memHit = memCache.get(name);
  if (memHit && memHit.expiresAt > now) {
    return memHit.prompt;
  }

  // 2) KV (cross-worker) cache
  try {
    const cached = await kvGetJson<LoadedPrompt>(kvKey(name));
    if (cached && typeof cached.version === 'number' && typeof cached.content === 'string') {
      memCache.set(name, { expiresAt: now + TTL_SEC * 1000, prompt: cached });
      return cached;
    }
  } catch {
    // KV unavailable — fall through to DB.
  }

  // 3) DB read (service_role)
  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from('system_prompts')
      .select('name, version, content, is_active')
      .eq('name', name)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (!error && data?.content) {
      const loaded: LoadedPrompt = {
        name,
        version: data.version,
        content: data.content,
      };
      memCache.set(name, { expiresAt: now + TTL_SEC * 1000, prompt: loaded });
      try {
        await kvSetJsonEx(kvKey(name), loaded, TTL_SEC);
      } catch {
        // KV write failure is non-fatal.
      }
      return loaded;
    }
  } catch {
    // DB unreachable — try env fallback.
  }

  // 4) Env fallback version only (content cannot be sourced — hardcoding forbidden).
  // This branch fails closed.
  const fallbackVersion = serverEnv().SYSTEM_PROMPT_VERSION;
  throw new ApiError(500, ErrorCode.PROMPT_NOT_FOUND, {
    prompt_name: name,
    fallback_version: fallbackVersion,
  });
}
