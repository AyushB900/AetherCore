# Publish the Java-backed demo

The GitHub Pages workspace remains usable without a hosting account. The Java-backed version needs a server for Java, PostgreSQL, Redis, and Kafka. No public server has been provisioned by this repository, and a successful local test is not a public deployment.

## A practical first host

Use a Linux VM with Docker Compose, approximately **4 GB RAM** and persistent disk, from a provider such as DigitalOcean. This runs the existing four-service stack without replacing Kafka or relying on trial-plan limits. Review the provider's current price before creating a VM. You need your own hosting account, an approved budget, SSH access, and a DNS hostname pointing to that VM. A custom domain has a separate cost unless you already own one.

This is a single-machine portfolio deployment. It does not provide bank-grade HA, regulatory controls, or disaster recovery. The important banking claims are the tested ledger invariants, not institutional deployment readiness.

## Prepare the server

1. Create the provider account and a Docker-capable Linux VM with persistent disk. Install Docker Engine and the Compose plugin using the provider/Docker instructions.
2. Point a DNS hostname you control, such as `bank.example.com`, to the VM's public address. Permit inbound 80 and 443; restrict SSH to your own access. Do not expose database, Redis, Kafka, or the service API to the Internet.
3. Clone the repository and create private deployment configuration:

```bash
git clone https://github.com/AyushB900/AetherCore.git
cd AetherCore
cp deploy/.env.example .env.deploy
chmod 600 .env.deploy
```

Edit `.env.deploy` locally on the server. Set the real hostname, a random PostgreSQL password, and a distinct random service API key of at least 24 characters. The service key stays on the server. Keep `DEMO_ORIGIN=https://ayushb900.github.io` if the Pages website will connect to the backend. Do not paste credentials into chat or commit the filled file.

```bash
docker compose --env-file .env.deploy -f deploy/compose.yaml config --quiet
docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --build
docker compose --env-file .env.deploy -f deploy/compose.yaml ps
```

Caddy obtains HTTPS for the configured DNS hostname. Inspect `gateway` and `app` logs if startup fails. The gateway publishes the website and demo API, blocks the internal banking API/metrics routes, and exposes only ports 80/443 publicly. The Java service's administrative port binds only to VM loopback. The database and Kafka use named persistent volumes; do not remove those volumes during updates.

## Connect and verify

- Open `https://YOUR_HOSTNAME/demo/`. When public demo sessions are enabled, the Java-served runtime configuration automatically selects the same-origin backend. The badge must say **Live Java engine**.
- Alternatively, open the GitHub Pages workspace, choose **Connect live backend**, and enter `https://YOUR_HOSTNAME`. No service key is entered in the browser.
- Start the guided demo, then try a hold/capture/reversal. The audit dashboard should show Kafka acknowledgements after a short delay. These acknowledgements prove broker receipt, not downstream processing or external settlement.
- Open a separate browser session. Its balances, journals, and holds must be different. Refresh preserves that visitor's token within its tab; the backend session expires after 24 hours.
- For an outage exercise, stop **only this deployment's** Kafka service, post a transfer, and observe queued events. Restart Kafka and confirm the backlog drains. Local-mode Pause delivery is a simulation and does not stop the server broker.

The anonymous demo allocates at most `DEMO_MAX_SESSIONS` sessions (default 1,000), each with at most 20 customer accounts and 500 successful write operations. Each simulated movement is capped at $1,000,000. Requests in one visitor session are serialized in PostgreSQL to enforce ownership and budgets. Internal-service concurrency tests and load tests separately exercise account row locking.

The session cap counts allocations over the lifetime of the demo database, including expired sessions. It does not automatically replenish. That bounds anonymous storage growth, but an operator may need to review/reset the isolated demo database or deliberately raise the cap. Expiration revokes access; it does **not** delete immutable financial journals. Do not run it against real financial data. Review access logs and resource usage; a hard data cap is not a substitute for a production abuse-control system.

## Local live-mode validation

With Java 21, Docker, and the backing services available:

```bash
docker compose up -d postgres redis kafka
set -a; . ./.env; set +a
./mvnw package -DskipTests
DEMO_ENABLED=true DEMO_ORIGIN=http://127.0.0.1:3000 java -jar target/aethercore-0.1.0.jar
```

In another shell:

```bash
cd site
npm ci
npx playwright install chromium
LIVE_BACKEND_URL=http://127.0.0.1:8080 npm test
```

`npm test` without `LIVE_BACKEND_URL` runs local-browser checks and explicitly skips live-only scenarios. CI starts the Java service and sets the variable so those scenarios execute. In the cloud machine, use its Maven proxy/trust settings and system Chromium as described in `cloud-environment.md`.

## Updates and recovery

Pull the desired Git commit and repeat `up -d --build`. Flyway applies additive migration V2 without changing migration V1 or rewriting old transfer fingerprints. Test restoration from PostgreSQL backups and retain journal, hold, session, and outbox tables together. Keep Kafka data and Caddy certificates on persistent volumes. Redis is advisory and can be recreated.

`DEMO_ENABLED=false` disables anonymous demo sessions; the service API remains protected by its own key. You can run Java, database, Redis, and Kafka on a different provider, but the backend must still use the correct database credentials, broker address, TLS/trust settings, and exact allowed browser origin.
