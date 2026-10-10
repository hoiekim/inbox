import { describe, it, expect, mock } from "bun:test";
import path from "path";

import { issueAuthenticatedSession } from "./issue-session";

describe("issueAuthenticatedSession", () => {
  it("attaches the identity only after the reissue has resolved", async () => {
    // The assignment is recorded through a setter rather than after the call, so
    // the sequence under test is the helper's own and not the assertion's.
    const order: string[] = [];
    let attached: unknown = null;
    const session: Record<string, unknown> = {};
    Object.defineProperty(session, "user", {
      get: () => attached,
      set: (value) => {
        attached = value;
        order.push("assign");
      },
      configurable: true,
      enumerable: true,
    });
    session.regenerate = mock((cb: (err: Error | null) => void) => {
      order.push("regenerate");
      attached = null;
      cb(null);
    });
    const req = { session } as unknown as import("express").Request;
    const user = { id: "u1", username: "alice" };

    await issueAuthenticatedSession(req, user as never);

    expect(order).toEqual(["regenerate", "assign"]);
    expect(req.session.user).toEqual(user);
  });

  it("leaves the session anonymous when the reissue fails", async () => {
    const session: Record<string, unknown> = {
      user: null,
      regenerate: mock((cb: (err: Error | null) => void) => cb(new Error("store down"))),
    };
    const req = { session } as unknown as import("express").Request;

    await expect(
      issueAuthenticatedSession(req, { id: "u1", username: "alice" } as never)
    ).rejects.toThrow("store down");
    expect(req.session.user).toBeNull();
  });

  // A route that attaches the identity itself would skip the reissue. The
  // assertion names the one file where the write is allowed instead of
  // enumerating spellings of the defect, so an unfamiliar spelling fails it
  // too, and it walks the whole http layer because a third session-issuing
  // route is as likely to land in a new router directory as in `users/`.
  it("is the only file in the http layer that attaches a session identity", async () => {
    const attachesIdentity = [
      /\.user\s*=(?!=)/,
      /\[\s*["']user["']\s*\]\s*=(?!=)/,
      /Object\.assign\s*\(\s*[\w.]*\bsession\b/,
    ];
    const layer = import.meta.dir;
    const sources = [...new Bun.Glob("**/*.ts").scanSync({ cwd: layer, absolute: true })].filter(
      (file) => !/\.test\.ts$/.test(file)
    );

    const attaching: string[] = [];
    for (const file of sources) {
      const source = await Bun.file(file).text();
      if (attachesIdentity.some((pattern) => pattern.test(source))) {
        attaching.push(path.relative(layer, file));
      }
    }

    expect(attaching).toEqual(["issue-session.ts"]);
  });
});
