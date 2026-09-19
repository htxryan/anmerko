import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export function siteAffected(path) {
  return /^(?:src\/|public\/icons\/128\.png$|site\/|releases\/|package(?:-lock)?\.json$|\.github\/|scripts\/(?:build-site|approved-release|verify-approved-release|build-store-site|verify-site-deployment|capture-deployment-state|deployment-eligibility)\.mjs$|scripts\/(?:site\/(?:build-site|build-support-site)|release\/(?:approved-release|verify-approved-release)|deployment\/(?:verify-site-deployment|capture-deployment-state|deployment-eligibility))\.mjs$)/.test(path);
}
export function canDeployAfter(source, latest, comparison) {
  if (source === latest) return true;
  return comparison.merge_base_commit?.sha === source
    && ['ahead', 'identical'].includes(comparison.status)
    && comparison.files.length < 300
    && !comparison.files.some(file => siteAffected(file.filename) || (file.previous_filename && siteAffected(file.previous_filename)));
}
if (import.meta.main) {
  const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`], { encoding: 'utf8', timeout: 30000 }));
  if (process.argv[2] === 'site-tested') {
    const run = api(`actions/runs/${process.env.CHECK_RUN}`);
    assert.equal(run.event, 'push'); assert.equal(run.head_branch, 'main'); assert.equal(run.conclusion, 'success');
    const { jobs } = api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const site = jobs.filter(job => job.name === 'Site');
    assert.equal(site.length, 1);
    assert.ok(['success', 'skipped'].includes(site[0].conclusion));
    appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${site[0].conclusion === 'success'}\n`);
  } else {
    const latest = api('git/ref/heads/main').object.sha;
    const publish = canDeployAfter(process.env.SOURCE_SHA, latest,
      process.env.SOURCE_SHA === latest ? null : api(`compare/${process.env.SOURCE_SHA}...${latest}`));
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${publish ? 'Current website inputs; publish' : 'Superseded website inputs; skip'} ${process.env.SOURCE_SHA}.\n`);
  }
}
