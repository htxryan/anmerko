export function releaseNotes(candidate) {
  const rows = [];
  for (const [browser, label] of [['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox (desktop and Android)']]) {
    const artifact = candidate.browsers[browser];
    if (artifact) rows.push(`| ${label} | \`${artifact.filename}\` | [Install or update](https://anmerko.com/docs/install/${browser}/) |`);
  }
  return `anmerko ${candidate.version}

Download your browser's installer from **Assets** below, then follow its installation guide.

| Browser | Download | Instructions |
| --- | --- | --- |
${rows.join('\n')}

Chrome and Edge use equivalent Chromium bundles. Firefox uses a Mozilla-signed XPI; keep it intact. GitHub's Source code archives are not installers. If a browser is absent from this release, use its latest published installer from an earlier release.

[Manual installation guides](https://anmerko.com/docs/install/)

Validated source: ${candidate.source}

The remaining files retain release evidence. Website promotion and extension-store review are separate.
`;
}
