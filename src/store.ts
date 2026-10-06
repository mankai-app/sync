import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { and, defineRelations, eq, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import {
  accounts,
  plugins,
  browsableplugins,
  library,
  progress,
} from "./db/schema";
import {
  mutationValidator,
  SyncError,
  type Change,
  type Mutation,
  type Result,
  type SyncRequest,
  type Target,
} from "./protocol";

type Cursor = { account: string; after: number };

const targetKey = (target: Target) =>
  JSON.stringify([
    target.type,
    target.key.sourceId,
    "mangaId" in target.key ? target.key.mangaId : null,
  ]);

type Metadata = { revision: number; datetime: number };

const metadata = (row: Metadata) => ({
  revision: String(row.revision),
  datetime: row.datetime,
});

function pluginChange(
  row: typeof plugins.$inferSelect,
  type: "plugin" | "browsableplugin",
): Change {
  const base = {
    ...metadata(row),
    type,
    key: { sourceId: row.sourceId },
  };

  return row.deleted
    ? { ...base, action: "delete" }
    : {
        ...base,
        action: "upsert",
        payload: { url: row.url!, type: row.type! },
      };
}

function libraryChange(row: typeof library.$inferSelect): Change {
  const base = {
    ...metadata(row),
    type: "library" as const,
    key: { sourceId: row.sourceId, mangaId: row.mangaId },
  };

  return row.deleted
    ? { ...base, action: "delete" }
    : {
        ...base,
        action: "upsert",
        payload: { updates: row.updates!, latestChapter: row.latestChapter! },
      };
}

function progressChange(row: typeof progress.$inferSelect): Change {
  const base = {
    ...metadata(row),
    type: "progress" as const,
    key: { sourceId: row.sourceId, mangaId: row.mangaId },
  };

  return row.deleted
    ? { ...base, action: "delete" }
    : {
        ...base,
        action: "upsert",
        payload: {
          chapterId: row.chapterId!,
          chapterTitle: row.chapterTitle,
          page: row.page!,
        },
      };
}

function clearChange(state: typeof accounts.$inferSelect): Change | undefined {
  if (state.progressClearRevision === null) return;

  return {
    revision: String(state.progressClearRevision),
    datetime: state.progressClearDatetime!,
    type: "progress",
    action: "clear",
  };
}

export function createStore(filename: string, secret: string) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });

  const sqlite = new Database(filename, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

  const db = drizzle({
    client: sqlite,
    relations: defineRelations(
      { accounts, plugins, browsableplugins, library, progress },
      (r) => ({
        accounts: {
          plugins: r.many.plugins({
            from: r.accounts.account,
            to: r.plugins.account,
          }),
          browsableplugins: r.many.browsableplugins({
            from: r.accounts.account,
            to: r.browsableplugins.account,
          }),
          library: r.many.library({
            from: r.accounts.account,
            to: r.library.account,
          }),
          progress: r.many.progress({
            from: r.accounts.account,
            to: r.progress.account,
          }),
        },
      }),
    ),
  });

  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  } catch (error) {
    sqlite.close();

    throw error;
  }

  // Signing ties the cursor to its account and prevents clients from changing the revision.
  const signature = (value: string) =>
    createHmac("sha256", secret).update(`cursor:${value}`).digest();

  const encodeCursor = (account: string, after: number) => {
    const value = Buffer.from(
      JSON.stringify({ account, after } satisfies Cursor),
    ).toString("base64url");

    return `${value}.${signature(value).toString("base64url")}`;
  };

  const decodeCursor = (token: string, account: string): Cursor => {
    try {
      const parts = token.split(".");
      const [value, mac] = parts;

      if (parts.length !== 2 || !value || !mac) throw new Error();

      const expected = signature(value);
      const actual = Buffer.from(mac, "base64url");

      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();

      const cursor = JSON.parse(Buffer.from(value, "base64url").toString());

      if (
        !cursor ||
        cursor.account !== account ||
        !Number.isSafeInteger(cursor.after) ||
        cursor.after < 0
      )
        throw new Error();

      return cursor;
    } catch {
      throw new SyncError("Invalid cursor; bootstrap with cursor: null");
    }
  };

  function sync(account: string, request: SyncRequest, defaultLimit: number) {
    // The immediate transaction keeps concurrent syncs from racing between reads and writes.
    return db.transaction(
      (tx) => {
        const after =
          request.cursor === null
            ? 0
            : decodeCursor(request.cursor, account).after;

        // Clients send epoch milliseconds; validate the integer without altering it.
        const mutations = request.mutations.map(
          (input): Mutation | undefined =>
            mutationValidator.Check(input) &&
            Number.isSafeInteger(input.datetime)
              ? input
              : undefined,
        );

        const keys = {
          plugin: [] as string[],
          browsableplugin: [] as string[],
          library: [] as SQL[],
          progress: [] as SQL[],
        };

        for (const mutation of mutations) {
          if (!mutation || mutation.action === "clear") continue;

          if (mutation.type === "plugin" || mutation.type === "browsableplugin")
            keys[mutation.type].push(mutation.key.sourceId);
          else
            keys[mutation.type].push(
              sql`(${mutation.key.sourceId}, ${mutation.key.mangaId})`,
            );
        }

        // Match each source/manga pair together, rather than unrelated combinations of IDs.
        const matchKeys = (
          table: typeof library | typeof progress,
          pairs: SQL[],
        ) =>
          pairs.length
            ? sql`(${table.sourceId}, ${table.mangaId}) in (${sql.join(pairs, sql`, `)})`
            : sql`false`;

        // First read: account metadata and all mutation targets in one SQL statement.
        const loaded = tx.query.accounts
          .findFirst({
            where: { account },
            with: {
              plugins: { where: { sourceId: { in: keys.plugin } } },
              browsableplugins: {
                where: { sourceId: { in: keys.browsableplugin } },
              },
              library: {
                where: { RAW: (table) => matchKeys(table, keys.library) },
              },
              progress: {
                where: { RAW: (table) => matchKeys(table, keys.progress) },
              },
            },
          })
          .sync();

        const state: typeof accounts.$inferSelect = loaded ?? {
          account,
          revision: 0,
          progressClearDatetime: null,
          progressClearRevision: null,
        };

        if (after > state.revision)
          throw new SyncError("Invalid cursor; bootstrap with cursor: null");

        // This map lives only for this sync and tracks earlier writes in the same batch.
        const currentRows = new Map<string, Change>();

        for (const change of [
          ...(loaded?.plugins ?? []).map((row) => pluginChange(row, "plugin")),
          ...(loaded?.browsableplugins ?? []).map((row) =>
            pluginChange(row, "browsableplugin"),
          ),
          ...(loaded?.library ?? []).map(libraryChange),
          ...(loaded?.progress ?? []).map(progressChange),
        ]) {
          if (change.action !== "clear")
            currentRows.set(targetKey(change), change);
        }

        const current = (target: Target): Change | undefined => {
          const row = currentRows.get(targetKey(target));
          const clear =
            target.type === "progress" ? clearChange(state) : undefined;

          // A clear also rejects late progress whose keys were absent when it ran.
          if (
            target.type === "progress" &&
            clear &&
            (!row || row.datetime <= clear.datetime)
          ) {
            return {
              revision: clear.revision,
              datetime: clear.datetime,
              type: "progress",
              action: "delete",
              key: target.key,
            };
          }

          return row;
        };

        const nextRevision = () => {
          state.revision += 1;

          tx.insert(accounts)
            .values({ account, revision: state.revision })
            .onConflictDoUpdate({
              target: accounts.account,
              set: { revision: state.revision },
            })
            .run();

          return state.revision;
        };

        const results = request.mutations.map((input, index): Result => {
          const operationId =
            input &&
            typeof input === "object" &&
            "operationId" in input &&
            typeof input.operationId === "string" &&
            input.operationId.length > 0 &&
            input.operationId.length <= 128
              ? input.operationId
              : null;

          const mutation = mutations[index];

          if (!mutation) return { operationId, status: "invalid" };

          const target: Target | undefined =
            mutation.action === "clear"
              ? undefined
              : ({ type: mutation.type, key: mutation.key } as Target);

          const existing = target ? current(target) : clearChange(state);
          // Newer datetimes win; ties favor deletes. Identical retries remain ignored.
          const wins =
            !existing ||
            mutation.datetime > existing.datetime ||
            (mutation.datetime === existing.datetime &&
              mutation.action === "delete" &&
              existing.action === "upsert");

          if (!wins)
            return {
              operationId,
              status: "ignored",
              revision: existing!.revision,
              ...(target ? { current: existing } : {}),
            };

          const revision = nextRevision();

          if (mutation.action === "clear") {
            state.progressClearDatetime = mutation.datetime;
            state.progressClearRevision = revision;

            tx.update(accounts)
              .set({
                progressClearDatetime: state.progressClearDatetime,
                progressClearRevision: state.progressClearRevision,
              })
              .where(eq(accounts.account, account))
              .run();

            // The retained clear marker covers these keys, so old progress rows can be removed.
            tx.delete(progress)
              .where(
                and(
                  eq(progress.account, account),
                  lte(progress.datetime, mutation.datetime),
                ),
              )
              .run();
          } else {
            const base = {
              account,
              sourceId: mutation.key.sourceId,
              revision,
              datetime: mutation.datetime,
              deleted: mutation.action === "delete",
            };

            if (
              mutation.type === "plugin" ||
              mutation.type === "browsableplugin"
            ) {
              const table =
                mutation.type === "plugin" ? plugins : browsableplugins;
              const row = {
                ...base,
                url: mutation.action === "upsert" ? mutation.payload.url : null,
                type:
                  mutation.action === "upsert" ? mutation.payload.type : null,
              };

              tx.insert(table)
                .values(row)
                .onConflictDoUpdate({
                  target: [table.account, table.sourceId],
                  set: row,
                })
                .run();
            } else if (mutation.type === "library") {
              const row = {
                ...base,
                mangaId: mutation.key.mangaId,
                updates:
                  mutation.action === "upsert"
                    ? mutation.payload.updates
                    : null,
                latestChapter:
                  mutation.action === "upsert"
                    ? mutation.payload.latestChapter
                    : null,
              };

              tx.insert(library)
                .values(row)
                .onConflictDoUpdate({
                  target: [library.account, library.sourceId, library.mangaId],
                  set: row,
                })
                .run();
            } else {
              const row = {
                ...base,
                mangaId: mutation.key.mangaId,
                chapterId:
                  mutation.action === "upsert"
                    ? mutation.payload.chapterId
                    : null,
                chapterTitle:
                  mutation.action === "upsert"
                    ? mutation.payload.chapterTitle
                    : null,
                page:
                  mutation.action === "upsert" ? mutation.payload.page : null,
              };

              tx.insert(progress)
                .values(row)
                .onConflictDoUpdate({
                  target: [
                    progress.account,
                    progress.sourceId,
                    progress.mangaId,
                  ],
                  set: row,
                })
                .run();
            }

            const { operationId: _operationId, ...change } = mutation;
            currentRows.set(targetKey(mutation), {
              ...change,
              revision: String(revision),
            });
          }

          return { operationId, status: "applied", revision: String(revision) };
        });

        const limit = request.limit ?? defaultLimit;

        // Second read: fetch current rows after uploads have been merged.
        // limit+1 per table is enough to find the next global page and detect hasMore.
        const pageState =
          state.revision === 0
            ? undefined
            : tx.query.accounts
                .findFirst({
                  columns: { account: true },
                  where: { account },
                  with: {
                    plugins: {
                      where: { revision: { gt: after } },
                      orderBy: { revision: "asc" },
                      limit: limit + 1,
                    },
                    browsableplugins: {
                      where: { revision: { gt: after } },
                      orderBy: { revision: "asc" },
                      limit: limit + 1,
                    },
                    library: {
                      where: { revision: { gt: after } },
                      orderBy: { revision: "asc" },
                      limit: limit + 1,
                    },
                    progress: {
                      where: { revision: { gt: after } },
                      orderBy: { revision: "asc" },
                      limit: limit + 1,
                    },
                  },
                })
                .sync();

        const pending = [
          ...(pageState?.plugins ?? []).map((row) =>
            pluginChange(row, "plugin"),
          ),
          ...(pageState?.browsableplugins ?? []).map((row) =>
            pluginChange(row, "browsableplugin"),
          ),
          ...(pageState?.library ?? []).map(libraryChange),
          ...(pageState?.progress ?? []).map(progressChange),
        ];

        const clear = clearChange(state);
        if (clear && Number(clear.revision) > after) pending.push(clear);

        pending.sort((a, b) => Number(a.revision) - Number(b.revision));
        const page = pending.slice(0, limit);

        return {
          results,
          changes: page,
          // Upload results never advance the cursor past rows that have not been delivered.
          nextCursor: encodeCursor(
            account,
            page.length
              ? Number(page[page.length - 1]!.revision)
              : state.revision,
          ),
          hasMore: pending.length > limit,
        };
      },
      { behavior: "immediate" },
    );
  }

  return { sync, close: () => sqlite.close() };
}
