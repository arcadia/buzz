import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { useAgentSessionTranscriptVariant } from "../agentSessionTranscriptContext";
import type { ActivityState } from "../agentActivityState";
import { ActivityStateMark } from "./ActivityStateMark";

export type ActivityRowLabelParts = {
  verb: string;
  object?: React.ReactNode;
};

export type ActivityRowStats = {
  additions: number;
  deletions: number;
};

export type ActivityRowToneScope = "none" | "tool" | "summary";

/**
 * Every activity row opens with the same gutter, whether or not it has a
 * state worth reporting, so verbs land on one column down the whole run. The
 * ragged left edge was most of what made a long transcript hard to scan.
 */
const DEFAULT_ROW_STATE: ActivityState = { state: "done", tone: "neutral" };

type ActivityRowProps = {
  children: React.ReactNode;
  className?: string;
  openToneScope?: Exclude<ActivityRowToneScope, "none">;
  /** Run state and tone for the gutter mark. Defaults to a finished step. */
  state?: ActivityState;
  testId?: string;
  title?: string;
};

type ActivityRowContentProps = {
  children: React.ReactNode;
  className?: string;
};

const ACTIVITY_ROW_CONTENT_MARKER = Symbol("ActivityRowContent");

type ActivityRowContentComponent = React.FC<ActivityRowContentProps> & {
  marker: typeof ACTIVITY_ROW_CONTENT_MARKER;
};

export function ActivityRow({
  children,
  className,
  openToneScope = "tool",
  state = DEFAULT_ROW_STATE,
  testId,
  title,
}: ActivityRowProps) {
  const childArray = React.Children.toArray(children);
  const summaryChildren = childArray.filter(
    (child) => !isActivityRowContent(child),
  );
  const contentChildren = childArray.filter(isActivityRowContent);

  if (contentChildren.length === 0) {
    return (
      <div
        className={cn("not-prose flex min-h-6 items-center gap-1.5", className)}
        data-testid={testId}
        title={title}
      >
        <ActivityStateMark state={state} />
        {children}
      </div>
    );
  }

  return (
    <details
      className={cn(
        openToneScope === "summary" ? "group/summary" : "group",
        "not-prose w-full",
        className,
      )}
      data-testid={testId}
      title={title}
    >
      <summary
        className={cn(
          "group/row flex min-h-6 w-full max-w-full cursor-pointer list-none items-center gap-1.5 text-muted-foreground",
          openToneScope === "summary"
            ? "group-open/summary:text-foreground"
            : "group-open:text-foreground",
        )}
      >
        <ActivityStateMark state={state} />
        {summaryChildren}
        <ChevronDown
          className={cn(
            // `ml-auto` parks every disclosure caret on one right-hand column;
            // trailing carets used to land wherever the label happened to end,
            // which is most of what made a long run look ragged.
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover/row:text-foreground",
            openToneScope === "summary"
              ? "group-open/summary:rotate-180 group-open/summary:text-foreground"
              : "group-open:rotate-180 group-open:text-foreground",
          )}
        />
      </summary>
      {contentChildren.map((child, index) => (
        <div
          className={child.props.className}
          // biome-ignore lint/suspicious/noArrayIndexKey: content regions are static children
          key={index}
        >
          {child.props.children}
        </div>
      ))}
    </details>
  );
}

export function ActivityRowLabel({
  className,
  emphasis = "normal",
  object,
  openToneScope,
  stats,
  testId,
  title,
  verb,
}: ActivityRowLabelParts & {
  className?: string;
  testId?: string;
  /**
   * `live` pulls a row out of the muted run — used for the step in flight, so
   * the one thing happening right now is also the one thing that reads dark.
   * `failed` recolours the verb so a failure never has to be hunted for.
   */
  emphasis?: "normal" | "live" | "failed";
  openToneScope: ActivityRowToneScope;
  stats?: ActivityRowStats | null;
  title?: string;
}) {
  const variant = useAgentSessionTranscriptVariant();
  const isCompactPreview = variant === "compactPreview";
  const size = isCompactPreview ? "text-xs" : "text-sm";
  const hover =
    openToneScope === "none"
      ? null
      : openToneScope === "summary"
        ? "transition-colors group-hover/row:text-foreground group-open/summary:text-foreground"
        : "transition-colors group-hover/row:text-foreground group-open:text-foreground";
  // Muted-foreground at full strength clears 4.5:1 on both themes; the old
  // /50 and /60 washes sat near 2:1 while carrying the row's only content.
  const verbTone =
    emphasis === "failed"
      ? "text-destructive"
      : emphasis === "live"
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-testid={testId}
      title={title}
    >
      <span className={cn("shrink-0 font-semibold", size, verbTone, hover)}>
        {verb}
      </span>
      {object ? (
        <span
          className={cn(
            "min-w-0 truncate font-normal text-muted-foreground",
            size,
            hover,
          )}
        >
          {object}
        </span>
      ) : null}
      {stats ? <ActivityRowStatsView stats={stats} /> : null}
    </span>
  );
}

export const ActivityRowContent = (({ children }: ActivityRowContentProps) => (
  <>{children}</>
)) as ActivityRowContentComponent;
ActivityRowContent.marker = ACTIVITY_ROW_CONTENT_MARKER;

/**
 * Indentation for an expanded group's children: a hairline rail plus one
 * gutter of offset, so a group reads as a group. Without it the children sat
 * flush with their parent and an expanded burst looked identical to the
 * top-level run around it.
 */
export const ACTIVITY_ROW_NESTED_CLASSNAME =
  "ml-1.5 border-l border-border/60 pl-3";

function ActivityRowStatsView({ stats }: { stats: ActivityRowStats }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold leading-5 tabular-nums">
      <span className="text-status-added">+{stats.additions}</span>
      <span className="text-status-deleted">-{stats.deletions}</span>
    </span>
  );
}

function isActivityRowContent(
  child: React.ReactNode,
): child is React.ReactElement<
  ActivityRowContentProps,
  ActivityRowContentComponent
> {
  return (
    React.isValidElement(child) &&
    typeof child.type !== "string" &&
    "marker" in child.type &&
    child.type.marker === ACTIVITY_ROW_CONTENT_MARKER
  );
}

export function splitActivityRowLabel(
  label: string,
): ActivityRowLabelParts | null {
  const match = label.match(
    /^(Added|Archived|Captured|Checked|Compacted|Created|Deleted|Edited|Ran|Read|Removed|Searched|Sent|Unarchived|Updated|Viewed)\s+(.+)$/,
  );
  return match ? { verb: match[1], object: match[2] } : null;
}

export type ActivityRowCountedObject = {
  count: number;
  rest: string;
};

/**
 * Split a summary label object like "16 tool calls" into its leading count
 * and the trailing text (" tool calls"), so the number can animate through
 * AnimatedCount while streaming bursts grow. Returns null when the object
 * does not lead with a count.
 */
export function splitActivityRowCountedObject(
  object: string,
): ActivityRowCountedObject | null {
  const match = object.match(/^(\d+)(\s.+)$/);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count)) return null;
  return { count, rest: match[2] };
}
