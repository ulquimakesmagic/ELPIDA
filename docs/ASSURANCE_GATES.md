# Assurance gates: compile cache, test gate and claims

Three additions make the difference between "we ran the tests" and "this commit was verified".

## 1. Compile cache (`scripts/compile.mjs`)

Every test file that touches Solidity calls `compileContracts()` in its own process. Each call used to recompile all
36 contracts: about 48 seconds on the development PC, twelve times per suite run, with no cache.

The cache is content-addressed in `cache/solc/<sha256>.json` (already gitignored). The key covers:

- `solc.version()` (which includes the platform),
- the compiler settings (optimizer, `evmVersion`, output selection),
- every `.sol` file in `contracts/evm/src`, `contracts/evm/testnet` and — when requested — `tests/fixtures`,
- a hash of every `.sol` file under `node_modules/@openzeppelin/contracts`, so a dependency bump cannot reuse a
  stale artifact.

Writes are atomic (temporary file plus rename), the directory keeps the twelve newest entries, and a read-only or
full disk falls back to compiling. Compiler warnings are stored with the entry and replayed, so a cached run is
indistinguishable from a clean one. The EIP-170 size check runs on cache hits too.

`cache/solc` is restored between CI runs by `actions/cache`; because the key is content-addressed, a restored entry
can never be stale.

Set `ELPIDA_SOLC_CACHE=0` to force a clean compile. Release and audit builds should use it and record the result.

Measured on the development PC: cold 53 s, warm 1.9 s; `npm run test:evm` 167 s → 107 s.

## 2. Test gate (`scripts/test-gate.mjs`)

`node --test` exits 0 when everything it could run passed, even if most of it was skipped. On a machine without the
Solana CLI that is 28 of 29 Solana tests, silently.

`npm run test:gate` reads the TAP stream instead of the exit code:

| Situation | Exit |
|---|---|
| every test ran and passed | 0 |
| any failing test | 1 |
| a skip that is **not** a known missing toolchain | 2 |
| the same, when a skip is environmental, under `--strict` | 2 |
| no TAP summary (crash, hang, kill) | 4 |
| `--coverage` requested but Node produced no report | 5 |
| coverage below a requested floor | 6 |

Environmental skips are recognised by reason (`solana-test-validator not found`, `cargo not found`, …). They are
listed with the file that owns the test, never summarised away, and become fatal under `--strict`.

```
npm run test:gate                      # the whole suite
npm run test:gate:strict               # the whole suite, no environmental skips allowed
node scripts/test-gate.mjs tests/solana.test.mjs --strict
npm run test:coverage                  # the whole suite, with a coverage report
node scripts/test-gate.mjs tests --coverage --min-lines=78 --min-branches=79 --min-funcs=81
```

## 2b. Coverage

`--coverage` adds Node's V8 coverage for `packages/core`, `packages/indexer`, `apps/api` and `apps/web`, and enforces
floors (`--min-lines`, `--min-branches`, `--min-funcs`, or `COVERAGE_MIN_LINES` and friends). Node prints the table as
TAP comments, so the gate reads the `all files` row from the same stream it already parses.

Measured on the development PC, 25 October 2026, over the full suite (440 tests, 98 files):

| Lines | Branches | Functions |
|---|---|---|
| 80.73% | 81.25% | 83.53% |

CI enforces 78 / 79 / 81. Raise them when the measured numbers rise; never lower them to make a change pass.

## 3. Claims harness (`tests/claims.test.mjs`)

This repository's assurance rests on documents being true, so the load-bearing claims are asserted:

| Claim | Assertion |
|---|---|
| Audit scope | `docs/AUDIT_SCOPE.md` lists 9 files, each at its real non-blank, non-comment line count; the headline total matches the table (631 today) |
| One curve shape | `SALE_CAP`, `VIRTUAL_TOKEN`, `TOKEN_SUPPLY`, `FEE_BPS`, `SNIPE_START_BPS`, `SNIPE_WINDOW` are identical in Solidity and `packages/core/curve-model.mjs` |
| Registry honesty | unique `chainId` per network; well-formed factory addresses; `shared.block` after every legacy block; no factory listed twice; known model names |
| CSP | no executable inline `<script>` in `index.html`; the server still sends `script-src 'self'` and `style-src 'self'` |
| Docs | every `docs/…` link in `README.md` resolves |
| Test hygiene | no `.only`, no `assert.ok(true)`, every test file declares a test |
| CI wiring | every `npm run <script>` in `.github/workflows` exists in `package.json` |

Each was mutation-tested: editing a line count in the audit brief, or `BASE_FEE_BPS` in the shared model, turns the
suite red, and the file is restored byte-identically.

## 4. Continuous integration (`.github/workflows/verify.yml`)

**`contracts-and-unit`** — checkout, Node 24, `npm ci`, restore the compile cache, `npm run compile`,
`test:claims`, `security:scan`, `test:evm`, then the whole suite through `test:gate`.

**`solana`** — installs the pinned Solana CLI (v2.3.13, the version the 19 October binaries were built with) and the
Rust toolchain, then runs `tests/solana.test.mjs` with `--strict` (zero skips allowed) and the Rust property tests
(`npm run test:solana-host`).

## 5. What is still manual

- **Fork lifecycle runs** (`npm run test:chain-fork`, `test:base-fork`, `test:equity-*`) need archive-capable public
  RPC endpoints and minutes per network. They are not in CI. Each run now writes a sanitised report to `docs/evidence/`
  (the raw copy stays in the gitignored `backups/`), and older runs can be imported with
  `scripts/import-fork-report.mjs`; the first one is `docs/evidence/base-sepolia-fork-48075531.json`. A claims
  assertion fails when a report is incomplete, mentions a credential or is not mentioned by any document.
- **Static analysis** is reproducible but not automated: `pip install slither-analyzer solc-select`, `solc-select install
  0.8.24`, then the command in `AUDIT_SCOPE.md` §7. Its output is committed at
  `docs/security/slither-2026-10-25.json` (slither 0.11.6, solc 0.8.24, 82 findings with detector, file and line), and a
  claims assertion fails if those counts stop matching the brief. Add the toolchain to CI when the triage must track
  every change rather than a release.
- **The full suite runtime** is still minutes, not seconds. The cache removes the repeated compiles; the remaining
  cost is real Uniswap v3 deployments in the EVM tests, which is the point of those tests.
- **Coverage excludes `packages/solana` and the contracts.** Solidity and Rust are not V8 code, and only files Node
  actually loads appear in the report, so the percentages are a regression floor rather than a completeness measure.
