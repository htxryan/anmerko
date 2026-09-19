import { execFileSync } from 'node:child_process';
import { activeRepository } from './release-repository.mjs';
// Standard hosted runner rates, checked 2026-09-13 against GitHub's pricing docs.
const rates = { linux: 0.006, windows: 0.010, macos: 0.062 };
const repository = activeRepository(), runs = [];
for (const id of process.argv.slice(2)) {
  if (!/^\d+$/.test(id)) throw new Error('Expected numeric workflow run IDs');
  const { jobs } = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${id}/jobs?per_page=100`], { encoding: 'utf8' }));
  if (jobs.length >= 100) throw new Error('Job list may be truncated');
  const measured = jobs.filter(j => j.started_at && j.completed_at && j.conclusion !== 'skipped' && j.runner_name).map(job => {
    const labels = job.labels.map(label => label.toLowerCase());
    const selfHosted = labels.includes('self-hosted');
    const os = labels.some(l => l.startsWith('macos')) ? 'macos' : labels.some(l => l.startsWith('windows')) ? 'windows' : 'linux';
    const seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
    return { name: job.name, runner: job.runner_name, selfHosted, os, conclusion: job.conclusion, seconds, roundedMinutes: Math.ceil(seconds / 60), estimatedUSD: selfHosted ? 0 : Math.ceil(seconds / 60) * rates[os] };
  });
  runs.push({ id: Number(id), url: `https://github.com/${repository}/actions/runs/${id}`, jobs: measured,
    seconds: measured.reduce((n, j) => n + j.seconds, 0), estimatedUSD: measured.reduce((n, j) => n + j.estimatedUSD, 0) });
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), rates, pricing: 'https://docs.github.com/en/billing/reference/actions-runner-pricing',
  note: 'Execution wall time per job, rounded up per GitHub. Self-hosted compute costs zero. Estimate before allowances, taxes, storage and account-specific billing. Release frequency must be reported separately.', runs }, null, 2));
