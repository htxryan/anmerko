# Legacy site retirement

The legacy archive design was superseded on 15 September 2026 and its local
builder is no longer part of this repository. Both old hostnames redirect to
`https://anmerko.com/`, dropping paths and queries. Do not restore archive
compatibility, release-dependent cutover logic, observation gates, or retired
deployment instructions.

Keep signed installers, immutable release records, and historical hashes
unchanged. See the [current cutover and rollback runbook](legacy-domain-cutover.md)
for the active redirect policy and verification steps.
