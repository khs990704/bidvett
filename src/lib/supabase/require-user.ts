/**
 * Server-side auth guard. Throws ApiError(401, ERR_UNAUTHENTICATED) if no session.
 * Kept separate from `server.ts` (co-owned with frontend) to avoid merge conflicts.
 */
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { ApiError, ErrorCode } from '@/lib/errors';

export async function requireUser(): Promise<{
  id: string;
  email: string | null;
}> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    throw new ApiError(401, ErrorCode.UNAUTHENTICATED);
  }
  return { id: data.user.id, email: data.user.email ?? null };
}
