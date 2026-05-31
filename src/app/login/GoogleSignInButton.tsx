"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface Props {
  redirectTo: string;
}

export function GoogleSignInButton({ redirectTo }: Props) {
  const [loading, setLoading] = React.useState(false);

  const onClick = async () => {
    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const next = encodeURIComponent(redirectTo || "/dashboard");
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/api/auth/callback?next=${next}`,
        },
      });
      if (error) {
        throw error;
      }
      // Browser is redirected to Google; nothing further to do here.
    } catch (err) {
      setLoading(false);
      toast.error("Could not start sign-in.", {
        description: err instanceof Error ? err.message : "Please retry.",
      });
    }
  };

  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="w-full"
      size="lg"
      data-testid="google-signin"
    >
      {loading ? <Spinner className="text-primary-foreground" /> : <GoogleIcon />}
      Continue with Google
    </Button>
  );
}

function GoogleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M21.35 11.1H12v3.8h5.35c-.23 1.4-1.62 4.1-5.35 4.1A6 6 0 1 1 12 6c1.66 0 2.78.66 3.42 1.23l2.34-2.28C16.39 3.74 14.38 3 12 3a9 9 0 1 0 0 18c5.2 0 8.62-3.66 8.62-8.8 0-.6-.06-1.04-.27-2.1Z"
        fill="#fff"
      />
    </svg>
  );
}
