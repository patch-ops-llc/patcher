import { describe, expect, it } from 'vitest';
import { createRepoAdapter, manualSteps } from '../src/dealroom/adapter.js';
import { prepareFiles } from '../src/dealroom/files.js';
import { DealRoomError, assertContentPath, createDealRoomRepo } from '../src/dealroom/github.js';
import { APP_KEY, DEALROOM_REPO, FakeGitHub } from './fixtures/sales.js';

/**
 * The deal room's repository client and the adapter over it, against a stand-in for
 * GitHub's API. The real repository was never read or written by these tests or by anything
 * else in this phase.
 */
const PROPOSAL = ['# Order sync for Larkfield', '', '## Summary', '', 'A sync into billing.', '', '## Scope', '', '- The sync', '- The dashboard'].join('\n');

function setup() {
  const github = new FakeGitHub();
  const repo = createDealRoomRepo({ appId: '4242', privateKey: APP_KEY, installationId: '777', fetch: github.fetch });
  return { github, repo, adapter: createRepoAdapter(repo) };
}

const ctx = { repo: DEALROOM_REPO, company: 'Larkfield Outfitters', proposalTitle: 'Order sync for Larkfield', proposalVersion: 2, updateId: 'ab12cd34-0000-4000-8000-000000000000', appBaseUrl: 'http://patcher.test', proposalId: 'p-1' };
const input = (files: { path: string; content: string }[], branch = 'patcher/larkfield/proposal-v1-abcdef12') => ({
  repo: DEALROOM_REPO,
  slug: 'larkfield',
  branch,
  title: 'Deal room content',
  body: 'Body',
  commitMessage: 'content(larkfield): proposal v1',
  files,
});

describe('the deal room repository client', () => {
  it('asks for a token that is narrowed to the one repository, with contents and pull requests only', async () => {
    const { github, repo } = setup();
    await repo.listFolder(DEALROOM_REPO, 'larkfield');
    expect(github.tokenRequests).toEqual([{ repositories: ['dealroom'], permissions: { contents: 'write', pull_requests: 'write' } }]);
    // The token is reused, not requested for every call.
    await repo.listFolder(DEALROOM_REPO, 'larkfield');
    expect(github.tokenRequests).toHaveLength(1);
  });

  it('lists what a deal folder already holds, relative to it, and nothing for a folder that does not exist', async () => {
    const { github, repo } = setup();
    expect(await repo.listFolder(DEALROOM_REPO, 'larkfield')).toEqual([]);
    github.files.set('content/larkfield/overview.md', 'x');
    github.files.set('content/larkfield/proposal/01-old.md', 'x');
    github.files.set('content/other-deal/overview.md', 'x');
    expect((await repo.listFolder(DEALROOM_REPO, 'larkfield')).sort()).toEqual(['overview.md', 'proposal/01-old.md']);
  });

  it('opens a pull request from a new branch and never writes to the default branch', async () => {
    const { github, repo } = setup();
    const opened = await repo.openPullRequest(input([{ path: 'content/larkfield/overview.md', content: '# Hello\n' }]));
    expect(opened).toMatchObject({ url: `https://github.com/${DEALROOM_REPO}/pull/101`, number: 101, base: 'main', reused: false });

    // Four writes, each a creation: a tree, a commit, a new branch, a pull request.
    expect(github.writes().map((c) => `${c.method} ${c.path.replace(`/repos/${DEALROOM_REPO}`, '')}`)).toEqual(['POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
    expect(github.calls.some((c) => ['PUT', 'PATCH', 'DELETE'].includes(c.method))).toBe(false);
    expect(github.calls.some((c) => /\/merge|\/merges/.test(c.path))).toBe(false);
    expect(github.branches.get('main')).toBe('sha-main-1');
    expect(github.writes()[2]!.body).toMatchObject({ ref: 'refs/heads/patcher/larkfield/proposal-v1-abcdef12' });
    expect(github.pulls[0]).toMatchObject({ head: 'patcher/larkfield/proposal-v1-abcdef12', base: 'main', state: 'open', merged: false });
    expect(github.branchFiles('patcher/larkfield/proposal-v1-abcdef12')).toEqual([{ path: 'content/larkfield/overview.md', content: '# Hello\n' }]);
  });

  it('refuses a path outside the deal’s folder, a branch outside patcher/, and an empty or oversized change, before any request', async () => {
    const { github, repo } = setup();
    const outside = ['README.md', 'content/other/overview.md', 'content/larkfield/../other/x.md', 'content/larkfield/', '.github/workflows/deploy.yml', 'content/larkfield//x.md', '/content/larkfield/x.md'];
    for (const path of outside) {
      await expect(repo.openPullRequest(input([{ path, content: 'x' }])), path).rejects.toThrow(DealRoomError);
      expect(() => assertContentPath('larkfield', path), path).toThrow(/Refused to write outside/);
    }
    for (const branch of ['main', 'feature/x', 'refs/heads/main', 'patcher/../main', 'Patcher/x']) {
      await expect(repo.openPullRequest(input([{ path: 'content/larkfield/a.md', content: 'x' }], branch)), branch).rejects.toThrow(/not under patcher/);
    }
    await expect(repo.openPullRequest(input([]))).rejects.toThrow(/no file/);
    await expect(repo.openPullRequest(input(Array.from({ length: 41 }, (_, i) => ({ path: `content/larkfield/f${i}.md`, content: 'x' }))))).rejects.toThrow(/Too many/);
    await expect(repo.openPullRequest({ ...input([{ path: 'content/larkfield/a.md', content: 'x' }]), repo: 'not a repo' })).rejects.toThrow(/Not a repository name/);
    expect(github.calls).toEqual([]);
  });

  it('finishes an attempt that pushed its branch and stopped, without pushing again', async () => {
    const { github, repo } = setup();
    const files = [{ path: 'content/larkfield/overview.md', content: '# Hello\n' }];
    github.failOn = { match: '/pulls', status: 502, message: 'Bad gateway' };
    await expect(repo.openPullRequest(input(files))).rejects.toThrow(/could not open the pull request: Bad gateway \(HTTP 502\)/);
    expect(github.pulls).toHaveLength(0);

    const before = github.writes().length;
    const opened = await repo.openPullRequest(input(files));
    expect(opened).toMatchObject({ number: 101, reused: true });
    expect(github.writes().slice(before).map((c) => c.path.replace(`/repos/${DEALROOM_REPO}`, ''))).toEqual(['/pulls']);

    // A third call finds the open pull request and writes nothing.
    const again = await repo.openPullRequest(input(files));
    expect(again).toMatchObject({ number: 101, reused: true });
    expect(github.pulls).toHaveLength(1);
  });

  it('will not ask for review of an existing branch that touches anything outside the folder, or reuse a closed pull request', async () => {
    const { github, repo } = setup();
    const files = [{ path: 'content/larkfield/overview.md', content: '# Hello\n' }];
    await repo.openPullRequest(input(files));
    github.close(101);
    await expect(repo.openPullRequest(input(files))).rejects.toThrow(/no longer open/);

    // A branch with our name that someone else filled.
    const other = setup();
    other.github.seedBranch('patcher/larkfield/proposal-v1-abcdef12', [
      { path: 'content/larkfield/overview.md', content: 'x' },
      { path: '.github/workflows/deploy.yml', content: 'x' },
    ]);
    await expect(other.repo.openPullRequest(input(files))).rejects.toThrow(/changes files outside content\/larkfield\//);
    expect(other.github.writes()).toEqual([]);
  });

  it('reports what GitHub refused in words, and reads the state of a pull request', async () => {
    const { github, repo } = setup();
    github.failOn = { match: '/access_tokens', status: 403, message: 'Resource not accessible by integration' };
    await expect(repo.listFolder(DEALROOM_REPO, 'larkfield')).rejects.toThrow(/could not get a token for the repository: Resource not accessible by integration \(HTTP 403\)/);

    await repo.openPullRequest(input([{ path: 'content/larkfield/overview.md', content: '# Hello\n' }]));
    expect((await repo.pullRequest(DEALROOM_REPO, 101)).state).toBe('open');
    github.merge(101);
    expect((await repo.pullRequest(DEALROOM_REPO, 101)).state).toBe('merged');
  });
});

describe('the repository adapter', () => {
  it('finds a deal only by the slug a person saved', async () => {
    const { adapter, github } = setup();
    expect(await adapter.findDeal(DEALROOM_REPO, { dealRoomSlug: null })).toBeNull();
    expect(await adapter.findDeal(DEALROOM_REPO, { dealRoomSlug: '../x' })).toBeNull();
    github.files.set('content/larkfield/deal.json', '{}');
    expect(await adapter.findDeal(DEALROOM_REPO, { dealRoomSlug: 'larkfield' })).toEqual({ slug: 'larkfield', existingFiles: ['deal.json'] });
  });

  it('publishes the prepared files as a pull request whose body lists the files and what is left to do by hand', async () => {
    const { adapter, github } = setup();
    const prepared = adapter.prepareUpdate({ slug: 'larkfield', title: 'Order sync for Larkfield', contentMd: PROPOSAL });
    const found = (await adapter.findDeal(DEALROOM_REPO, { dealRoomSlug: 'larkfield' }))!;
    const published = await adapter.publish(prepared, found, ctx);

    expect(published).toMatchObject({ route: 'pull_request', status: 'pr_open', repo: DEALROOM_REPO, branch: 'patcher/larkfield/proposal-v2-ab12cd34', prNumber: 101 });
    expect(published.files.map((f) => f.path)).toEqual(['content/larkfield/overview.md', 'content/larkfield/proposal/01-summary.md', 'content/larkfield/proposal/02-scope.md']);
    const pull = github.pulls[0]!;
    expect(pull.title).toBe('Deal room content: Larkfield Outfitters proposal v2');
    expect(pull.body).toContain('**Patcher does not merge this.**');
    expect(pull.body).toContain('- `content/larkfield/proposal/02-scope.md`');
    expect(pull.body).toContain('- [ ] In the app, under Deal Admin');
    expect(pull.body).toContain('This is the first content for this room.');
    expect(pull.body).toContain('http://patcher.test/sales/proposals/p-1');
    expect(github.branchFiles(pull.head).every((f) => f.path.startsWith('content/larkfield/'))).toBe(true);
  });

  it('leaves an overview that is already in the room alone and names older section files it does not write', async () => {
    const { adapter, github } = setup();
    github.files.set('content/larkfield/overview.md', 'Written by a person.');
    github.files.set('content/larkfield/proposal/01-summary.md', 'old');
    github.files.set('content/larkfield/proposal/07-appendix.md', 'old');
    github.files.set('content/larkfield/proposal/03-timeline.json', '{}');
    const prepared = adapter.prepareUpdate({ slug: 'larkfield', title: 'T', contentMd: PROPOSAL });
    const found = (await adapter.findDeal(DEALROOM_REPO, { dealRoomSlug: 'larkfield' }))!;
    const published = await adapter.publish(prepared, found, ctx);

    expect(published.files.map((f) => f.path)).toEqual(['content/larkfield/proposal/01-summary.md', 'content/larkfield/proposal/02-scope.md']);
    expect(published.manualSteps.join('\n')).toMatch(/Already in the room and left as it is: overview\.md/);
    expect(published.manualSteps.join('\n')).toMatch(/does not write: proposal\/07-appendix\.md\./);
    expect(published.manualSteps.join('\n')).toMatch(/Check who can open the room before merging/);
    // Nothing is deleted: the pull request only adds and changes files.
    expect(github.branchFiles(github.pulls[0]!.head).map((f) => f.path)).toEqual(['content/larkfield/proposal/01-summary.md', 'content/larkfield/proposal/02-scope.md']);
  });

  it('refuses to publish files that failed their checks', async () => {
    const { adapter, github } = setup();
    const prepared = prepareFiles({ slug: 'larkfield', title: 'T', contentMd: '# T\n\n## One\n\n<b>x</b>' });
    await expect(adapter.publish(prepared, { slug: 'larkfield', existingFiles: [] }, ctx)).rejects.toThrow(/were not written/);
    expect(github.calls).toEqual([]);
  });

  it('always tells the person what a pull request cannot do', () => {
    const steps = manualSteps({ version: 3, firstContent: false, leftAlone: [], stale: [] });
    expect(steps[0]).toMatch(/Deal Admin.*proposal version \(v3\)/);
    expect(steps.join('\n')).toMatch(/No timeline or payment schedule visual/);
    expect(steps.join('\n')).toMatch(/Reset that edit in Deal Admin/);
  });
});
