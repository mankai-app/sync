import { afterEach, describe, expect, test } from "bun:test";

import { migrateV2 } from "../scripts/migrate-v2";
import type { ServerCredentials } from "../scripts/migration-common";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import type { Change, Mutation, Result, SyncRequest } from "../src/protocol";

type SyncResponse = {
  results: Result[];
  changes: Change[];
  nextCursor: string;
  hasMore: boolean;
};
type FixtureOptions = {
  pageSize?: number;
  maxMutations?: number;
  sourceExpires?: boolean;
  refreshExpires?: boolean;
  destinationExpires?: boolean;
  failAfter?: number;
  payloadLimit?: number;
  sourceResponse?: (body: SyncResponse, page: number) => unknown;
  destinationResponse?: (batch: Mutation[]) => unknown;
};
const timestamp = Date.UTC(2026, 9, 5, 4);
const password = " v2-migration-password ";
const progress = (index: number): Mutation => ({
  operationId: `seed-${index}`,
  type: "progress",
  action: "upsert",
  key: { sourceId: "source-1", mangaId: `manga-${index}` },
  datetime: timestamp + index,
  payload: {
    chapterId: `chapter-${index}`,
    chapterTitle: index % 2 ? `Chapter ${index}` : null,
    page: index,
  },
});
const plugin = (sourceId: string): Mutation => ({
  operationId: `plugin-${sourceId}`,
  type: "plugin",
  action: "upsert",
  key: { sourceId },
  datetime: timestamp,
  payload: { url: `https://plugins.example.com/${sourceId}?version=2` },
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: FixtureOptions = {}) {
  const config = (label: string): Config => ({
    host: "127.0.0.1",
    port: 3000,
    database: ":memory:",
    jwt: {
      secret: `${label}-v2-migration-secret-with-thirty-two-characters`,
      expiresInSeconds: 60,
    },
    sync: {
      pageSize: label === "old" ? (options.pageSize ?? 2) : 1,
      maxMutations: label === "old" ? 1000 : (options.maxMutations ?? 100),
    },
    users: [
      { username: `${label}-reader`, password },
      { username: "other-reader", password },
    ],
  });
  const oldApp = createApp(config("old")).listen({
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(async () => {
    await oldApp.stop();
  });
  const newApp = createApp(config("new")).listen({
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(async () => {
    await newApp.stop();
  });
  const sourceRequests: SyncRequest[] = [];
  const uploads: Mutation[][] = [];
  const counts = {
    sourceLogins: 0,
    sourceRefreshes: 0,
    destinationRefreshes: 0,
  };
  let sourceExpired = false;
  let destinationExpired = false;
  let sourcePages = 0;
  let uploadAttempts = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const source = url.pathname.startsWith("/old/");
      if (!source && !url.pathname.startsWith("/new/"))
        return new Response(null, { status: 404 });
      const path = url.pathname.slice(4);
      const app = source ? oldApp : newApp;
      if (path === "/auth/login" && source) counts.sourceLogins++;
      if (path === "/auth/refresh") {
        if (source) {
          counts.sourceRefreshes++;
          if (options.refreshExpires && counts.sourceRefreshes === 2)
            return new Response(null, { status: 401 });
        } else counts.destinationRefreshes++;
      }
      let batch: Mutation[] = [];
      if (path === "/sync") {
        const body = await request.clone().json();
        if (source) {
          sourceRequests.push(body);
          expect(body.mutations).toEqual([]);
          expect(body).not.toHaveProperty("limit");
          if (options.sourceExpires && !sourceExpired) {
            sourceExpired = true;
            return new Response(null, { status: 401 });
          }
        } else {
          expect(body.cursor).toBeNull();
          expect(body.limit).toBe(1);
          batch = body.mutations;
          uploads.push(batch);
          if (batch.length) {
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
            if (
              options.payloadLimit !== undefined &&
              batch.length > options.payloadLimit
            )
              return new Response(null, { status: 413 });
            if (options.destinationResponse)
              return Response.json(options.destinationResponse(batch));
          }
        }
      }
      const response = await fetch(
        new Request(new URL(path, app.server!.url), request),
      );
      if (source && path === "/sync" && response.ok) {
        const body = (await response.json()) as SyncResponse;
        sourcePages++;
        return Response.json(
          options.sourceResponse?.(body, sourcePages) ?? body,
        );
      }
      return response;
    },
  });
  cleanups.push(async () => {
    proxy.stop(true);
  });
  const oldServer: ServerCredentials = {
    url: `${proxy.url.origin}/old///`,
    username: "old-reader",
    password,
  };
  const newServer: ServerCredentials = {
    url: `${proxy.url.origin}/new/`,
    username: "new-reader",
    password,
  };
  const sync = async (
    source: boolean,
    mutations: Mutation[] = [],
    cursor: string | null = null,
    username?: string,
  ) => {
    const app = source ? oldApp : newApp;
    const post = async (path: string, body: unknown, accessToken?: string) => {
      const response = await app.handle(
        new Request(new URL(path, app.server!.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const { refreshToken } = await post("/auth/login", {
      username: username ?? (source ? "old-reader" : "new-reader"),
      password,
    });
    const { accessToken } = await post("/auth/refresh", { refreshToken });
    return (await post(
      "/sync",
      { cursor, mutations },
      accessToken,
    )) as SyncResponse;
  };
  const changes = async (source: boolean, username?: string) => {
    const result: Change[] = [];
    let cursor: string | null = null;
    for (;;) {
      const response = await sync(source, [], cursor, username);
      result.push(...response.changes);
      if (!response.hasMore) return result;
      cursor = response.nextCursor;
    }
  };
  return {
    oldServer,
    newServer,
    directOldServer: { ...oldServer, url: oldApp.server!.url.href },
    sync,
    changes,
    sourceRequests,
    uploads,
    counts,
  };
}
const state = (changes: Change[]) =>
  changes.map(({ revision, ...value }) => value);

describe("v2 migration", () => {
  test("copies every state type over signed cursor pages, adapts batches, and safely reruns", async () => {
    const f = await fixture({ maxMutations: 1 });
    await f.sync(true, [
      plugin("source-1"),
      {
        operationId: "library",
        type: "library",
        action: "upsert",
        key: { sourceId: "source-1", mangaId: "saved" },
        datetime: timestamp,
        payload: {
          updates: false,
          latestChapter: {
            id: "chapter|id",
            title: "Title \u2603",
            locked: true,
          },
        },
      },
      progress(1),
      {
        operationId: "delete-plugin",
        type: "plugin",
        action: "delete",
        key: { sourceId: "deleted-source" },
        datetime: timestamp,
      },
      {
        operationId: "delete-library",
        type: "library",
        action: "delete",
        key: { sourceId: "source-1", mangaId: "deleted-library" },
        datetime: timestamp,
      },
      {
        operationId: "delete-progress",
        type: "progress",
        action: "delete",
        key: { sourceId: "source-1", mangaId: "deleted-progress" },
        datetime: timestamp,
      },
      {
        operationId: "clear",
        type: "progress",
        action: "clear",
        datetime: timestamp - 1,
      },
    ]);
    // Existing destination state shifts its revisions independently of the source.
    await f.sync(false, [plugin("destination-only")]);
    const original = await f.changes(true);
    expect(await migrateV2(f.oldServer, f.newServer)).toEqual({
      plugins: 1,
      library: 1,
      records: 1,
      deletions: 3,
      clears: 1,
      applied: 7,
      ignored: 0,
    });
    expect(f.sourceRequests).toHaveLength(4);
    expect(f.sourceRequests[0]!.cursor).toBeNull();
    expect(
      f.sourceRequests
        .slice(1)
        .every((request) => typeof request.cursor === "string"),
    ).toBe(true);
    const imported = await f.changes(false);
    expect(state(imported).slice(1)).toEqual(state(original));
    expect(imported[1]!.revision).not.toBe(original[0]!.revision);
    expect(
      f.uploads.flat().every((mutation) => !("revision" in mutation)),
    ).toBe(true);
    expect(await f.changes(true)).toEqual(original);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 0,
      ignored: 7,
    });
    expect(await f.changes(false)).toEqual(imported);
  });

  test("keeps newer destination state and lets deletes win timestamp ties", async () => {
    const f = await fixture();
    await f.sync(true, [
      progress(0),
      {
        operationId: "delete",
        type: "plugin",
        action: "delete",
        key: { sourceId: "source-1" },
        datetime: timestamp,
      },
    ]);
    await f.sync(false, [
      { ...progress(0), datetime: timestamp + 1000 },
      plugin("source-1"),
    ]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
      ignored: 1,
    });
    expect(await f.changes(false)).toMatchObject([
      { type: "progress", datetime: timestamp + 1000 },
      { type: "plugin", action: "delete", datetime: timestamp },
    ]);
  });

  test("imports clear markers, removes older destination progress, and keeps newer progress", async () => {
    const f = await fixture();
    await f.sync(true, [
      progress(20),
      {
        operationId: "clear",
        type: "progress",
        action: "clear",
        datetime: timestamp + 10,
      },
    ]);
    await f.sync(false, [progress(5), progress(30)]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      records: 1,
      clears: 1,
      applied: 2,
    });
    const imported = await f.changes(false);
    expect(imported).toHaveLength(3);
    expect(
      imported.some(
        (change) =>
          change.action !== "clear" &&
          change.type === "progress" &&
          change.key.mangaId === "manga-5",
      ),
    ).toBe(false);
    expect(imported).toContainEqual(
      expect.objectContaining({ action: "clear", datetime: timestamp + 10 }),
    );
    expect((await f.sync(false, [progress(0)])).results[0]!.status).toBe(
      "ignored",
    );
  });

  test("imports all source pages", async () => {
    const f = await fixture({ pageSize: 1 });
    await f.sync(true, [progress(0), progress(1), progress(2)]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      records: 3,
      applied: 3,
      ignored: 0,
    });
    expect(f.sourceRequests).toHaveLength(3);
    expect(f.uploads.map((batch) => batch.length)).toEqual([0, 3]);
    expect(state(await f.changes(false))).toEqual(state(await f.changes(true)));
  });

  test("supports an empty account without uploading", async () => {
    const f = await fixture();
    expect(await migrateV2(f.oldServer, f.newServer)).toEqual({
      plugins: 0,
      library: 0,
      records: 0,
      deletions: 0,
      clears: 0,
      applied: 0,
      ignored: 0,
    });
    expect(f.sourceRequests).toHaveLength(1);
    expect(f.uploads).toEqual([[]]);
  });

  test("rejects invalid data on a later page before uploading", async () => {
    const f = await fixture({
      pageSize: 1,
      sourceResponse: (body, page) =>
        page === 2
          ? {
              ...body,
              changes: body.changes.map((change) => ({
                ...change,
                datetime: -1,
              })),
            }
          : body,
    });
    await f.sync(true, [progress(0), progress(1)]);
    await expect(migrateV2(f.oldServer, f.newServer)).rejects.toThrow(
      "Old server changes[1]: invalid v2 change",
    );
    expect(f.uploads).toEqual([[]]);
    expect(await f.changes(false)).toEqual([]);
  });

  test("rejects malformed responses, stalled cursors, and invalid revisions", async () => {
    let firstCursor = "";
    const responses: FixtureOptions["sourceResponse"][] = [
      () => ({ changes: [] }),
      (body) => ({ ...body, hasMore: "false" }),
      (body) => ({ ...body, nextCursor: "" }),
      (body) => ({ ...body, results: [{}] }),
      (body) => ({ ...body, hasMore: true, changes: [] }),
      (body) => ({
        ...body,
        changes: body.changes.map((change) => ({
          ...change,
          revision: "9007199254740992",
        })),
      }),
      (body, page) =>
        page === 2
          ? {
              ...body,
              changes: body.changes.map((change) => ({
                ...change,
                revision: "1",
              })),
            }
          : body,
      (body, page) => {
        if (page === 1) firstCursor = body.nextCursor;
        return { ...body, hasMore: true, nextCursor: firstCursor };
      },
    ];
    for (const sourceResponse of responses) {
      const f = await fixture({ pageSize: 1, sourceResponse });
      await f.sync(true, [progress(0), progress(1)]);
      await expect(migrateV2(f.oldServer, f.newServer)).rejects.toThrow(
        "Old server",
      );
      expect(f.uploads).toEqual([[]]);
    }
  });

  test("refreshes both servers and retries identical mutations after token expiration", async () => {
    const f = await fixture({ sourceExpires: true, destinationExpires: true });
    await f.sync(true, [progress(0)]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
    });
    expect(f.counts).toEqual({
      sourceLogins: 1,
      sourceRefreshes: 2,
      destinationRefreshes: 2,
    });
    expect(f.sourceRequests[1]).toEqual(f.sourceRequests[0]);
    const attempts = f.uploads.filter((batch) => batch.length);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  test("logs in again when the source refresh token expires", async () => {
    const f = await fixture({ sourceExpires: true, refreshExpires: true });
    await f.sync(true, [progress(0)]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
    });
    expect(f.counts).toMatchObject({ sourceLogins: 2, sourceRefreshes: 3 });
  });

  test("adapts uploads to HTTP 413 limits", async () => {
    const f = await fixture({ payloadLimit: 1 });
    await f.sync(true, [progress(0), progress(1), progress(2)]);
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 3,
    });
    expect(f.uploads.map((batch) => batch.length)).toEqual([0, 3, 1, 1, 1]);
  });

  test("resumes after an interrupted upload without duplicating state", async () => {
    const options: FixtureOptions = { failAfter: 1, pageSize: 50 };
    const f = await fixture(options);
    await f.sync(
      true,
      Array.from({ length: 101 }, (_, index) => progress(index)),
    );
    await expect(migrateV2(f.oldServer, f.newServer)).rejects.toThrow(
      "HTTP 503",
    );
    expect(await f.changes(false)).toHaveLength(100);
    delete options.failAfter;
    expect(await migrateV2(f.oldServer, f.newServer)).toMatchObject({
      applied: 1,
      ignored: 100,
    });
    expect(await f.changes(false)).toHaveLength(101);
  });

  test("rejects invalid destination results", async () => {
    for (const destinationResponse of [
      () => ({ results: [] }),
      (batch: Mutation[]) => ({
        results: batch.map(() => ({ operationId: "wrong", status: "applied" })),
      }),
      (batch: Mutation[]) => ({
        results: batch.map((mutation) => ({
          operationId: mutation.operationId,
          status: "invalid",
        })),
      }),
    ]) {
      const f = await fixture({ destinationResponse });
      await f.sync(true, [progress(0)]);
      await expect(migrateV2(f.oldServer, f.newServer)).rejects.toThrow(
        "New server",
      );
      expect(await f.changes(false)).toEqual([]);
    }
  });

  test("rejects wrong credentials and self-migration before downloading", async () => {
    const f = await fixture();
    await expect(
      migrateV2({ ...f.oldServer, password: "wrong" }, f.newServer),
    ).rejects.toThrow("Old server: auth/login returned HTTP 401");
    await expect(
      migrateV2(f.oldServer, { ...f.newServer, password: "wrong" }),
    ).rejects.toThrow("New server: auth/login returned HTTP 401");
    await expect(
      migrateV2(f.oldServer, {
        ...f.oldServer,
        url: f.oldServer.url.replace(/\/+$/, ""),
      }),
    ).rejects.toThrow("accounts must be different");
    expect(f.sourceRequests).toEqual([]);
    expect(f.uploads).toEqual([]);
  });

  test("supports copying between distinct accounts on the same v2 server", async () => {
    const f = await fixture();
    await f.sync(true, [progress(0)]);
    const target = { ...f.directOldServer, username: "other-reader" };
    expect(await migrateV2(f.directOldServer, target)).toMatchObject({
      applied: 1,
    });
    expect(state(await f.changes(true, "other-reader"))).toEqual(
      state(await f.changes(true)),
    );
    expect(await migrateV2(f.directOldServer, target)).toMatchObject({
      applied: 0,
      ignored: 1,
    });
  });
});
