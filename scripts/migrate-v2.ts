import { mutationValidator, type Mutation } from "../src/protocol";
import {
  Client,
  normalizeServerUrl,
  object,
  promptServers,
  uploadMutations,
  type MigrationOptions,
  type ServerCredentials,
} from "./migration-common";

export type MigrationSummary = {
  plugins: number;
  library: number;
  records: number;
  deletions: number;
  clears: number;
  applied: number;
  ignored: number;
};

export async function migrateV2(
  oldServer: ServerCredentials,
  newServer: ServerCredentials,
  options: MigrationOptions = {},
): Promise<MigrationSummary> {
  if (
    normalizeServerUrl(oldServer.url) === normalizeServerUrl(newServer.url) &&
    oldServer.username === newServer.username
  )
    throw new Error("The old and new server accounts must be different");

  const log = options.log ?? (() => {});
  const source = new Client(oldServer, "Old server");
  const destination = new Client(newServer, "New server");
  log("Authenticating with both servers...");
  await source.login();
  await destination.login();
  // Check the destination before downloading or writing account data.
  await destination.request("POST", "sync", {
    cursor: null,
    limit: 1,
    mutations: [],
  });

  const summary: MigrationSummary = {
    plugins: 0,
    library: 0,
    records: 0,
    deletions: 0,
    clears: 0,
    applied: 0,
    ignored: 0,
  };
  const mutations: Mutation[] = [];
  let cursor: string | null = null;
  let lastRevision = 0;
  for (;;) {
    // Omit limit so any configured source page size is supported.
    const page = object(
      await source.request("POST", "sync", { cursor, mutations: [] }),
      "old server sync response",
    );
    if (
      !Array.isArray(page.results) ||
      page.results.length !== 0 ||
      !Array.isArray(page.changes) ||
      typeof page.hasMore !== "boolean" ||
      typeof page.nextCursor !== "string" ||
      !page.nextCursor ||
      page.nextCursor.length > 2048
    )
      throw new Error("Old server: invalid sync response");
    if (page.hasMore && (!page.changes.length || page.nextCursor === cursor))
      throw new Error("Old server: sync pagination did not advance");

    for (const value of page.changes) {
      const description = `Old server changes[${mutations.length}]`;
      const { revision, ...state } = object(value, description);
      if (
        typeof revision !== "string" ||
        !/^[1-9]\d*$/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) ||
        Number(revision) <= lastRevision
      )
        throw new Error(
          `${description}: revision must increase between changes`,
        );
      // Revisions and cursors belong to the source. Only state and original
      // timestamps are imported; the destination assigns its own revisions.
      const mutation = { ...state, operationId: crypto.randomUUID() };
      if (!mutationValidator.Check(mutation)) {
        const path = mutationValidator.Errors(mutation).First()?.path;
        throw new Error(
          `${description}: invalid v2 change${path ? ` (${path})` : ""}`,
        );
      }
      lastRevision = Number(revision);
      mutations.push(mutation);
      if (mutation.action === "delete") summary.deletions++;
      else if (mutation.action === "clear") summary.clears++;
      else
        summary[
          mutation.type === "plugin"
            ? "plugins"
            : mutation.type === "library"
              ? "library"
              : "records"
        ]++;
    }
    log(
      `Downloaded ${summary.plugins} plugins, ${summary.library} library items, ${summary.records} progress records, ${summary.deletions} deletions, ${summary.clears} progress clears.`,
    );
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  // Validate the entire export before sending the first destination mutation.
  if (mutations.length)
    await uploadMutations(destination, mutations, summary, log);
  return summary;
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run scripts/migrate-v2.ts\nPrompts for old and new server URLs, usernames, and passwords.\nStop syncing to the old server while migrating. Password input is hidden.",
    );
    return;
  }
  if (args.length)
    throw new Error("Unknown argument. Usage: bun run scripts/migrate-v2.ts");
  console.log(
    "Migrate one account between Mankai Sync v2 servers.\nStop syncing to the old server during migration. Original timestamps, deletions, and progress clears are preserved.",
  );
  const [oldServer, newServer] = await promptServers();
  const summary = await migrateV2(oldServer, newServer, {
    log: console.log,
  });
  console.log(
    `Validated ${summary.plugins} plugins, ${summary.library} library items, ${summary.records} progress records, ${summary.deletions} deletions, and ${summary.clears} progress clears.`,
  );
  console.log(
    `Migration complete: ${summary.applied} applied, ${summary.ignored} unchanged (identical or newer destination state).`,
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
