"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Flag } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RiskBadge } from "@/components/analyze/RiskBadge";
import { listAnalyses, ApiError } from "@/lib/api";
import type { AnalysesListItem } from "@/lib/types/api";
import { toast } from "@/components/ui/sonner";

const PAGE_SIZE = 20;

export function HistoryList() {
  const [items, setItems] = React.useState<AnalysesListItem[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [initialLoaded, setInitialLoaded] = React.useState(false);

  const load = React.useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      try {
        const res = await listAnalyses({
          limit: PAGE_SIZE,
          cursor: nextCursor,
        });
        setItems((prev) => (nextCursor ? [...prev, ...res.items] : res.items));
        setCursor(res.next_cursor);
        if (!res.next_cursor || res.items.length < PAGE_SIZE) setDone(true);
      } catch (err) {
        toast.error("Could not load history.", {
          description: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setLoading(false);
        setInitialLoaded(true);
      }
    },
    [],
  );

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!initialLoaded) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          You have no analyses yet.{" "}
          <Link href="/dashboard" className="underline">
            Run your first analysis →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {items.map((it) => (
              <li key={it.id}>
                <Link
                  href={`/analyses/${it.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-accent/40"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <RiskBadge riskLevel={it.risk_level} verdict={it.verdict} />
                    <span className="text-sm">
                      {it.verdict === "DO_NOT_APPLY" ? (
                        <span className="text-destructive font-medium">BLOCKED</span>
                      ) : it.match_score !== null ? (
                        <>
                          Match{" "}
                          <span className="font-mono font-semibold">
                            {it.match_score}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    {it.is_reported ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Flag className="h-3 w-3" /> reported
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{new Date(it.created_at).toLocaleString()}</span>
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {!done ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => cursor && load(cursor)}
            disabled={loading || !cursor}
          >
            {loading ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          End of history.
        </p>
      )}
    </div>
  );
}
