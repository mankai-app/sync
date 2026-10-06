import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { SyncError, type Mutation } from "../src/protocol";
import { createStore } from "../src/store";

const secret = "test-secret-with-at-least-thirty-two-characters";
const datetime = (seconds: number) => Date.UTC(2026, 9, 5, 4, 0, seconds);
const progress = (
  operationId: string,
  seconds: number,
  mangaId = "manga-1",
): Extract<Mutation, { type: "progress"; action: "upsert" }> => ({
  operationId,
  type: "progress",
  action: "upsert",
  datetime: datetime(seconds),
  key: { sourceId: "source-1", mangaId },
  payload: { chapterId: "chapter-1", chapterTitle: null, page: seconds },
});
const clear = (operationId: string, seconds: number): Mutation => ({
  operationId,
  type: "progress",
  action: "clear",
  datetime: datetime(seconds),
});
const plugin = (
  operationId: string,
  seconds: number,
): Extract<Mutation, { type: "plugin"; action: "upsert" }> => ({
  operationId,
  type: "plugin",
  action: "upsert",
  datetime: datetime(seconds),
  key: { sourceId: "source-1" },
  payload: { url: "https://example.com/plugin?token=portable", type: "js" },
});

describe("sync protocol", () => {
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    store = createStore(":memory:", secret);
  });
  afterEach(() => {
    store.close();
  });
  const pull = (
    mutations: unknown[] = [],
    cursor: string | null = null,
    limit = 100,
    account = "reader",
  ) => store.sync(account, { cursor, limit, mutations }, 100);

  test.each(["plugin", "browsableplugin"] as const)(
    "%s preserves string payload types through conflicts, deletes, and restores",
    (type) => {
      const original = { ...plugin("original", 1), type };
      const updated = {
        ...plugin("updated", 2),
        type,
        payload: { url: "https://example.com/updated", type: "custom" },
      };
      const batch = pull([original, updated, original]);
      expect(batch.results.map((result) => result.status)).toEqual([
        "applied",
        "applied",
        "ignored",
      ]);
      expect(batch.changes).toMatchObject([
        { type, action: "upsert", payload: updated.payload, revision: "2" },
      ]);
      expect(pull([original]).results[0]?.current).toMatchObject({
        type,
        payload: updated.payload,
        revision: "2",
      });
      const deletion = {
        operationId: "delete",
        type,
        action: "delete",
        datetime: updated.datetime,
        key: updated.key,
      };
      const deleted = pull([deletion, updated, deletion]);
      expect(deleted.results.map((result) => result.status)).toEqual([
        "applied",
        "ignored",
        "ignored",
      ]);
      expect(deleted.changes).toMatchObject([
        { type, action: "delete", revision: "3" },
      ]);
      expect(deleted.changes[0]).not.toHaveProperty("payload");
      expect(pull([updated]).results[0]?.current?.action).toBe("delete");
      expect(
        pull([{ ...updated, datetime: datetime(3) }]).changes,
      ).toMatchObject([
        { type, action: "upsert", payload: updated.payload, revision: "4" },
      ]);
      expect(pull([], null, 100, "other").changes).toEqual([]);
    },
  );

  test.each(["plugin", "browsableplugin"] as const)(
    "%s requires a string payload type and the same source key and actions",
    (type) => {
      const item = { ...plugin("invalid", 1), type };
      const invalid = [
        { ...item, payload: { url: item.payload.url } },
        ...[null, 1, true, {}].map((value) => ({
          ...item,
          payload: { ...item.payload, type: value },
        })),
        { ...item, payload: { ...item.payload, url: "invalid" } },
        { ...item, key: { ...item.key, mangaId: "extra" } },
        { ...item, action: "clear" },
      ];
      expect(pull(invalid).results.map((result) => result.status)).toEqual(
        invalid.map(() => "invalid"),
      );
      expect(pull().changes).toEqual([]);
      expect(
        pull([{ ...item, payload: { ...item.payload, type: "" } }]).results[0]
          ?.status,
      ).toBe("applied");
    },
  );

  test("plugin kinds with the same source ID stay independent across global pages", () => {
    const page1 = pull(
      [
        plugin("plugin", 1),
        {
          ...plugin("browsable", 1),
          type: "browsableplugin",
          payload: {
            url: "https://example.com/browsable",
            type: "custom",
          },
        },
        progress("progress", 1),
      ],
      null,
      1,
    );
    expect(page1.changes).toMatchObject([{ type: "plugin", revision: "1" }]);
    expect(page1.hasMore).toBe(true);
    const page2 = pull([], page1.nextCursor, 1);
    expect(page2.changes).toMatchObject([
      { type: "browsableplugin", revision: "2", payload: { type: "custom" } },
    ]);
    expect(page2.hasMore).toBe(true);
    const page3 = pull([], page2.nextCursor, 1);
    expect(page3.changes).toMatchObject([{ type: "progress", revision: "3" }]);
    expect(page3.hasMore).toBe(false);
    const removed = pull([
      {
        operationId: "remove-browsable",
        type: "browsableplugin",
        action: "delete",
        key: { sourceId: "source-1" },
        datetime: datetime(2),
      },
    ]);
    expect(
      removed.changes.map((change) => [change.type, change.action]),
    ).toEqual([
      ["plugin", "upsert"],
      ["progress", "upsert"],
      ["browsableplugin", "delete"],
    ]);
  });

  test("upgrades existing plugin rows to js and persists the mirrored browsable schema", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "mankai-sync-plugin-upgrade-"),
    );
    const filename = join(directory, "sync.sqlite");
    const oldMigrations = join(directory, "drizzle");
    cpSync(
      join(import.meta.dir, "../drizzle/20261005081758_initial"),
      join(oldMigrations, "20261005081758_initial"),
      { recursive: true },
    );
    const connection = new Database(filename, { create: true });
    let upgraded: ReturnType<typeof createStore> | undefined;
    try {
      migrate(drizzle({ client: connection }), {
        migrationsFolder: oldMigrations,
      });
      connection
        .query("INSERT INTO accounts (account, revision) VALUES (?, ?)")
        .run("reader", 2);
      const insert = connection.query(
        "INSERT INTO plugins (account, source_id, revision, datetime, deleted, url) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "reader",
        "source-1",
        1,
        datetime(1),
        0,
        "https://example.com/legacy",
      );
      insert.run("reader", "deleted", 2, datetime(2), 1, null);
      upgraded = createStore(filename, secret);
      expect(
        connection
          .query("SELECT source_id, type FROM plugins ORDER BY source_id")
          .all(),
      ).toEqual([
        { source_id: "deleted", type: "js" },
        { source_id: "source-1", type: "js" },
      ]);
      const original = upgraded.sync(
        "reader",
        { cursor: null, mutations: [] },
        100,
      );
      expect(original.changes).toMatchObject([
        {
          type: "plugin",
          action: "upsert",
          payload: { url: "https://example.com/legacy", type: "js" },
          revision: "1",
        },
        { type: "plugin", action: "delete", revision: "2" },
      ]);
      const pluginColumns = connection
        .query("PRAGMA table_info(plugins)")
        .all() as {
        name: string;
        dflt_value: string | null;
      }[];
      expect(
        connection.query("PRAGMA table_info(browsableplugins)").all(),
      ).toEqual(pluginColumns);
      expect(
        pluginColumns.find((column) => column.name === "type")?.dflt_value,
      ).toBeNull();
      const inserted = upgraded.sync(
        "reader",
        {
          cursor: original.nextCursor,
          mutations: [
            {
              ...plugin("browsable", 3),
              type: "browsableplugin",
              payload: { url: "https://example.com/browsable", type: "custom" },
            },
          ],
        },
        100,
      );
      expect(inserted.results[0]?.status).toBe("applied");
      upgraded.close();
      upgraded = createStore(filename, secret);
      expect(
        upgraded.sync(
          "reader",
          { cursor: original.nextCursor, mutations: [] },
          100,
        ).changes,
      ).toEqual(inserted.changes);
      expect(
        connection
          .query("SELECT count(*) AS count FROM __drizzle_migrations")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      upgraded?.close();
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("newer wins, equal deletes win, tombstones survive and newer upserts restore", () => {
    expect(pull([progress("new", 10)]).results[0]?.status).toBe("applied");
    const ignored = pull([progress("old", 5), progress("equal", 10)]);
    expect(ignored.results.map((result) => result.status)).toEqual([
      "ignored",
      "ignored",
    ]);
    expect(ignored.results[0]?.current?.datetime).toBe(datetime(10));
    expect(ignored.results[0]?.current).not.toHaveProperty("operationId");
    const deletion: Mutation = {
      operationId: "delete",
      type: "progress",
      action: "delete",
      key: { sourceId: "source-1", mangaId: "manga-1" },
      datetime: datetime(10),
    };
    expect(pull([deletion]).changes[0]?.action).toBe("delete");
    expect(pull([deletion]).results[0]?.status).toBe("ignored");
    expect(pull([progress("same-time", 10)]).results[0]?.current?.action).toBe(
      "delete",
    );
    expect(pull([progress("restore", 11)]).changes[0]).toMatchObject({
      action: "upsert",
      datetime: datetime(11),
      revision: "3",
    });
  });

  test("duplicates are ignored without revisions and operation IDs never control merging", () => {
    const original = pull([progress("retry", 10), progress("retry", 10)]);
    expect(original.results.map((result) => result.status)).toEqual([
      "applied",
      "ignored",
    ]);
    expect(original.results.map((result) => result.revision)).toEqual([
      "1",
      "1",
    ]);
    expect(original.changes).toHaveLength(1);
    const retry = pull([progress("different-id", 10)], original.nextCursor);
    expect(retry.results[0]).toMatchObject({
      status: "ignored",
      revision: "1",
    });
    expect(retry.changes).toEqual([]);
    expect(retry.nextCursor).toBe(original.nextCursor);
    const newer = pull([progress("retry", 20)], original.nextCursor);
    expect(newer.results[0]).toEqual({
      operationId: "retry",
      status: "applied",
      revision: "2",
    });
    expect(pull([progress("retry", 10)]).results[0]?.current?.datetime).toBe(
      datetime(20),
    );
    expect(
      pull([{ ...progress("invalid", 30), payload: { page: -1 } }]).results[0]
        ?.status,
    ).toBe("invalid");
    expect(pull([progress("invalid", 30)]).results[0]).toMatchObject({
      status: "applied",
      revision: "3",
    });
    expect(
      pull([null, { type: "progress" }]).results.map(
        (result) => result.operationId,
      ),
    ).toEqual([null, null]);
  });

  test("clear removes old progress entries, rejects late uploads, and preserves newer progress", () => {
    pull([
      plugin("plugin", 1),
      progress("old", 5),
      progress("future", 20, "manga-2"),
    ]);
    const applied = pull([clear("clear", 10)]);
    expect(applied.results[0]?.status).toBe("applied");
    expect(
      applied.changes.map((change) => [
        change.type,
        change.action,
        change.revision,
      ]),
    ).toEqual([
      ["plugin", "upsert", "1"],
      ["progress", "upsert", "3"],
      ["progress", "clear", "4"],
    ]);
    const rejected = pull([
      progress("late-old", 5, "manga-3"),
      progress("equal", 10),
      clear("stale-clear", 9),
      clear("clear", 10),
    ]);
    expect(rejected.results.map((result) => result.status)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
    ]);
    expect(rejected.results[0]?.current).toEqual({
      type: "progress",
      action: "delete",
      key: { sourceId: "source-1", mangaId: "manga-3" },
      datetime: datetime(10),
      revision: "4",
    });
    expect(pull([progress("restore", 11)]).results[0]).toMatchObject({
      status: "applied",
      revision: "5",
    });
    pull([clear("new-clear", 30)]);
    expect(pull([clear("clear", 10)]).results[0]).toEqual({
      operationId: "clear",
      status: "ignored",
      revision: "6",
    });
    expect(
      pull().changes.map((change) => [
        change.type,
        change.action,
        change.revision,
      ]),
    ).toEqual([
      ["plugin", "upsert", "1"],
      ["progress", "clear", "6"],
    ]);
  });

  test("clear applies to empty history; plugin deletion retains library items and progress", () => {
    expect(pull([clear("empty", 1)]).results[0]?.status).toBe("applied");
    pull([
      plugin("plugin", 2),
      progress("progress", 2),
      {
        operationId: "library",
        type: "library",
        action: "upsert",
        datetime: datetime(2),
        key: { sourceId: "source-1", mangaId: "manga-1" },
        payload: { updates: true, latestChapter: { id: "chapter-2" } },
      },
    ]);
    const response = pull([
      {
        operationId: "remove-plugin",
        type: "plugin",
        action: "delete",
        key: { sourceId: "source-1" },
        datetime: datetime(3),
      },
    ]);
    expect(
      response.changes.map((change) => [
        change.type,
        change.action,
        change.revision,
      ]),
    ).toEqual([
      ["progress", "clear", "1"],
      ["progress", "upsert", "3"],
      ["library", "upsert", "4"],
      ["plugin", "delete", "5"],
    ]);
  });

  test("live pages coalesce undelivered edits and revisit delivered rows after updates", () => {
    const page1 = pull(
      [
        progress("one", 1, "one"),
        progress("two", 2, "two"),
        progress("three", 3, "three"),
      ],
      null,
      1,
    );
    expect(page1.hasMore).toBe(true);
    pull([progress("two-new", 20, "two")]);
    const page2 = pull([], page1.nextCursor, 1);
    expect(page2.changes[0]).toMatchObject({
      key: { mangaId: "three" },
      revision: "3",
    });
    const page3 = pull([], page2.nextCursor, 1);
    expect(page3.changes[0]).toMatchObject({
      key: { mangaId: "two" },
      payload: { page: 20 },
      revision: "4",
    });
    expect(page3.hasMore).toBe(false);
    pull([progress("one-new", 30, "one")]);
    expect(pull([], page3.nextCursor).changes[0]).toMatchObject({
      key: { mangaId: "one" },
      revision: "5",
    });
    expect(pull().changes).toHaveLength(3);
  });

  test("a clear between pages removes obsolete rows and delivers the retained marker", () => {
    const page1 = pull(
      [
        progress("one", 1, "one"),
        progress("two", 2, "two"),
        progress("three", 3, "three"),
      ],
      null,
      1,
    );
    pull([progress("two-new", 20, "two"), clear("clear", 10)]);
    const page2 = pull([], page1.nextCursor, 1);
    expect(page2.changes[0]).toMatchObject({
      key: { mangaId: "two" },
      datetime: datetime(20),
      revision: "4",
    });
    const page3 = pull([], page2.nextCursor, 1);
    expect(page3.changes[0]).toEqual({
      type: "progress",
      action: "clear",
      datetime: datetime(10),
      revision: "5",
    });
    expect(page3.hasMore).toBe(false);
    expect(pull([], page3.nextCursor).changes).toEqual([]);
    expect(pull().changes).toHaveLength(2);
  });

  test("later writes join live pagination and upload results never skip pulled rows", () => {
    const initial = pull();
    const page1 = pull(
      [
        progress("one", 1, "one"),
        progress("two", 2, "two"),
        progress("three", 3, "three"),
      ],
      initial.nextCursor,
      1,
    );
    expect(page1.results.map((result) => result.revision)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(page1.changes[0]?.revision).toBe("1");
    pull([progress("four", 4, "four")]);
    const page2 = pull([], page1.nextCursor, 1);
    const page3 = pull([], page2.nextCursor, 1);
    expect(page2.changes[0]?.revision).toBe("2");
    expect(page3.changes[0]?.revision).toBe("3");
    expect(page3.hasMore).toBe(true);
    const page4 = pull([], page3.nextCursor, 1);
    expect(page4.changes[0]?.revision).toBe("4");
    expect(page4.hasMore).toBe(false);
    expect(pull([], page4.nextCursor).changes).toEqual([]);
  });

  test("bulk reads stay bounded for a 1000-mutation batch across all entity types", () => {
    const queries = spyOn(Database.prototype, "query");
    const readCount = () =>
      queries.mock.calls.filter(([query]) =>
        query.trimStart().toLowerCase().startsWith("select "),
      ).length;
    const mutations = Array.from({ length: 1000 }, (_, index): Mutation => {
      const key = { sourceId: `source-${index}`, mangaId: `manga-${index}` };

      if (index % 3 === 0)
        return {
          ...plugin(`plugin-${index}`, index),
          key: { sourceId: key.sourceId },
        };
      if (index % 3 === 1)
        return {
          operationId: `library-${index}`,
          type: "library",
          action: "upsert",
          datetime: datetime(index),
          key,
          payload: {
            updates: true,
            latestChapter: { id: `chapter-${index}`, locked: false },
          },
        };

      return { ...progress(`progress-${index}`, index), key };
    });

    try {
      expect(pull().changes).toEqual([]);
      expect(readCount()).toBe(1);
      queries.mockClear();

      const applied = pull(mutations);
      expect(
        applied.results.every((result) => result.status === "applied"),
      ).toBe(true);
      expect(applied.changes).toHaveLength(100);
      expect(applied.hasMore).toBe(true);
      expect(readCount()).toBe(2);
      queries.mockClear();

      const ignored = pull(mutations, applied.nextCursor);
      expect(
        ignored.results.every((result) => result.status === "ignored"),
      ).toBe(true);
      expect(ignored.results.map((result) => result.revision)).toEqual(
        applied.results.map((result) => result.revision),
      );
      expect(ignored.changes.map((change) => change.revision)).toEqual(
        Array.from({ length: 100 }, (_, index) => String(index + 101)),
      );
      expect(readCount()).toBe(2);
      queries.mockClear();

      pull([], ignored.nextCursor);
      expect(readCount()).toBe(2);
    } finally {
      queries.mockRestore();
    }
  });

  test("batched state tracks updates and clears in request order", () => {
    pull([progress("old", 5, "shared"), progress("future", 50, "future")]);

    const response = pull([
      progress("update", 20, "shared"),
      clear("first-clear", 25),
      progress("late", 22, "shared"),
      progress("restore", 26, "shared"),
      progress("duplicate", 26, "shared"),
      clear("second-clear", 30),
      progress("last-restore", 31, "shared"),
    ]);

    expect(response.results.map((result) => result.status)).toEqual([
      "applied",
      "applied",
      "ignored",
      "applied",
      "ignored",
      "applied",
      "applied",
    ]);
    expect(response.results[2]?.current).toMatchObject({
      action: "delete",
      datetime: datetime(25),
      revision: "4",
    });
    expect(response.results[4]?.current).toMatchObject({
      action: "upsert",
      datetime: datetime(26),
      payload: { page: 26 },
      revision: "5",
    });
    expect(response.changes).toEqual([
      {
        type: "progress",
        action: "upsert",
        revision: "2",
        datetime: datetime(50),
        key: { sourceId: "source-1", mangaId: "future" },
        payload: { chapterId: "chapter-1", chapterTitle: null, page: 50 },
      },
      {
        type: "progress",
        action: "clear",
        revision: "6",
        datetime: datetime(30),
      },
      {
        type: "progress",
        action: "upsert",
        revision: "7",
        datetime: datetime(31),
        key: { sourceId: "source-1", mangaId: "shared" },
        payload: { chapterId: "chapter-1", chapterTitle: null, page: 31 },
      },
    ]);
  });

  test("account isolation includes cursors; cursor rejection precedes writes", () => {
    const first = pull([progress("same-id", 10)]);
    expect(pull([], null, 100, "other").changes).toEqual([]);
    expect(
      pull([progress("same-id", 20)], null, 100, "other").results[0]?.status,
    ).toBe("applied");
    expect(() =>
      pull([progress("must-not-write", 30)], first.nextCursor, 100, "other"),
    ).toThrow(SyncError);
    expect(() =>
      pull([progress("must-not-write", 30)], first.nextCursor + "tamper"),
    ).toThrow(SyncError);
    expect(pull().changes[0]?.datetime).toBe(datetime(10));
    expect(pull([], null, 100, "other").changes[0]?.datetime).toBe(
      datetime(20),
    );
    expect(pull([progress("must-not-write", 30)]).results[0]?.status).toBe(
      "applied",
    );
  });

  test("invalid payloads, types, actions and datetimes never enter current state", () => {
    const response = pull([
      {
        ...progress("negative", 1),
        payload: { chapterId: "x", chapterTitle: null, page: -1 },
      },
      { ...progress("fractional-date", 1), datetime: datetime(1) + 0.5 },
      { ...progress("bad-type", 1), type: "unknown" },
      { ...clear("bad-clear", 1), key: { sourceId: "x", mangaId: "y" } },
      { ...plugin("bad-url", 1), payload: { url: "invalid" } },
      progress("valid", 2),
    ]);
    expect(response.results.map((result) => result.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "applied",
    ]);
    expect(response.changes).toHaveLength(1);
    expect(response.changes[0]).toMatchObject({
      datetime: datetime(2),
      revision: "1",
    });
  });

  test("datetime requires safe integer milliseconds and preserves numeric boundaries", () => {
    const invalid = [
      "2026-10-05T04:00:00.000Z",
      String(datetime(1)),
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      null,
    ];
    const rejected = pull(
      invalid.map((value) => ({
        ...progress("invalid-date", 0),
        datetime: value,
      })),
    );

    expect(rejected.results.map((result) => result.status)).toEqual(
      Array(invalid.length).fill("invalid"),
    );
    expect(rejected.changes).toEqual([]);

    const epoch = pull([{ ...progress("epoch", 0), datetime: 0 }]);
    expect(epoch.changes[0]?.datetime).toBe(0);
    const next = pull(
      [{ ...progress("one-millisecond", 1), datetime: 1 }],
      epoch.nextCursor,
    );
    expect(next.results[0]?.status).toBe("applied");
    expect(next.changes[0]?.datetime).toBe(1);

    const maximum = pull(
      [{ ...progress("maximum", 2), datetime: Number.MAX_SAFE_INTEGER }],
      next.nextCursor,
    );
    expect(maximum.changes[0]?.datetime).toBe(Number.MAX_SAFE_INTEGER);
    const ignored = pull(
      [{ ...progress("older", 1), datetime: Number.MAX_SAFE_INTEGER - 1 }],
      maximum.nextCursor,
    );
    expect(ignored.results[0]?.current?.datetime).toBe(Number.MAX_SAFE_INTEGER);
    expect(ignored.changes).toEqual([]);

    const cleared = pull([
      { ...clear("maximum-clear", 3), datetime: Number.MAX_SAFE_INTEGER },
    ]);
    expect(cleared.changes[0]).toMatchObject({
      action: "clear",
      datetime: Number.MAX_SAFE_INTEGER,
    });
    expect(
      pull([{ ...progress("late", 2), datetime: Number.MAX_SAFE_INTEGER }])
        .results[0]?.status,
    ).toBe("ignored");
  });

  test("oversized payload strings are rejected without writing or disrupting valid mutations", () => {
    const result = pull([
      {
        ...plugin("oversized-plugin", 1),
        payload: { ...plugin("", 1).payload, type: "x".repeat(65) },
      },
      {
        ...plugin("oversized-browsable", 1),
        type: "browsableplugin",
        payload: {
          url: "https://example.com/browsable",
          type: "x".repeat(65),
        },
      },
      {
        ...progress("oversized-title", 1),
        payload: {
          ...progress("", 1).payload,
          chapterTitle: "x".repeat(1025),
        },
      },
      {
        operationId: "oversized-latest-title",
        type: "library",
        action: "upsert",
        datetime: datetime(1),
        key: { sourceId: "source-1", mangaId: "manga-1" },
        payload: {
          updates: true,
          latestChapter: { id: "chapter-1", title: "x".repeat(1025) },
        },
      },
      {
        ...progress("valid-title", 2),
        payload: {
          ...progress("", 2).payload,
          chapterTitle: "x".repeat(1024),
        },
      },
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "applied",
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      type: "progress",
      revision: "1",
      payload: { chapterTitle: "x".repeat(1024) },
    });
    expect(pull().changes).toEqual(result.changes);
  });

  test("latestChapter accepts optional fields, round-trips JSON, and rejects invalid shapes", () => {
    const libraryItem = (latestChapter: unknown, seconds = 1) => ({
      operationId: "library",
      type: "library",
      action: "upsert",
      datetime: datetime(seconds),
      key: { sourceId: "source-1", mangaId: "manga-1" },
      payload: { updates: true, latestChapter },
    });
    const invalid = pull(
      [
        "chapter-1",
        {},
        { id: 42 },
        { id: "chapter-1", title: null },
        { id: "chapter-1", locked: "false" },
      ].map((chapter) => libraryItem(chapter)),
    );
    expect(invalid.results.map((result) => result.status)).toEqual(
      Array(5).fill("invalid"),
    );
    expect(invalid.changes).toEqual([]);
    const chapter = { id: "chapter-1", title: 'Chapter "one"', locked: false };
    const full = pull([libraryItem(chapter)]);
    expect(full.results[0]?.status).toBe("applied");
    expect(full.changes[0]).toMatchObject({
      payload: { updates: true, latestChapter: chapter },
    });
    expect(
      pull([libraryItem({ id: "older" }, 0)]).results[0]?.current,
    ).toMatchObject({ payload: { latestChapter: chapter } });
    const minimal = pull(
      [libraryItem({ id: "chapter-2" }, 2)],
      full.nextCursor,
    );
    expect(minimal.changes[0]).toMatchObject({
      payload: { latestChapter: { id: "chapter-2" } },
    });
    const deletion = pull(
      [
        {
          operationId: "delete-library",
          type: "library",
          action: "delete",
          datetime: datetime(2),
          key: { sourceId: "source-1", mangaId: "manga-1" },
        },
      ],
      minimal.nextCursor,
    );
    expect(deletion.changes[0]?.action).toBe("delete");
    expect(deletion.changes[0]).not.toHaveProperty("payload");
    const restored = pull(
      [libraryItem({ id: "chapter-3", locked: true }, 3)],
      deletion.nextCursor,
    );
    expect(restored.changes[0]).toMatchObject({
      payload: { latestChapter: { id: "chapter-3", locked: true } },
    });
  });

  test("a row write failure rolls back the entire batch and account revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-atomic-"));
    const filename = join(directory, "sync.sqlite");
    const diskStore = createStore(filename, secret);
    const connection = new Database(filename);
    try {
      connection.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON progress
        WHEN NEW.manga_id = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      expect(() =>
        diskStore.sync(
          "reader",
          {
            cursor: null,
            mutations: [progress("first", 1), progress("fail", 2, "fail")],
          },
          100,
        ),
      ).toThrow();
      expect(
        diskStore.sync("reader", { cursor: null, mutations: [] }, 100).changes,
      ).toEqual([]);
      expect(
        connection.query("SELECT count(*) AS count FROM accounts").get(),
      ).toEqual({ count: 0 });
      connection.exec("DROP TRIGGER fail_progress");
      expect(
        diskStore.sync(
          "reader",
          { cursor: null, mutations: [progress("first", 1)] },
          100,
        ).results[0],
      ).toMatchObject({ status: "applied", revision: "1" });
    } finally {
      connection.close();
      diskStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("SQLite stores only current rows without receipts, changes, or operation IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-state-"));
    const filename = join(directory, "sync.sqlite");
    let diskStore = createStore(filename, secret);
    const connection = new Database(filename);
    const libraryItem = (seconds: number): Mutation => ({
      operationId: "library",
      type: "library",
      action: "upsert",
      datetime: datetime(seconds),
      key: { sourceId: "source-1", mangaId: "manga-1" },
      payload: {
        updates: seconds === 2,
        latestChapter: {
          id: `chapter-${seconds}`,
          title: `Chapter ${seconds}`,
          locked: false,
        },
      },
    });
    try {
      const response = diskStore.sync(
        "reader",
        {
          cursor: null,
          mutations: [
            plugin("plugin", 1),
            {
              ...plugin("plugin", 2),
              payload: { url: "https://example.com/latest", type: "js" },
            },
            libraryItem(1),
            libraryItem(2),
            progress("progress", 1),
            progress("progress", 2),
          ],
        },
        100,
      );
      expect(response.changes.map((change) => change.revision)).toEqual([
        "2",
        "4",
        "6",
      ]);
      for (const change of response.changes)
        expect(change).not.toHaveProperty("operationId");
      for (const table of ["accounts", "plugins", "library", "progress"]) {
        expect(
          connection.query(`SELECT count(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 1 });
        const columns = connection
          .query(`PRAGMA table_info(${table})`)
          .all() as { name: string; type: string }[];
        expect(
          columns.some((column) => column.name.includes("operation")),
        ).toBe(false);
        expect(
          columns.find((column) => column.name.endsWith("datetime"))?.type,
        ).toBe("INTEGER");

        if (table !== "accounts") {
          expect(
            connection
              .query(
                `SELECT datetime, typeof(datetime) AS storage_type FROM ${table}`,
              )
              .get(),
          ).toEqual({ datetime: datetime(2), storage_type: "integer" });
        }
      }
      expect(
        connection
          .query(
            "SELECT name FROM sqlite_master WHERE name IN ('receipts', 'changes')",
          )
          .all(),
      ).toEqual([]);
      expect(connection.query("SELECT url FROM plugins").get()).toEqual({
        url: "https://example.com/latest",
      });
      expect(
        connection.query("SELECT updates, latest_chapter FROM library").get(),
      ).toEqual({
        updates: 1,
        latest_chapter: JSON.stringify({
          id: "chapter-2",
          title: "Chapter 2",
          locked: false,
        }),
      });
      diskStore.close();
      diskStore = createStore(filename, secret);
      const restoredLibrary = diskStore
        .sync("reader", { cursor: null, mutations: [] }, 100)
        .changes.find((change) => change.type === "library");
      expect(restoredLibrary).toMatchObject({
        payload: {
          updates: true,
          latestChapter: { id: "chapter-2", title: "Chapter 2", locked: false },
        },
      });
      expect(connection.query("SELECT page FROM progress").get()).toEqual({
        page: 2,
      });
      const deletion: Mutation = {
        operationId: "progress",
        type: "progress",
        action: "delete",
        datetime: datetime(2),
        key: { sourceId: "source-1", mangaId: "manga-1" },
      };
      const deleted = diskStore.sync(
        "reader",
        { cursor: response.nextCursor, mutations: [deletion, deletion] },
        100,
      );
      expect(deleted.results.map((result) => result.status)).toEqual([
        "applied",
        "ignored",
      ]);
      expect(deleted.changes).toHaveLength(1);
      expect(
        connection
          .query(
            "SELECT deleted, chapter_id, chapter_title, page, revision FROM progress",
          )
          .get(),
      ).toEqual({
        deleted: 1,
        chapter_id: null,
        chapter_title: null,
        page: null,
        revision: 7,
      });
    } finally {
      connection.close();
      diskStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("current state and signed cursors persist; a retry after restart is ignored", () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-test-"));
    let diskStore = createStore(join(directory, "sync.sqlite"), secret);
    try {
      const original = diskStore.sync(
        "reader",
        { cursor: null, mutations: [progress("persisted", 10)] },
        100,
      );
      diskStore.close();
      diskStore = createStore(join(directory, "sync.sqlite"), secret);
      const retry = diskStore.sync(
        "reader",
        { cursor: original.nextCursor, mutations: [progress("persisted", 10)] },
        100,
      );
      expect(retry.results[0]).toMatchObject({
        operationId: "persisted",
        status: "ignored",
        revision: "1",
        current: { datetime: datetime(10) },
      });
      expect(retry.changes).toEqual([]);
      expect(retry.nextCursor).toBe(original.nextCursor);
      expect(
        diskStore.sync("reader", { cursor: null, mutations: [] }, 100)
          .changes[0],
      ).toMatchObject({ datetime: datetime(10), revision: "1" });
      expect(
        diskStore.sync(
          "reader",
          {
            cursor: original.nextCursor,
            mutations: [progress("persisted", 11)],
          },
          100,
        ).results[0]?.revision,
      ).toBe("2");
    } finally {
      diskStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("HTTP authentication and request validation", () => {
  let app: ReturnType<typeof createApp>;
  let config: Config;
  beforeEach(async () => {
    config = await loadConfig("config.example.json");
    config.database = ":memory:";
    config.jwt.secret = secret;
    config.jwt.expiresInSeconds = 60;
    config.jwt.refreshExpiresInSeconds = 120;
    app = createApp(config).listen({ hostname: "127.0.0.1", port: 0 });
  });
  afterEach(async () => {
    await app.stop();
  });
  const post = (endpoint: string, body: unknown, token?: string) =>
    fetch(new URL(endpoint, app.server!.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const login = async () => {
    const response = await post("/auth/login", {
      username: "reader",
      password: "change-me",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refreshToken: string };
    expect(body).toEqual({ refreshToken: expect.any(String) });
    return body.refreshToken;
  };
  const refresh = async (refreshToken: string) => {
    const response = await post("/auth/refresh", { refreshToken });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string };
    expect(body).toEqual({ accessToken: expect.any(String) });
    return body.accessToken;
  };
  const authenticate = async () => refresh(await login());

  test("sync accepts both plugin kinds and returns their string payload types", async () => {
    const token = await authenticate();
    const mutations = [
      plugin("plugin", 1),
      {
        ...plugin("browsable", 1),
        type: "browsableplugin",
        payload: {
          url: "https://example.com/browsable",
          type: "custom",
        },
      },
      {
        ...plugin("missing-type", 2),
        payload: { url: "https://example.com/invalid" },
      },
    ];
    const uploaded = await post("/sync", { cursor: null, mutations }, token);
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json();
    expect(
      body.results.map((result: { status: string }) => result.status),
    ).toEqual(["applied", "applied", "invalid"]);
    expect(body.changes).toMatchObject([
      { type: "plugin", payload: { type: "js" } },
      { type: "browsableplugin", payload: { type: "custom" } },
    ]);
    const pulled = await post("/sync", { cursor: null, mutations: [] }, token);
    expect(pulled.status).toBe(200);
    expect((await pulled.json()).changes).toEqual(body.changes);
    const removed = await post(
      "/sync",
      {
        cursor: body.nextCursor,
        mutations: [
          {
            operationId: "delete-browsable",
            type: "browsableplugin",
            action: "delete",
            datetime: datetime(2),
            key: { sourceId: "source-1" },
          },
        ],
      },
      token,
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).changes).toMatchObject([
      { type: "browsableplugin", action: "delete" },
    ]);
  });

  test("login issues a refresh JWT and refresh issues an access JWT with configured lifetimes", async () => {
    const before = Math.floor(Date.now() / 1000);
    const refreshToken = await login();
    const accessToken = await refresh(refreshToken);
    const after = Math.floor(Date.now() / 1000);
    for (const [token, audience, lifetime] of [
      [refreshToken, "refresh", config.jwt.refreshExpiresInSeconds!],
      [accessToken, "access", config.jwt.expiresInSeconds],
    ] as const) {
      const claims = await app.decorator.jwt.verify(token);
      expect(claims).toMatchObject({
        iss: "mankai-sync",
        sub: "reader",
        aud: audience,
      });
      if (!claims) throw new Error("Invalid issued token");
      expect(claims.exp).toBeGreaterThanOrEqual(before + lifetime);
      expect(claims.exp).toBeLessThanOrEqual(after + lifetime);
    }
    expect(
      (await post("/sync", { cursor: null, mutations: [] }, accessToken))
        .status,
    ).toBe(200);
  });

  test("refresh lifetime defaults to 30 days when omitted from existing configs", async () => {
    await app.stop();
    delete config.jwt.refreshExpiresInSeconds;
    app = createApp(config).listen({ hostname: "127.0.0.1", port: 0 });
    const before = Math.floor(Date.now() / 1000);
    const token = await login();
    const claims = await app.decorator.jwt.verify(token);
    if (!claims) throw new Error("Invalid issued token");
    expect(claims.exp).toBeGreaterThanOrEqual(before + 2592000);
    expect(claims.exp).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 2592000,
    );
    expect(await refresh(token)).toEqual(expect.any(String));
  });

  test("access and refresh tokens cannot be interchanged and the old auth route is removed", async () => {
    const refreshToken = await login();
    const accessToken = await refresh(refreshToken);
    expect(
      (await post("/sync", { cursor: null, mutations: [] }, refreshToken))
        .status,
    ).toBe(401);
    expect(
      (await post("/auth/refresh", { refreshToken: accessToken })).status,
    ).toBe(401);
    expect(
      (await post("/auth", { username: "reader", password: "change-me" }))
        .status,
    ).toBe(404);
  });

  test("returns 401 for wrong credentials and invalid, expired or incomplete JWTs", async () => {
    for (const username of ["reader", "unknown"]) {
      expect(
        (await post("/auth/login", { username, password: "wrong" })).status,
      ).toBe(401);
    }
    expect((await post("/sync", {})).status).toBe(401);

    for (const audience of ["access", "refresh"] as const) {
      const future = Math.floor(Date.now() / 1000) + 60;
      const valid = await app.decorator.jwt.sign({
        sub: "reader",
        aud: audience,
        exp: future,
      });
      const parts = valid.split(".");
      parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
      const invalidTokens = [
        "",
        "invalid",
        parts.join("."),
        await app.decorator.jwt.sign({
          sub: "reader",
          aud: audience,
          exp: future - 120,
        }),
        await app.decorator.jwt.sign({ sub: "reader", aud: audience }),
        await app.decorator.jwt.sign({
          sub: "unknown",
          aud: audience,
          exp: future,
        }),
        await app.decorator.jwt.sign({ aud: audience, exp: future }),
        await app.decorator.jwt.sign({ sub: "reader", exp: future }),
        await app.decorator.jwt.sign({
          sub: "reader",
          aud: audience,
          exp: future,
          iss: "other-server",
        }),
        await app.decorator.jwt.sign({
          sub: "reader",
          aud: audience,
          exp: future,
          nbf: future,
        }),
      ];
      for (const token of invalidTokens) {
        const response =
          audience === "access"
            ? await post("/sync", { cursor: null, mutations: [] }, token)
            : await post("/auth/refresh", { refreshToken: token });
        expect(response.status).toBe(401);
      }
    }
  });

  test("a refresh token can renew access and retry the same sync mutations", async () => {
    const refreshToken = await login();
    const expired = await app.decorator.jwt.sign({
      sub: "reader",
      aud: "access",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const body = {
      cursor: null,
      mutations: [progress("retry-after-refresh", 1)],
    };
    expect((await post("/sync", body, expired)).status).toBe(401);
    const first = await post("/sync", body, await refresh(refreshToken));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      results: [{ operationId: "retry-after-refresh", status: "applied" }],
    });
    const retry = await post("/sync", body, await refresh(refreshToken));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      results: [{ operationId: "retry-after-refresh", status: "ignored" }],
    });
  });

  test("validates login and refresh request bodies", async () => {
    for (const body of [
      null,
      [],
      {},
      { username: "reader" },
      { username: 123, password: "bad" },
      { username: "reader", password: null },
      { username: "x".repeat(129), password: "change-me" },
      { username: "reader", password: "x".repeat(1025) },
    ]) {
      expect((await post("/auth/login", body)).status).toBe(400);
    }
    for (const body of [
      null,
      [],
      {},
      { refreshToken: 123 },
      { refreshToken: null },
      { refreshToken: "x".repeat(4097) },
    ]) {
      expect((await post("/auth/refresh", body)).status).toBe(400);
    }
  });

  test("validates the request envelope and returns 400 for cursors without accepting mutations", async () => {
    const token = await authenticate();
    for (const body of [
      { cursor: null, mutations: [], limit: 0 },
      { cursor: null, mutations: [], limit: config.sync.pageSize + 1 },
      { cursor: null, mutations: [], limit: 1.5 },
      { mutations: [] },
      {
        cursor: null,
        mutations: Array(config.sync.maxMutations + 1).fill(null),
      },
    ]) {
      expect((await post("/sync", body, token)).status).toBe(400);
    }
    expect(
      (
        await post(
          "/sync",
          { cursor: "bad", mutations: [progress("rejected", 1)] },
          token,
        )
      ).status,
    ).toBe(400);
    const response = await post(
      "/sync",
      { cursor: null, mutations: [] },
      token,
    );
    expect(((await response.json()) as { changes: unknown[] }).changes).toEqual(
      [],
    );
    expect(
      (await post("/auth/login", { username: 123, password: "bad" })).status,
    ).toBe(400);
  });
});

describe("user configuration and startup", () => {
  const passwordHash =
    "$argon2id$v=19$m=65536,t=2,p=1$KLYNrdOxXwO4ic7lhOvcSuwJpHKpHG/+i1ugBWqteQg$zhtKbDinu8CxhXEXOx7aWbffJYK4ccOOJRk/BXpRCjg";

  test("users must supply exactly one password format", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-config-"));
    const filename = join(directory, "config.json");
    const config = await loadConfig("config.example.json");
    try {
      for (const user of [
        { username: "reader" },
        { username: "reader", password: "change-me", passwordHash },
      ]) {
        await Bun.write(filename, JSON.stringify({ ...config, users: [user] }));
        await expect(loadConfig(filename)).rejects.toThrow("Invalid config");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("token lifetimes must be positive safe integers and refresh lifetime is optional", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-config-"));
    const filename = join(directory, "config.json");
    const config = await loadConfig("config.example.json");
    try {
      delete config.jwt.refreshExpiresInSeconds;
      await Bun.write(filename, JSON.stringify(config));
      expect(
        (await loadConfig(filename)).jwt.refreshExpiresInSeconds,
      ).toBeUndefined();
      for (const key of ["expiresInSeconds", "refreshExpiresInSeconds"]) {
        for (const value of [
          0,
          -1,
          1.5,
          "60",
          null,
          true,
          Number.MAX_SAFE_INTEGER + 1,
        ]) {
          await Bun.write(
            filename,
            JSON.stringify({
              ...config,
              jwt: { ...config.jwt, [key]: value },
            }),
          );
          await expect(loadConfig(filename)).rejects.toThrow("Invalid config");
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("startup migrations precede plaintext and hashed authentication and run once across restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mankai-sync-startup-"));
    const filename = join(directory, "config.json");
    const config = await loadConfig("config.example.json");
    config.database = join(directory, "sync.sqlite");
    config.users.push({ username: "hashed-reader", passwordHash });
    let app: ReturnType<typeof createApp> | undefined;
    try {
      await Bun.write(filename, JSON.stringify(config));
      const loaded = await loadConfig(filename);
      app = createApp(loaded).listen({ hostname: "127.0.0.1", port: 0 });
      const authenticate = (username: string, password: string) =>
        fetch(new URL("/auth/login", app!.server!.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
      const migrationCount = () => {
        const connection = new Database(config.database, { readonly: true });
        try {
          return connection
            .query("SELECT count(*) AS count FROM __drizzle_migrations")
            .get();
        } finally {
          connection.close();
        }
      };
      expect(migrationCount()).toEqual({ count: 3 });
      for (const username of ["reader", "hashed-reader"]) {
        const login = await authenticate(username, "change-me");
        expect(login.status).toBe(200);
        const refreshToken = ((await login.json()) as { refreshToken: string })
          .refreshToken;
        const refreshed = await fetch(
          new URL("/auth/refresh", app.server!.url),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          },
        );
        expect(refreshed.status).toBe(200);
        const accessToken = (
          (await refreshed.json()) as { accessToken: string }
        ).accessToken;
        expect(await app.decorator.jwt.verify(accessToken)).toMatchObject({
          sub: username,
          aud: "access",
        });
        expect((await authenticate(username, "wrong")).status).toBe(401);
      }
      await app.stop();
      app = createApp(loaded).listen({ hostname: "127.0.0.1", port: 0 });
      expect(migrationCount()).toEqual({ count: 3 });
      expect((await authenticate("reader", "change-me")).status).toBe(200);
    } finally {
      if (app) await app.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
