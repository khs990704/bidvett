"use client";

import * as React from "react";
import { AlertTriangle, ShieldCheck, ExternalLink, Flag } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RiskBadge } from "./RiskBadge";
import { toast } from "@/components/ui/sonner";
import { reportScam, ApiError } from "@/lib/api";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";

import type { AnalyzeResponse } from "@/lib/types/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: AnalyzeResponse | null;
}

export function ReportModal({ open, onOpenChange, report }: Props) {
  if (!report) return null;

  // Architectural rule: match_score === null forces Risk View (hide score)
  const isRisk =
    report.verdict === "DO_NOT_APPLY" ||
    report.match_score === null ||
    report.backend_risk.critical ||
    report.ai_risk.risk_level === "DANGER";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {isRisk ? <RiskView report={report} onClose={() => onOpenChange(false)} /> : <SafeView report={report} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────── Safe / Warning view ──────────────────────────
function SafeView({
  report,
  onClose,
}: {
  report: AnalyzeResponse;
  onClose: () => void;
}) {
  const isWarning = report.ai_risk.risk_level === "WARNING";
  const score = report.match_score ?? 0;
  const scoreVariant: "default" | "warning" | "danger" = isWarning
    ? "warning"
    : score >= 70
      ? "default"
      : "warning";

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-success" />
          <DialogTitle>Analysis result</DialogTitle>
        </div>
        <DialogDescription>Review and report this analysis if needed.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Backend risk:</span>
          <Badge variant={report.backend_risk.critical ? "destructive" : "success"}>
            {report.backend_risk.critical
              ? `CRITICAL (${report.backend_risk.rules_triggered.join(", ")})`
              : "No critical rules triggered"}
          </Badge>
          <span className="text-sm text-muted-foreground ml-3">AI risk:</span>
          <RiskBadge riskLevel={report.ai_risk.risk_level} />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Match score</span>
            <span className="font-mono">{score} / 100</span>
          </div>
          <Progress value={score} variant={scoreVariant} />
        </div>

        {report.score_reason ? (
          <div>
            <h4 className="text-sm font-medium mb-1">Why this score</h4>
            <p className="text-sm text-muted-foreground">{report.score_reason}</p>
          </div>
        ) : null}

        <div>
          <h4 className="text-sm font-medium mb-1">Action tip</h4>
          <p className="text-sm">{report.action_tip}</p>
        </div>

        {report.ai_risk.contextual_red_flags.length > 0 ? (
          <div>
            <h4 className="text-sm font-medium mb-1">Heads-up</h4>
            <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
              {report.ai_risk.contextual_red_flags.map((rf, i) => (
                <li key={i}>{rf}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <ExtractedSignals report={report} />
      </div>

      <DialogFooter className="gap-2">
        <ReportScamInline analysisId={report.analysis_id} />
        <Button variant="outline" onClick={() => window.open("https://www.upwork.com", "_blank")}>
          <ExternalLink /> Open Upwork
        </Button>
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </>
  );
}

// ──────────────────────────── Risk view ────────────────────────────────────
function RiskView({
  report,
  onClose,
}: {
  report: AnalyzeResponse;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <DialogTitle className="text-destructive">DO NOT APPLY</DialogTitle>
        </div>
        <DialogDescription>
          This job was flagged by our rule engine and/or AI risk analyzer. The
          match score is intentionally hidden.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive mb-1">
            Spending a Connect here is strongly discouraged.
          </p>
          <p className="text-muted-foreground">
            {report.action_tip ||
              "Skip this job and report it to Upwork TOS team."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Backend rules:</span>
          {report.backend_risk.rules_triggered.length > 0 ? (
            report.backend_risk.rules_triggered.map((r) => (
              <Badge key={r} variant="destructive">
                {r}
              </Badge>
            ))
          ) : (
            <Badge variant="outline">none</Badge>
          )}
          <span className="text-sm text-muted-foreground ml-3">AI risk:</span>
          <RiskBadge riskLevel={report.ai_risk.risk_level} verdict={report.verdict} />
        </div>

        {report.ai_risk.contextual_red_flags.length > 0 ? (
          <div>
            <h4 className="text-sm font-medium mb-1">Contextual red flags</h4>
            <ul className="list-disc pl-5 text-sm space-y-1">
              {report.ai_risk.contextual_red_flags.map((rf, i) => (
                <li key={i}>{rf}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <ExtractedSignals report={report} />
      </div>

      <DialogFooter className="gap-2">
        <ReportScamInline analysisId={report.analysis_id} />
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

// ──────────────────────────── Shared bits ──────────────────────────────────
function ExtractedSignals({ report }: { report: AnalyzeResponse }) {
  const s = report.extracted_signals;
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs grid grid-cols-2 sm:grid-cols-4 gap-2">
      <KV k="Hire rate" v={`${s.client_hire_rate}%`} />
      <KV k="Payment" v={s.payment_verified ? "verified" : "unverified"} />
      <KV k="Total spend" v={`$${s.total_spend_amount.toLocaleString()}`} />
      <KV k="Rating" v={`${s.client_rating.toFixed(2)} / 5`} />
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted-foreground">{k}</div>
      <div className="font-medium">{v}</div>
    </div>
  );
}

function ReportScamInline({ analysisId }: { analysisId: string }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!reason.trim()) {
      toast.error("Please describe what looked wrong.");
      return;
    }
    setBusy(true);
    try {
      await reportScam({ analysis_id: analysisId, reason });
      toast.success("Thanks — we'll review this job.");
      setOpen(false);
      setReason("");
    } catch (err) {
      toast.error("Could not submit report.", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Flag /> Report scam
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What looked wrong? (required, max 1000 chars)"
        maxLength={1000}
        rows={3}
      />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner className="text-primary-foreground" /> : <Flag />}
          Submit report
        </Button>
      </div>
    </div>
  );
}
