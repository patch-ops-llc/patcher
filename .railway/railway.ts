import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

/**
 * The whole Patcher project on Railway: one Postgres, the public `web` service and the
 * private `worker` service, both built from this repository.
 *
 * Railway reads this file only when someone runs the CLI from a linked checkout:
 *
 *   railway config plan     # shows what would change, changes nothing
 *   railway config apply    # applies after confirmation
 *
 * This file describes the whole project: a service or variable that is removed from it is
 * deleted on the next apply. Secrets are never written here. `preserve()` means "keep the
 * value that is already set in Railway", so every variable a person sets in the dashboard
 * must be listed below or the next apply removes it.
 */

const REPO = 'patch-ops-llc/patcher';

// Until the first pull request is merged the code exists only on its branch.
const branch = process.env.PATCHER_DEPLOY_BRANCH ?? 'main';

export default defineRailway(() => {
  const db = postgres('Postgres');

  const shared = {
    source: github(REPO, { branch }),
    build: 'npm run build',
    healthcheck: '/health',
    healthcheckTimeout: 120,
    deploy: {
      // Versioned SQL migrations, then the queue's schema. Safe to run from both services.
      preDeployCommand: ['npm run migrate'],
      // Restart on failure with 10 retries is Railway's default. Stating a default here
      // makes every plan report a change, so it is left out.
    },
  } satisfies Parameters<typeof service>[1];

  const sharedEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: db.env.DATABASE_URL,
    // Set by the owner from the Slack app; see docs/setup-checklist.md.
    SLACK_TEAM_ID: preserve(),
    SLACK_BOT_TOKEN: preserve(),
  };

  // Public: Slack requests, the control UI and /health. It holds no credential that can
  // act on a third party except the bot token it needs to open a modal.
  const web = service('web', {
    ...shared,
    start: 'node dist/web.js',
    env: {
      ...sharedEnv,
      SESSION_SECRET: preserve(),
      TOKEN_PUBLIC_KEY: preserve(),
      SLACK_CLIENT_ID: preserve(),
      SLACK_CLIENT_SECRET: preserve(),
      SLACK_SIGNING_SECRET: preserve(),
      BOOTSTRAP_OWNER_SLACK_USER_ID: preserve(),
      // The password the inbound-mail service sends with forwarded Slack notification mail.
      INBOUND_EMAIL_WEBHOOK_SECRET: preserve(),
    },
  });

  // Private: no domain. Job consumers, the scheduler and every outbound call.
  const worker = service('worker', {
    ...shared,
    start: 'node dist/worker.js',
    env: {
      ...sharedEnv,
      // Where links in Slack messages point. The worker has no public domain of its own.
      APP_BASE_URL: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      TOKEN_PRIVATE_KEY: preserve(),
      // The weekly audit. Only the worker holds these; see docs/setup-checklist.md.
      RAILWAY_API_TOKEN: preserve(),
      CURSOR_API_KEY: preserve(),
      CURSOR_AGENT_MODEL: preserve(),
      GITHUB_APP_ID: preserve(),
      GITHUB_APP_PRIVATE_KEY: preserve(),
      GITHUB_APP_INSTALLATION_ID: preserve(),
      // The model that assesses, ranks and drafts. Unset: the rules rank the report.
      ANTHROPIC_API_KEY: preserve(),
      // The deal room's own GitHub App, which can only open a content pull request there.
      DEALROOM_GITHUB_APP_ID: preserve(),
      DEALROOM_GITHUB_APP_PRIVATE_KEY: preserve(),
      DEALROOM_GITHUB_APP_INSTALLATION_ID: preserve(),
    },
  });

  return project('Patcher', { resources: [db, web, worker] });
});
