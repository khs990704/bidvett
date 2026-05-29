"use client";

import * as React from "react";
import { CreditBadge } from "./CreditBadge";
import { PasteAnalyzer } from "./PasteAnalyzer";
import { RecentAnalyses } from "./RecentAnalyses";

/**
 * Client-only orchestrator: bumps a reloadKey on each successful analyze so
 * the CreditBadge and RecentAnalyses widgets re-fetch.
 */
export function DashboardClient() {
  const [reloadKey, setReloadKey] = React.useState(0);
  const bump = () => setReloadKey((k) => k + 1);

  return (
    <div className="space-y-6">
      <CreditBadge reloadKey={reloadKey} />
      <PasteAnalyzer onAnalyzed={bump} />
      <RecentAnalyses reloadKey={reloadKey} />
    </div>
  );
}
