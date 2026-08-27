import { cn } from "@/shared/lib/cn";
import { useTranscriptAnimationEnabled } from "../transcriptAnimationPreference";
import type { ActivityState } from "../agentActivityState";

/**
 * The animation preference is read here rather than in the mark itself: the
 * mark renders on every row of the timeline — the app's hottest list — and
 * only the in-flight row has anything to animate, so the store subscription
 * belongs to the handful of running rows instead of all sixty.
 */
function RunningHalo() {
  const animationsEnabled = useTranscriptAnimationEnabled();
  if (!animationsEnabled) return null;
  return (
    <span className="buzz-activity-halo absolute size-1.5 rounded-full bg-primary/40" />
  );
}

const STATE_TITLE = {
  running: "Running now",
  queued: "Queued",
  failed: "Failed",
  done: "Finished",
} as const;

const TONE_TITLE = {
  read: "read",
  write: "changed something",
  admin: "changed access or membership",
  neutral: null,
} as const;

/**
 * The timeline's gutter mark: one glyph per row, carrying run state and
 * whether the step changed anything.
 *
 * Ink is deliberately proportional to how much the reader has to care. A
 * finished read — the overwhelming majority of rows in a long run — gets a
 * faint tick that exists only to give the column a rhythm. Everything the
 * reader might need to act on (in flight, queued, failed, or a write) gets a
 * full-size mark in a system colour. Sixty rows then read as "mostly quiet,
 * two things changed, one broke" without a single command being parsed.
 */
export function ActivityStateMark({
  className,
  state,
}: {
  className?: string;
  state: ActivityState;
}) {
  const changed = state.tone === "write" || state.tone === "admin";
  const toneTitle = TONE_TITLE[state.tone];
  const title = [STATE_TITLE[state.state], toneTitle]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-3 shrink-0 items-center justify-center",
        className,
      )}
      data-activity-state={state.state}
      data-activity-tone={state.tone}
      data-testid="activity-state-mark"
      title={title}
    >
      {state.state === "running" ? <RunningHalo /> : null}
      <span
        className={cn(
          "relative rounded-full",
          state.state === "failed"
            ? "size-1.5 bg-destructive"
            : state.state === "running"
              ? "size-1.5 bg-primary"
              : state.state === "queued"
                ? "size-1.5 border border-muted-foreground/60"
                : changed
                  ? "size-1.5 bg-status-modified"
                  : "size-1 bg-muted-foreground/40",
        )}
      />
    </span>
  );
}
