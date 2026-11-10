import { describe, expect, it } from 'vitest';
import { ConfigError, loadMigrateConfig, loadWebConfig, loadWorkerConfig } from '../src/config.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(48),
};
const slack = {
  SLACK_TEAM_ID: 'T0HUB',
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  SLACK_CLIENT_ID: '1.2',
  SLACK_CLIENT_SECRET: 'client-secret-value',
  SLACK_SIGNING_SECRET: 'signing-secret-value',
  BOOTSTRAP_OWNER_SLACK_USER_ID: 'U0OWNER',
};

describe('configuration', () => {
  it('starts with only the database and session secret, reporting the rest as not configured', () => {
    const config = loadWebConfig({ ...required, RAILWAY_PUBLIC_DOMAIN: 'web-production.up.railway.app' });
    expect(config.appBaseUrl).toBe('https://web-production.up.railway.app');
    expect(config.features.slackRequests).toEqual({ configured: false, missing: ['SLACK_SIGNING_SECRET', 'SLACK_TEAM_ID'] });
    expect(config.features.slackModals).toEqual({ configured: false, missing: ['SLACK_BOT_TOKEN'] });
    expect(config.features.signIn).toEqual({
      configured: false,
      missing: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_TEAM_ID', 'BOOTSTRAP_OWNER_SLACK_USER_ID'],
    });

    const worker = loadWorkerConfig({ DATABASE_URL: required.DATABASE_URL });
    expect(worker.features.slackApi).toEqual({ configured: false, missing: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'] });
  });

  it('reports every feature configured once the Slack variables are set', () => {
    const config = loadWebConfig({ ...required, ...slack, APP_BASE_URL: 'https://patcher.example.com/' });
    expect(config.appBaseUrl).toBe('https://patcher.example.com');
    expect(config.features.slackRequests.configured).toBe(true);
    expect(config.features.slackModals.configured).toBe(true);
    expect(config.features.signIn.configured).toBe(true);
    expect(loadWorkerConfig({ ...required, ...slack }).features.slackApi.configured).toBe(true);
  });

  it('treats an empty variable as unset', () => {
    const config = loadWebConfig({ ...required, SLACK_SIGNING_SECRET: '', SLACK_TEAM_ID: '  ' });
    expect(config.features.slackRequests.missing).toEqual(['SLACK_SIGNING_SECRET', 'SLACK_TEAM_ID']);
  });

  it('refuses to start without the database URL or with a short session secret', () => {
    expect(() => loadWebConfig({ SESSION_SECRET: required.SESSION_SECRET })).toThrow(/DATABASE_URL/);
    expect(() => loadWebConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(/SESSION_SECRET/);
    expect(() => loadWebConfig({ ...required, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadMigrateConfig({})).toThrow(/DATABASE_URL/);
  });

  it('names the variable in an error but never repeats its value', () => {
    const bad = { ...required, SLACK_TEAM_ID: 'not-a-team-id-SECRETVALUE' };
    let message = '';
    try {
      loadWebConfig(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('SLACK_TEAM_ID');
    expect(message).not.toContain('SECRETVALUE');
  });

  it('reads the dry-run switch from the environment', () => {
    expect(loadWorkerConfig({ ...required }).dryRunEnv).toBe(false);
    expect(loadWorkerConfig({ ...required, DRY_RUN: '1' }).dryRunEnv).toBe(true);
    expect(loadWorkerConfig({ ...required, DRY_RUN: 'true' }).dryRunEnv).toBe(true);
    expect(loadWorkerConfig({ ...required, DRY_RUN: '0' }).dryRunEnv).toBe(false);
  });

  it('refuses the development-only Slack overrides in production', () => {
    const production = { ...required, NODE_ENV: 'production' };
    expect(() => loadWebConfig({ ...production, SLACK_API_URL: 'http://localhost:4010/api/' })).toThrow(/SLACK_API_URL/);
    expect(() => loadWebConfig({ ...production, SLACK_OIDC_URL: 'http://localhost:4010' })).toThrow(/SLACK_OIDC_URL/);
    expect(() => loadWorkerConfig({ ...production, SLACK_API_URL: 'http://localhost:4010/api/' })).toThrow(/SLACK_API_URL/);
    expect(loadWebConfig({ ...required, SLACK_OIDC_URL: 'http://localhost:4010' }).slackOidcUrl).toBe('http://localhost:4010');
  });
});
