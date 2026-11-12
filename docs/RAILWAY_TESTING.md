# Railway online testing

This deploys the frontend and API together as one test service. Simulation uses a shared, in-memory private chain: visitors share demo accounts and launches, and the chain resets on restart or redeploy. Use one replica. The SQLite indexer does not make the simulated chain persistent. Public testnet transactions use the connected user's wallet and the configured testnet contracts.

## Deploy

1. In Railway, create a project from the GitHub repository `ulquimakesmagic/ELPIDA` (renamed from AbdulganiyuMalik01 on 12 Nov 2026), branch `main`. Use the repository root `/`.
2. Railway uses the included Dockerfile and `railway.json`; leave build/start commands unset. The container uses Node 24 and listens on Railway's `PORT`. Startup compiles and seeds the simulated chain, so allow a few minutes; readiness is checked at `/health` with a 300-second timeout.
3. Open the service's Settings → Networking → Public Networking and select **Generate Domain**. Use the port shown by Railway for the service.
4. Redeploy after generating the domain so the server receives `RAILWAY_PUBLIC_DOMAIN`. Alternatively set `ELPIDA_PUBLIC_URL` to the full generated HTTPS origin and redeploy. This also works for a custom domain. Only the configured origin and localhost are accepted.
5. Open the generated HTTPS URL. `/health` should return `{"status":"ok","mode":"simulation"}`. Check discovery, token creation, a buy/sell and creator rewards. Share the URL for browser and wallet testing.

No build-time secrets are needed for simulation. For public metadata publishing, add `PINATA_JWT` to Railway's server variables. For X verification, add `ELPIDA_X_CLIENT_ID`, `ELPIDA_X_CLIENT_SECRET` if required by your app, and `ELPIDA_X_REDIRECT_URI=https://YOUR-DOMAIN/api/rewards/x/callback`; register that same callback with X. Keep secrets in Railway variables, never in Git.

## Limits and troubleshooting

- This is a development prototype for online testing. The deployment does not publish production contracts or enable mainnet launches.
- Mount a volume at `/app/local-data`. The simulated chain is rebuilt at start by replaying `simulation-journal-v2.jsonl` from the volume, so launches, trades and rewards survive restarts and redeploys. Check `/api/public/status` → `storage.simulation.replayed`. The same object reports `skipped`, `malformed` and up to 20 `failures` (action and reason), so an entry that will not replay is visible instead of silently missing; set `ELPIDA_REPLAY_STRICT=1` to refuse to start when anything was lost. Delete the journal file to start a fresh simulation. Errors and replay counts are written to the service log (`storage_ready`).
- If the page returns 403, verify `RAILWAY_PUBLIC_DOMAIN` or `ELPIDA_PUBLIC_URL`, then redeploy. Avoid visiting an alternate domain that is not configured.
- If deployment times out, inspect the service logs for compilation or runtime errors. `/health` is available only after the runtime has initialized.
- Public testnets still require test funds and valid shared deployments. A hosted frontend cannot bypass wallet signatures or unavailable testnet contracts.

Docker is not installed on the development computer, so the Linux container build must be confirmed in Railway. Local API checks cover public-host requests, origin rejection and Railway healthchecks.

References: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles), [healthchecks](https://docs.railway.com/deployments/healthchecks), [public networking](https://docs.railway.com/networking/public-networking).
