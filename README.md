# WorkCode

WorkCode is the project editor for WorkOS. It also runs as a standalone progressive web app with offline editing, TypeScript language tools, and browser-local projects. Inside WorkOS it can open existing library documents, edit project folders in place, and connect to Linux and SSH terminals.

## Run locally

Use Node.js 22.12 or later. Run `npm ci` and `npm run dev` from the repository root. To try the installable build, run `npm run build` followed by `npm run preview`. The production site is in `dist/code/` and can be served from an HTTPS directory.

## Release for WorkOS

Run `npm run release:zip` with Python 3 available. Publish `dist/WorkCode-v1.zip` as an asset on a stable GitHub release tagged `vMAJOR.MINOR.PATCH`. The asset name identifies bridge version 1. WorkOS checks GitHub’s asset size and SHA-256 before activating a release. Each window keeps using the version it opened with.

[Download a release](https://github.com/monokaijs/WorkCode/releases)
