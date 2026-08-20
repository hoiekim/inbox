/**
 * The per-user ceiling on mailbox rows.
 *
 * LIST/LSUB materialise every stored row and emit one line each, so the row
 * count is the multiplicand a per-name cap cannot bound. The cases pin that
 * CREATE refuses at the ceiling before the INSERT, that the ceiling does not
 * mask an existing name, and that the count it gates on is a single aggregate
 * scoped to the calling user rather than to the server.
 */

import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { SignedUser } from "common";
import { Store } from "./store";

// Pinned as a literal, not imported: the ceiling is the contract these cases
// exist to hold, so changing its value has to fail here.
const LIMIT = 1000;

const VALID_USER: SignedUser = { id: "u1", username: "admin" } as SignedUser;
const OTHER_USER: SignedUser = { id: "u2", username: "other" } as SignedUser;

// A schema-valid mailboxes row so `new MailboxModel(row)` validates on the
// INSERT ... RETURNING * path.
const CREATED_ROW = {
  mailbox_id: "mb1",
  user_id: "u1",
  name: "Archive",
  address: null,
  parent_id: null,
  uid_validity: 1,
  uid_next: 1,
  subscribed: true,
  special_use: null,
  created: "2026-08-20T00:00:00.000Z",
};

// Per-user stored counts. A cap that counted globally would read the same
// number for every user, which is what the two-user case exists to catch.
const storedByUser = new Map<string, number>();
let nameExists = false;
const statements: Array<{ sql: string; values: unknown[] }> = [];

const mockQuery = mock(async (sql: string, values: unknown[] = []) => {
  statements.push({ sql, values });
  if (sql.includes("COUNT(*)")) {
    const user = values[0] as string;
    return { rows: [{ count: storedByUser.get(user) ?? 0 }], rowCount: 1 };
  }
  if (sql.includes("SELECT * FROM mailboxes")) {
    return nameExists
      ? { rows: [CREATED_ROW], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  return { rows: [CREATED_ROW], rowCount: 1 };
});

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { createMailbox } = await import("./mailbox-ops");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

beforeEach(() => {
  mockQuery.mockClear();
  statements.length = 0;
  storedByUser.clear();
  nameExists = false;
});

const create = async (
  name: string,
  user: SignedUser = VALID_USER
): Promise<string[]> => {
  const store = new Store(user);
  const lines: string[] = [];
  await createMailbox("A1", name, store, (data: string) => {
    lines.push(data);
    return true;
  });
  return lines;
};

const sqlMatching = (fragment: string): Array<{ sql: string; values: unknown[] }> =>
  statements.filter((s) => s.sql.includes(fragment));

const inserts = () => sqlMatching("INSERT INTO mailboxes");
const counts = () => sqlMatching("COUNT(*)");

describe("CREATE per-user mailbox ceiling", () => {
  it("accepts the row that reaches the ceiling", async () => {
    storedByUser.set("u1", LIMIT - 1);
    expect(await create("Archive")).toEqual(["A1 OK CREATE completed\r\n"]);
    expect(inserts()).toHaveLength(1);
  });

  it("refuses at the ceiling, without an INSERT", async () => {
    storedByUser.set("u1", LIMIT);
    expect(await create("Archive")).toEqual([
      `A1 NO [LIMIT] Mailbox limit of ${LIMIT} reached\r\n`,
    ]);
    expect(inserts()).toEqual([]);
  });

  it("keeps refusing above the ceiling, so rows already stored are not a bypass", async () => {
    storedByUser.set("u1", LIMIT * 5);
    expect(await create("Archive")).toEqual([
      `A1 NO [LIMIT] Mailbox limit of ${LIMIT} reached\r\n`,
    ]);
    expect(inserts()).toEqual([]);
  });

  it("gates on one aggregate, not a row fetch", async () => {
    await create("Archive");
    const countSql = counts();
    expect(countSql).toHaveLength(1);
    expect(countSql[0].sql).toContain("FROM mailboxes");
    expect(countSql[0].sql).not.toContain("SELECT *");
  });

  it("counts only the calling user, so one full account does not deny another", async () => {
    storedByUser.set("u1", LIMIT);
    storedByUser.set("u2", 0);

    expect(await create("Archive", VALID_USER)).toEqual([
      `A1 NO [LIMIT] Mailbox limit of ${LIMIT} reached\r\n`,
    ]);
    expect(await create("Archive", OTHER_USER)).toEqual(["A1 OK CREATE completed\r\n"]);

    // The aggregate must carry the user as a bound parameter, not count the table.
    expect(counts().map((s) => s.values[0])).toEqual(["u1", "u2"]);
  });

  it("still reports an existing name as existing at the ceiling", async () => {
    // A client running ensure-folder-exists treats ALREADYEXISTS as success and
    // a bare NO as failure, so the ceiling must not mask the name probe.
    storedByUser.set("u1", LIMIT);
    nameExists = true;
    expect(await create("Archive")).toEqual([
      "A1 NO [ALREADYEXISTS] Mailbox already exists\r\n",
    ]);
    expect(inserts()).toEqual([]);
  });
});
