"use client";

import * as React from "react";
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ReportModal } from "@/components/analyze/ReportModal";
import { getAnalysis, ApiError } from "@/lib/api";
import type { AnalyzeResponse } from "@/lib/types/api";

interface Props {
  id: string;
}

export function AnalysisDetailClient({ id }: Props) {
  const [report, setReport] = React.useState<AnalyzeResponse | null>(null);
  const [open, setOpen] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getAnalysis(id);
        if (!cancelled) setReport(res);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? `${err.code}: ${err.message}` : "Failed to load analysis",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6 space-y-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button asChild variant="outline">
            <Link href="/dashboard/history">Back to history</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!report) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading analysis…
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/history">← Back to history</Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Reopen report
        </Button>
      </div>
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            Analysis <span className="font-mono">{id}</span> —{" "}
            <button
              type="button"
              className="underline"
              onClick={() => setOpen(true)}
            >
              open full report
            </button>
            .
          </p>
        </CardContent>
      </Card>
      <ReportModal open={open} onOpenChange={setOpen} report={report} />
    </>
  );
}
