# Working in this repository

## When you return after a break

More than one agent works on this repo. Before starting any task:

1. `git fetch origin` and compare with `origin/main` (`git log --oneline HEAD..origin/main`).
2. Read the new commits and merged PRs. Open the files they touch, especially any you are about to edit.
3. Check `docs/HUMAN_ACTIONS.md` and `docs/IMPLEMENTATION_SCOPE_*.md` for changed decisions.
4. Rebase or merge main into your branch, then rerun the tests before building on top.
5. Say in your first message what changed.

## Rules that stay in force

- Never push to `main`. One PR per phase.
- Never print, commit or copy private keys, `.env` values or keypair files.
- Never touch mainnet or real funds without explicit approval.
- Keep testnet labels. Hide a module rather than invent data.
- Tests gate everything: `PATH=/root/sol/solana-release/bin:$PATH npm test`.
- The UI is vanilla ES modules. The CSP forbids inline scripts and inline styles.
