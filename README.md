# AetherCore

**A transactional core banking ledger built with Java 21, Spring Boot, PostgreSQL, Redis, and Kafka.**

AetherCore explores the failure modes behind moving money: two payments spending the same balance, a client retrying after losing a response, and an event broker going offline after a database commit. It implements a USD account ledger with database-enforced double entry and an asynchronous audit-event pipeline.

This is a runnable engineering portfolio project, not a licensed banking product or a connection to real payment rails. “Settlement” events describe internal postings; they do not prove external settlement.

## Try the banking sandbox

[Open the hands-on demo](https://ayushb900.github.io/AetherCore/demo/) or use **Try the banking demo** on the portfolio homepage.

The workspace starts with three accounts and $25,000 in simulated funds. Visitors can:

- Open accounts, add demo deposits, and transfer funds with cent-accurate amounts.
- Inspect debit/credit receipts and retry a request without charging again.
- Search the journal, download its JSON export, and check reconciliation.
- Run concurrent retry and overdraft experiments using dedicated test accounts.
- Reload to keep their workspace, or explicitly reset to the starter data.

**The Pages demo uses a local IndexedDB engine; it does not call the Java backend.** Each browser has its own data. IndexedDB transactions serialize writes across tabs; no service API key is shipped to visitors. No signup or bank details are needed. Data is fictional, limited to 20 customer accounts and 1,000 postings, and may be removed by clearing site storage. The real Java/PostgreSQL/Redis/Kafka implementation remains available below and has its own integration tests.

## Project portfolio

The responsive [portfolio page](site/index.html) presents the architecture and engineering decisions, and links to the [working browser workspace](site/demo/index.html). The original illustrative retry animation is also retained. Preview everything with `python3 -m http.server 3000 --directory site`.

To publish, enable **Settings → Pages → Source: GitHub Actions** and run **Deploy project portfolio** once. Subsequent pushes to `main` that change `site/**` automatically deploy the update. Publishing depends on GitHub Pages being enabled.

Browser checks (Node.js 22+): `cd site && npm ci && npx playwright install chromium && npm test`. There are 16 checks across desktop and mobile, covering account creation, funding, transfers, receipt retries, precision and overdraft errors, persistence, cross-tab concurrency, ledger search/export, reset, safe text rendering, isolated visitors, and the original simulation. The static site has no runtime package dependencies; Node is needed only for tests.

## What makes it interesting

- **Atomic money movement:** transfer receipt, debit, credit, balance projections, and outbox event commit in one PostgreSQL transaction.
- **Double entry enforced in SQL:** a deferred constraint trigger requires exactly the matching debit and credit before commit. Journal records reject updates and deletes.
- **Race-safe balances:** ordered pessimistic row locks serialize competing spends. Customer balances also have a nonnegative database constraint.
- **Durable idempotency:** a unique request key and SHA-256 payload fingerprint return the original receipt after a retry; a different payload returns `409`. Database keys do not expire.
- **Redis acceleration:** bounded advisory request leases and 24-hour receipt hints. Correctness survives absent Redis, expired leases, and stale cached IDs; PostgreSQL always verifies the mapping.
- **Transactional outbox:** Kafka acknowledgements precede marking events published. `SKIP LOCKED` supports multiple publishers. Consumers deduplicate stable `eventId` values.
- **Reconciliation:** one MVCC snapshot compares every balance with its journal and every transfer with its debit/credit pair.
- **Evidence:** real-service integration tests, concurrent contention tests, HTTP replay demo, and GitHub Actions.

## Start locally

Requirements: Docker with Compose; Java 21 and Maven are needed only for host development. The Maven Wrapper pins Maven 3.9.11. Allow approximately 2 GB RAM for the local stack, plus build overhead.

```bash
cp .env.example .env
# Edit .env: set random DB_PASSWORD and AETHER_API_KEY (at least 24 characters).
docker compose up -d --build
curl --fail http://localhost:8080/actuator/health
```

Wait for the application to return `{"status":"UP"}`. Compose binds the demo stack to loopback. `.env` is ignored by Git. Do not use the example values outside local development.

Run the HTTP concurrency demo (Python 3, standard library only):

```bash
set -a
. ./.env
set +a
python3 scripts/demo.py
```

It creates fresh accounts, simulates a $100 deposit, sends 32 copies of the same $25 transfer, and checks for exactly one posting and 31 replays. Then 40 concurrent $10 withdrawals compete for the remaining $75; exactly seven succeed. It checks balances and reconciliation and prints measured elapsed time. Every run creates new data; this is a correctness demonstration, not a controlled throughput benchmark.

```bash
docker compose logs -f app
docker compose down       # preserves the database volume
# docker compose down -v  # destructive: removes local banking data
```

## Develop and test

```bash
docker compose up -d postgres redis kafka
set -a; . ./.env; set +a
./mvnw spring-boot:run
```

Run the application on the host **or** in Compose, so they do not compete for port 8080. Integration tests use isolated disposable containers and random ports; they do not touch your Compose database.

```bash
./mvnw verify
```

Tests require a working Docker daemon. A missing Docker daemon fails the suite rather than silently skipping banking checks. The suite exercises concurrent retries, overdraft contention, opposing transfers, immutable journals, direct-SQL unbalanced transactions, outbox rollback, Kafka event consumption, API authentication/validation, and Redis failure handling.

## API

All `/api/v1/**` routes require `X-API-Key: $AETHER_API_KEY`. This is a service-to-service credential granting access to **all accounts and simulated deposits**, not end-user authentication. Only `/actuator/health` is public. Actuator metrics require the same key.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/accounts` | Create a zero-balance USD customer account |
| GET | `/api/v1/accounts/{id}` | Read account and balance |
| GET | `/api/v1/accounts/{id}/entries?after=0&limit=50` | Cursor-paginated journal; limit 1–200 |
| POST | `/api/v1/deposits` | Simulated external funding against USD clearing |
| POST | `/api/v1/transfers` | Atomic customer-to-customer transfer |
| GET | `/api/v1/transfers/{id}` | Read immutable receipt |
| GET | `/api/v1/reconciliation` | Drift, journal balance, and outbox backlog |

Transfer and deposit routes require `Idempotency-Key` (1–128 ASCII letters, digits, `.`, `_`, `:`, `-`). Keys share a global namespace across these operations. Keep a key for retries of the same logical operation. Successful first calls return `201`; successful replays return `200` with `Idempotency-Replayed: true`. A rolled-back failure consumes no key. Account creation is not idempotent.

```bash
curl --fail -X POST http://localhost:8080/api/v1/accounts \
  -H "X-API-Key: $AETHER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"ownerName":"Ada","currency":"USD"}'

# Substitute real account UUIDs from the response.
curl --fail -X POST http://localhost:8080/api/v1/deposits \
  -H "X-API-Key: $AETHER_API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: funding-001' \
  -d '{"destinationId":"CUSTOMER_UUID","amountMinor":10000,"currency":"USD"}'

curl --fail -X POST http://localhost:8080/api/v1/transfers \
  -H "X-API-Key: $AETHER_API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: payment-001' \
  -d '{"sourceId":"SENDER_UUID","destinationId":"RECIPIENT_UUID","amountMinor":2500,"currency":"USD"}'
```

Amounts are **integer minor units** (2500 = $25.00), never binary floating point. A single transfer is limited to 1–1,000,000,000,000 minor units. Only USD is supported; FX requires a separate multi-leg journal design. Clearing balances may be negative by design; customer balances cannot be.

Errors use RFC 9457 problem details with a stable `code`: `INVALID_REQUEST`/`INVALID_IDEMPOTENCY_KEY` (400), not found (404), `IDEMPOTENCY_CONFLICT` (409), `INSUFFICIENT_FUNDS`/`SAME_ACCOUNT`/`INVALID_ACCOUNT_KIND` (422), and `RETRY_TRANSACTION` (503). For uncertain outcomes, read the receipt or retry with the **same** key.

## Design and interview notes

- [Architecture, transaction boundaries, and failure analysis](docs/architecture.md)
- [API contract](docs/openapi.yaml)
- [Resume bullets and interview walkthrough](docs/resume.md)
- [Reproduced validation results](docs/validation.md)
- [Cloud environment activation](docs/cloud-environment.md)

The implementation deliberately chooses PostgreSQL as the financial source of truth. Redis cannot guarantee durable idempotency by itself, and a Kafka send inside a normal database transaction cannot make two separate systems atomic. The outbox closes that gap using durable intent and at-least-once delivery.

## Configuration

| Variable | Default / requirement |
|---|---|
| `AETHER_API_KEY` | Required, at least 24 characters |
| `DB_PASSWORD` | Required |
| `DB_URL` | `jdbc:postgresql://localhost:5432/aethercore` |
| `DB_USER` | `aethercore` |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379` |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` |
| `REDIS_ENABLED` | `true`; disable optional acceleration for troubleshooting |
| `OUTBOX_ENABLED` | `true`; disabling retains events but stops delivery |
| `OUTBOX_DELAY_MS` | `1000` |
| `PORT` | `8080` |

Redis loss does not block ledger correctness. Kafka loss leaves committed transfers available with an increasing outbox backlog; delivery resumes after recovery. Monitor backlog and reconciliation rather than treating a healthy HTTP endpoint as proof of event delivery.

## Scope and next steps

Before any real financial deployment: independent security/accounting review, customer-scoped authorization and maker/checker controls, TLS/SASL, separate migration/runtime database roles, operational audit of privileged actions, HA and backups with restore drills, external rail reconciliation, regulatory controls, rate limits, and observability/SLOs. The local single-node Kafka stack is not highly available. Database administrators can bypass triggers; database constraints protect normal writes, not a hostile superuser. Projection tampering is detected by reconciliation, not prevented against the database owner.

No unmeasured throughput, production deployment, or regulatory-compliance claims are made. Use the included tests and measured demo output when discussing the project.
