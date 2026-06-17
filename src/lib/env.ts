/**
 * Environment variable validation.
 * Source: _workspace/01_architecture.md §10, _workspace/00_input.md §11.3 (PIVOT-01).
 *
 * Server-only vars are validated lazily on first access via `serverEnv()`,
 * so unrelated routes (and client bundles) don't trip the check.
 * Public (NEXT_PUBLIC_*) vars are validated eagerly at module load.
 *
 * Payment provider: Dodo Payments (PIVOT-01 2026-05-29).
 */
import { z } from 'zod';

// --------------------------------------------------------------------
// Public env — safe in client bundles. NEXT_PUBLIC_* prefix required.
// --------------------------------------------------------------------
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  // Dodo Payments — hosted-redirect flow, so no publishable key is shipped.
  NEXT_PUBLIC_DODO_PRICE_SINGLE: z.string().min(1).optional(),
  NEXT_PUBLIC_DODO_PRICE_WEEKLY: z.string().min(1).optional(),
  NEXT_PUBLIC_DODO_PRICE_MONTHLY: z.string().min(1).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_DODO_PRICE_SINGLE: process.env.NEXT_PUBLIC_DODO_PRICE_SINGLE,
  NEXT_PUBLIC_DODO_PRICE_WEEKLY: process.env.NEXT_PUBLIC_DODO_PRICE_WEEKLY,
  NEXT_PUBLIC_DODO_PRICE_MONTHLY: process.env.NEXT_PUBLIC_DODO_PRICE_MONTHLY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});

// --------------------------------------------------------------------
// Server env — never imported into client bundles.
// --------------------------------------------------------------------
const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  // Dodo Payments — server-side API + Standard Webhooks signing secret.
  DODO_API_KEY: z.string().min(1),
  DODO_WEBHOOK_SECRET: z.string().min(1),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),
  KV_REST_API_READ_ONLY_TOKEN: z.string().min(1).optional(),
  KV_URL: z.string().min(1).optional(),
  SENTRY_DSN: z.string().optional(),
  SYSTEM_PROMPT_VERSION: z.coerce.number().int().min(1).default(1),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

let _serverEnv: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() called from client bundle.');
  }
  const parsed = serverEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DODO_API_KEY: process.env.DODO_API_KEY,
    DODO_WEBHOOK_SECRET: process.env.DODO_WEBHOOK_SECRET,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    KV_REST_API_READ_ONLY_TOKEN: process.env.KV_REST_API_READ_ONLY_TOKEN,
    KV_URL: process.env.KV_URL,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SYSTEM_PROMPT_VERSION: process.env.SYSTEM_PROMPT_VERSION,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid server environment: ${issues}`);
  }
  _serverEnv = parsed.data;
  return _serverEnv;
}
