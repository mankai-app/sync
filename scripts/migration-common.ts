import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import type { Mutation } from "../src/protocol";

export type ServerCredentials = {
  url: string;
  username: string;
  password: string;
};

export type MigrationOptions = {
  log?: (message: string) => void;
};

export class HttpError extends Error {
  constructor(
    label: string,
    path: string,
    readonly status: number,
  ) {
    super(`${label}: ${path.split("?")[0]} returned HTTP ${status}`);
  }
}

export function object(
  value: unknown,
  description: string,
): Record<string, unknown> {
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

export class Client {
  private accessToken = "";
  private refreshToken = "";
  private readonly base: string;

  constructor(
    private credentials: ServerCredentials,
    private readonly label: string,
    private readonly legacy = false,
  ) {
    this.base = normalizeServerUrl(credentials.url);
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

export async function uploadMutations(
  destination: Client,
  mutations: Mutation[],
  summary: { applied: number; ignored: number },
  log: (message: string) => void,
): Promise<void> {
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
}

export async function promptServers(
  oldAccountLabel = "username",
): Promise<[ServerCredentials, ServerCredentials]> {
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

  try {
    return [
      await server("Old", oldAccountLabel),
      await server("New", "username"),
    ];
  } finally {
    prompts.close();
    output.end();
  }
}
