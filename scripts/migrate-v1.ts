import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import {
  mutationValidator,
  type LatestChapter,
  type Mutation,
} from "../src/protocol";

export type ServerCredentials = {
  url: string;
  username: string;
  password: string;
};

export type MigrationSummary = {
  records: number;
  library: number;
  deletions: number;
  applied: number;
  ignored: number;
  dryRun: boolean;
};

class HttpError extends Error {
  constructor(
    label: string,
    path: string,
    readonly status: number,
  ) {
    super(`${label}: ${path.split("?")[0]} returned HTTP ${status}`);
  }
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${description}: expected an object`);
  return value as Record<string, unknown>;
}

function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label}: authentication response is missing a token`);
  return value;
}

export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "Enter a complete server URL, such as https://sync.example.com",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Server URLs must use HTTP(S), without credentials, a query, or a fragment",
    );
  return url.href.replace(/\/+$/, "");
}

class Client {
  private accessToken = "";
  private refreshToken = "";
  private readonly base: string;
  private readonly label: string;

  constructor(
    private credentials: ServerCredentials,
    private readonly legacy: boolean,
  ) {
    this.base = normalizeServerUrl(credentials.url);
    this.label = legacy ? "Old server" : "New server";
  }

  private async json(
    method: string,
    path: string,
    body?: unknown,
    authenticated = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authenticated
            ? { authorization: `Bearer ${this.accessToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        `${this.label}: ${path.split("?")[0]} could not be reached (30-second timeout; redirects are not followed)`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Do not print response bodies: they can contain tokens or account data.
      throw new HttpError(this.label, path, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(
        `${this.label}: ${path.split("?")[0]} returned invalid JSON`,
      );
    }
  }

  async login() {
    const response = object(
      await this.json("POST", "auth/login", {
        username: this.credentials.username,
        password: this.credentials.password,
      }),
      `${this.label} login response`,
    );
    this.refreshToken = token(response.refreshToken, this.label);
    if (this.legacy) this.accessToken = token(response.accessToken, this.label);
    else await this.refresh();
  }

  private async refresh() {
    const response = object(
      await this.json("POST", "auth/refresh", {
        refreshToken: this.refreshToken,
      }),
      `${this.label} refresh response`,
    );
    this.accessToken = token(response.accessToken, this.label);
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      return await this.json(method, path, body, true);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
    }
    try {
      await this.refresh();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      await this.login();
    }
    // Retry with the same body, preserving operation IDs and datetimes.
    return this.json(method, path, body, true);
  }
}

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
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): Promise<MigrationSummary> {
  if (normalizeServerUrl(oldServer.url) === normalizeServerUrl(newServer.url))
    throw new Error("The old and new server URLs must be different");
  const log = options.log ?? (() => {});
  const source = new Client(oldServer, true);
  const destination = new Client(newServer, false);
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

  let batchSize = 100;
  for (let offset = 0; offset < mutations.length;) {
    const batch = mutations.slice(offset, offset + batchSize);
    let response: Record<string, unknown>;
    try {
      response = object(
        await destination.request("POST", "sync", {
          cursor: null,
          limit: 1,
          mutations: batch,
        }),
        "new server sync response",
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        [400, 413].includes(error.status) &&
        batch.length > 1
      ) {
        batchSize = Math.max(1, Math.floor(batch.length / 2));
        log(
          `Reducing upload batch size to ${batchSize} to fit the new server's limits.`,
        );
        continue;
      }
      throw error;
    }
    if (
      !Array.isArray(response.results) ||
      response.results.length !== batch.length
    )
      throw new Error(
        "New server: sync response has an unexpected number of results",
      );
    for (const [index, value] of response.results.entries()) {
      const result = object(value, "new server mutation result");
      if (result.operationId !== batch[index]!.operationId)
        throw new Error(
          "New server: mutation result operation ID does not match",
        );
      if (result.status === "applied") summary.applied++;
      else if (result.status === "ignored") summary.ignored++;
      else
        throw new Error(
          `New server rejected a mutation at export index ${offset + index}`,
        );
    }
    offset += batch.length;
    log(
      `Uploaded ${offset}/${mutations.length}: ${summary.applied} applied, ${summary.ignored} unchanged.`,
    );
  }
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
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run this command in an interactive terminal to enter credentials securely",
    );

  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const prompts = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const abort = new AbortController();
  prompts.on("SIGINT", () => abort.abort());
  prompts.on("close", () => abort.abort());
  const ask = async (label: string, secret = false): Promise<string> => {
    for (;;) {
      let answer: string;
      try {
        hidden = secret;
        if (secret) process.stdout.write(label);
        answer = await prompts.question(secret ? "" : label, {
          signal: abort.signal,
        });
      } catch {
        throw new Error("Migration cancelled");
      } finally {
        hidden = false;
        if (secret) process.stdout.write("\n");
      }
      if (secret ? answer.length > 0 : answer.trim().length > 0)
        return secret ? answer : answer.trim();
      console.log("A value is required.");
    }
  };
  const server = async (
    label: string,
    accountLabel: string,
  ): Promise<ServerCredentials> => {
    let url: string;
    for (;;) {
      try {
        url = normalizeServerUrl(await ask(`${label} server URL: `));
        break;
      } catch (error) {
        if (abort.signal.aborted) throw error;
        console.log(error instanceof Error ? error.message : "Invalid URL");
      }
    }
    return {
      url,
      username: await ask(`${label} ${accountLabel}: `),
      password: await ask(`${label} password: `, true),
    };
  };

  console.log(
    "Migrate one account from Mankai Sync v1 to the new server.\nStop syncing to the old server during migration. Plugin URLs are not available in v1.",
  );
  let oldServer: ServerCredentials;
  let newServer: ServerCredentials;
  try {
    oldServer = await server("Old", "email");
    newServer = await server("New", "username");
  } finally {
    prompts.close();
    output.end();
  }
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
