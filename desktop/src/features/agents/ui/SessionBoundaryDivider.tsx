import { Clock, Radio } from "lucide-react";

/**
 * Horizontal rule rendered between session runs in the observer transcript.
 *
 * Three label states (based on live-frame observation, not harness affinity):
 *  - `"current"`     — most recent session observed via the live relay subscription.
 *  - `"most-recent"` — newest visible session with no matching live frames
 *                      (loaded from archive or session ended before observation).
 *  - `"earlier"`     — an older session preceding the most-recent one.
 */
export function SessionBoundaryDivider({
  labelState,
  sessionStartTimestamp,
}: {
  labelState: "current" | "most-recent" | "earlier";
  sessionStartTimestamp: string;
}) {
  const label =
    labelState === "current"
      ? "Latest live-observed session"
      : labelState === "most-recent"
        ? "Most recent observed session"
        : "Earlier observed session";
  const formattedDate = new Date(sessionStartTimestamp).toLocaleString();
  return (
    <div
      className="flex items-center gap-2 px-3 py-2"
      data-testid="session-boundary-divider"
    >
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {labelState === "current" ? (
          <Radio aria-hidden="true" className="h-3 w-3" />
        ) : (
          <Clock aria-hidden="true" className="h-3 w-3" />
        )}
        {label}
        {" · "}
        {formattedDate}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
