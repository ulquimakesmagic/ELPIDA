# Resume and codebase catch-up

At the start of every new or resumed chat, before implementation or deployment:

1. Read `CLAUDE.md` and applicable repository instructions. Check the branch and
   working tree; preserve unrelated edits, particularly `package-lock.json`.
2. Fetch origin. Compare this checkout and the last reviewed commit with
   `origin/main`, including other agents' new branches and merged work. If the
   fetch fails, say the checkout may be stale; do not claim to be up to date.
3. Read new commit summaries and relevant diffs, then open the affected code.
   Read `docs/HUMAN_ACTIONS.md`, scope documents and the latest mainnet checklist,
   deployment records and feature-specific runbooks. Reconcile newer evidence
   with older chat assumptions; do not repeat completed work.
4. Base new work on current main or integrate it into the existing task branch
   without discarding changes. Run checks appropriate to the touched behavior.
   Distinguish recorded test results from checks actually rerun in this chat.
5. Briefly report what changed, what remains open and the next justified step.
   Separate source implementation, local/fork testing, public testnet evidence
   and mainnet readiness. Never infer deployment or safety from source alone.

Keep Model 10 pricing and separate chain wallets unless explicitly instructed
otherwise. No mainnet transactions or real funds without explicit authorization.
Never expose secrets or key files. Use a feature branch and PR; never push main.
