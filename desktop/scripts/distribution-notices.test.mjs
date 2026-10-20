import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyDistributionNotices } from "./distribution-notices.mjs";

test("packaging rejects stale dependencies and truncated license text", () => {
  const root = mkdtempSync(path.join(tmpdir(), "buzz-notices-test-"));
  try {
    mkdirSync(path.join(root, "licenses"));
    const files = {
      "Cargo.lock": "version = 4\n",
      "licenses/desktop-native.txt": "Copyright Example Authors\nMIT text\n",
    };
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(root, name), text);
    }
    writeFileSync(
      path.join(root, "licenses/native-inputs.sha256"),
      `${Object.entries(files)
        .map(
          ([name, text]) =>
            `${createHash("sha256").update(text).digest("hex")}  ${name}`,
        )
        .join("\n")}\n`,
    );
    assert.doesNotThrow(() => verifyDistributionNotices(root));
    writeFileSync(path.join(root, "Cargo.lock"), "version = 5\n");
    assert.throws(() => verifyDistributionNotices(root), /stale.*Cargo.lock/u);
    writeFileSync(
      path.join(root, "Cargo.lock"),
      files["Cargo.lock"].replaceAll("\n", "\r\n"),
    );
    assert.doesNotThrow(() => verifyDistributionNotices(root));
    writeFileSync(path.join(root, "licenses/desktop-native.txt"), "MIT\n");
    assert.throws(
      () => verifyDistributionNotices(root),
      /stale.*desktop-native.txt/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
