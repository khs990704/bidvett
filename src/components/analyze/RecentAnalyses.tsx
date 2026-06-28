"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { RiskBadge } from "./RiskBadge";
import { listAnalyses, ApiError } from "@/lib/api";
import type { AnalysesListItem } from "@/lib/types/api";
import { toast } from "@/components/ui/sonner";
import { ChevronRight, Flag } from "lucide-react";

interface Props {
  reloadKey?: number;
  limit?: number;
}

export function RecentAnalyses({ reloadKey = 0, limit = 5 }: Props) {
  const [items, setItems] = React.useState<AnalysesListItem[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await listAnalyses({ limit });
        if (!cancelled) setItems(res.items);
      } catch (err) {
        if (!cancelled) {
          toast.error("Could not load history.", {
            description: err instanceof ApiError ? err.message : undefined,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, limit]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Recent analyses</CardTitle>
        <Link
          href="/dashboard/history"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all →
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : !items || items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No analyses yet. Paste a job above to get started.
          </p>
        ) : (
          <ul className="divide-y" data-testid="recent-list">
            {items.map((it) => (
              <li key={it.id}>
                <Link
                  href={`/analyses/${it.id}`}
                  className="flex items-center justify-between py-2.5 hover:bg-accent/40 px-1 rounded"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <RiskBadge riskLevel={it.risk_level} verdict={it.verdict} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {it.job_title ?? analysisSummary(it)}
                      </p>
                      {it.job_title ? (
                        <p className="text-xs text-muted-foreground">
                          {analysisSummary(it)}
                        </p>
                      ) : null}
                    </div>
                    {it.is_reported ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Flag className="h-3 w-3" /> reported
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatTs(it.created_at)}</span>
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function analysisSummary(it: AnalysesListItem): string {
  if (it.verdict === "DO_NOT_APPLY") return "BLOCKED";
  if (it.match_score !== null) return `Match ${it.match_score}`;
  return "Analysis";
}
