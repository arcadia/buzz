import * as React from "react";

import {
  canSendAgentPermissionDecision,
  cancelManagedAgentTurn,
  sendAgentPermissionDecision,
} from "@/shared/api/agentControl";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useFeedbackToasts } from "@/shared/hooks/useToastEffect";
import { useStableMap } from "@/shared/hooks/useStableReference";
import {
  findPermissionToolItem,
  findTurnRequesterPubkey,
} from "./agentPermissionDecision";
import type { PermissionOption, TranscriptItem } from "./agentSessionTypes";

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

/**
 * How far along one answer is.
 *
 * `sent` deliberately does not mean "approved". The authoritative outcome is
 * the harness's own response, observed later on the same frame stream that
 * stamps `item.outcome` and collapses the block to a resolved row. Claiming
 * the outcome at send time would put a green tick on screen for a decision the
 * agent may never have received.
 */
export type PermissionDecisionState = {
  status: "sending" | "sent" | "failed";
  optionId: string;
  message?: string;
};

export type AgentPermissionDecisionContextValue = {
  /** A decision can be delivered: transport connected and a channel in scope. */
  canDecide: boolean;
  /** The turn can be interrupted, which is also how a pending request is denied. */
  canStopTurn: boolean;
  decide: (
    itemId: string,
    requestId: string | null,
    option: PermissionOption,
  ) => void;
  decisions: ReadonlyMap<string, PermissionDecisionState>;
  /** Permission item id → the pubkey of whoever asked for that turn. */
  requesterByItemId: ReadonlyMap<string, string>;
  stopTurn: (() => void) | null;
  /** Permission item id → the tool row this request gates, when named. */
  toolByItemId: ReadonlyMap<string, ToolItem>;
  viewerPubkey: string | null;
};

const EMPTY_DECISIONS: ReadonlyMap<string, PermissionDecisionState> = new Map();
const EMPTY_REQUESTERS: ReadonlyMap<string, string> = new Map();
const EMPTY_TOOLS: ReadonlyMap<string, ToolItem> = new Map();

/**
 * Everything off by default. A permission block rendered outside a provider —
 * a compact preview, a snapshot, a surface that has no agent to talk to —
 * reads as an observer's view rather than offering a control it cannot honour.
 */
const DEFAULT_VALUE: AgentPermissionDecisionContextValue = {
  canDecide: false,
  canStopTurn: false,
  decide: () => {},
  decisions: EMPTY_DECISIONS,
  requesterByItemId: EMPTY_REQUESTERS,
  stopTurn: null,
  toolByItemId: EMPTY_TOOLS,
  viewerPubkey: null,
};

const AgentPermissionDecisionContext =
  React.createContext<AgentPermissionDecisionContextValue>(DEFAULT_VALUE);

export function useAgentPermissionDecisionContext() {
  return React.useContext(AgentPermissionDecisionContext);
}

export function AgentPermissionDecisionProvider({
  agentName,
  agentPubkey,
  canInterruptTurn,
  channelId,
  children,
  items,
}: {
  agentName: string;
  agentPubkey: string;
  canInterruptTurn: boolean;
  channelId: string | null;
  children: React.ReactNode;
  items: readonly TranscriptItem[];
}) {
  const identityQuery = useIdentityQuery();
  const viewerPubkey = identityQuery.data?.pubkey ?? null;

  const [decisions, setDecisions] =
    React.useState<ReadonlyMap<string, PermissionDecisionState>>(
      EMPTY_DECISIONS,
    );
  const [noticeMessage, setNoticeMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  useFeedbackToasts(noticeMessage, errorMessage);

  // Both joins are keyed by permission item id and hold only primitives or
  // reducer-owned item references, so `useStableMap` can hold the identity
  // steady while the transcript churns around them — a streaming run must not
  // re-render the one card the reader is deciding on with every frame.
  const requesterByItemId = useStableMap(
    React.useMemo(() => {
      const map = new Map<string, string>();
      for (const item of items) {
        if (item.type !== "lifecycle" || item.renderClass !== "permission") {
          continue;
        }
        const requester = findTurnRequesterPubkey(items, item.turnId);
        if (requester) map.set(item.id, requester);
      }
      return map;
    }, [items]),
  );

  const toolByItemId = useStableMap(
    React.useMemo(() => {
      const map = new Map<string, ToolItem>();
      for (const item of items) {
        if (item.type !== "lifecycle" || item.renderClass !== "permission") {
          continue;
        }
        const tool = findPermissionToolItem(items, item.permission?.toolCallId);
        if (tool) map.set(item.id, tool);
      }
      return map;
    }, [items]),
  );

  // A control frame is addressed to one channel — the harness parses
  // `channelId` as a UUID and drops the frame without one. The unscoped "all
  // channels" view therefore genuinely cannot answer or interrupt, and says so
  // rather than offering a button that would be discarded in transit.
  const hasChannelScope = Boolean(channelId);
  const canDecide = canSendAgentPermissionDecision() && hasChannelScope;
  const canStopTurn = canInterruptTurn && hasChannelScope;

  const decide = React.useCallback(
    (itemId: string, requestId: string | null, option: PermissionOption) => {
      if (!channelId) return;
      if (!requestId) {
        // No JSON-RPC id means nothing to correlate the answer with. Refusing
        // is the only safe move: a decision sent against the wrong request
        // would authorize a call the reader never looked at.
        setDecisions((prev) =>
          new Map(prev).set(itemId, {
            status: "failed",
            optionId: option.optionId,
            message:
              "This request arrived without an id, so it cannot be answered from here.",
          }),
        );
        return;
      }

      setDecisions((prev) =>
        new Map(prev).set(itemId, {
          status: "sending",
          optionId: option.optionId,
        }),
      );

      void (async () => {
        try {
          await sendAgentPermissionDecision(agentPubkey, channelId, {
            requestId,
            optionId: option.optionId,
          });
          setDecisions((prev) =>
            new Map(prev).set(itemId, {
              status: "sent",
              optionId: option.optionId,
            }),
          );
          setErrorMessage(null);
          setNoticeMessage(`Sent "${option.name}" to ${agentName}.`);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `Could not send "${option.name}" to ${agentName}.`;
          setDecisions((prev) =>
            new Map(prev).set(itemId, {
              status: "failed",
              optionId: option.optionId,
              message,
            }),
          );
          setNoticeMessage(null);
          setErrorMessage(`Your answer did not reach ${agentName}. ${message}`);
        }
      })();
    },
    [agentName, agentPubkey, channelId],
  );

  const stopTurn = React.useCallback(() => {
    if (!channelId) return;
    void (async () => {
      try {
        await cancelManagedAgentTurn(agentPubkey, channelId);
        setErrorMessage(null);
        setNoticeMessage(
          `Stop signal sent to ${agentName}. It may take a moment to respond.`,
        );
      } catch (error) {
        setNoticeMessage(null);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : `Failed to stop ${agentName}'s current turn.`,
        );
      }
    })();
  }, [agentName, agentPubkey, channelId]);

  const value = React.useMemo<AgentPermissionDecisionContextValue>(
    () => ({
      canDecide,
      canStopTurn,
      decide,
      decisions,
      requesterByItemId,
      stopTurn: canStopTurn ? stopTurn : null,
      toolByItemId,
      viewerPubkey,
    }),
    [
      canDecide,
      canStopTurn,
      decide,
      decisions,
      requesterByItemId,
      stopTurn,
      toolByItemId,
      viewerPubkey,
    ],
  );

  return (
    <AgentPermissionDecisionContext.Provider value={value}>
      {children}
    </AgentPermissionDecisionContext.Provider>
  );
}
