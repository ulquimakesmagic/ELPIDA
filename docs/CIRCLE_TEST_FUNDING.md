# Circle test funding

Open **Network and test funds → Circle test funding**. The public USDC faucet link works without server setup: choose Base Sepolia or Ethereum Sepolia and paste your connected wallet address. Complete Circle's CAPTCHA yourself. The public faucet currently supplies 20 test USDC per address/network every two hours. You still need test ETH for gas, native-paired first buys and launchpad deployment.

## Enable the protected helper

### Windows terminal setup

The repository is `C:\Users\user\Desktop\OneForAll\ELPIDA\elpida-v1` (one level below `ELPIDA`). JavaScript from Circle's documentation must be saved in a script and run with Node; PowerShell cannot execute JavaScript pasted directly into its prompt. The SDK and module configuration are already installed in this repository. Do not reset Git or reinstall them to set up Circle.

Put your test key into the ignored `elpida-v1/.env` as `CIRCLE_API_KEY=...`, then run:

```powershell
Set-Location 'C:\Users\user\Desktop\OneForAll\ELPIDA\elpida-v1'
npm.cmd run circle:setup
```

This generates and registers the entity secret, saves it in `.env`, and saves recovery files under the ignored `local-data/circle-entity-setup/recovery/`. It preserves an existing configured entity secret and never prints secret values. A pending secret is saved before registration so an uncertain response cannot lose it. If you have already registered an entity secret in Circle Console, use that secret in `.env` instead of running registration again. After failure, check Circle Console before repeating the command; never replace a pending secret after an uncertain registration response.

Copy the three private values from `.env` into Railway Variables yourself. Keep a separate secure copy of the recovery files. `npm.cmd run circle:setup -- --check` validates the prerequisites without creating or registering a secret.

### Circle account and deployment

1. In https://console.circle.com/, create a **test** API key and generate/register an entity secret following https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet. Keep the entity-secret recovery file securely outside the repository.
2. Put these variables in the ignored project `.env` for localhost, or Railway service **Variables** for the hosted app. Never paste credentials into chat, browser fields or Git:
   - `CIRCLE_API_KEY`: Circle test key beginning `TEST_API_KEY:`.
   - `CIRCLE_ENTITY_SECRET`: registered 64-character hexadecimal secret.
   - `ELPIDA_CIRCLE_ADMIN_TOKEN`: your own random access code of at least 32 characters (for example generate 32 random bytes as hex with a trusted password manager).
3. Restart the local app or redeploy Railway. Open the funding panel, choose a supported test network, enter **only the Elpida funding access code**, then **Prepare Circle test wallet**.
4. Save the displayed wallet-set ID as `CIRCLE_WALLET_SET_ID` in Railway Variables. Redeploy. This lets the helper reuse wallets if Railway's local filesystem is replaced. A persistent volume for `local-data/` is recommended: it preserves faucet cooldowns, transfer request records and uncertain-transfer retry IDs too.
5. Request test ETH + USDC. Refresh balances after settlement. Enter your browser wallet's address on the same test network and send a small amount. Check transfer status until `COMPLETE`; refresh your browser wallet. Connect that wallet to Elpida and launch normally.

The helper creates an EOA controlled by your Circle account; it is not a browser wallet connector. Signing launches still happens in MetaMask or your chosen browser wallet. No private key is exported. Only Base Sepolia and Ethereum Sepolia, official test USDC and native test ETH are allowed. Transfers are capped at 100 USDC or 0.1 ETH each. Faucet cooldowns and available amounts are ultimately controlled by Circle. Test funds have no monetary value.

## Recovery and security

The access code authorizes spending from the helper's test wallets: treat it as a credential. It stays in the current panel's memory; neither it nor the Circle API credentials are stored in browser storage. Calls also require the application's origin and CSRF protections. API errors are sanitized.

If the Circle wallet has zero balances, request faucet funds before sending. A transfer is now rejected before submission when the selected asset balance is too low, no ETH exists for gas, or an ETH send would empty the wallet. The per-transfer cap is not an available balance. Reserve ETH for gas even after passing these checks; Circle validates actual gas costs at submission.

`403 Forbidden` from the faucet means Circle denied that API request; it does not mean Elpida's access code is wrong. Check Circle Console/API-key product permissions and restrictions, or use Circle's Console faucet where available. The public Circle faucet can supply test USDC directly to your browser wallet; get Base Sepolia test ETH from the network faucet linked in Elpida if the Circle faucet remains unavailable. No test assets were received in the live diagnostic on October 11: the Base Sepolia wallet was empty and Circle returned HTTP 403. Eight Circle funding tests pass after the balance/error-handling fix.

The Circle Console faucet at https://console.circle.com/faucet/circle-wallet was verified with the actual wallet ID. It offers 20 USDC and 0.01 test ETH for Base Sepolia, with a team limit of five requests per 24 hours and reCAPTCHA protection. Elpida keeps the prepared Wallet ID visible and links to this fallback. Complete human verification and submit **Send tokens** yourself; merely adding the wallet ID does not send funds. After settlement, send less than the ETH balance (for example 0.008 ETH from a 0.01 ETH balance). The native-send default is now 0.008 ETH. Native launch fees, the first buy and wallet gas still need to fit your connected wallet's actual balance.

Wallet/set creation and transfers use saved UUID idempotency keys. If a send response is uncertain, retry unchanged details in the same open panel: the request ID is reused. Do not close/reload the panel and submit a fresh transfer until you have checked Circle Console for the original transfer. Losing the local record prevents in-app transaction lookup; use Circle Console to inspect and reconcile transfers before resuming. This utility is for a trusted operator, not multi-user wallet custody or a production funding service.

Live Circle requests require valid credentials and a registered entity secret. Automated tests use a mocked SDK and do not prove that your account has faucet access. No mainnet integration, automatic CAPTCHA solving or cross-chain transfer is included. USDC fee payment remains separate from the token's trading pair: a native-paired launch still needs ETH for its first purchase and gas.

References: https://faucet.circle.com/ · https://developers.circle.com/wallets/dev-controlled/transfer-tokens-across-wallets

## Verification (October 11, 2026)

`node --test tests/api.test.mjs tests/circle-funding.test.mjs`: 12 tests passed, zero failures. This includes existing launch/trade behavior, CSRF/origin checks, Circle authorization, allowlists, decimal validation, wallet persistence, cooldowns, sanitized errors and uncertain-transfer idempotency. Dependency audit: zero known vulnerabilities.

The funding panel was exercised in the browser with a mocked Circle client: rejected missing access code, prepared a wallet, requested funds, refreshed ETH/USDC balances, submitted a transfer and observed `COMPLETE`. Desktop and 375px phone layouts were inspected. These were simulated responses, not actual Circle transfers. No Circle API credentials were present locally; live funding remains unverified pending account setup.
