import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityStateMark } from "./ActivityStateMark.tsx";

function markup(state) {
  return renderToStaticMarkup(
    React.createElement(ActivityStateMark, { state }),
  );
}

/**
 * The announced text only — not the `title` attribute, which carries the same
 * words on an aria-hidden element and is therefore invisible to the reader
 * these assertions are about.
 */
function announced(state) {
  const match = markup(state).match(/<span class="sr-only">([^<]*)<\/span>/);
  return match ? match[1] : null;
}

test("a failure is announced, not only coloured", () => {
  // The mark is aria-hidden (its `title` is pointer decoration), and the row's
  // only other failure signal is `text-destructive`. Inside a role="log"
  // aria-live region that means a failed step announces nothing at all.
  assert.equal(announced({ state: "failed", tone: "neutral" }), "Failed");
});

test("a step that changed something says so in text", () => {
  assert.equal(
    announced({ state: "done", tone: "write" }),
    "Finished · changed something",
  );
});

test("running and queued carry their state in text", () => {
  assert.equal(
    announced({ state: "running", tone: "read" }),
    "Running now · read",
  );
  assert.equal(announced({ state: "queued", tone: "neutral" }), "Queued");
});

test("a finished read stays silent — its own row label already says it", () => {
  // Sixty announced dots would bury the transcript, and the row reads
  // "Read <file>" on its own.
  assert.equal(
    announced({ state: "done", tone: "read" }),
    null,
    "quiet rows must not be announced",
  );
});

test("notable states get the full-size mark, quiet ones the faint one", () => {
  assert.match(markup({ state: "failed", tone: "neutral" }), /size-1\.5/);
  assert.match(markup({ state: "done", tone: "admin" }), /size-1\.5/);
  const quiet = markup({ state: "done", tone: "read" });
  assert.ok(!quiet.includes("size-1.5"), "a finished read stays faint");
});
