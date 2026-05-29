import { Badge } from "@/components/ui/badge";
import type { RiskLevel, Verdict } from "@/lib/types/api";

interface Props {
  riskLevel?: RiskLevel;
  verdict?: Verdict;
  className?: string;
}

export function RiskBadge({ riskLevel, verdict, className }: Props) {
  // Verdict trumps when DO_NOT_APPLY (architectural decision: hide score).
  if (verdict === "DO_NOT_APPLY") {
    return (
      <Badge variant="destructive" className={className}>
        DO NOT APPLY
      </Badge>
    );
  }
  switch (riskLevel) {
    case "SAFE":
      return (
        <Badge variant="success" className={className}>
          SAFE
        </Badge>
      );
    case "WARNING":
      return (
        <Badge variant="warning" className={className}>
          WARNING
        </Badge>
      );
    case "DANGER":
      return (
        <Badge variant="destructive" className={className}>
          DANGER
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className={className}>
          —
        </Badge>
      );
  }
}
