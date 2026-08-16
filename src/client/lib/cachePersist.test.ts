import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import { MailHeaderData } from "common";
import { queryClient } from "./queryClient";
import {
  hydrateQueryCache,
  clearCachedQueries,
  setCacheUser,
  startCachePersistence,
} from "./cachePersist";
import { idbGetAllQueries, idbPutQuery, idbClearQueries } from "./idbStore";
import { QueryCache } from "./cache";

const HEADERS_KEY = "/api/mails/headers/me@hoie.kim";
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  queryClient.clear();
  await idbClearQueries();
  setCacheUser(undefined);
});

describe("hydrateQueryCache", () => {
  it("seeds the cache with revived MailHeaderData instances for the matching user", async () => {
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1", subject: "hi", read: false }],
      userId: "u1",
      lastFetchedAt: Date.now(),
    });
    await hydrateQueryCache("u1");
    const data = queryClient.getQueryData<MailHeaderData[]>(HEADERS_KEY);
    expect(data).toBeDefined();
    expect(data!).toHaveLength(1);
    expect(data![0]).toBeInstanceOf(MailHeaderData);
    expect(data![0].id).toBe("m1");
  });

  it("does not seed (and purges) entries owned by a different user", async () => {
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1" }],
      userId: "other-user",
      lastFetchedAt: Date.now(),
    });
    await hydrateQueryCache("u1");
    expect(queryClient.getQueryData(HEADERS_KEY)).toBeUndefined();
    await flush();
    expect(await idbGetAllQueries()).toHaveLength(0);
  });

  it("drops entries older than the catalog maxAge", async () => {
    const eightDaysAgo = Date.now() - 1000 * 60 * 60 * 24 * 8;
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1" }],
      userId: "u1",
      lastFetchedAt: eightDaysAgo,
    });
    await hydrateQueryCache("u1");
    expect(queryClient.getQueryData(HEADERS_KEY)).toBeUndefined();
    await flush();
    expect(await idbGetAllQueries()).toHaveLength(0);
  });

  it("ignores keys that are not in the catalog", async () => {
    const searchKey = "/api/mails/search/me@hoie.kim";
    await idbPutQuery({
      key: searchKey,
      payload: [{ id: "s1" }],
      userId: "u1",
      lastFetchedAt: Date.now(),
    });
    await hydrateQueryCache("u1");
    expect(queryClient.getQueryData(searchKey)).toBeUndefined();
  });

  it("no-ops when logged out", async () => {
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1" }],
      userId: "u1",
      lastFetchedAt: Date.now(),
    });
    await hydrateQueryCache(undefined);
    expect(queryClient.getQueryData(HEADERS_KEY)).toBeUndefined();
  });
});

describe("startCachePersistence", () => {
  it("mirrors a successful in-catalog query into IndexedDB for the current user", async () => {
    setCacheUser("u1");
    const unsubscribe = startCachePersistence();
    await queryClient.fetchQuery(HEADERS_KEY, async () => [
      new MailHeaderData({ id: "m1", subject: "hi" }),
    ]);
    await flush();
    const all = await idbGetAllQueries();
    expect(all).toHaveLength(1);
    expect(all[0].key).toBe(HEADERS_KEY);
    expect(all[0].userId).toBe("u1");
    unsubscribe();
  });

  it("does not persist queries outside the catalog", async () => {
    setCacheUser("u1");
    const unsubscribe = startCachePersistence();
    await queryClient.fetchQuery("/api/mails/search/me@hoie.kim", async () => []);
    await flush();
    expect(await idbGetAllQueries()).toHaveLength(0);
    unsubscribe();
  });

  it("does not persist while logged out", async () => {
    setCacheUser(undefined);
    const unsubscribe = startCachePersistence();
    await queryClient.fetchQuery(HEADERS_KEY, async () => [
      new MailHeaderData({ id: "m1" }),
    ]);
    await flush();
    expect(await idbGetAllQueries()).toHaveLength(0);
    unsubscribe();
  });

  it("re-persists a seed at its original fetch time, so an over-age entry still expires", async () => {
    // Bootstrap order: startCachePersistence() runs before login, so the
    // hydrate-time setQueryData fires this subscription. Stamping `now` here
    // would re-date the seed on every login and re-arm its maxAge forever.
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1", subject: "hi" }],
      userId: "u1",
      lastFetchedAt: sixDaysAgo,
    });
    setCacheUser("u1");
    const unsubscribe = startCachePersistence();
    await hydrateQueryCache("u1");
    await flush();
    const [stored] = await idbGetAllQueries();
    expect(stored.lastFetchedAt).toBe(sixDaysAgo);
    unsubscribe();
  });

  it("carries the fetch time through an optimistic write, so a local edit is not a refresh", async () => {
    setCacheUser("u1");
    const unsubscribe = startCachePersistence();
    await queryClient.fetchQuery(HEADERS_KEY, async () => [
      new MailHeaderData({ id: "m1", subject: "hi", read: false }),
    ]);
    await flush();
    const fetchedAt = (await idbGetAllQueries())[0].lastFetchedAt;

    await new Promise((r) => setTimeout(r, 20));
    new QueryCache<MailHeaderData[]>(HEADERS_KEY).set((old) =>
      old?.map((m) => new MailHeaderData({ ...m, read: true }))
    );
    await flush();

    const [stored] = await idbGetAllQueries();
    expect((stored.payload as MailHeaderData[])[0].read).toBe(true);
    expect(stored.lastFetchedAt).toBe(fetchedAt);
    unsubscribe();
  });
});

describe("clearCachedQueries", () => {
  it("empties the store", async () => {
    await idbPutQuery({
      key: HEADERS_KEY,
      payload: [{ id: "m1" }],
      userId: "u1",
      lastFetchedAt: Date.now(),
    });
    await clearCachedQueries();
    expect(await idbGetAllQueries()).toHaveLength(0);
  });
});
