import * as React from "react";

import { formatDurationMs } from "../agentSessionUtils";

const TICK_MS = 1000;

/**
 * Past this, "still running" is not credible: an archived transcript whose
 * completion frame never arrived would otherwise render a step as running for
 * weeks. Showing nothing is honest; showing "631338m" is not.
 */
const MAX_CREDIBLE_ELAPSED_MS = 6 * 60 * 60 * 1000;

/**
 * Wall-clock elapsed for a step that has not finished.
 *
 * "Working" and "stalled" carry the same frames on the wire — nothing in the
 * observer stream says a call has hung. Rather than invent a stall threshold,
 * the timeline shows how long the in-flight step has been running and lets the
 * reader judge: a shell command at 4s reads differently from the same command
 * at 4m, and that difference is the honest signal we actually have.
 */
export function ActivityElapsed({
  className,
  startedAt,
}: {
  className?: string;
  startedAt: string;
}) {
  const startedMs = React.useMemo(() => {
    const parsed = Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [startedAt]);

  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (startedMs == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedMs]);

  if (startedMs == null) return null;

  // Clock skew between the agent host and this desktop can put `startedAt` in
  // the future; show nothing rather than a negative or jumping value.
  const elapsedMs = Math.max(0, now - startedMs);
  if (elapsedMs > MAX_CREDIBLE_ELAPSED_MS) return null;
  const elapsed = formatDurationMs(elapsedMs);
  if (!elapsed) return null;

  return (
    <span className={className} data-testid="activity-elapsed">
      {elapsed}
    </span>
  );
}
