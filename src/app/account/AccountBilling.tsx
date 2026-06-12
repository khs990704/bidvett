"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getCredits, cancelSubscription, ApiError } from "@/lib/api";
import type { CreditsResponse } from "@/lib/types/api";
import { toast } from "@/components/ui/sonner";

// Polling config — total ~30s budget, balance webhook usually lands < 3s.
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 15;

function isCreditsChanged(
  prev: CreditsResponse | null,
  next: CreditsResponse,
): boolean {
  if (!prev) return true;
  if (prev.balance !== next.balance) return true;
  if (!!prev.active_pass !== !!next.active_pass) return true;
  if (!!prev.active_subscription !== !!next.active_subscription) return true;
  if (
    prev.active_subscription?.cancel_at_period_end !==
    next.active_subscription?.cancel_at_period_end
  )
    return true;
  return false;
}

export function AccountBilling() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dodoSuccess = searchParams.get("dodo") === "success";

  const [data, setData] = React.useState<CreditsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pollingPayment, setPollingPayment] = React.useState(dodoSuccess);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);

  // Initial fetch.
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

  // Polling after Dodo redirect — webhook is async, balance may lag by 1–3s.
  // Gated on `!loading` so the initial fetch has a chance to populate the
  // baseline; otherwise the first successful poll trips isCreditsChanged on
  // a null baseline and fires a spurious "Payment processed" toast.
  React.useEffect(() => {
    if (!pollingPayment || loading) return;
    let cancelled = false;
    let attempts = 0;
    const baseline = data;

    const tick = async () => {
      attempts += 1;
      try {
        const res = await getCredits();
        if (cancelled) return;
        const changed = isCreditsChanged(baseline, res);
        setData(res);
        if (changed) {
          setPollingPayment(false);
          router.replace("/account?tab=billing", { scroll: false });
          toast.success("Payment processed.");
          return;
        }
      } catch {
        // Swallow transient errors; keep polling.
      }
      if (attempts >= POLL_MAX_ATTEMPTS && !cancelled) {
        setPollingPayment(false);
        router.replace("/account?tab=billing", { scroll: false });
        toast.message("Still finalizing your payment. Refresh in a moment.");
      }
    };

    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // baseline (`data`) is captured at effect start by design — re-running on
    // every data change would reset the attempt counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollingPayment, loading, router]);

  const hasCancellableSub =
    !!data?.active_subscription &&
    !data.active_subscription.cancel_at_period_end;

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await cancelSubscription();
      if (res.already_cancelled) {
        toast.message("Subscription was already scheduled for cancellation.");
      } else {
        toast.success(
          "Subscription will end at the end of the current billing period.",
        );
      }
      // Refetch to surface cancel_at_period_end=true.
      const fresh = await getCredits();
      setData(fresh);
      setCancelOpen(false);
    } catch (err) {
      toast.error("Could not cancel subscription.", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pollingPayment ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <Spinner /> Finalizing your payment…
          </div>
        ) : null}

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
          {hasCancellableSub ? (
            <Button
              variant="ghost"
              onClick={() => setCancelOpen(true)}
              disabled={cancelling}
            >
              Cancel subscription
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <a
              href="https://app.dodopayments.com/customer-portal"
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage in Dodo Portal ↗
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Payment history and invoices are available in your Dodo receipts.
        </p>
      </CardContent>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel subscription?</DialogTitle>
            <DialogDescription>
              Your access continues until the end of the current billing
              period. You won&apos;t be charged again unless you re-subscribe.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelOpen(false)}
              disabled={cancelling}
            >
              Keep subscription
            </Button>
            <Button onClick={handleCancel} disabled={cancelling}>
              {cancelling ? <Spinner /> : "Cancel at period end"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
