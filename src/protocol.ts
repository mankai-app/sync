import { t, type Static } from "elysia";
import { TypeCompiler } from "elysia/type-system";

const id = t.String({ minLength: 1, maxLength: 512 });

const pluginKey = t.Object({ sourceId: id }, { additionalProperties: false });

const mangaKey = t.Object(
  { sourceId: id, mangaId: id },
  { additionalProperties: false },
);

const common = {
  operationId: t.String({ minLength: 1, maxLength: 128 }),
  datetime: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};

const pluginPayload = t.Object(
  {
    url: t.String({ format: "uri", maxLength: 16384 }),
    type: t.String({ maxLength: 64 }),
  },
  { additionalProperties: false },
);

const latestChapterSchema = t.Object(
  {
    id,
    title: t.Optional(t.String({ maxLength: 1024 })),
    locked: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);
export type LatestChapter = Static<typeof latestChapterSchema>;

const libraryPayload = t.Object(
  { updates: t.Boolean(), latestChapter: latestChapterSchema },
  { additionalProperties: false },
);

const progressPayload = t.Object(
  {
    chapterId: id,
    chapterTitle: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
    page: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

const mutationSchema = t.Union([
  t.Object(
    {
      ...common,
      type: t.Literal("plugin"),
      action: t.Literal("upsert"),
      key: pluginKey,
      payload: pluginPayload,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Literal("browsableplugin"),
      action: t.Literal("upsert"),
      key: pluginKey,
      payload: pluginPayload,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Literal("library"),
      action: t.Literal("upsert"),
      key: mangaKey,
      payload: libraryPayload,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Literal("progress"),
      action: t.Literal("upsert"),
      key: mangaKey,
      payload: progressPayload,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Literal("plugin"),
      action: t.Literal("delete"),
      key: pluginKey,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Literal("browsableplugin"),
      action: t.Literal("delete"),
      key: pluginKey,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...common,
      type: t.Union([t.Literal("library"), t.Literal("progress")]),
      action: t.Literal("delete"),
      key: mangaKey,
    },
    { additionalProperties: false },
  ),
  t.Object(
    { ...common, type: t.Literal("progress"), action: t.Literal("clear") },
    { additionalProperties: false },
  ),
]);

export const mutationValidator = TypeCompiler.Compile(mutationSchema);

export type Mutation = Static<typeof mutationSchema>;

type State<T> = T extends unknown ? Omit<T, "operationId"> : never;

export type Change = State<Mutation> & { revision: string };

export type Result = {
  operationId: string | null;
  status: "applied" | "ignored" | "invalid";
  revision?: string;
  current?: Change;
};

export type Target =
  | { type: "plugin" | "browsableplugin"; key: { sourceId: string } }
  | {
      type: "library" | "progress";
      key: { sourceId: string; mangaId: string };
    };

export const syncRequestSchema = (pageSize: number, maxMutations: number) =>
  t.Object(
    {
      cursor: t.Union([t.String({ maxLength: 2048 }), t.Null()]),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: pageSize })),
      // Validate mutations separately so one invalid entry doesn't reject the batch.
      mutations: t.Array(t.Unknown(), { maxItems: maxMutations }),
    },
    { additionalProperties: false },
  );

export type SyncRequest = Static<ReturnType<typeof syncRequestSchema>>;

export class SyncError extends Error {}
