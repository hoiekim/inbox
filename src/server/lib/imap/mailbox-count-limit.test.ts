/**
 * The per-user ceiling on mailbox rows.
 *
 * LIST/LSUB materialise every stored row and emit one line each, so the row
 * count is the multiplicand a per-name cap cannot bound. The cases pin that
 * CREATE refuses at the ceiling before the INSERT, and that the count it
 * gates on is a single aggregate scoped to the calling user.
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

let mailboxCount = 0;
const statements: string[] = [];

const mockQuery = mock(async (sql: string) => {
  statements.push(sql);
  if (sql.includes("COUNT(*)")) {
    return { rows: [{ count: mailboxCount }], rowCount: 1 };
  }
  // getMailboxByName's duplicate probe — no existing row.
  if (sql.includes("SELECT * FROM mailboxes")) return { rows: [], rowCount: 0 };
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
});

const create = async (name: string): Promise<string[]> => {
  const store = new Store(VALID_USER);
  const lines: string[] = [];
  await createMailbox("A1", name, store, (data: string) => {
    lines.push(data);
    return true;
  });
  return lines;
};

const inserts = (): string[] => statements.filter((s) => s.includes("INSERT INTO mailboxes"));
const counts = (): string[] => statements.filter((s) => s.includes("COUNT(*)"));

describe("CREATE per-user mailbox ceiling", () => {
  it("accepts the row that reaches the ceiling", async () => {
    mailboxCount = LIMIT - 1;
    expect(await create("Archive")).toEqual(["A1 OK CREATE completed\r\n"]);
    expect(inserts()).toHaveLength(1);
  });

  it("refuses at the ceiling, without an INSERT", async () => {
    mailboxCount = LIMIT;
    expect(await create("Archive")).toEqual([
      `A1 NO [LIMIT] Mailbox limit of ${LIMIT} reached\r\n`,
    ]);
    expect(inserts()).toEqual([]);
  });

  it("keeps refusing above the ceiling, so rows already stored are not a bypass", async () => {
    mailboxCount = LIMIT * 5;
    expect(await create("Archive")).toEqual([
      `A1 NO [LIMIT] Mailbox limit of ${LIMIT} reached\r\n`,
    ]);
    expect(inserts()).toEqual([]);
  });

  it("gates on one aggregate scoped to the calling user, not a row fetch", async () => {
    mailboxCount = 0;
    await create("Archive");
    const countSql = counts();
    expect(countSql).toHaveLength(1);
    expect(countSql[0]).toContain("FROM mailboxes");
    expect(countSql[0]).toContain("user_id = $1");
    expect(countSql[0]).not.toContain("SELECT *");
  });

  it("refuses before the duplicate probe reads any mailbox row", async () => {
    mailboxCount = LIMIT;
    await create("Archive");
    expect(statements.filter((s) => s.includes("SELECT * FROM mailboxes"))).toEqual([]);
  });
});
