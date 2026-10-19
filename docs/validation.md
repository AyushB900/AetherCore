# Reproduced validation

The following checks were executed in the cloud development environment with Java 21 and a working Docker daemon. These are current-instance results, not a production benchmark or proof of a future GitHub Actions run.

| Check | Observed result |
|---|---|
| `./mvnw verify` with the cloud proxy/trust settings | 22 tests passed, 0 failed, 0 skipped; executable JAR built |
| Portfolio Playwright tests using Chromium | 30 passed with live mode configured: desktop 1440px and mobile 390px |
| Actual HTTP retry demo | 32 identical requests: 1 created receipt, 31 replays, one $25 debit |
| Actual HTTP overdraft demo | 40 requests for $10 with $75 available: 7 posted, 33 rejected |
| Snapshot reconciliation after the demo | 0 drifted accounts, 0 unbalanced transfers, net balance 0 |
| Kafka outbox after normal operation | Pending events drained to 0 |
| Multi-stage Docker build and Compose app startup | Image built with TLS verification; the HTTP concurrency demo also passed against the non-root application container |
| Repeat HTTP demo while Redis and Kafka were stopped | Same money/replay results; 9 events remained pending |
| Restart Redis and Kafka | Pending events drained back to 0, reconciliation remained clean |

The normal duplicate-request batch took 0.165 seconds in one local run; with both Redis and Kafka stopped it took 1.887 seconds. These timings describe only this small retry experiment, include connection/cache effects, and must not be represented as a transactions-per-second benchmark. PostgreSQL remained running throughout the outage experiment.

The portfolio simulation runs entirely in the browser and is labeled as illustrative. Its browser tests verify that it displays one posting and 31 replays, can reset, handles the copy control, and fits both viewports without horizontal overflow. Backend guarantees are verified separately against real PostgreSQL 17, Redis 7.4, and Kafka 3.9.1 services.

## Hands-on browser workspace

The Pages demo is now a working local account workspace in `site/demo/`. Seven additional scenarios run at each viewport (14 checks), alongside the two original portfolio checks. Verified flows include creating/funding accounts, transferring exact cents, replaying the original receipt, preserving data after reload, rejecting overdrafts and excess decimal precision, searching/exporting/resetting, isolating different visitors, and rendering user-provided names as text.

Both browser reliability experiments ran against committed IndexedDB transactions: 32 identical transfer requests produced one posting and 31 replays; 40 separate withdrawals against $100 produced ten $10 postings and 30 insufficient-funds failures. A separate two-tab test proved only one competing full-balance spend could commit. A fault-injection test proved a failed transaction did not retain a changed balance. These results describe the browser engine, not Java/PostgreSQL behavior; the backend tests above remain separate.

## Live banking upgrade validation

The expanded Java suite passes **22 tests**, including reservation contention, atomic capture rollback, exact compensating reversals, concurrent reversal retries, expiry/ownership checks, and public API/CORS boundaries. The browser suite passes **30 checks** with a live backend supplied: 22 run locally and eight exercise the actual Java/PostgreSQL service across desktop and mobile. Those eight live checks are explicitly skipped if `LIVE_BACKEND_URL` is absent; CI provisions the live service and supplies the variable.

Verified live UI flows include full hold capture, compensating reversal with original history retained, release, Kafka acknowledgement display, the guided walkthrough, and loss of a committed transfer's HTTP response followed by a retry of the same key. The retry returned the original receipt without a second debit. Frontend request keys are retained until both the receipt and refreshed workspace have been obtained.

Both Compose configurations parse successfully. Caddy's HTTPS configuration validates without obtaining a public certificate. Migration V2's checksum matches the existing demo database; V3 adds further guards without modifying V1/V2. Public certificate issuance, DNS routing, and a new external server remain unvalidated until the owner creates a hosting account and deploys.

The public deployment topology was also started locally with its own PostgreSQL/Redis/Kafka data volumes and a Caddy HTTP gateway. A browser automatically connected through the gateway to an isolated Java session, completed the guided lifecycle, and confirmed the internal `/api/v1/reconciliation` route returned 404 at the gateway. The runtime image ran as UID 999, not root. Public DNS and certificate issuance still require the owner's hosting account and hostname; local gateway validation does not establish an Internet deployment.
