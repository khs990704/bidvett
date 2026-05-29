"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ChevronDown } from "lucide-react";

export function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const router = useRouter();

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const signOut = async () => {
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.push("/");
      router.refresh();
    } catch (err) {
      toast.error("Sign out failed.", {
        description: err instanceof Error ? err.message : "Please retry.",
      });
    }
  };

  const initial = (email || "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {initial}
        </span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">
            {email}
          </div>
          <Link
            href="/account"
            className="block rounded px-2 py-1.5 hover:bg-accent"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Account settings
          </Link>
          <Link
            href="/dashboard/history"
            className="block rounded px-2 py-1.5 hover:bg-accent"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Analysis history
          </Link>
          <button
            type="button"
            role="menuitem"
            className="block w-full text-left rounded px-2 py-1.5 text-destructive hover:bg-accent"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
