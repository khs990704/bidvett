"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getCredits, ApiError } from "@/lib/api";
import type { CreditsResponse } from "@/lib/types/api";
import { toast } from "@/components/ui/sonner";

interface Props {
  initial?: CreditsResponse | null;
  /** External version key to force refetch (parent bumps after analyze). */
  reloadKey?: number;
}

export function CreditBadge({ initial, reloadKey = 0 }: Props) {
  const [data, setData] = React.useState<CreditsResponse | null>(
    initial ?? null,
  );
  const [loading, setLoading] = React.useState(initial == null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await getCredits();
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) {
          toast.error("Could not load credits.", {
            description: err instanceof ApiError ? err.message : undefined,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (initial == null || reloadKey > 0) {
      void load();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return (
    <Card>
      <CardContent className="pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Credits</span>
            <Badge variant={(data?.balance ?? 0) > 0 ? "secondary" : "destructive"}>
              {loading ? "…" : `${data?.balance ?? 0} left`}
            </Badge>
          </div>
          {data?.active_pass ? (
            <PassLine
              label="Weekly Pass"
              data={data.active_pass}
              showCancelHint={data.active_pass.cancel_at_period_end}
            />
          ) : null}
          {data?.active_subscription ? (
            <PassLine
              label="Monthly Sub"
              data={data.active_subscription}
              showCancelHint={data.active_subscription.cancel_at_period_end}
            />
          ) : null}
          {!data?.active_pass && !data?.active_subscription && !loading ? (
            <span className="text-xs text-muted-foreground">No active plan</span>
          ) : null}
          {loading ? <Spinner /> : null}
        </div>

        {(data?.balance ?? 0) === 0 &&
        !data?.active_pass &&
        !data?.active_subscription ? (
          <Button asChild size="sm">
            <Link href="/pricing">Buy more</Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href="/pricing">Manage plan</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function PassLine({
  label,
  data,
  showCancelHint,
}: {
  label: string;
  data: {
    usage_this_period: number;
    soft_cap: number;
    period_end?: string;
    expires_at?: string;
    is_recurring?: boolean;
  };
  showCancelHint?: boolean;
}) {
  const end = "period_end" in data ? data.period_end : data.expires_at;
  return (
    <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
      <Badge variant="outline">{label}</Badge>
      <span>
        {data.usage_this_period}/{data.soft_cap} used
      </span>
      {end ? (
        <span>
          · {data.is_recurring === false ? "expires" : "renews"} {formatDate(end)}
        </span>
      ) : null}
      {showCancelHint ? <span className="text-warning">· cancels at period end</span> : null}
    </div>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
