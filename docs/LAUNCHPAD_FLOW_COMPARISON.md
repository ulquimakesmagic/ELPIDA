# Launchpad flow comparison (October 2026)

Sources are official docs where available, read on 11 October 2026. Where a doc does not cover a step, the table says so rather than guessing. Competitors' mechanics differ from Elpida's; patterns were adopted, not mechanics.

| | Pump.fun | Flaunch | Raydium LaunchLab | Clanker | Pons |
|---|---|---|---|---|---|
| **Entry point** | One create page | Create page with a fast default path | Choice of JustSendit (fast) or LaunchLab (full configuration) | Deploy page with seven sections | Single launch form |
| **Form** | Name, ticker, image, description, links; holder-rewards choice at creation | Metadata plus creator; defaults: revenue on, 80/20 creator/buybacks, fair launch | Details, supply split, graduation target, vesting, fee share, optional initial buy, then review | Basic info (network first), metadata, fee type, reward recipients, pool, vault, dev buy | Name, symbol, image, description, links, fee wallet |
| **Wallet timing** | Not documented | Not documented | Connected wallet listed as a prerequisite | Wallet required; timing not documented | Wallet signs every transaction |
| **Cost disclosure** | Fee schedule documented separately | Not on the launch page | Rough ranges only (0.05–0.5 SOL), not itemized | Fee table (creator plus 20% protocol) | Exact launch fee (0.0005 ETH); 1% pool fee |
| **Transaction feedback** | Not documented | Not documented | Summary review before Create, then wallet approval | No review screen documented | Wallet approval documented; detailed feedback not documented |
| **Token page** | Curve progress, chart, trades | Revenue stream (NFT) | Percent sold, raised vs target, chart | Admin page for claims | Progress line to graduation |
| **Rewards** | Holder rewards paid automatically; nothing to claim | Creator split 0–100%, immutable; transferable revenue NFT | Post-migration rights depend on upgrade and platform configuration; older Fee Keys differ | Multiple recipients with admins; claim on the Admin page | Fixed split (70/30 now); auto-claim fallback |
| **UX consideration** | Explain permanent holder-rewards choice | Make manager and claim paths understandable | Itemize estimated costs and explain current fee rights; documentation includes explicit vesting warnings | Explain mutable admin roles | Explain immediate WETH pool and lack of migration |

## Patterns adopted in Elpida

- **One entry point with progressive detail** (Raydium, Clanker). Five guided steps, with only the relevant settings revealed.
- **Network first, wallet after** (Clanker). The network is chosen first, and the wallet is requested only after a public testnet is chosen.
- **Exact, itemized costs** (Pons). The creation fee, purchase, included trading fee and estimated tokens appear before signing.
- **Immutability made explicit** (Flaunch, Pump.fun). Both the rewards step and the review list what is fixed after launch.
- **Weighted recipients with a visible 100% total** (Flaunch fee splits, Clanker recipients).
- **Graduation progress on every card and token page** (Raydium, Pons). Elpida draws it as a rising arc that echoes its mark.
- **Distinct transaction states and recoverable errors**. The sampled docs do not fully specify these UI states. Elpida shows approval, wallet confirmation, submission and confirmation separately, and errors keep the draft.

The comparison evaluates documented flows, not a complete live usability audit. A missing documented state does not prove a competitor lacks it. Pons currently launches directly into its locked WETH pool; Elpida retains its own virtual curve and later migration.

Component and motion references: [Watermelon UI](https://ui.watermelon.sh/), [animated components](https://ui.watermelon.sh/animated-components), [Motion for React](https://motion.dev/docs/react), [React](https://react.dev/) and [Next.js](https://nextjs.org/docs). These inform interaction design; this existing buildless app retains ES modules and CSS animation.

## Sources

- Pump.fun holder rewards: https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md
- Pump.fun public docs (fees, PumpSwap): https://github.com/pump-fun/pump-public-docs
- Flaunch launch settings: https://docs.flaunch.gg/getting-started/flaunch-a-coin
- Flaunch creator revenue: https://docs.flaunch.gg/features/creator-revenue
- Flaunch managers: https://docs.flaunch.gg/managers
- Raydium LaunchLab creation flow: https://docs.raydium.io/user-flows/creating-a-launchlab-token
- Clanker deployment UI: https://clanker.gitbook.io/documentation/general/token-deployments/clanker.world-deployments
- Clanker creator rewards and fees: https://clanker.gitbook.io/documentation/general/creator-rewards-and-fees
- Pons docs: https://docs.ponsfamily.com/
