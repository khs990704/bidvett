"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { createCheckoutSession, ApiError } from "@/lib/api";
import type { PlanKey } from "@/lib/types/api";

export interface PricingPlan {
  plan: PlanKey;
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  highlight?: boolean;
}

interface Props {
  plan: PricingPlan;
  signedIn: boolean;
}

export function PricingCard({ plan, signedIn }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const onClick = async () => {
    if (!signedIn) {
      router.push(`/login?redirect_to=/pricing`);
      return;
    }
    setBusy(true);
    try {
      const idemKey = `checkout-${plan.plan}-${Date.now()}`;
      const res = await createCheckoutSession(
        { plan: plan.plan },
        { idempotencyKey: idemKey },
      );
      window.location.assign(res.checkout_url);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        toast.error("Could not start checkout.", {
          description: `${err.code}: ${err.message}`,
        });
      } else {
        toast.error("Could not start checkout.", {
          description: err instanceof Error ? err.message : "Unexpected error",
        });
      }
    }
  };

  return (
    <Card
      className={cn(
        "flex flex-col",
        plan.highlight && "ring-2 ring-primary shadow-lg",
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{plan.name}</CardTitle>
          {plan.highlight ? <Badge>Best value</Badge> : null}
        </div>
        <CardDescription>
          <span className="text-2xl font-bold text-foreground">{plan.price}</span>{" "}
          <span className="text-muted-foreground">{plan.cadence}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <ul className="space-y-2 text-sm">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <Check className="h-4 w-4 mt-0.5 text-success shrink-0" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button
          onClick={onClick}
          disabled={busy}
          className="w-full"
          size="lg"
          variant={plan.highlight ? "default" : "outline"}
          data-testid={`buy-${plan.plan}`}
        >
          {busy ? <Spinner className="text-primary-foreground" /> : null}
          {plan.cta}
        </Button>
      </CardFooter>
    </Card>
  );
}
