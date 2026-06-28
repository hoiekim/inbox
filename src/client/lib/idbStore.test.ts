import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  idbGetAllQueries,
  idbPutQuery,
  idbDeleteQuery,
  idbClearQueries,
} from "./idbStore";

beforeEach(async () => {
  await idbClearQueries();
});

describe("idbStore", () => {
  it("round-trips an entry", async () => {
    await idbPutQuery({
      key: "k1",
      payload: { a: 1 },
      userId: "u1",
      lastFetchedAt: 123,
    });
    const all = await idbGetAllQueries();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      key: "k1",
      payload: { a: 1 },
      userId: "u1",
      lastFetchedAt: 123,
    });
  });

  it("upserts by key (no duplicate rows)", async () => {
    await idbPutQuery({ key: "k1", payload: { a: 1 }, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k1", payload: { a: 2 }, userId: "u1", lastFetchedAt: 2 });
    const all = await idbGetAllQueries();
    expect(all).toHaveLength(1);
    expect((all[0].payload as { a: number }).a).toBe(2);
  });

  it("deletes by key", async () => {
    await idbPutQuery({ key: "k1", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k2", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbDeleteQuery("k1");
    const all = await idbGetAllQueries();
    expect(all.map((e) => e.key)).toEqual(["k2"]);
  });

  it("clears all entries", async () => {
    await idbPutQuery({ key: "k1", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k2", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbClearQueries();
    expect(await idbGetAllQueries()).toHaveLength(0);
  });
});
