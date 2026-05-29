/**
 * POST /api/gdpr/delete — placeholder per 00_input.md §6 item #4.
 * v1.1 will implement account deletion (cascade via auth.users delete).
 * For MVP this returns 501 Not Implemented.
 */
import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/require-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async () => {
  await requireUser();
  return NextResponse.json(
    {
      error: {
        code: 'ERR_NOT_IMPLEMENTED',
        message: 'Account deletion will be available in v1.1.',
      },
    },
    { status: 501 },
  );
});
