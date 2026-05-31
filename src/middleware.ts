import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Middleware:
 *   1. Refresh the Supabase session cookie on every request.
 *   2. Gate /dashboard/**, /onboarding, /account, /analyses/** behind auth.
 *
 * Per-IP rate limiting for /api/* is handled in the route handlers (backend
 * scope). This middleware focuses on the auth gate + cookie hygiene.
 */

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/onboarding",
  "/account",
  "/analyses",
];

const AUTH_REDIRECT_TO = "/login";

export async function middleware(req: NextRequest) {
  let response = NextResponse.next({ request: { headers: req.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfiguration — let request through; route handlers will fail loudly.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) =>
          req.cookies.set(name, value),
        );
        response = NextResponse.next({ request: { headers: req.headers } });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = req.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  if (isProtected && !user) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = AUTH_REDIRECT_TO;
    redirectUrl.searchParams.set("redirect_to", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  // If signed-in user lands on /login, push them forward.
  if (user && pathname === "/login") {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, robots.txt, sitemap.xml
     * - api/webhooks/dodo (signature-authenticated, skip cookie refresh)
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/webhooks/dodo|api/auth/callback).*)",
  ],
};
