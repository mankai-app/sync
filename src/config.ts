import { t, type Static } from "elysia";
import { TypeCompiler } from "elysia/type-system";

const tokenLifetimeSchema = t.Number({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
});

const configSchema = t.Object(
  {
    host: t.String({ minLength: 1 }),
    port: t.Integer({ minimum: 1, maximum: 65535 }),
    database: t.String({ minLength: 1 }),
    jwt: t.Object(
      {
        secret: t.String({ minLength: 32 }),
        expiresInSeconds: tokenLifetimeSchema,
        refreshExpiresInSeconds: t.Optional(tokenLifetimeSchema),
      },
      { additionalProperties: false },
    ),
    sync: t.Object(
      {
        pageSize: t.Integer({ minimum: 1, maximum: 10000 }),
        maxMutations: t.Integer({ minimum: 1, maximum: 10000 }),
      },
      { additionalProperties: false },
    ),
    users: t.Array(
      t.Union([
        t.Object(
          {
            username: t.String({ minLength: 1, maxLength: 128 }),
            password: t.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        t.Object(
          {
            username: t.String({ minLength: 1, maxLength: 128 }),
            passwordHash: t.String({ pattern: "^\\$argon2id\\$" }),
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof configSchema>;

const validator = TypeCompiler.Compile(configSchema);

export async function loadConfig(filename: string): Promise<Config> {
  const config: unknown = await Bun.file(filename).json();

  if (!validator.Check(config)) {
    throw new Error(
      `Invalid config: ${validator.Errors(config).First()?.path}`,
    );
  }

  if (
    new Set(config.users.map((user) => user.username)).size !==
    config.users.length
  ) {
    throw new Error("Config usernames must be unique");
  }

  return config;
}
