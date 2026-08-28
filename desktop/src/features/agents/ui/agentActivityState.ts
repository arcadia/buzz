import type { AgentActivityTone, TranscriptItem } from "./agentSessionTypes";

/**
 * How a timeline row reads at a glance, independent of what tool produced it.
 *
 * The timeline's job is to answer three questions without reading any command:
 * what is happening now, did anything fail, and did anything change. `state`
 * answers the first two; `tone` answers the third.
 */
export type ActivityRunState = "running" | "queued" | "failed" | "done";

export type ActivityState = {
  state: ActivityRunState;
  tone: AgentActivityTone;
};

const DONE_NEUTRAL: ActivityState = { state: "done", tone: "neutral" };

type ToolTranscriptItem = Extract<TranscriptItem, { type: "tool" }>;

/**
 * Run state for one tool row. `isError` wins over `status` because a harness
 * can report a completed call whose payload is an error.
 */
export function toolRunState(item: ToolTranscriptItem): ActivityRunState {
  if (item.isError || item.status === "failed") return "failed";
  if (item.status === "executing") return "running";
  if (item.status === "pending") return "queued";
  return "done";
}

/**
 * Tone comes from the classifier's descriptor, which is the single place that
 * decides what a tool call means. Rows whose descriptor has no tone read as
 * neutral rather than guessing — a bare shell command genuinely can be either
 * a read or a write, and inventing a heuristic here would be worse than
 * saying nothing.
 */
export function activityStateForItem(item: TranscriptItem): ActivityState {
  if (item.type !== "tool") {
    return DONE_NEUTRAL;
  }
  return {
    state: toolRunState(item),
    tone: item.descriptor?.tone ?? "neutral",
  };
}

/**
 * Aggregate state for a collapsed run ("Ran 6 tool calls"). A collapsed row
 * must never hide a failure or an in-flight call, so those win over the
 * change signal, which in turn wins over plain reads.
 */
export function activityStateForItems(items: TranscriptItem[]): ActivityState {
  let tone: AgentActivityTone = "neutral";
  let state: ActivityRunState = "done";

  for (const item of items) {
    const child = activityStateForItem(item);
    if (RUN_STATE_RANK[child.state] > RUN_STATE_RANK[state]) {
      state = child.state;
    }
    if (TONE_RANK[child.tone] > TONE_RANK[tone]) {
      tone = child.tone;
    }
  }

  return { state, tone };
}

/** Whether a row deserves ink for its own sake rather than for rhythm. */
export function isNotableActivityState({ state, tone }: ActivityState) {
  return state !== "done" || tone === "write" || tone === "admin";
}

const RUN_STATE_RANK: Record<ActivityRunState, number> = {
  done: 0,
  queued: 1,
  running: 2,
  failed: 3,
};

const TONE_RANK: Record<AgentActivityTone, number> = {
  neutral: 0,
  read: 1,
  write: 2,
  admin: 3,
};
