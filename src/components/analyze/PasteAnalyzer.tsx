"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";

import { analyzeJob, ApiError } from "@/lib/api";
import { extractUpworkCoreText } from "@/lib/extractors/upwork";
import { ReportModal } from "./ReportModal";
import type { AnalyzeResponse } from "@/lib/types/api";

const HARD_LIMIT = 64_000; // server cap
const SOFT_LIMIT = 16_000; // pre-processor target; warn above this AFTER cleaning

interface Props {
  onAnalyzed?: () => void;
}

export function PasteAnalyzer({ onAnalyzed }: Props) {
  const [raw, setRaw] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<AnalyzeResponse | null>(null);
  const [open, setOpen] = React.useState(false);

  const onAnalyze = async () => {
    const cleaned = extractUpworkCoreText(raw);
    if (cleaned.length < 50) {
      toast.error("Paste the full Upwork job page (at least 50 characters).");
      return;
    }
    if (cleaned.length > HARD_LIMIT) {
      toast.error("Job text is too long.", {
        description: `${cleaned.length.toLocaleString()} chars (limit ${HARD_LIMIT.toLocaleString()}).`,
      });
      return;
    }
    if (cleaned.length > SOFT_LIMIT) {
      toast.warning("Long paste — analysis may run near the soft limit.");
    }

    setBusy(true);
    const idemKey = crypto.randomUUID();
    try {
      const res = await analyzeJob(
        { job_text: cleaned },
        { idempotencyKey: idemKey },
      );
      setReport(res);
      setOpen(true);
      onAnalyzed?.();
    } catch (err) {
      handleAnalyzeError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-3">
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={14}
          placeholder="Paste the entire Upwork job page (job title, description, client info, activity panel). We strip nav and footer automatically."
          className="font-mono text-xs"
          data-testid="paste-textarea"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {raw.length.toLocaleString()} chars · cleans to{" "}
            {extractUpworkCoreText(raw).length.toLocaleString()} after preprocessing
          </span>
          <Button
            onClick={onAnalyze}
            disabled={busy || !raw.trim()}
            size="lg"
            data-testid="analyze-btn"
          >
            {busy ? <Spinner className="text-primary-foreground" /> : <Sparkles />}
            {busy ? "Analyzing… up to 3s" : "Analyze"}
          </Button>
        </div>
      </CardContent>
      <ReportModal open={open} onOpenChange={setOpen} report={report} />
    </Card>
  );
}

function handleAnalyzeError(err: unknown) {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ERR_OUT_OF_CREDITS":
        toast.error("You're out of credits.", {
          description: (
            <span>
              <Link href="/pricing" className="underline">
                Buy more
              </Link>{" "}
              to keep analyzing.
            </span>
          ) as unknown as string,
        });
        return;
      case "ERR_SOFT_CAP_REACHED":
        toast.error("You hit this period's soft cap.", {
          description: "Try again next period or upgrade your plan.",
        });
        return;
      case "ERR_INPUT_TOO_LARGE":
        toast.error("Input too large. Trim the paste.");
        return;
      case "ERR_RATE_LIMITED":
        toast.error("Too many requests. Please slow down.");
        return;
      case "ERR_LLM_UPSTREAM":
        toast.error("The analyzer is temporarily unavailable.", {
          description: "No credit was deducted. Please retry in a moment.",
        });
        return;
      case "ERR_UNAUTHENTICATED":
        toast.error("Please sign in again.");
        return;
      default:
        toast.error("Analysis failed.", {
          description: `${err.code}: ${err.message}`,
        });
        return;
    }
  }
  toast.error("Analysis failed.", {
    description: err instanceof Error ? err.message : "Unexpected error",
  });
}
