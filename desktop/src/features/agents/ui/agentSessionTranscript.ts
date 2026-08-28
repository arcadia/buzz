import type {
  AgentActivityDescriptor,
  AgentActivityRenderClass,
  ObserverEvent,
  PermissionRequestDetails,
  PromptSection,
  ToolStatus,
  TranscriptItem,
} from "./agentSessionTypes";
import {
  findBuzzToolName,
  isGenericToolTitle,
  normalizeToolStatus,
} from "./agentSessionToolCatalog";
import { classifyTool } from "./agentSessionToolClassifier";
import {
  describePermissionOutcome,
  describePermissionRequest,
  jsonRpcIdKey,
  jsonRpcIdValue,
  PERMISSION_REQUEST_TITLE,
  PERMISSION_UNANSWERED_OUTCOME,
} from "./agentSessionPermissionFrames";
import { asRecord, asString } from "./agentSessionUtils";
import {
  describeFreeformStatus,
  describeTurnStarted,
  describeSessionResolved,
  extractBlockText,
  extractContentText,
  extractPlanText,
  extractPromptText,
  extractTriggeringEventIds,
  extractToolArgs,
  extractToolIdentity,
  extractToolResult,
  parsePromptText,
  parseSystemPromptSections,
  rawPayloadTitle,
  stringifyPayload,
} from "./agentSessionTranscriptHelpers";
import { friendlyTurnErrorCopy } from "../lib/friendlyAgentLastError";

export { describeRawEvent } from "./agentSessionTranscriptHelpers";

export type TranscriptState = {
  items: TranscriptItem[];
  itemsById: Map<string, TranscriptItem>;
  activeMessageKey: Map<string, string>;
  sealedKeys: Set<string>;
  triggeringEventIdsByTurn: Map<string, string[]>;
  /**
   * Maps JSON-RPC request id → { itemId, optionNames }.
   * Populated when a `session/request_permission` request is ingested so the
   * matching response (which carries the same JSON-RPC id, no `method`) can
   * correlate and append the outcome to the lifecycle item.
   */
  pendingPermissions: Map<
    string,
    { itemId: string; optionNames: Map<string, string> }
  >;
  continuationSeq: number;
  latestSessionId: string | null;
};

export function createEmptyTranscriptState(): TranscriptState {
  return {
    items: [],
    itemsById: new Map(),
    activeMessageKey: new Map(),
    sealedKeys: new Set(),
    triggeringEventIdsByTurn: new Map(),
    pendingPermissions: new Map(),
    continuationSeq: 0,
    latestSessionId: null,
  };
}

/**
 * Mutable draft that collects changes during a single processTranscriptEvent
 * call. Replaces the previous pattern of nested closures capturing bare `let`
 * bindings — all mutation now targets this explicit object.
 */
type TranscriptDraft = {
  items: TranscriptItem[];
  itemsById: Map<string, TranscriptItem>;
  activeMessageKey: Map<string, string>;
  sealedKeys: Set<string>;
  triggeringEventIdsByTurn: Map<string, string[]>;
  pendingPermissions: Map<
    string,
    { itemId: string; optionNames: Map<string, string> }
  >;
  continuationSeq: number;
  latestSessionId: string | null;
  changed: boolean;
};

function draftFrom(state: TranscriptState): TranscriptDraft {
  return {
    items: state.items,
    itemsById: state.itemsById,
    activeMessageKey: state.activeMessageKey,
    sealedKeys: state.sealedKeys,
    triggeringEventIdsByTurn: state.triggeringEventIdsByTurn,
    pendingPermissions: state.pendingPermissions,
    continuationSeq: state.continuationSeq,
    latestSessionId: state.latestSessionId,
    changed: false,
  };
}

/** Lazily copy items + itemsById on first mutation so callers get new refs. */
function ensureMutable(d: TranscriptDraft) {
  if (!d.changed) {
    d.items = [...d.items];
    d.itemsById = new Map(d.itemsById);
    d.changed = true;
  }
}

function replaceItem(d: TranscriptDraft, id: string, updated: TranscriptItem) {
  ensureMutable(d);
  const idx = d.items.findIndex((it) => it.id === id);
  if (idx !== -1) {
    d.items[idx] = updated;
  }
  d.itemsById.set(id, updated);
}

function pushItem(d: TranscriptDraft, item: TranscriptItem) {
  ensureMutable(d);
  d.items.push(item);
  d.itemsById.set(item.id, item);
}

function sealOpenMessages(d: TranscriptDraft) {
  let copied = false;
  for (const [, currentKey] of d.activeMessageKey) {
    if (!d.sealedKeys.has(currentKey)) {
      if (!copied) {
        d.sealedKeys = new Set(d.sealedKeys);
        copied = true;
      }
      d.sealedKeys.add(currentKey);
    }
  }
}

function turnMapKey(channelKey: string, turnKey: string | number | null) {
  return `${channelKey}:${turnKey ?? "unknown"}`;
}

function rememberTriggeringEventIds(
  d: TranscriptDraft,
  channelKey: string,
  turnKey: string | number | null,
  ids: string[],
) {
  if (ids.length === 0) return;
  d.triggeringEventIdsByTurn = new Map(d.triggeringEventIdsByTurn);
  d.triggeringEventIdsByTurn.set(turnMapKey(channelKey, turnKey), ids);
}

function getSingleTriggeringEventId(
  d: TranscriptDraft,
  channelKey: string,
  turnKey: string | number | null,
) {
  const ids = d.triggeringEventIdsByTurn.get(turnMapKey(channelKey, turnKey));
  return ids?.length === 1 ? maybeNostrEventId(ids[0]) : null;
}

function maybeNostrEventId(id: string | null | undefined) {
  return id && /^[0-9a-fA-F]{64}$/.test(id) ? id : null;
}

type TranscriptItemContext = {
  channelId: string | null;
  turnId: string | null;
  sessionId: string | null;
};

function upsertMessage(
  d: TranscriptDraft,
  id: string,
  role: "assistant" | "user",
  title: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  authorPubkey: string | null = null,
  acpSource?: string,
  messageId: string | null = null,
) {
  const currentKey = d.activeMessageKey.get(id);

  if (currentKey && !d.sealedKeys.has(currentKey)) {
    const existing = d.itemsById.get(currentKey);
    if (existing?.type === "message") {
      replaceItem(d, currentKey, {
        ...existing,
        text: existing.text + text,
        channelId: ctx.channelId,
        turnId: ctx.turnId ?? existing.turnId,
        sessionId: ctx.sessionId ?? existing.sessionId,
        authorPubkey: authorPubkey ?? existing.authorPubkey,
        acpSource: acpSource ?? existing.acpSource,
        messageId: messageId ?? existing.messageId,
      });
      return;
    }
  }

  d.continuationSeq += 1;
  const newKey = currentKey ? `${id}:c${d.continuationSeq}` : id;
  pushItem(d, {
    id: newKey,
    type: "message",
    renderClass: "message",
    role,
    title,
    text,
    timestamp,
    messageId,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    authorPubkey,
    acpSource,
  });
  d.activeMessageKey = new Map(d.activeMessageKey);
  d.activeMessageKey.set(id, newKey);
}

function upsertTextItem(
  d: TranscriptDraft,
  id: string,
  type: "thought" | "lifecycle",
  title: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
) {
  const existing = d.itemsById.get(id);
  if (existing && existing.type === type) {
    replaceItem(d, id, {
      ...existing,
      text:
        type === "lifecycle"
          ? joinLifecycleText(existing.text, text)
          : existing.text + text,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    return;
  }
  sealOpenMessages(d);
  if (type === "thought") {
    pushItem(d, {
      id,
      type: "thought",
      renderClass: "thought",
      title,
      text,
      timestamp,
      channelId: ctx.channelId,
      turnId: ctx.turnId,
      sessionId: ctx.sessionId,
      acpSource,
    });
    return;
  }

  upsertLifecycleItem(
    d,
    id,
    title.toLowerCase().includes("error") ? "error" : "status",
    title,
    text,
    timestamp,
    ctx,
    acpSource,
  );
}

function joinLifecycleText(existing: string, next: string) {
  if (!existing) return next;
  if (!next) return existing;
  return `${existing}\n${next}`;
}

function upsertLifecycleItem(
  d: TranscriptDraft,
  id: string,
  renderClass: Extract<
    AgentActivityRenderClass,
    "status" | "permission" | "error"
  >,
  title: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
  descriptor?: AgentActivityDescriptor,
  permission?: PermissionRequestDetails,
) {
  const existing = d.itemsById.get(id);
  if (existing?.type === "lifecycle") {
    replaceItem(d, id, {
      ...existing,
      renderClass,
      title,
      text: joinLifecycleText(existing.text, text),
      descriptor: descriptor ?? existing.descriptor,
      permission: permission ?? existing.permission,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    return;
  }

  sealOpenMessages(d);
  pushItem(d, {
    id,
    type: "lifecycle",
    renderClass,
    title,
    text,
    timestamp,
    descriptor,
    permission,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    acpSource,
  });
}

/**
 * A permission request is a snapshot of one question, not a running log.
 *
 * `upsertLifecycleItem` joins text across frames, which is right for repeated
 * `turn_error` lines and wrong here: the same request can arrive twice (a live
 * frame and an archive rebuild), and joining would print its description
 * twice. The payload is likewise the frame's own, never merged with an older
 * one — the headline and the buttons on this card have to describe the same
 * call, because approving what you read must not authorize something else.
 *
 * Kept apart from the status/error upsert so the two cannot drift into each
 * other's merge rules.
 */
function upsertPermissionItem(
  d: TranscriptDraft,
  id: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  descriptor: AgentActivityDescriptor,
  permission: PermissionRequestDetails,
) {
  const existing = d.itemsById.get(id);
  const fields = {
    type: "lifecycle" as const,
    renderClass: "permission" as const,
    title: PERMISSION_REQUEST_TITLE,
    text,
    descriptor,
    permission,
    channelId: ctx.channelId,
    acpSource: "permission_request",
  };

  if (existing?.type === "lifecycle") {
    replaceItem(d, id, {
      ...existing,
      ...fields,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
    });
    return;
  }

  sealOpenMessages(d);
  pushItem(d, {
    ...fields,
    id,
    timestamp,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
  });
}

/**
 * Close out every permission the ending turn never got an answer for.
 *
 * Only the harness's own response resolves a request, and a turn that errors,
 * panics, or completes never sends one. Left alone the card reads "Waiting for
 * your decision" forever — and its Stop button carries no turn id, so pressing
 * it would interrupt whatever unrelated turn is running by then. The wording
 * claims only what is known: nobody answered, and an unanswered request is
 * denied by the runtime.
 */
function resolvePermissionsForEndedTurn(
  d: TranscriptDraft,
  turnId: string | null,
) {
  // Without a turn id there is nothing to scope the sweep to, and resolving
  // every open request would retire ones that are still live.
  if (!turnId) return;

  // Scanning items rather than the pending-response index deliberately: a
  // request that arrived without a JSON-RPC id is never parked there, and it
  // is exactly the request that can never be answered.
  const settled = new Set<string>();
  // Captured before the first replaceItem swaps `d.items` for a copy; the
  // entries are the same objects either way.
  const scanned = d.items;
  for (const item of scanned) {
    if (item.type !== "lifecycle" || item.renderClass !== "permission") {
      continue;
    }
    if (item.turnId !== turnId || item.outcome) continue;
    replaceItem(d, item.id, {
      ...item,
      outcome: PERMISSION_UNANSWERED_OUTCOME,
    });
    settled.add(item.id);
  }

  if (settled.size === 0) return;
  d.pendingPermissions = new Map(
    [...d.pendingPermissions].filter(
      ([, pending]) => !settled.has(pending.itemId),
    ),
  );
}

// Like upsertLifecycleItem but REPLACES the text on update instead of
// appending. Used for coalescing fields (e.g. usage_update) where only the
// latest value is meaningful — repeated updates must not accumulate.
function replaceLifecycleItem(
  d: TranscriptDraft,
  id: string,
  renderClass: Extract<
    AgentActivityRenderClass,
    "status" | "permission" | "error"
  >,
  title: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
) {
  const existing = d.itemsById.get(id);
  if (existing?.type === "lifecycle") {
    replaceItem(d, id, {
      ...existing,
      renderClass,
      title,
      text,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    return;
  }

  sealOpenMessages(d);
  pushItem(d, {
    id,
    type: "lifecycle",
    renderClass,
    title,
    text,
    timestamp,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    acpSource,
  });
}

function upsertPlan(
  d: TranscriptDraft,
  id: string,
  title: string,
  text: string,
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
  updateMarkerId?: string,
) {
  const existing = d.itemsById.get(id);
  if (existing?.type === "plan") {
    const changed = existing.text !== text;
    replaceItem(d, id, {
      ...existing,
      text,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    if (changed) {
      pushItem(d, {
        id: updateMarkerId ?? `${id}:update:${timestamp}`,
        type: "plan",
        renderClass: "plan",
        title: "Plan updated",
        text: summarizePlanUpdate(text),
        timestamp,
        isUpdate: true,
        targetId: id,
        channelId: ctx.channelId,
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
        acpSource,
      });
    }
    return;
  }
  sealOpenMessages(d);
  pushItem(d, {
    id,
    type: "plan",
    renderClass: "plan",
    title,
    text,
    timestamp,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    acpSource,
  });
}

function summarizePlanUpdate(text: string) {
  const taskMatches = [...text.matchAll(/\[[ xX]\]/g)];
  if (taskMatches.length > 0) {
    const completed = taskMatches.filter((match) =>
      match[0].toLowerCase().includes("x"),
    ).length;
    return `${completed}/${taskMatches.length} complete`;
  }

  const stepCount = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)).length;
  return stepCount > 0 ? `${stepCount} step${stepCount === 1 ? "" : "s"}` : "";
}

function upsertMetadata(
  d: TranscriptDraft,
  id: string,
  title: string,
  sections: PromptSection[],
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
) {
  const existing = d.itemsById.get(id);
  if (existing?.type === "metadata") {
    replaceItem(d, id, {
      ...existing,
      sections,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    return;
  }
  sealOpenMessages(d);
  pushItem(d, {
    id,
    type: "metadata",
    renderClass: "raw-rail",
    title,
    sections,
    timestamp,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    acpSource,
  });
}

function isTerminalToolStatus(status: ToolStatus) {
  return status === "completed" || status === "failed";
}

function mergeToolStatus(existing: ToolStatus, next: ToolStatus): ToolStatus {
  if (isTerminalToolStatus(existing) && !isTerminalToolStatus(next)) {
    return existing;
  }

  return next;
}

function upsertTool(
  d: TranscriptDraft,
  id: string,
  title: string,
  toolName: string,
  buzzToolName: string | null,
  status: ToolStatus,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  timestamp: string,
  ctx: TranscriptItemContext,
  acpSource?: string,
) {
  const existing = d.itemsById.get(id);
  const canonicalBuzzToolName =
    buzzToolName ?? findBuzzToolName(toolName, true);
  if (existing?.type === "tool") {
    const updatedTitle = !isGenericToolTitle(title) ? title : existing.title;
    let updatedToolName = existing.toolName;
    let updatedBuzzToolName = existing.buzzToolName;
    if (canonicalBuzzToolName) {
      updatedBuzzToolName = canonicalBuzzToolName;
      updatedToolName = canonicalBuzzToolName;
    } else if (!existing.buzzToolName && !isGenericToolTitle(toolName)) {
      updatedToolName = toolName;
    }
    const mergedStatus = mergeToolStatus(existing.status, status);
    const updatedArgs = Object.keys(args).length > 0 ? args : existing.args;
    const updatedResult = result || existing.result;
    const updatedIsError = isError || existing.isError;
    const descriptor = classifyTool({
      title: updatedTitle,
      toolName: updatedToolName,
      buzzToolName: updatedBuzzToolName,
      args: updatedArgs,
      result: updatedResult,
      isError: updatedIsError || mergedStatus === "failed",
    });
    replaceItem(d, id, {
      ...existing,
      renderClass: descriptor.renderClass,
      descriptor,
      title: updatedTitle,
      toolName: updatedToolName,
      buzzToolName: updatedBuzzToolName,
      status: mergedStatus,
      args: updatedArgs,
      result: updatedResult,
      isError: updatedIsError,
      completedAt:
        isTerminalToolStatus(mergedStatus) && existing.completedAt == null
          ? timestamp
          : existing.completedAt,
      channelId: ctx.channelId,
      turnId: ctx.turnId ?? existing.turnId,
      sessionId: ctx.sessionId ?? existing.sessionId,
      acpSource: acpSource ?? existing.acpSource,
    });
    return;
  }
  const resolvedToolName = canonicalBuzzToolName ?? toolName;
  const descriptor = classifyTool({
    title,
    toolName: resolvedToolName,
    buzzToolName: canonicalBuzzToolName,
    args,
    result,
    isError: isError || status === "failed",
  });
  sealOpenMessages(d);
  pushItem(d, {
    id,
    type: "tool",
    renderClass: descriptor.renderClass,
    descriptor,
    title,
    toolName: resolvedToolName,
    buzzToolName: canonicalBuzzToolName,
    status,
    args,
    result,
    isError,
    timestamp,
    startedAt: timestamp,
    completedAt: isTerminalToolStatus(status) ? timestamp : null,
    channelId: ctx.channelId,
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    acpSource,
  });
}

export function processTranscriptEvent(
  state: TranscriptState,
  event: ObserverEvent,
): TranscriptState {
  const d = draftFrom(state);

  if (event.sessionId && event.sessionId !== d.latestSessionId) {
    d.latestSessionId = event.sessionId;
  }

  const channelId = event.channelId ?? null;
  const ch = channelId ?? "global";
  const ctx: TranscriptItemContext = {
    channelId,
    turnId: event.turnId,
    sessionId: event.sessionId ?? d.latestSessionId,
  };

  if (event.kind === "raw_json_rpc") {
    upsertMetadata(
      d,
      `raw-json-rpc:${ch}:${event.seq}`,
      "Raw ACP payload",
      [
        {
          title: rawPayloadTitle(event.payload),
          body: stringifyPayload(event.payload),
        },
      ],
      event.timestamp,
      ctx,
      event.kind,
    );
  } else if (event.kind === "turn_started") {
    rememberTriggeringEventIds(
      d,
      ch,
      event.turnId ?? event.seq,
      extractTriggeringEventIds(event.payload),
    );
    upsertTextItem(
      d,
      `turn:${ch}:${event.turnId ?? event.seq}`,
      "lifecycle",
      "Turn started",
      describeTurnStarted(event.payload),
      event.timestamp,
      ctx,
      event.kind,
    );
  } else if (event.kind === "session_resolved") {
    upsertTextItem(
      d,
      `session:${ch}:${event.turnId ?? event.seq}`,
      "lifecycle",
      "Session ready",
      describeSessionResolved(event.payload),
      event.timestamp,
      ctx,
      event.kind,
    );
  } else if (event.kind === "acp_parse_error") {
    upsertTextItem(
      d,
      `parse-error:${ch}:${event.seq}`,
      "lifecycle",
      "Wire parse error",
      extractBlockText(event.payload),
      event.timestamp,
      ctx,
      event.kind,
    );
  } else if (event.kind === "turn_completed") {
    // No row of its own — the transcript already shows the turn's work. The
    // turn ending is still the moment any request it left open stops being a
    // live question, so it is recorded as such.
    resolvePermissionsForEndedTurn(d, event.turnId);
  } else if (event.kind === "turn_error" || event.kind === "agent_panic") {
    const payload = asRecord(event.payload);
    const outcome = asString(payload.outcome) ?? "error";
    const error = asString(payload.error) ?? "Unknown error";
    const displayError = friendlyTurnErrorCopy(error, payload.code);
    const title =
      event.kind === "agent_panic" ? "Agent error (crash)" : "Turn error";
    upsertTextItem(
      d,
      `${event.kind}:${ch}:${event.turnId ?? event.seq}`,
      "lifecycle",
      title,
      `${outcome}: ${displayError}`,
      event.timestamp,
      ctx,
      event.kind,
    );
    resolvePermissionsForEndedTurn(d, event.turnId);
  } else if (event.kind === "acp_read" || event.kind === "acp_write") {
    const payload = asRecord(event.payload);
    const method = asString(payload.method);

    if (method === "session/request_permission") {
      const request = describePermissionRequest(payload);
      // ACP asks permission per tool call, so several requests in one turn is
      // the normal case. Keying the card by turn merged them: the second
      // request inherited the first's resolved outcome and never appeared at
      // all, or — with both open — took the first's headline over its own
      // options, buttons and id. The JSON-RPC id is the request's own
      // identity; `seq` stands in for a frame that carries none, and the
      // session scopes ids that restart with each new harness connection.
      const rpcKey = jsonRpcIdKey(payload.id);
      const requestKey = rpcKey ?? `seq:${event.seq}`;
      const sessionKey = event.sessionId ?? d.latestSessionId ?? "nosession";
      const itemId = `permission:${ch}:${sessionKey}:${requestKey}`;
      upsertPermissionItem(
        d,
        itemId,
        request.text,
        event.timestamp,
        ctx,
        request.descriptor,
        {
          // The raw id, not the map key: this is shipped verbatim as the
          // decision frame's `requestId`, and a JSON-encoded key would reach
          // the harness wrapped in literal quotes and match nothing.
          requestId: jsonRpcIdValue(payload.id),
          toolCallId: request.toolCallId,
          options: request.options,
        },
      );
      if (rpcKey) {
        // Index by JSON-RPC id so the response (acp_write with result.outcome,
        // no method) can correlate by id rather than by turn/seq. A frame with
        // no id can never be correlated, so it is not parked here — the
        // turn-end sweep is what eventually closes it out.
        d.pendingPermissions = new Map(d.pendingPermissions);
        d.pendingPermissions.set(rpcKey, {
          itemId,
          optionNames: request.optionNames,
        });
      }
    } else if (event.kind === "acp_write" && !method) {
      // Permission response: {"id": <same as request>, "result": {"outcome": {...}}}
      const responseId = jsonRpcIdKey(payload.id);
      const result = asRecord(asRecord(payload.result).outcome);
      const outcomeKind = asString(result.outcome);
      const pending = responseId ? d.pendingPermissions.get(responseId) : null;
      if (pending && outcomeKind && responseId) {
        const optionId = asString(result.optionId) ?? null;
        const outcomeText = describePermissionOutcome(
          outcomeKind,
          optionId,
          pending.optionNames,
        );
        const existing = d.itemsById.get(pending.itemId);
        if (existing?.type === "lifecycle") {
          replaceItem(d, pending.itemId, {
            ...existing,
            outcome: outcomeText,
          });
          // Remove from pending map — the outcome is now recorded.
          d.pendingPermissions = new Map(d.pendingPermissions);
          d.pendingPermissions.delete(responseId);
        }
      }
    } else if (event.kind === "acp_write" && method === "session/prompt") {
      const promptText = extractPromptText(payload);
      if (promptText) {
        const parsedPrompt = parsePromptText(promptText);
        if (parsedPrompt.userText) {
          upsertMessage(
            d,
            `prompt:${ch}:${event.turnId ?? event.seq}`,
            "user",
            parsedPrompt.userTitle,
            parsedPrompt.userText,
            event.timestamp,
            ctx,
            parsedPrompt.userPubkey,
            "session/prompt:user",
            parsedPrompt.userEventId ??
              getSingleTriggeringEventId(d, ch, event.turnId ?? event.seq),
          );
        }
        if (parsedPrompt.sections.length > 0) {
          upsertMetadata(
            d,
            `prompt-context:${ch}:${event.turnId ?? event.seq}`,
            "Prompt context",
            parsedPrompt.sections,
            event.timestamp,
            ctx,
            "session/prompt:context",
          );
        }
      }
    } else if (event.kind === "acp_write" && method === "session/new") {
      // The base + persona prompts ride session/new's systemPrompt, framed by
      // the harness as [Base]/[System]/[Agent Memory — core]/[Channel Canvas].
      // Each session/new event is keyed by (seq, timestamp) — the same dedup
      // pair used by observerRelayStore — so distinct sessions each retain
      // their own system-prompt card even across archive rebuilds where two
      // processes may emit the same seq. turnId: null keeps it out of turn
      // buckets; acpSource "session/new" lets the display grouper place it
      // as a standalone card before the session's first turn.
      const params = asRecord(payload.params);
      const systemPrompt = asString(params.systemPrompt);
      if (systemPrompt) {
        const sections = parseSystemPromptSections(systemPrompt);
        if (sections.length > 0) {
          upsertMetadata(
            d,
            `system-prompt:${ch}:${event.seq}:${event.timestamp}`,
            "System prompt",
            sections,
            event.timestamp,
            { ...ctx, turnId: null },
            "session/new",
          );
        }
      }
    } else if (
      event.kind === "acp_write" &&
      method === "_goose/unstable/session/steer"
    ) {
      const promptText = extractPromptText(payload);
      if (promptText) {
        const parsedPrompt = parsePromptText(promptText);
        if (parsedPrompt.userText) {
          upsertMessage(
            d,
            `steer:${ch}:${event.turnId ?? event.seq}`,
            "user",
            parsedPrompt.userTitle,
            parsedPrompt.userText,
            event.timestamp,
            ctx,
            parsedPrompt.userPubkey,
            "session/steer:user",
            parsedPrompt.userEventId,
          );
        }
        if (parsedPrompt.sections.length > 0) {
          upsertMetadata(
            d,
            `steer-context:${ch}:${event.turnId ?? event.seq}`,
            "Prompt context",
            parsedPrompt.sections,
            event.timestamp,
            ctx,
            "session/steer:context",
          );
        }
      }
    } else if (event.kind === "acp_read" && method === "session/update") {
      const params = asRecord(payload.params);
      const update = asRecord(params.update);
      const updateType = asString(update.sessionUpdate) ?? "unknown";
      const turnKey = event.turnId ?? event.sessionId ?? "unknown";
      const messageId = asString(update.messageId);

      if (updateType === "agent_message_chunk") {
        upsertMessage(
          d,
          `assistant:${ch}:${messageId ?? turnKey}`,
          "assistant",
          "Assistant",
          extractContentText(update.content),
          event.timestamp,
          ctx,
          null,
          updateType,
        );
      } else if (updateType === "user_message_chunk") {
        // Suppress user_message_chunk echo when a steer already rendered
        // the user message for this turn (Goose echoes steered content back).
        const steerKey = `steer:${ch}:${event.turnId ?? event.seq}`;
        const authorPubkey = asString(update.authorPubkey);
        if (!d.itemsById.has(steerKey)) {
          const channelMessageId = maybeNostrEventId(messageId);
          upsertMessage(
            d,
            `user:${ch}:${messageId ?? turnKey}`,
            "user",
            "User",
            extractContentText(update.content),
            event.timestamp,
            ctx,
            authorPubkey,
            updateType,
            channelMessageId,
          );
        }
      } else if (updateType === "agent_thought_chunk") {
        upsertTextItem(
          d,
          `thinking:${ch}:${messageId ?? turnKey}`,
          "thought",
          "Thinking",
          extractContentText(update.content),
          event.timestamp,
          ctx,
          updateType,
        );
      } else if (updateType === "tool_call") {
        const toolId = asString(update.toolCallId) ?? `tool:${event.seq}`;
        const identity = extractToolIdentity(update);
        upsertTool(
          d,
          `tool:${ch}:${toolId}`,
          identity.title,
          identity.toolName,
          identity.buzzToolName,
          normalizeToolStatus(asString(update.status) ?? "executing"),
          extractToolArgs(update),
          extractToolResult(update),
          false,
          event.timestamp,
          ctx,
          updateType,
        );
      } else if (updateType === "tool_call_update") {
        const toolId = asString(update.toolCallId) ?? `tool:${event.seq}`;
        const status = normalizeToolStatus(
          asString(update.status) ?? "completed",
        );
        const identity = extractToolIdentity(update);
        upsertTool(
          d,
          `tool:${ch}:${toolId}`,
          identity.title,
          identity.toolName,
          identity.buzzToolName,
          status,
          extractToolArgs(update),
          extractToolResult(update),
          status === "failed",
          event.timestamp,
          ctx,
          updateType,
        );
      } else if (updateType === "plan") {
        upsertPlan(
          d,
          `plan:${ch}:${turnKey}`,
          "Plan",
          extractPlanText(update),
          event.timestamp,
          ctx,
          updateType,
          `plan-update:${ch}:${turnKey}:${event.seq}`,
        );
      } else if (updateType === "current_mode_update") {
        const mode = asString(update.currentModeId) ?? "";
        if (mode) {
          upsertLifecycleItem(
            d,
            `mode:${ch}:${turnKey}`,
            "status",
            "Mode",
            mode,
            event.timestamp,
            ctx,
            updateType,
          );
        }
      } else if (updateType === "usage_update") {
        const used = typeof update.used === "number" ? update.used : null;
        const size = typeof update.size === "number" ? update.size : null;
        if (used !== null && size !== null) {
          const costRecord = asRecord(update.cost);
          const costAmount =
            typeof costRecord.amount === "number" ? costRecord.amount : null;
          const costCurrency = asString(costRecord.currency);
          const costStr =
            costAmount !== null && costCurrency
              ? ` ($${costAmount.toFixed(4)} ${costCurrency})`
              : "";
          replaceLifecycleItem(
            d,
            `usage:${ch}:${turnKey}`,
            "status",
            "Usage",
            `Tokens: ${used}/${size}${costStr}`,
            event.timestamp,
            ctx,
            updateType,
          );
        }
      } else if (updateType === "available_commands_update") {
        const cmds = Array.isArray(update.availableCommands)
          ? update.availableCommands
          : [];
        upsertLifecycleItem(
          d,
          `commands:${ch}:${turnKey}`,
          "status",
          "Commands",
          `Commands available: ${cmds.length}`,
          event.timestamp,
          ctx,
          updateType,
        );
      } else if (updateType === "config_option_update") {
        const opts = Array.isArray(update.configOptions)
          ? (update.configOptions as Array<Record<string, unknown>>)
          : [];
        const optText = opts
          .map((o) => {
            const name = asString(o.name) ?? asString(o.id) ?? "?";
            const val =
              asString(o.currentValue) ??
              (typeof o.value === "boolean" ? String(o.value) : null) ??
              "";
            return val ? `${name} = ${val}` : name;
          })
          .join(", ");
        if (optText) {
          upsertLifecycleItem(
            d,
            `config:${ch}:${turnKey}`,
            "status",
            "Config",
            optText,
            event.timestamp,
            ctx,
            updateType,
          );
        }
      } else {
        // Free-form observer status records are not part of the ACP session/update
        // union. Surface only explicit title/text payloads; leave all other
        // unknown frames out of the feed instead of guessing at semantics.
        const status = describeFreeformStatus(payload);
        if (status) {
          upsertLifecycleItem(
            d,
            `status:${ch}:${event.turnId ?? event.seq}:${status.statusType}`,
            "status",
            status.title,
            status.text,
            event.timestamp,
            ctx,
            status.statusType,
          );
        }
      }
    } else {
      // Free-form observer status records are not part of the ACP JSON-RPC
      // method set. Surface only explicit title/text payloads; leave all other
      // unknown frames out of the feed instead of guessing at semantics.
      const status = describeFreeformStatus(payload);
      if (status) {
        upsertLifecycleItem(
          d,
          `status:${ch}:${event.turnId ?? event.seq}:${status.statusType}`,
          "status",
          status.title,
          status.text,
          event.timestamp,
          ctx,
          status.statusType,
        );
      }
    }
  }

  if (!d.changed && d.latestSessionId === state.latestSessionId) {
    return state;
  }

  return {
    items: d.items,
    itemsById: d.itemsById,
    activeMessageKey: d.activeMessageKey,
    sealedKeys: d.sealedKeys,
    triggeringEventIdsByTurn: d.triggeringEventIdsByTurn,
    pendingPermissions: d.pendingPermissions,
    continuationSeq: d.continuationSeq,
    latestSessionId: d.latestSessionId,
  };
}

export function buildTranscriptState(
  events: readonly ObserverEvent[],
): TranscriptState {
  let state = createEmptyTranscriptState();
  for (const event of events) {
    state = processTranscriptEvent(state, event);
  }
  return state;
}

export function buildTranscript(
  events: readonly ObserverEvent[],
): TranscriptItem[] {
  return buildTranscriptState(events).items;
}
