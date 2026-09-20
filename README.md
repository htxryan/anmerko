<p align="center">
  <img src="public/icons/128.png" alt="anmerko logo" width="80" height="80">
</p>

<h1 align="center">anmerko</h1>

<p align="center">
Collect website comments and screenshots, then share them with your AI agent.
</p>

<p align="center">
  <a href="https://anmerko.com/">Website</a> ·
  <a href="https://anmerko.com/docs/">Documentation</a> ·
  <a href="https://github.com/htxryan/anmerko/releases">Releases</a>
</p>

## Get started

**anmerko** is a browser extension for desktop (Chrome, Edge, and Firefox) or mobile (Edge and Firefox for Android, and Orion for iPhone). It stores feedback in your browser and needs no account or API key. You choose when to export or share it.

[Install for desktop or mobile browsers](https://anmerko.com/docs/install/) to try it on any website.

![anmerko element feedback on Salad Recipe Finder](site/public/screenshots/01-element-feedback.png)

## Development

Use Node.js 24+. From the repository root:

```sh
npm ci
npx playwright install chromium
npm run check
npm run site:build
```

`site:build` compiles the current shared demo UI and uses approved installer bytes.
Private release assets require authenticated `gh` or `GH_TOKEN` with repository read access.

Development guides are kept in this repository:

- [Contributing](docs/contributing.md)
- [Build and test](docs/development.md)
- [CI scopes, release validation and promotion](docs/release-process.md)
- [Site deployment and rollback](docs/site-deployment.md)
- [Store publishing and listing assets](docs/store/distribution.md)
- [Project agent skills for Codex CLI, Claude Code, and OpenCode](.agents/README.md)

## License

[MIT](LICENSE) © 2026 [Ryan Henderson](https://ryanhenderson.dev).
