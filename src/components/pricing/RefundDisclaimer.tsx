/**
 * Placeholder refund copy. Final wording is pending legal review.
 * The [TBD: 법무 검토] dev-only marker is hidden in production builds.
 */
export function RefundDisclaimer() {
  const isDev = process.env.NODE_ENV === "development";
  return (
    <p className="text-xs text-muted-foreground text-center">
      * No refunds after first analysis. 100% refund within 7 days if 0
      analyses used. See{" "}
      <a href="/legal/terms" className="underline hover:text-foreground">
        Terms
      </a>{" "}
      for details.
      {isDev ? (
        <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-600">
          [TBD: 법무 검토]
        </span>
      ) : null}
    </p>
  );
}
