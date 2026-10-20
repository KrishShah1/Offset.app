# Tests

No framework and no runner in `package.json`. Each file is a script that
asserts, prints a `PASS` / `**FAIL**` line per assertion, and ends with a count.
A suite exits non-zero if anything failed, so it works in CI as-is.

## Logic — `tests/logic/`

Pure functions from `src/lib/`. No build, no browser.

```sh
npx vite-node tests/logic/metals.test.mjs
```

`vite-node` rather than plain `node` because the modules under test are written
for Vite's resolver. The exception is `billsorter.test.mjs`, which tests the
Google Apps Script in `apps-script/bill-sorter/` rather than `src/lib/`, and runs
under plain `node`.

| Suite | Assertions | Covers |
|---|---|---|
| `billsorter.test.mjs` | 208 | Gmail bill sorter: matching, months, duplicates, time limits |
| `brokers.test.mjs` | 42 | broker holdings exports, column aliasing |
| `corp.test.mjs` | 106 | entities, control, ledgers, audit events |
| `i18n.test.mjs` | 81 | dictionaries, plurals, coverage |
| `invoice.test.mjs` | 66 | template language, GST, totals |
| `langs.test.mjs` | 139 | the thirteen languages, RTL, detection |
| `metals.test.mjs` | 92 | units, purity, quoting, session close |
| `onboarding.test.mjs` | 44 | empty install, sample data |
| `ops.test.mjs` | 151 | inventory, payables, advances, payroll |
| `store.test.mjs` | 65 | corporate storage layer |
| | **994** | |

## Browser — `tests/browser/`

Playwright against the **production build**, never the dev server.

```sh
VITE_OPEN_ACCESS=true npx vite build
npx vite preview --port 4188 &
node tests/browser/rtlui.mjs
```

| Suite | Assertions | Covers |
|---|---|---|
| `corpui.mjs` | 41 | companies nav, switcher, consolidated view |
| `flows.mjs` | 35 | create, edit, delete, filter, restore, export, keyboard |
| `invoiceui.mjs` | 32 | default and imported templates, GST, PDF download |
| `langui.mjs` | 53 | the language picker and what it changes |
| `metalsui.mjs` | 27 | metal holdings on screen |
| `namecheck.mjs` | 6 | asset names resolve on every row |
| `onboardui.mjs` | 22 | the empty install |
| `reportui.mjs` | 33 | the problem-report flow |
| `rtlui.mjs` | 54 | Arabic and Urdu mirror correctly |
| | **303** | |

Playwright is not a dependency of the app; `_playwright.mjs` resolves it from
the environment. Override either default if your machine differs:

- `PLAYWRIGHT_MODULE` — path to Playwright's `index.mjs`
  (default `/opt/node22/lib/node_modules/playwright/index.mjs`)
- `OFFSET_TEST_URL` — where the preview server is listening
  (default `http://localhost:4188`)

**Do not remove `serviceWorkers: 'block'`** from any browser context. The PWA
worker serves stale chunks and will make a fixed bug look unfixed. This cost
hours twice.
