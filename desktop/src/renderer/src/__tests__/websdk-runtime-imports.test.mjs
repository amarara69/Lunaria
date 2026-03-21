import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webSdkRoot = path.resolve(__dirname, "../../WebSDK/src");

test("WebSDK runtime helpers no longer import removed .mjs renderer utilities", () => {
  const offenders = [];

  for (const entry of readdirSync(webSdkRoot)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }

    const absolutePath = path.join(webSdkRoot, entry);
    const source = readFileSync(absolutePath, "utf8");
    if (source.includes("../../src/runtime/") && source.includes(".mjs")) {
      offenders.push(entry);
    }
  }

  assert.deepEqual(offenders.sort(), []);
});
