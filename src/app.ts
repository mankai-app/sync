import { jwt } from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import { TypeCompiler } from "elysia/type-system";

import type { Config } from "./config";
import { syncRequestSchema, SyncError } from "./protocol";
import { createStore } from "./store";

export function createApp(config: Config) {
  const store = createStore(config.database, config.jwt.secret);
  const users = new Map(config.users.map((user) => [user.username, user]));
  const authentication = jwt({
    secret: config.jwt.secret,
    alg: "HS256",
    iss: "mankai-sync",
  });
  const verifyToken = async (
    token: string | undefined,
    audience: "access" | "refresh",
  ) => {
    const claims = await authentication.decorator.jwt.verify(token, {
      algorithms: ["HS256"],
      issuer: "mankai-sync",
      audience,
      requiredClaims: ["sub", "exp"],
    });

    return claims && typeof claims.sub === "string" && users.has(claims.sub)
      ? claims.sub
      : null;
  };

  const requestValidator = TypeCompiler.Compile(
    syncRequestSchema(config.sync.pageSize, config.sync.maxMutations),
  );

  return new Elysia()
    .use(authentication)
    .onError(({ code, error, status }) => {
      if (error instanceof SyncError)
        return status(400, { error: error.message });

      if (code === "VALIDATION" || code === "PARSE")
        return status(400, { error: "Invalid request" });

      if (code === "NOT_FOUND") return status(404, { error: "Not found" });

      console.error(error);

      return status(500, { error: "Internal server error" });
    })
    .post(
      "/auth/login",
      async ({ body, jwt, status }) => {
        const user = users.get(body.username);

        if (
          !user ||
          !("password" in user
            ? body.password === user.password
            : await Bun.password.verify(body.password, user.passwordHash))
        ) {
          return status(401, { error: "Invalid credentials" });
        }

        return {
          refreshToken: await jwt.sign({
            sub: user.username,
            aud: "refresh",
            exp:
              Math.floor(Date.now() / 1000) +
              (config.jwt.refreshExpiresInSeconds ?? 30 * 24 * 60 * 60),
          }),
        };
      },
      {
        body: t.Object(
          { username: t.String(), password: t.String() },
          { additionalProperties: false },
        ),
      },
    )
    .post(
      "/auth/refresh",
      async ({ body, jwt, status }) => {
        const username = await verifyToken(body.refreshToken, "refresh");
        if (!username) return status(401, { error: "Invalid refresh token" });

        return {
          accessToken: await jwt.sign({
            sub: username,
            aud: "access",
            exp: Math.floor(Date.now() / 1000) + config.jwt.expiresInSeconds,
          }),
        };
      },
      {
        body: t.Object(
          { refreshToken: t.String() },
          { additionalProperties: false },
        ),
      },
    )
    .post("/sync", async ({ body, headers, status }) => {
      const token = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? "")?.[1];
      const username = await verifyToken(token, "access");
      if (!username) return status(401, { error: "Unauthorized" });

      if (!requestValidator.Check(body))
        return status(400, { error: "Invalid sync request" });

      return store.sync(username, body, config.sync.pageSize);
    })
    .onStop(() => store.close());
}
