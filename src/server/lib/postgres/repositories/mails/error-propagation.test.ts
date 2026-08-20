import { describe, it, expect, beforeAll } from "bun:test";

describe("core.ts does not report a DB fault as not-found", () => {
  // A DB fault must not be swallowed and returned as the same falsy value that
  // means "no row matched" — that would surface as "not found or you don't
  // have permission" (post-spam-mark), "No email is found." (get-body) or a
  // plain success for a delete that never landed. Letting the error propagate
  // routes it to `Route.handler`, which logs, alarms and answers 500 — the
  // same call `saveMail` makes ("silent-drop is worse than loud failure").
  const fns = [
    "getMailById",
    "markMailRead",
    "markMailSaved",
    "deleteMail",
    "markMailSpam",
  ];

  let source: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    source = await fs.readFile(path.join(import.meta.dir, "core.ts"), "utf8");
  });

  it.each(fns)("%s swallows no error", (name) => {
    const body = source.match(
      new RegExp(`export const ${name} = async \\([\\s\\S]*?\\n};`)
    )?.[0];
    // A missed match would make every assertion below vacuous.
    expect(body).toBeDefined();
    expect(body).not.toContain("catch");
  });
});

describe("http.ts getMailHeaders does not render an empty mailbox on a DB fault", () => {
  // This one swallowed into `return []`, which is the same lie with the widest
  // blast radius in the family: GET /api/mails answered 200 with an empty list,
  // so a DB fault presented as "you have no mail" rather than as an error.
  let source: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    source = await fs.readFile(path.join(import.meta.dir, "http.ts"), "utf8");
  });

  it("swallows no error", () => {
    const body = source.match(/export const getMailHeaders = async \([\s\S]*?\n};/)?.[0];
    expect(body).toBeDefined();
    expect(body).not.toContain("catch");
  });
});
