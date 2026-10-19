# Reproduced validation

The following checks were executed in the cloud development environment with Java 21 and a working Docker daemon. These are current-instance results, not a production benchmark or proof of a future GitHub Actions run.

| Check | Observed result |
|---|---|
| `./mvnw verify` with the cloud proxy/trust settings | 12 tests passed, 0 failed, 0 skipped; executable JAR built |
| Portfolio Playwright tests using Chromium | 2 passed: desktop 1440px and mobile 390px |
| Actual HTTP retry demo | 32 identical requests: 1 created receipt, 31 replays, one $25 debit |
| Actual HTTP overdraft demo | 40 requests for $10 with $75 available: 7 posted, 33 rejected |
| Snapshot reconciliation after the demo | 0 drifted accounts, 0 unbalanced transfers, net balance 0 |
| Kafka outbox after normal operation | Pending events drained to 0 |
| Repeat HTTP demo while Redis and Kafka were stopped | Same money/replay results; 9 events remained pending |
| Restart Redis and Kafka | Pending events drained back to 0, reconciliation remained clean |

The normal duplicate-request batch took 0.165 seconds in one local run; with both Redis and Kafka stopped it took 1.887 seconds. These timings describe only this small retry experiment, include connection/cache effects, and must not be represented as a transactions-per-second benchmark. PostgreSQL remained running throughout the outage experiment.

The portfolio simulation runs entirely in the browser and is labeled as illustrative. Its browser tests verify that it displays one posting and 31 replays, can reset, handles the copy control, and fits both viewports without horizontal overflow. Backend guarantees are verified separately against real PostgreSQL 17, Redis 7.4, and Kafka 3.9.1 services.
