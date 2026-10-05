import { defineConfig } from "drizzle-kit";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Config } from "./src/config";

const config = JSON.parse(readFileSync("config.json", "utf8")) as Config;

const database =
  config.database === ":memory:" ? ":memory:" : resolve(config.database);

if (database !== ":memory:") mkdirSync(dirname(database), { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  dbCredentials: { url: database },
});
