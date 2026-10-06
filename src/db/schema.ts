import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { LatestChapter } from "../protocol";

export const accounts = sqliteTable("accounts", {
  account: text().primaryKey(),
  revision: integer().notNull().default(0),
  progressClearDatetime: integer("progress_clear_datetime"),
  progressClearRevision: integer("progress_clear_revision"),
});

const itemColumns = () => ({
  account: text().notNull(),
  sourceId: text("source_id").notNull(),
  revision: integer().notNull(),
  datetime: integer().notNull(),
  deleted: integer({ mode: "boolean" }).notNull(),
});

const pluginColumns = () => ({
  ...itemColumns(),
  url: text(),
  type: text(),
});

export const plugins = sqliteTable("plugins", pluginColumns(), (table) => [
  primaryKey({ columns: [table.account, table.sourceId] }),
  index("plugins_sync").on(table.account, table.revision),
]);

export const browsableplugins = sqliteTable(
  "browsableplugins",
  pluginColumns(),
  (table) => [
    primaryKey({ columns: [table.account, table.sourceId] }),
    index("browsableplugins_sync").on(table.account, table.revision),
  ],
);

export const library = sqliteTable(
  "library",
  {
    ...itemColumns(),
    mangaId: text("manga_id").notNull(),
    updates: integer({ mode: "boolean" }),
    latestChapter: text("latest_chapter", {
      mode: "json",
    }).$type<LatestChapter>(),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.sourceId, table.mangaId] }),
    index("library_sync").on(table.account, table.revision),
  ],
);

export const progress = sqliteTable(
  "progress",
  {
    ...itemColumns(),
    mangaId: text("manga_id").notNull(),
    chapterId: text("chapter_id"),
    chapterTitle: text("chapter_title"),
    page: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.account, table.sourceId, table.mangaId] }),
    index("progress_sync").on(table.account, table.revision),
  ],
);
