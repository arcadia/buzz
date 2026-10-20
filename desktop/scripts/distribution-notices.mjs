import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Reject missing, edited or stale native notices before packaging any frontend. */
export function verifyDistributionNotices(root = repository) {
  const manifest = readFileSync(
    path.join(root, "licenses/native-inputs.sha256"),
    "utf8",
  );
  for (const line of manifest.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error("Invalid native notices checksum manifest");
    const [, expected, relative] = match;
    const content = readFileSync(path.join(root, relative), "utf8").replace(
      /\r\n/gu,
      "\n",
    );
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `Distribution notices are stale (${relative}). Run python scripts/generate-distribution-notices.py.`,
      );
    }
  }
}
