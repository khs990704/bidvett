import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number; // 0-100
  variant?: "default" | "warning" | "danger";
}

export function Progress({
  value,
  variant = "default",
  className,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const barColor =
    variant === "danger"
      ? "bg-destructive"
      : variant === "warning"
        ? "bg-warning"
        : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
        className,
      )}
      {...props}
    >
      <div
        className={cn("h-full transition-all", barColor)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
