import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { UserMenu } from "./UserMenu";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  variant?: "marketing" | "app";
}

export async function Header({ variant = "app" }: HeaderProps) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between">
        <Link
          href={user ? "/dashboard" : "/"}
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
          BidVett
        </Link>

        <nav className="flex items-center gap-1 sm:gap-3 text-sm">
          {variant === "app" && user ? (
            <>
              <Link
                href="/dashboard"
                className="hidden sm:inline px-3 py-2 text-muted-foreground hover:text-foreground"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/history"
                className="hidden sm:inline px-3 py-2 text-muted-foreground hover:text-foreground"
              >
                History
              </Link>
              <Link
                href="/pricing"
                className="px-3 py-2 text-muted-foreground hover:text-foreground"
              >
                Pricing
              </Link>
              <UserMenu email={user.email ?? ""} />
            </>
          ) : (
            <>
              <Link
                href="/pricing"
                className="px-3 py-2 text-muted-foreground hover:text-foreground"
              >
                Pricing
              </Link>
              <Button asChild size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
