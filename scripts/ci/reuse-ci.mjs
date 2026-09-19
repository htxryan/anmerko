import { execFileSync } from 'node:child_process';
import { workflowVersion, requiredRunners } from './ci-policy.mjs';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredJobs = scope => ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
  ...requiredRunners(scope)
    .map(os => `Desktop browsers (${os}) / Browser scenarios`)];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const command = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...options,
});
const api = path => JSON.parse(command('gh', ['api', path]));

// Read one small JSON member, without extracting or executing anything from PRs.
export function readSource(repository, artifact) {
  const directory = mkdtempSync(join(tmpdir(), 'anmerko-ci-source-'));
  try {
    const archive = join(directory, 'source.zip');
    writeFileSync(archive, command('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
      encoding: 'buffer', maxBuffer: 65536,
    }));
    return JSON.parse(command('unzip', ['-p', archive, 'source.json'], { maxBuffer: 65536 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function findReusableCheck({ repository, commit, event, ref, scope = 'full', version = workflowVersion(), now = Date.now(), get = api, read = readSource }) {
  if (!['fast', 'full'].includes(scope)) return null;
  if (event !== 'push' || ref !== 'refs/heads/main' || !sha(commit)) return null;
  const root = `repos/${repository}`;
  const main = get(`${root}/git/commits/${commit}`);
  const associated = get(`${root}/commits/${commit}/pulls?per_page=100`);
  for (const item of associated) {
    const pr = get(`${root}/pulls/${item.number}`);
    if (!pr.merged || pr.merge_commit_sha !== commit || pr.base.ref !== 'main'
      || pr.base.repo.full_name !== repository || pr.head.repo?.full_name !== repository) continue;
    const runs = get(`${root}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=10`);
    for (const run of runs.workflow_runs) {
      const age = now - Date.parse(run.run_started_at);
      if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success'
        || run.path !== '.github/workflows/check.yml' || run.head_sha !== pr.head.sha
        || run.repository.full_name !== repository || run.head_repository.full_name !== repository
        || !(age >= 0 && age <= 24 * 60 * 60 * 1000)) continue;
      const { jobs } = get(`${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      if (!requiredJobs(scope).every(name => jobs.filter(job => job.name === name).length === 1
        && jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'))) continue;
      const { artifacts } = get(`${root}/actions/runs/${run.id}/artifacts?per_page=100`);
      const artifact = artifacts.find(a => a.name === `ci-source-${run.run_attempt}` && !a.expired && a.size_in_bytes <= 65536);
      if (!artifact) continue;
      const source = read(repository, artifact);
      if (source.schema !== 2 || source.workflowVersion !== version
        || !['fast', 'full'].includes(source.scope) || (scope === 'full' && source.scope !== 'full')
        || source.repository !== repository || source.runId !== run.id
        || source.runAttempt !== run.run_attempt || source.pr !== pr.number
        || source.head !== pr.head.sha || source.base !== main.parents[0]?.sha
        || !sha(source.sha) || !sha(source.tree) || source.tree !== main.tree.sha) continue;
      // Confirm the synthetic PR merge commit and both parents with GitHub,
      // not just the artifact's claim. Squash and ordinary merges are supported.
      const tested = get(`${root}/git/commits/${source.sha}`);
      if (tested.tree.sha !== main.tree.sha || tested.parents.length !== 2
        || tested.parents[0].sha !== source.base || tested.parents[1].sha !== source.head) continue;
      return { runId: run.id, pr: pr.number, source: source.sha, tree: source.tree,
        url: `https://github.com/${repository}/actions/runs/${run.id}` };
    }
  }
  return null;
}

export function reuseOrRun(options) {
  try { return { reuse: findReusableCheck(options), reason: 'No recent passing PR check matches the merged source.' }; }
  catch { return { reuse: null, reason: 'PR evidence could not be verified; running the normal checks.' }; }
}

function main() {
  const env = process.env;
  if (process.argv[2] === 'record') {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const git = ref => command('git', ['rev-parse', ref]).trim();
    const source = { schema: 2, scope: env.VALIDATION_SCOPE, workflowVersion: workflowVersion(), repository: env.GITHUB_REPOSITORY,
      runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, pr: event.number, sha: git('HEAD'), tree: git('HEAD^{tree}'),
      base: event.pull_request?.base.sha, head: event.pull_request?.head.sha };
    if (source.sha !== env.GITHUB_SHA) throw new Error('Checkout does not match the workflow commit');
    writeFileSync(join(env.RUNNER_TEMP, 'source.json'), JSON.stringify(source) + '\n');
    return;
  }
  const result = reuseOrRun({ repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, scope: env.VALIDATION_SCOPE });
  const summary = result.reuse
    ? `Reusing the selected extension validation scope from [PR #${result.reuse.pr}](${result.reuse.url}): GitHub confirms the same tree \`${result.reuse.tree}\` and merge base. Relevant website changes are built and tested separately.`
    : result.reason;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${Boolean(result.reuse)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
