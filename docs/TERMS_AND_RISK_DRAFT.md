# Terms of use and risk disclosures: DRAFT for legal review (checklist D5, 24 October 2026)

**Status: draft written by Claude for a lawyer to edit. Not legal advice, not reviewed, not published.** Facts about how
Elpida works are from the code and docs as of this date. Bracketed items need decisions.

---

## Terms of use (outline)

1. **Who we are.** Elpida ("we") provides a website, elpida.fun, that lets you interact with smart contracts on public
   blockchains. [Legal entity, address and governing law: to be decided with counsel.]
2. **Eligibility.** You must be [18] or older and not be in, or a resident of, a restricted jurisdiction [list] or
   on a sanctions list. You are responsible for following the laws that apply to you.
3. **Non-custodial.** We never hold your funds or keys. Every action is a transaction your own wallet signs. We cannot
   reverse, cancel or refund a transaction.
4. **User-created tokens.** Anyone can create a token. We do not create, review, endorse or vouch for any token, its
   creator, its name, image or description. Nothing on the site is investment, financial, legal or tax advice.
5. **Fees.** Launches cost a $10 fee, priced by an on-chain oracle in the network's coin, or 10 USDC where offered.
   - Curve trades pay 1.25%, split 50/50 between Elpida and the creator's reward wallet.
   - During a token's first 60 seconds a higher launch-protection fee applies. It falls from 90% to 1.25%, and the
     amount above 1.25% is added to the token's locked liquidity.
   - After graduation the DEX's pool fee applies, and the locked position's fees are split 50/50 between Elpida and
     the creator.
   - Network fees (gas) are separate.
   - [Exact current figures per network to be confirmed at launch.]
6. **Prohibited use.** No market manipulation, wash trading, scams, impersonation, infringing names or images,
   illegal content, sanctions evasion or attacks on the service. We may hide content or tokens from the website.
   We cannot change or remove anything on-chain.
7. **No warranty; limitation of liability.** The service is provided "as is". [Standard limitation clauses, as
   permitted by the governing law.]
8. **Changes.** We may update these terms. [Notice mechanism.]

## Risk disclosures (plain language, shown before the first launch or trade)

- **You can lose everything you put in.** Memecoins usually have no intrinsic value, and most go to zero.
- **Prices move fast and can be manipulated.** Early buyers, bots and the creator may sell at any time.
- **Transactions are final.** A wrong address, amount or token cannot be undone.
- **Smart contract risk.** The contracts are new.
  - [Before the audit: they have not been independently audited.] [After: audited by X on date; an audit lowers risk
    but does not remove it.]
  - Bugs, oracle failures or problems in the DEXs and blockchains they rely on (Uniswap, PancakeSwap, PumpSwap,
    Chainlink, Pyth, the networks themselves) could cause losses.
- **Liquidity is locked forever.** At graduation the pool position is locked permanently. Nobody can withdraw it,
  including the creator and Elpida. That protects buyers from a rug pull of the pool, but it does not stop holders
  from selling.
- **Token details cannot be changed.** A token's name, symbol, image and links are fixed in its launch transaction.
- **Testnet is not real.** Test networks are labelled as such, and their tokens have no value.
- **Regulation may change** and may restrict access in your country.

## Questions for counsel

1. In Nigeria, under the Investments and Securities Act 2025 and SEC rules, does Elpida need registration (for example
   as a digital asset offering platform), and is the SEC's ARIP pathway appropriate?
2. Which jurisdictions to block at launch, and how (geo-blocking, attestation).
3. Entity, governing law and dispute resolution.
4. Whether the creator fee share or fee splitting creates any obligation (for example tax reporting).
5. Content moderation duties for user-uploaded names and images.
6. Whether the click-through entry disclaimer (docs/SITE_ANALYTICS.md) is enough, which places to name in it
   (`ELPIDA_RESTRICTED_JURISDICTIONS`), and whether attestation alone is acceptable or a geo-block is needed.
7. Privacy: whether the opt-in analytics and the Docs privacy notice meet the NDPA 2023 (Nigeria), the GDPR for EU and
   UK visitors, and what a full privacy policy must add (controller identity, contact, retention, visitor rights).
