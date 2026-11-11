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
  // Weekly audit. Each is optional: without it the part that needs it reports "not configured".
  RAILWAY_API_TOKEN: optional(z.string().min(20)),
  CURSOR_API_KEY: optional(z.string().min(20)),
  CURSOR_AGENT_MODEL: optional(z.string().min(1).max(100)),
  GITHUB_APP_ID: optional(z.string().regex(/^[A-Za-z0-9]+$/)),
  GITHUB_APP_PRIVATE_KEY: optional(z.string().min(100)),
  GITHUB_APP_INSTALLATION_ID: optional(z.string().regex(/^\d+$/)),
  // The Penguin deal room's own GitHub App, installed on that one repository. Without it an
  // approved Penguin proposal says "not configured" instead of opening a pull request.
  DEALROOM_GITHUB_APP_ID: optional(z.string().regex(/^[A-Za-z0-9]+$/)),
  DEALROOM_GITHUB_APP_PRIVATE_KEY: optional(z.string().min(100)),
  DEALROOM_GITHUB_APP_INSTALLATION_ID: optional(z.string().regex(/^\d+$/)),
  // The model steps of the audit. Without it the audit ranks by its rules and says so.
  ANTHROPIC_API_KEY: optional(z.string().min(20)),
  // Development and test only: point the clients at local fakes.
  RAILWAY_API_URL: optional(z.string().url()),
  CURSOR_API_URL: optional(z.string().url()),
  GITHUB_API_URL: optional(z.string().url()),
  ANTHROPIC_API_URL: optional(z.string().url()),
  CALENDLY_API_URL: optional(z.string().url()),
  FATHOM_API_URL: optional(z.string().url()),
  DEALROOM_GITHUB_API_URL: optional(z.string().url()),
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
  if (
    parsed.NODE_ENV === 'production' &&
    (parsed.RAILWAY_API_URL ||
      parsed.CURSOR_API_URL ||
      parsed.GITHUB_API_URL ||
      parsed.ANTHROPIC_API_URL ||
      parsed.CALENDLY_API_URL ||
      parsed.FATHOM_API_URL ||
      parsed.DEALROOM_GITHUB_API_URL)
  ) {
    throw new ConfigError(
      'RAILWAY_API_URL, CURSOR_API_URL, GITHUB_API_URL, ANTHROPIC_API_URL, CALENDLY_API_URL, FATHOM_API_URL and DEALROOM_GITHUB_API_URL must not be set in production',
    );
  }
  const base = common(parsed);
  const githubVars = {
    GITHUB_APP_ID: parsed.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: parsed.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_INSTALLATION_ID: parsed.GITHUB_APP_INSTALLATION_ID,
  };
  const dealRoomVars = {
    DEALROOM_GITHUB_APP_ID: parsed.DEALROOM_GITHUB_APP_ID,
    DEALROOM_GITHUB_APP_PRIVATE_KEY: parsed.DEALROOM_GITHUB_APP_PRIVATE_KEY,
    DEALROOM_GITHUB_APP_INSTALLATION_ID: parsed.DEALROOM_GITHUB_APP_INSTALLATION_ID,
  };
  return {
    ...base,
    tokenPrivateKey: parsed.TOKEN_PRIVATE_KEY,
    railwayApiToken: parsed.RAILWAY_API_TOKEN,
    railwayApiUrl: parsed.RAILWAY_API_URL,
    cursorApiKey: parsed.CURSOR_API_KEY,
    cursorAgentModel: parsed.CURSOR_AGENT_MODEL,
    cursorApiUrl: parsed.CURSOR_API_URL,
    github:
      parsed.GITHUB_APP_ID && parsed.GITHUB_APP_PRIVATE_KEY && parsed.GITHUB_APP_INSTALLATION_ID
        ? {
            appId: parsed.GITHUB_APP_ID,
            privateKey: parsed.GITHUB_APP_PRIVATE_KEY,
            installationId: parsed.GITHUB_APP_INSTALLATION_ID,
          }
        : undefined,
    githubApiUrl: parsed.GITHUB_API_URL,
    dealRoom:
      parsed.DEALROOM_GITHUB_APP_ID && parsed.DEALROOM_GITHUB_APP_PRIVATE_KEY && parsed.DEALROOM_GITHUB_APP_INSTALLATION_ID
        ? {
            appId: parsed.DEALROOM_GITHUB_APP_ID,
            privateKey: parsed.DEALROOM_GITHUB_APP_PRIVATE_KEY,
            installationId: parsed.DEALROOM_GITHUB_APP_INSTALLATION_ID,
          }
        : undefined,
    dealRoomApiUrl: parsed.DEALROOM_GITHUB_API_URL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicApiUrl: parsed.ANTHROPIC_API_URL,
    calendlyApiUrl: parsed.CALENDLY_API_URL,
    fathomApiUrl: parsed.FATHOM_API_URL,
    features: {
      /** Posting, editing messages, the channel list and the App Home tab. */
      slackApi: feature({
        SLACK_BOT_TOKEN: parsed.SLACK_BOT_TOKEN,
        SLACK_TEAM_ID: parsed.SLACK_TEAM_ID,
      }),
      tokenDecryption: feature({ TOKEN_PRIVATE_KEY: parsed.TOKEN_PRIVATE_KEY }),
      /** The weekly audit's collectors and the service inventory. Read-only. */
      railway: feature({ RAILWAY_API_TOKEN: parsed.RAILWAY_API_TOKEN }),
      /** Commits behind the default branch and dependency alerts, for the audit. */
      github: feature(githubVars),
      /** "Fix via agent": starting a Cursor agent on a linked repository after approval. */
      cursor: feature({ CURSOR_API_KEY: parsed.CURSOR_API_KEY }),
      /** Every model call: the audit's analysis, its ranking and the fix briefs. */
      anthropic: feature({ ANTHROPIC_API_KEY: parsed.ANTHROPIC_API_KEY }),
      /** Opening a content pull request on the Penguin deal room's repository after approval. */
      dealroom: feature(dealRoomVars),
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
