import type { PermissionOption } from "./agentSessionTypes";
import { asRecord, asString } from "./agentSessionUtils";

/**
 * The row label every permission request carries, and the fallback title for a
 * frame that names nothing. Shared so the reducer's row, the request parser's
 * default, and the "don't repeat the label in the body" test can never drift.
 */
export const PERMISSION_REQUEST_TITLE = "Permission requested";

/** What the transcript records when a turn ends with a request unanswered. */
export const PERMISSION_UNANSWERED_OUTCOME = "Unanswered (turn ended)";

/** A JSON-RPC id as the spec allows it: a string or a finite number. */
export type JsonRpcId = string | number;

/**
 * The JSON-RPC id exactly as it arrived, or null when the frame carries none.
 *
 * This is the value an answer has to echo, so it keeps its wire type. A string
 * id re-encoded as JSON would reach the harness wrapped in literal quotes and
 * never match the parked request, which is the one failure an approval control
 * cannot have: a decision that reports success and answers nothing. Objects
 * and booleans are not legal ids and read as absent.
 */
export function jsonRpcIdValue(value: unknown): JsonRpcId | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * A collision-free map key for a JSON-RPC id.
 *
 * `1` and `"1"` are two different requests per the spec, so the key carries
 * the wire type as a prefix. This is bookkeeping only — it identifies a
 * request inside this module's own maps and item ids, and never goes on the
 * wire. `jsonRpcIdValue` is what an answer sends back.
 */
export function jsonRpcIdKey(value: unknown): string | null {
  const id = jsonRpcIdValue(value);
  if (id === null) return null;
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

export function describePermissionRequest(payload: Record<string, unknown>) {
  const params = asRecord(payload.params);
  const title =
    asString(params.title) ??
    asString(params.message) ??
    asString(params.reason) ??
    PERMISSION_REQUEST_TITLE;
  const toolCallId =
    asString(params.toolCallId) ?? asString(params.tool_call_id) ?? null;

  // Parse the options ONCE into their structured form. The display line, the
  // outcome-labelling map, and the answer buttons are all projections of this
  // list — previously the display path kept only the joined names and the
  // `optionId`s survived nowhere the renderer could reach, which is why the
  // card could show the choices but never offer them.
  const structuredOptions: PermissionOption[] = Array.isArray(params.options)
    ? params.options.flatMap((option) => {
        const record = asRecord(option);
        const optionId = asString(record.optionId);
        const kind = asString(record.kind) ?? null;
        const name = asString(record.name) ?? kind ?? optionId;
        // An option with no id cannot be answered with, so it is not an
        // option — drop it rather than render a button that cannot be sent.
        // The renderer says so out loud when this empties the list: an
        // approval demand with no affordance still expires into a denial.
        if (!optionId || !name) return [];
        return [{ optionId, kind, name }];
      })
    : [];

  const options = structuredOptions.map((option) => option.name);
  const detail: string[] = [];
  if (title !== PERMISSION_REQUEST_TITLE) detail.push(title);
  // The tool-call id used to be printed here as the only way to know which
  // call was gated. It now rides `permission.toolCallId`, where the renderer
  // uses it to join to the actual tool row and show the command — so the bare
  // id is plumbing on screen, and it sat in the middle of the request line.
  if (options.length > 0) detail.push(`Options: ${options.join(", ")}`);

  // optionId → kind, for outcome labeling on the response.
  const optionNames = new Map<string, string>();
  for (const option of structuredOptions) {
    if (option.kind) {
      optionNames.set(option.optionId, option.kind);
    }
  }

  return {
    title,
    text: detail.join("\n"),
    optionNames,
    toolCallId,
    options: structuredOptions,
    descriptor: {
      renderClass: "permission" as const,
      label: PERMISSION_REQUEST_TITLE,
      preview: title,
      action: { verb: "Requested", object: title },
      tone: "admin" as const,
      operation: "session/request_permission",
      object: title,
      source: "acp" as const,
      groupKey: "permission:request",
    },
  };
}

/**
 * Format a human-readable outcome label from a permission response.
 * kind values from ACP: allow_once, allow_always, reject_once, reject_always.
 * "reject_*" kinds are denials; anything else that is selected is an approval.
 */
export function describePermissionOutcome(
  outcome: string,
  optionId: string | null,
  optionNames: Map<string, string>,
): string {
  if (outcome === "cancelled") {
    return "Cancelled";
  }
  if (outcome === "selected" && optionId) {
    const kind = optionNames.get(optionId) ?? optionId;
    const isDenial = kind.startsWith("reject");
    const verb = isDenial ? "Denied" : "Approved";
    return `${verb} (${kind})`;
  }
  return outcome;
}
