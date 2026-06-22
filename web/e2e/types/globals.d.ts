// Minimal ambient declarations for the Node globals used by the Playwright
// config. `@types/node` is intentionally not a dependency of this package
// (route-mocked specs run in the browser), so we declare only what we use:
// `process.env` for CI/branch toggles in `playwright.config.ts`.
//
// The DOM lib already provides `URL`, `URLSearchParams`, `setTimeout`, etc.,
// which the fixtures rely on.

declare const process: {
  env: Record<string, string | undefined>;
};
