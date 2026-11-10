import { z } from 'zod';

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const optional = (schema: z.ZodString) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .pipe(schema.optional());

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: optional(z.string().url()),
  RAILWAY_PUBLIC_DOMAIN: optional(z.string()),
  DRY_RUN: flag,
  SLACK_TEAM_ID: optional(z.string().regex(/^T[A-Z0-9]+$/)),
  SLACK_BOT_TOKEN: optional(z.string().min(10)),
  // Development and test only: point the Slack client at a local fake.
  SLACK_API_URL: optional(z.string().url()),
});

const webSchema = baseSchema.extend({
  SESSION_SECRET: z.string().min(32),
  SLACK_CLIENT_ID: optional(z.string().min(3)),
  SLACK_CLIENT_SECRET: optional(z.string().min(10)),
  SLACK_SIGNING_SECRET: optional(z.string().min(10)),
  BOOTSTRAP_OWNER_SLACK_USER_ID: optional(z.string().regex(/^[UW][A-Z0-9]+$/)),
  TOKEN_PUBLIC_KEY: optional(z.string().min(100)),
  // Development and test only: point Sign in with Slack at a local fake.
  SLACK_OIDC_URL: optional(z.string().url()),
});

const workerSchema = baseSchema.extend({
  TOKEN_PRIVATE_KEY: optional(z.string().min(100)),
});

export class ConfigError extends Error {}

/** A feature that needs owner-supplied variables, and which of them are missing. */
export interface FeatureStatus {
  configured: boolean;
  missing: string[];
}

function feature(vars: Record<string, string | undefined>): FeatureStatus {
  const missing = Object.entries(vars)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  return { configured: missing.length === 0, missing };
}

function parse<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Names only. Values must never reach a log line.
    const names = [...new Set(result.error.issues.map((i) => i.path.join('.')))].sort();
    throw new ConfigError(`Missing or invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}

function common(parsed: z.infer<typeof baseSchema>) {
  if (parsed.NODE_ENV === 'production' && parsed.SLACK_API_URL) {
    throw new ConfigError('SLACK_API_URL must not be set in production');
  }
  const appBaseUrl = (
    parsed.APP_BASE_URL ??
    (parsed.RAILWAY_PUBLIC_DOMAIN ? `https://${parsed.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${parsed.PORT}`)
  ).replace(/\/+$/, '');
  return {
    env: parsed.NODE_ENV,
    isProduction: parsed.NODE_ENV === 'production',
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    appBaseUrl,
    dryRunEnv: parsed.DRY_RUN,
    hubTeamId: parsed.SLACK_TEAM_ID,
    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackApiUrl: parsed.SLACK_API_URL,
  };
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = parse(webSchema, env);
  if (parsed.NODE_ENV === 'production' && parsed.SLACK_OIDC_URL) {
    throw new ConfigError('SLACK_OIDC_URL must not be set in production');
  }
  const base = common(parsed);
  return {
    ...base,
    sessionSecret: parsed.SESSION_SECRET,
    slackClientId: parsed.SLACK_CLIENT_ID,
    slackClientSecret: parsed.SLACK_CLIENT_SECRET,
    slackSigningSecret: parsed.SLACK_SIGNING_SECRET,
    bootstrapOwner: parsed.BOOTSTRAP_OWNER_SLACK_USER_ID,
    tokenPublicKey: parsed.TOKEN_PUBLIC_KEY,
    slackOidcUrl: parsed.SLACK_OIDC_URL,
    features: {
      /** Events, buttons and the slash command. */
      slackRequests: feature({
        SLACK_SIGNING_SECRET: parsed.SLACK_SIGNING_SECRET,
        SLACK_TEAM_ID: parsed.SLACK_TEAM_ID,
      }),
      /** The Edit modal, which web opens itself inside Slack's three-second window. */
      slackModals: feature({ SLACK_BOT_TOKEN: parsed.SLACK_BOT_TOKEN }),
      signIn: feature({
        SLACK_CLIENT_ID: parsed.SLACK_CLIENT_ID,
        SLACK_CLIENT_SECRET: parsed.SLACK_CLIENT_SECRET,
        SLACK_TEAM_ID: parsed.SLACK_TEAM_ID,
        BOOTSTRAP_OWNER_SLACK_USER_ID: parsed.BOOTSTRAP_OWNER_SLACK_USER_ID,
      }),
      tokenEncryption: feature({ TOKEN_PUBLIC_KEY: parsed.TOKEN_PUBLIC_KEY }),
    },
  };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = parse(workerSchema, env);
  const base = common(parsed);
  return {
    ...base,
    tokenPrivateKey: parsed.TOKEN_PRIVATE_KEY,
    features: {
      /** Posting, editing messages, the channel list and the App Home tab. */
      slackApi: feature({
        SLACK_BOT_TOKEN: parsed.SLACK_BOT_TOKEN,
        SLACK_TEAM_ID: parsed.SLACK_TEAM_ID,
      }),
      tokenDecryption: feature({ TOKEN_PRIVATE_KEY: parsed.TOKEN_PRIVATE_KEY }),
    },
  };
}

export function loadMigrateConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = parse(
    z.object({ DATABASE_URL: z.string().min(1), LOG_LEVEL: baseSchema.shape.LOG_LEVEL }),
    env,
  );
  return { databaseUrl: parsed.DATABASE_URL, logLevel: parsed.LOG_LEVEL };
}

export type WebConfig = ReturnType<typeof loadWebConfig>;
export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
