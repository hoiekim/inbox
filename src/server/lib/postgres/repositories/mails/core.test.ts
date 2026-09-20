/**
 * The SQL these mutations emit is pinned in `core-query.test.ts`, on the
 * builders' output. What is left here is the part no emitted string can show:
 * `buildMarkMailSpamQuery` takes `modseq` as a parameter, so every assertion on
 * its output holds for any value the caller passes, and where that value comes
 * from is visible only at the call site. Scoped to the one file the function
 * lives in.
 */
import { describe, it, expect, beforeAll } from "bun:test";

describe("markMailSpam — mod-sequence reservation", () => {
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "core.ts"),
      "utf8"
    );
    const fnMatch = source.match(/export const markMailSpam[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("markMailSpam not found in core.ts");
    // A comment inside the argument list would land in the parsed argument and
    // fail for the wrong reason.
    fnSource = fnMatch[0].replace(/^\s*\/\/.*$/gm, "");
  });

  it("stamps a freshly reserved mod-sequence rather than a constant", () => {
    // The flip moves the mail out of INBOX, so it has to advance
    // HIGHESTMODSEQ. With a constant the UPDATE still matches, `updated` still
    // refreshes and the response is still `{found: true, changed: true}` —
    // while a CONDSTORE client reads an unmoved HIGHESTMODSEQ and never
    // resyncs the mail away.
    const call = fnSource.match(/buildMarkMailSpamQuery\(([\s\S]*?)\)\s*;/);
    expect(call, "buildMarkMailSpamQuery call not found").not.toBeNull();
    const args = call![1].split(",").map((argument) => argument.trim());
    expect(args[3]).toBe("await getNextModseq(user_id)");
  });
});
