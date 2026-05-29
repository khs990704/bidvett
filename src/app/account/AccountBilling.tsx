"use client";

import * as React from "react";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { getCredits, ApiError } from "@/lib/api";
import type { CreditsResponse } from "@/lib/types/api";
import { toast } from "@/components/ui/sonner";

export function AccountBilling() {
  const [data, setData] = React.useState<CreditsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getCredits();
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled)
          toast.error("Could not load billing info.", {
            description: err instanceof ApiError ? err.message : undefined,
          });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Credits balance:</span>
              <Badge variant="secondary">{data?.balance ?? 0}</Badge>
            </div>
            {data?.active_pass ? (
              <p>
                <span className="text-muted-foreground">Weekly Pass: </span>
                expires {new Date(data.active_pass.expires_at).toLocaleString()}{" "}
                · {data.active_pass.usage_this_period}/
                {data.active_pass.soft_cap} used
              </p>
            ) : null}
            {data?.active_subscription ? (
              <p>
                <span className="text-muted-foreground">Monthly Sub: </span>
                renews{" "}
                {new Date(
                  data.active_subscription.period_end,
                ).toLocaleString()}{" "}
                · {data.active_subscription.usage_this_period}/
                {data.active_subscription.soft_cap} used
                {data.active_subscription.cancel_at_period_end
                  ? " · cancels at period end"
                  : ""}
              </p>
            ) : null}
            {!data?.active_pass && !data?.active_subscription ? (
              <p className="text-muted-foreground">No active plan.</p>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button asChild variant="outline">
            <Link href="/pricing">View plans</Link>
          </Button>
          <Button asChild variant="ghost">
            <a
              href="https://billing.stripe.com/p/login"
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage in Stripe Portal ↗
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Payment history and invoices are available in your Stripe receipts.
        </p>
      </CardContent>
    </Card>
  );
}
