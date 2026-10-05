import { resolve, dirname } from "node:path";

import { createApp } from "./app";
import { loadConfig } from "./config";

const filename = resolve(Bun.argv[2] ?? "config.json");
const config = await loadConfig(filename);

if (config.database !== ":memory:")
  config.database = resolve(dirname(filename), config.database);

const app = createApp(config).listen({
  hostname: config.host,
  port: config.port,
});

console.log(`Mankai sync listening on ${app.server?.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.stop();
    process.exit(0);
  });
}
