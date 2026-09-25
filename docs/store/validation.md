# Desktop store launch acceptance

Firefox [private-archive issue #26](https://github.com/htxryan/anmerko-private-archive/issues/26),
Chrome [private-archive issue #27](https://github.com/htxryan/anmerko-private-archive/issues/27),
and Edge [private-archive issue #35](https://github.com/htxryan/anmerko-private-archive/issues/35)
are complete. On September 19,
2026, the owner clarified that practical launch verification is sufficient;
an exhaustive native certification matrix and a future version's update are
not blockers for the current launch.

A store launch requires public approval, an actual store installation and core
workflow smoke test, verified package identity, applicable automated regressions,
and accurate published installation guidance. All three browsers meet that bar.
Unrun scenarios below remain unrun; closure does not turn them into passing tests.

## Completed evidence

| Browser | Public release and real native installation | Observed core workflow | Evidence |
| --- | --- | --- | --- |
| Firefox | AMO 0.5.5; official Firefox 156.0 on macOS 26.6.2 ARM64 | Element/global comments, screenshots, clipboard/export, reload and full browser restart, protected-page recovery. Additional checks covered editing/drafts, shadow/form context, zoom/scroll crops, capture cancellation on navigation/tab switches, background wake, and clipboard-failure fallback. | [Sanitized verification summary](../evidence/anmerko/verification-summary.md) |
| Chrome | Chrome Web Store 0.5.5; official Chrome 153.0.8010.36 on macOS 26.6.2 ARM64 | Element/global comments, native screenshot crop, clipboard/export, appearance and preamble settings, reload retention, protected-page guidance. | [Sanitized verification summary](../evidence/anmerko/verification-summary.md) |
| Edge | Edge Add-ons 0.5.5; official Edge 153.0.4234.32 on macOS | Element/global comments, native screenshot crop, clipboard/export, reload retention, float/minimize/restore/dock, protected-page guidance and recovery. | [Sanitized verification summary](../evidence/anmerko/verification-summary.md) |

All three installed payloads match the selected release from source
`519a8c1e3417c68d3094e63f3c879f4262ba08e3`, allowing only documented store
signing/update metadata. The Chromium ZIP SHA-256 is
`d9ca4aa7c08b446429c78c706fb9b875286ecb48faa7606e108d4df0d032aebd`.
The listed Firefox XPI SHA-256 is
`d266bb09a36529453bef7d37d26d80dbf98e21c086184ebca75761ff719da9cb`.
The signed website Firefox 0.5.5.1 XPI SHA-256 is
`dc9aec89a3841c9faa47ffe5d7524e2589236e3f0ca78b154e9c16ed2e784267`.
See the [sanitized verification summary](../evidence/anmerko/verification-summary.md).

[Private-archive selected-source Check 34976898752](https://github.com/htxryan/anmerko-private-archive/actions/runs/34976898752)
passed applicable macOS and Linux browser regressions, including stable and
minimum Firefox candidate coverage. These are automated candidate checks;
the real store installations are independently recorded above.

Release automation is complete in
[private-archive state 018](https://github.com/htxryan/anmerko-private-archive/releases/download/automation-0-5-5-519a8c1e3417c68d3094e63f3c879f4262ba08e3/state-018.json).
The [installation hub](https://anmerko.com/docs/install/) and browser guides
cover Chrome/Edge/Firefox desktop, Edge/Firefox Android, supported stores,
manual alternatives, and unsupported mobile platforms. Private-archive PRs
[#120](https://github.com/htxryan/anmerko-private-archive/pull/120) and
[#124](https://github.com/htxryan/anmerko-private-archive/pull/124) updated and
verified the public guidance without changing approved installers.
Firefox Android has prior native signed-runtime acceptance and an exact runtime
payload match to the listed package; this does not claim a fresh Android AMO UI
installation. Edge Android support retains its documented owner verification.

## Continuing maintenance

- **Windows:** [#2](https://github.com/htxryan/anmerko/issues/2) owns native
  Windows testing; [#1](https://github.com/htxryan/anmerko/issues/1) owns the
  known Windows CI repair and hold.
- **Linux:** [#3](https://github.com/htxryan/anmerko/issues/3) owns native
  Linux testing beyond the existing automated coverage.
- **Store updates:** preserve useful 0.5.5 test installations and check ordinary
  update retention when the next approved release exists. A future release is
  not a prerequisite for closing this launch. The next release adds the
  `webNavigation` and `alarms` permissions for journeys. Chrome and Edge disable
  the updated extension until the user accepts the new "Read your browsing
  history" warning, and Firefox waits for the user to approve the new
  permission before applying the update. Include that approval in the
  retention check.
- **Additional coverage:** native minimum-version store actions and some
  extended platform cases remain unrun. Private audit evidence records their
  limits. Expand checks for changed behavior or actual failures; report
  concrete bugs as focused issues instead of reopening launch work for every
  possible combination.

The prelaunch preview had zero real users. Legacy data migration and
preview-to-store transition testing are not applicable. No migration is needed.
