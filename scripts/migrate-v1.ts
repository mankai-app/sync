import {
  mutationValidator,
  type LatestChapter,
  type Mutation,
} from "../src/protocol";

import {
  Client,
  normalizeServerUrl,
  object,
  promptServers,
  uploadMutations,
  type MigrationOptions,
  type ServerCredentials,
} from "./migration-common";

export { normalizeServerUrl, type ServerCredentials } from "./migration-common";

export type MigrationSummary = {
  records: number;
  library: number;
  deletions: number;
  applied: number;
  ignored: number;
  dryRun: boolean;
};

export function decodeChapter(encoded: unknown): LatestChapter {
  if (typeof encoded !== "string")
    throw new Error("latestChapter must be a v1 chapter string");
  // v1 Chapter.encode() escapes backslashes and pipes in id|title|locked.
  const parts: string[] = [""];
  for (let index = 0; index < encoded.length; index++) {
    const character = encoded[index]!;
    if (character === "\\" && index + 1 < encoded.length)
      parts[parts.length - 1] += encoded[++index]!;
    else if (character === "|") parts.push("");
    else parts[parts.length - 1] += character;
  }
  return {
    id: parts[0]!,
    ...(parts[1] ? { title: parts[1] } : {}),
    ...(["true", "false"].includes(parts[2] ?? "")
      ? { locked: parts[2] === "true" }
      : {}),
  };
}

function datetime(value: unknown): number {
  const milliseconds =
    typeof value === "number"
      ? value
      : typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
          )
        ? Date.parse(value)
        : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new Error(
      "datetime must represent nonnegative, safe integer Unix milliseconds",
    );
  return milliseconds;
}

function convert(
  value: unknown,
  kind: "records" | "saveds" | "deleted",
  description: string,
): Mutation {
  try {
    const item = object(value, "v1 item");
    const base = {
      operationId: crypto.randomUUID(),
      datetime: datetime(item.datetime),
      key: { sourceId: item.pluginId, mangaId: item.mangaId },
    };
    const mutation =
      kind === "records"
        ? {
            ...base,
            type: "progress",
            action: "upsert",
            payload: {
              chapterId: item.chapterId,
              chapterTitle: item.chapterTitle ?? null,
              page: item.page,
            },
          }
        : kind === "saveds"
          ? {
              ...base,
              type: "library",
              action: "upsert",
              payload: {
                updates: item.updates,
                latestChapter: decodeChapter(item.latestChapter),
              },
            }
          : { ...base, type: "library", action: "delete" };
    if (!mutationValidator.Check(mutation)) {
      const path = mutationValidator.Errors(mutation).First()?.path;
      throw new Error(
        `item cannot be represented by the new protocol${path ? ` (${path})` : ""}`,
      );
    }
    return mutation;
  } catch (error) {
    throw new Error(
      `${description}: ${error instanceof Error ? error.message : "invalid item"}`,
    );
  }
}

export async function migrateV1(
  oldServer: ServerCredentials,
  newServer: ServerCredentials,
  options: MigrationOptions & { dryRun?: boolean } = {},
): Promise<MigrationSummary> {
  if (normalizeServerUrl(oldServer.url) === normalizeServerUrl(newServer.url))
    throw new Error("The old and new server URLs must be different");
  const log = options.log ?? (() => {});
  const source = new Client(oldServer, "Old server", true);
  const destination = new Client(newServer, "New server");
  log("Authenticating with both servers...");
  await source.login();
  await destination.login();
  // Check the destination sync route before downloading or writing account data.
  await destination.request("POST", "sync", {
    cursor: null,
    limit: 1,
    mutations: [],
  });

  const summary: MigrationSummary = {
    records: 0,
    library: 0,
    deletions: 0,
    applied: 0,
    ignored: 0,
    dryRun: options.dryRun ?? false,
  };
  const mutations: Mutation[] = [];
  const pageSize = 50; // v1 caps each collection independently at 50.
  for (let offset = 0; ; offset += pageSize) {
    const page = object(
      await source.request("GET", `sync?os=${offset}&lm=${pageSize}`),
      "old server sync response",
    );
    let hasMore = false;
    for (const kind of ["records", "saveds", "deleted"] as const) {
      const items = page[kind];
      if (!Array.isArray(items) || items.length > pageSize)
        throw new Error(
          `Old server: ${kind} must be an array of at most ${pageSize} items`,
        );
      if (items.length === pageSize) hasMore = true;
      for (const [index, item] of items.entries())
        mutations.push(
          convert(item, kind, `Old server ${kind}[${offset + index}]`),
        );
      summary[
        kind === "saveds"
          ? "library"
          : kind === "deleted"
            ? "deletions"
            : "records"
      ] += items.length;
    }
    log(
      `Downloaded ${summary.records} progress records, ${summary.library} library items, ${summary.deletions} library deletions.`,
    );
    if (!hasMore) break;
  }
  // Validate the entire export before sending the first destination mutation.
  if (summary.dryRun || !mutations.length) return summary;

  await uploadMutations(destination, mutations, summary, log);
  return summary;
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run scripts/migrate-v1.ts [--dry-run]\nPrompts for old server URL, email, password, and new server URL, username, password.\nStop syncing to the old server while migrating. Password input is hidden.\n--dry-run authenticates and validates all source data without uploading mutations.",
    );
    return;
  }
  if (args.some((arg) => arg !== "--dry-run"))
    throw new Error(
      "Unknown argument. Usage: bun run scripts/migrate-v1.ts [--dry-run]",
    );
  console.log(
    "Migrate one account from Mankai Sync v1 to the new server.\nStop syncing to the old server during migration. Plugin URLs are not available in v1.",
  );
  const [oldServer, newServer] = await promptServers("email");
  const summary = await migrateV1(oldServer, newServer, {
    dryRun: args.includes("--dry-run"),
    log: console.log,
  });
  console.log(
    `Validated ${summary.records} progress records, ${summary.library} library items, and ${summary.deletions} library deletions.`,
  );
  console.log(
    summary.dryRun
      ? "Dry run complete. No mutations were uploaded."
      : `Migration complete: ${summary.applied} applied, ${summary.ignored} unchanged (identical or newer destination state).`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    console.error(
      "Fix the issue and rerun. Original timestamps are preserved, so completed imports can be retried safely.",
    );
    process.exitCode = 1;
  }
}
