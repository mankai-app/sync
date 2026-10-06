import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeChapter,
  migrateV1,
  normalizeServerUrl,
  type ServerCredentials,
} from "../scripts/migrate-v1";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import type { Change, Mutation } from "../src/protocol";

const timestamp = Date.UTC(2026, 9, 5, 4);
const password = " migration-test-password ";
const record = (index: number) => ({
  mangaId: `manga-${index}`,
  pluginId: "source-1",
  datetime:
    index % 2 ? timestamp + index : new Date(timestamp + index).toISOString(),
  chapterId: `chapter-${index}`,
  chapterTitle: index % 2 ? `Chapter ${index}` : null,
  page: index,
});
const saved = (index: number) => ({
  mangaId: `saved-${index}`,
  pluginId: "source-1",
  datetime: new Date(timestamp).toISOString(),
  updates: true,
  latestChapter: String.raw`chapter\|id\\tail|Title \| with \\ slash|false`,
});

type FixtureOptions = {
  records?: unknown[];
  saveds?: unknown[];
  deleted?: unknown[];
  maxMutations?: number;
  sourcePrefix?: string;
  sourceExpires?: boolean;
  refreshExpires?: boolean;
  destinationExpires?: boolean;
  failAfter?: number;
  invalidResult?: boolean;
  badResponse?: boolean;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: FixtureOptions = {}) {
  const config: Config = {
    host: "127.0.0.1",
    port: 3000,
    database: ":memory:",
    jwt: {
      secret: "migration-test-secret-with-thirty-two-characters",
      expiresInSeconds: 60,
    },
    sync: { pageSize: 1, maxMutations: options.maxMutations ?? 100 },
    users: [{ username: "new-reader", password }],
  };
  const app = createApp(config).listen({ hostname: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await app.stop();
  });
  const offsets: number[] = [];
  const sourceMethods: string[] = [];
  const uploads: Mutation[][] = [];
  let sourceLogins = 0;
  let sourceRefreshes = 0;
  let destinationRefreshes = 0;
  let uploadAttempts = 0;
  let sourceExpired = false;
  let destinationExpired = false;

  const sourcePrefix = options.sourcePrefix ?? "/legacy";

  const old = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      sourceMethods.push(`${request.method} ${url.pathname}`);
      if (
        url.pathname === `${sourcePrefix}/auth/login` &&
        request.method === "POST"
      ) {
        sourceLogins++;
        const input = await request.json();
        if (
          input.username !== "old-reader@example.com" ||
          input.password !== password
        )
          return Response.json(
            { error: "Invalid credentials" },
            { status: 401 },
          );
        return Response.json({
          accessToken: "old-access",
          refreshToken: "old-refresh",
        });
      }
      if (
        url.pathname === `${sourcePrefix}/auth/refresh` &&
        request.method === "POST"
      ) {
        sourceRefreshes++;
        expect(await request.json()).toEqual({ refreshToken: "old-refresh" });
        return options.refreshExpires
          ? Response.json({ error: "Expired" }, { status: 401 })
          : Response.json({ accessToken: "old-access" });
      }
      if (url.pathname !== `${sourcePrefix}/sync` || request.method !== "GET")
        return new Response(null, { status: 404 });
      if (request.headers.get("authorization") !== "Bearer old-access")
        return new Response(null, { status: 401 });
      if (options.sourceExpires && !sourceExpired) {
        sourceExpired = true;
        return new Response(null, { status: 401 });
      }
      expect(url.searchParams.get("lm")).toBe("50");
      expect(url.searchParams.has("ts")).toBe(false);
      const offset = Number(url.searchParams.get("os"));
      offsets.push(offset);
      if (options.badResponse) return Response.json({ records: [] });
      return Response.json({
        records: (options.records ?? []).slice(offset, offset + 50),
        saveds: (options.saveds ?? []).slice(offset, offset + 50),
        deleted: (options.deleted ?? []).slice(offset, offset + 50),
      });
    },
  });
  cleanups.push(async () => {
    old.stop(true);
  });
  // Proxy the real destination to inject expiration and failures without changing its code.
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/replacement/"))
        return new Response(null, { status: 404 });
      const path = url.pathname.slice("/replacement".length);
      if (path === "/auth/refresh") destinationRefreshes++;
      if (path === "/sync") {
        const body = await request.clone().json();
        expect(body.cursor).toBeNull();
        expect(body.limit).toBe(1);
        uploads.push(body.mutations);
        if (body.mutations.length) {
          uploadAttempts++;
          if (options.destinationExpires && !destinationExpired) {
            destinationExpired = true;
            return new Response(null, { status: 401 });
          }
          if (
            options.failAfter !== undefined &&
            uploadAttempts > options.failAfter
          )
            return new Response(null, { status: 503 });
          if (options.invalidResult)
            return Response.json({
              results: body.mutations.map((mutation: Mutation) => ({
                operationId: mutation.operationId,
                status: "invalid",
              })),
            });
        }
      }
      return fetch(
        new Request(new URL(path + url.search, app.server!.url), request),
      );
    },
  });
  cleanups.push(async () => {
    proxy.stop(true);
  });
  const oldServer: ServerCredentials = {
    url: `${old.url.origin}${sourcePrefix}/`,
    username: "old-reader@example.com",
    password,
  };
  const newServer: ServerCredentials = {
    url: `${proxy.url.href}replacement///`,
    username: "new-reader",
    password,
  };
  const access = async () => {
    const login = await app.handle(
      new Request(new URL("/auth/login", app.server!.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "new-reader", password }),
      }),
    );
    const { refreshToken } = await login.json();
    const refreshed = await app.handle(
      new Request(new URL("/auth/refresh", app.server!.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      }),
    );
    return (await refreshed.json()).accessToken as string;
  };
  const sync = async (
    mutations: Mutation[] = [],
    cursor: string | null = null,
  ) => {
    const response = await app.handle(
      new Request(new URL("/sync", app.server!.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await access()}`,
        },
        body: JSON.stringify({ cursor, mutations }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      changes: Change[];
      nextCursor: string;
      hasMore: boolean;
    };
  };
  const changes = async () => {
    const result: Change[] = [];
    let cursor: string | null = null;
    for (;;) {
      const response = await sync([], cursor);
      result.push(...response.changes);
      if (!response.hasMore) return result;
      cursor = response.nextCursor;
    }
  };
  return {
    oldServer,
    newServer,
    offsets,
    sourceMethods,
    uploads,
    sync,
    changes,
    authCounts: () => ({ sourceLogins, sourceRefreshes, destinationRefreshes }),
  };
}

describe("v1 migration", () => {
  test("uses root endpoints without an API prefix on the old server", async () => {
    const f = await fixture({ records: [record(0)], sourcePrefix: "" });

    expect(await migrateV1(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
    });
    expect(f.sourceMethods).toEqual(["POST /auth/login", "GET /sync"]);
    expect(f.authCounts()).toMatchObject({
      sourceLogins: 1,
      sourceRefreshes: 0,
    });
  });

  test("decodes escaped chapter IDs and titles using the v1 format", () => {
    expect(decodeChapter(saved(0).latestChapter)).toEqual({
      id: "chapter|id\\tail",
      title: "Title | with \\ slash",
      locked: false,
    });
    expect(decodeChapter("id||true")).toEqual({ id: "id", locked: true });
    expect(decodeChapter("id")).toEqual({ id: "id" });
    expect(decodeChapter("id|title|")).toEqual({ id: "id", title: "title" });
  });

  test("normalizes base URLs and rejects credential-bearing and unsupported URLs", () => {
    expect(normalizeServerUrl(" https://example.com/prefix/// ")).toBe(
      "https://example.com/prefix",
    );
    for (const value of [
      "example.com",
      "ftp://example.com",
      "https://user:pass@example.com",
      "https://example.com/?token=secret",
      "https://example.com/#token",
    ])
      expect(() => normalizeServerUrl(value)).toThrow();
  });

  test("paginates all collections, preserves state, fits small batch limits, and safely reruns", async () => {
    const f = await fixture({
      records: Array.from({ length: 55 }, (_, index) => record(index)),
      saveds: [saved(0), saved(1)],
      deleted: [
        { mangaId: "deleted", pluginId: "source-1", datetime: timestamp },
      ],
      maxMutations: 2,
    });
    await f.sync([
      {
        operationId: "existing-newer",
        type: "progress",
        action: "upsert",
        key: { sourceId: "source-1", mangaId: "manga-0" },
        datetime: timestamp + 1000,
        payload: { chapterId: "keep-newer", chapterTitle: "Newer", page: 99 },
      },
      {
        operationId: "existing-library",
        type: "library",
        action: "upsert",
        key: { sourceId: "source-1", mangaId: "deleted" },
        datetime: timestamp - 1,
        payload: { updates: false, latestChapter: { id: "old" } },
      },
    ]);
    const summary = await migrateV1(f.oldServer, f.newServer);
    expect(summary).toEqual({
      records: 55,
      library: 2,
      deletions: 1,
      applied: 57,
      ignored: 1,
      dryRun: false,
    });
    expect(f.offsets).toEqual([0, 50]);
    const imported = await f.changes();
    expect(imported).toHaveLength(58);
    expect(
      imported.find(
        (change) =>
          change.action !== "clear" &&
          (change.type === "library" || change.type === "progress") &&
          change.key.mangaId === "manga-0",
      ),
    ).toMatchObject({
      datetime: timestamp + 1000,
      payload: { chapterId: "keep-newer", page: 99 },
    });
    expect(
      imported.find(
        (change) =>
          change.action !== "clear" &&
          (change.type === "library" || change.type === "progress") &&
          change.key.mangaId === "manga-1",
      ),
    ).toMatchObject({
      datetime: timestamp + 1,
      key: { sourceId: "source-1" },
      payload: { chapterTitle: "Chapter 1", page: 1 },
    });
    expect(
      imported.find(
        (change) =>
          change.action !== "clear" &&
          (change.type === "library" || change.type === "progress") &&
          change.key.mangaId === "saved-0",
      ),
    ).toMatchObject({
      type: "library",
      payload: {
        updates: true,
        latestChapter: decodeChapter(saved(0).latestChapter),
      },
    });
    expect(
      imported.find(
        (change) =>
          change.action !== "clear" &&
          (change.type === "library" || change.type === "progress") &&
          change.key.mangaId === "deleted",
      ),
    ).toMatchObject({
      type: "library",
      action: "delete",
      datetime: timestamp,
    });
    expect(
      f.sourceMethods.filter((method) => method.startsWith("POST")),
    ).toEqual(["POST /legacy/auth/login"]);
    expect(await migrateV1(f.oldServer, f.newServer)).toMatchObject({
      applied: 0,
      ignored: 58,
    });
    expect(await f.changes()).toEqual(imported);
  });

  test("continues pagination when only library or deleted entries fill a page", async () => {
    const f = await fixture({
      saveds: Array.from({ length: 51 }, (_, index) => saved(index)),
      deleted: Array.from({ length: 50 }, (_, index) => ({
        mangaId: `deleted-${index}`,
        pluginId: "source-1",
        datetime: timestamp,
      })),
    });
    expect(
      await migrateV1(f.oldServer, f.newServer, { dryRun: true }),
    ).toMatchObject({ library: 51, deletions: 50 });
    expect(f.offsets).toEqual([0, 50]);
    expect(f.uploads.every((batch) => batch.length === 0)).toBe(true);
    expect(await f.changes()).toEqual([]);
  });

  test("validates later pages before uploading any mutations", async () => {
    const records = Array.from({ length: 51 }, (_, index) => record(index));
    records[50] = { ...record(50), page: -1 };
    const f = await fixture({ records });
    await expect(migrateV1(f.oldServer, f.newServer)).rejects.toThrow(
      "Old server records[50]",
    );
    expect(f.offsets).toEqual([0, 50]);
    expect(f.uploads.every((batch) => batch.length === 0)).toBe(true);
    expect(await f.changes()).toEqual([]);
  });

  test("rejects missing chapter IDs, negative dates, fractional pages, and malformed exports", async () => {
    for (const options of [
      { saveds: [{ ...saved(0), latestChapter: "|title|false" }] },
      { records: [{ ...record(0), datetime: -1 }] },
      { records: [{ ...record(0), page: 0.5 }] },
      { records: [{ ...record(0), pluginId: "" }] },
      { badResponse: true },
    ]) {
      const f = await fixture(options);
      await expect(migrateV1(f.oldServer, f.newServer)).rejects.toThrow();
      expect(f.uploads.every((batch) => batch.length === 0)).toBe(true);
      expect(await f.changes()).toEqual([]);
    }
  });

  test("refreshes expired tokens on both servers without changing the upload body", async () => {
    const f = await fixture({
      records: [record(0)],
      sourceExpires: true,
      destinationExpires: true,
    });
    expect(await migrateV1(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
    });
    expect(f.authCounts()).toEqual({
      sourceLogins: 1,
      sourceRefreshes: 1,
      destinationRefreshes: 2,
    });
    const attempts = f.uploads.filter((batch) => batch.length > 0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  test("logs in again when the old refresh token is also expired", async () => {
    const f = await fixture({
      records: [record(0)],
      sourceExpires: true,
      refreshExpires: true,
    });
    expect(await migrateV1(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
    });
    expect(f.authCounts()).toMatchObject({
      sourceLogins: 2,
      sourceRefreshes: 1,
    });
  });

  test("resumes safely after a partially completed migration", async () => {
    const options: FixtureOptions = {
      records: Array.from({ length: 101 }, (_, index) => record(index)),
      failAfter: 1,
    };
    const f = await fixture(options);
    await expect(migrateV1(f.oldServer, f.newServer)).rejects.toThrow(
      "HTTP 503",
    );
    expect(await f.changes()).toHaveLength(100);
    delete options.failAfter;
    expect(await migrateV1(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
      ignored: 100,
    });
    expect(await f.changes()).toHaveLength(101);
  });

  test("stops on invalid destination results and wrong credentials", async () => {
    const f = await fixture({ records: [record(0)], invalidResult: true });
    await expect(migrateV1(f.oldServer, f.newServer)).rejects.toThrow(
      "New server rejected a mutation",
    );
    await expect(
      migrateV1({ ...f.oldServer, password: "wrong" }, f.newServer),
    ).rejects.toThrow("Old server: auth/login returned HTTP 401");
    await expect(
      migrateV1(f.oldServer, { ...f.newServer, password: "wrong" }),
    ).rejects.toThrow("New server: auth/login returned HTTP 401");
    expect(await f.changes()).toEqual([]);
  });
});
