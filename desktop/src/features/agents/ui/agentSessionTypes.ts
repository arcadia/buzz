import type { LucideIcon } from "lucide-react";

export type ObserverEvent = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string | null;
  payload: unknown;
};

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type ToolStatus = "executing" | "completed" | "failed" | "pending";

export type AgentActivityRenderClass =
  | "message"
  | "relay-op"
  | "file-edit"
  | "file-read"
  | "skill-read"
  | "image"
  | "shell"
  | "status"
  | "thought"
  | "plan"
  | "permission"
  | "error"
  | "generic"
  | "raw-rail"
  | "suppressed";

export type AgentActivityTone = "read" | "write" | "admin" | "neutral";

export type AgentActivityAction = {
  verb: string;
  object?: string | null;
};

export type AgentActivityDescriptor = {
  renderClass: AgentActivityRenderClass;
  label: string;
  preview: string | null;
  action?: AgentActivityAction;
  tone?: AgentActivityTone;
  operation?: string;
  object?: string | null;
  source?: "mcp" | "shell" | "acp" | "harness" | "fallback";
  groupKey?: string;
  reason?: string;
};

/** Observer/ACP wire label for dev-only transcript debugging. */
export type TranscriptAcpSource = string;

/**
 * One answer the agent will accept for a permission request, as sent.
 *
 * `optionId` is the only value the response may carry back — the harness
 * comment is emphatic that it must always be looked up by `kind` and never
 * hardcoded, so it is kept verbatim rather than reconstructed. `kind` is the
 * ACP vocabulary (`allow_once`, `allow_always`, `reject_once`,
 * `reject_always`) and is optional because a harness may omit it; `name` is
 * the label the agent asked us to show.
 */
export type PermissionOption = {
  optionId: string;
  kind: string | null;
  name: string;
};

/**
 * Everything needed to answer a permission request, kept structured.
 *
 * The renderer used to recover the options by string-splitting the item's
 * display text, which is fine for showing a list and impossible to answer
 * from: the `optionId`s never survived. `requestId` is the JSON-RPC id the
 * response must echo, stringified by `jsonRpcId` so a numeric `1` and the
 * string `"1"` stay distinct.
 */
export type PermissionRequestDetails = {
  requestId: string | null;
  toolCallId: string | null;
  options: PermissionOption[];
};

/** Shared optional identity fields attached during transcript construction. */
export type TranscriptItemIdentity = {
  turnId?: string | null;
  sessionId?: string | null;
  channelId?: string | null;
};

export type TranscriptItem =
  | ({
      id: string;
      type: "message";
      renderClass: "message";
      role: "assistant" | "user";
      title: string;
      text: string;
      timestamp: string;
      messageId?: string | null;
      acpSource?: TranscriptAcpSource;
      authorPubkey?: string | null;
    } & TranscriptItemIdentity)
  | ({
      id: string;
      type: "thought";
      renderClass: "thought";
      title: string;
      text: string;
      timestamp: string;
      acpSource?: TranscriptAcpSource;
    } & TranscriptItemIdentity)
  | ({
      id: string;
      type: "plan";
      renderClass: "plan";
      title: string;
      text: string;
      timestamp: string;
      isUpdate?: boolean;
      targetId?: string;
      acpSource?: TranscriptAcpSource;
    } & TranscriptItemIdentity)
  | ({
      id: string;
      type: "lifecycle";
      renderClass: "status" | "permission" | "error";
      title: string;
      text: string;
      /** Resolved outcome for permission items (e.g. "Approved (allow_once)", "Denied (reject_once)", "Cancelled"). */
      outcome?: string;
      /** Structured request payload for permission items, absent otherwise. */
      permission?: PermissionRequestDetails;
      timestamp: string;
      descriptor?: AgentActivityDescriptor;
      acpSource?: TranscriptAcpSource;
    } & TranscriptItemIdentity)
  | ({
      id: string;
      type: "metadata";
      renderClass: "raw-rail";
      title: string;
      sections: PromptSection[];
      timestamp: string;
      acpSource?: TranscriptAcpSource;
    } & TranscriptItemIdentity)
  | ({
      id: string;
      type: "tool";
      renderClass: AgentActivityRenderClass;
      descriptor: AgentActivityDescriptor;
      title: string;
      toolName: string;
      buzzToolName: string | null;
      status: ToolStatus;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
      timestamp: string;
      startedAt: string;
      completedAt: string | null;
      acpSource?: TranscriptAcpSource;
    } & TranscriptItemIdentity);

export type PromptSection = {
  title: string;
  body: string;
};

export type BuzzToolInfo = {
  icon: LucideIcon;
  label: string;
  tone: "read" | "write" | "admin";
};
