import { cn } from "@/shared/lib/cn";
import { useTranscriptAnimationEnabled } from "../transcriptAnimationPreference";
import {
  type ActivityState,
  isNotableActivityState,
} from "../agentActivityState";

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
  // The same predicate that decides how much ink a row is worth now decides
  // its size, rather than the size rule being restated inline where the two
  // could drift.
  const notable = isNotableActivityState(state);
  const toneTitle = TONE_TITLE[state.tone];
  const title = [STATE_TITLE[state.state], toneTitle]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
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
            notable ? "size-1.5" : "size-1",
            state.state === "failed"
              ? "bg-destructive"
              : state.state === "running"
                ? "bg-primary"
                : state.state === "queued"
                  ? "border border-muted-foreground/60"
                  : changed
                    ? "bg-status-modified"
                    : "bg-muted-foreground/40",
          )}
        />
      </span>
      {/* The mark carries run state and "this changed something" in colour and
          size alone, and it has to stay aria-hidden — its `title` is decoration
          for a pointer, and sixty announced dots would bury the transcript. So
          the states a reader has to act on get a text equivalent instead, in
          the live region the list already is. A finished read stays silent:
          its own row label ("Read …") already says everything the faint dot
          does. */}
      {notable ? <span className="sr-only">{title}</span> : null}
    </>
  );
}
