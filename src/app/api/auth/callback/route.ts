/**
 * GET /api/auth/callback
 * Supabase OAuth code exchange. Routes new users to /onboarding,
 * existing users to /dashboard.
 * Source: _workspace/02_api_spec.md §3.1.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/dashboard';
  const base = url.origin;

  if (!code) {
    return NextResponse.redirect(`${base}/login?error=oauth_failed`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[auth.callback] exchange failed', error);
    return NextResponse.redirect(`${base}/login?error=oauth_failed`);
  }

  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id;
  if (!userId) {
    return NextResponse.redirect(`${base}/login?error=oauth_failed`);
  }

  // Decide route by users_profile presence (RLS uses cookie session).
  const { data: profile } = await supabase
    .from('users_profile')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  const destination = profile ? next : '/onboarding';
  return NextResponse.redirect(`${base}${destination}`);
}
