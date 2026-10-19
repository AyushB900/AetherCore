# Reproduce the hot-account load test

Use your own isolated development database with no other clients posting money. This is a bounded correctness/performance experiment, not a capacity benchmark, a production SLO, or a promise of institutional throughput.

Run the Java application with PostgreSQL, Redis, and Kafka. The internal service API must be reachable locally, or through your own SSH tunnel; the public deployment gateway deliberately blocks it. Export the service key securely from your ignored configuration.

```bash
set -a; . ./.env; set +a
python3 scripts/load-test.py --url http://localhost:8080 --requests 200 --concurrency 1 --output /tmp/hotpair-c1.json
python3 scripts/load-test.py --url http://localhost:8080 --requests 200 --concurrency 8 --output /tmp/hotpair-c8.json
python3 scripts/load-test.py --url http://localhost:8080 --requests 200 --concurrency 16 --output /tmp/hotpair-c16.json
```

Each run creates and funds a fresh account pair, makes 200 unique $1 transfers alternating direction, and then submits 32 copies of another transfer using one key. It checks 200 distinct receipts, one additional retry posting, 31 replays, account conservation, and zero posted/hold/journal drift. It fails rather than reporting a successful benchmark if those checks fail.

The JSON records the exact source commit, whether its working tree was dirty, client/server Java context for this local host-JAR run, CPU availability, elapsed time, observed requests per second, and nearest-rank p50/p95/p99 latency. Results include HTTP connection setup and queueing/lock contention for one hot pair. They exclude external settlement and Kafka delivery time. A higher worker count can increase waiting rather than improve throughput.

Checked-in `hotpair-c*.json` reports describe a shared cloud development machine, host Java process, and containerized backing services. Other idle demo services were present; these are small single runs without a controlled hardware baseline or a JIT warmup protocol. Do not extrapolate them to production capacity. The website displays these observations with the same limitations and links here for raw evidence.

## Recorded observations

These three single runs used source commit `70addbf184c2fa882a6d1c49c15ddb6dd6972ada` with a clean working tree, 5 available CPUs and Java 21.0.12.1. The host Java process served the API on loopback; PostgreSQL, Redis, and Kafka ran in containers on the shared machine. No requests failed and all four reconciliation fields were zero in every run.

| Workers | Requests | Observed req/s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| 1 | 200 | 90.5 | 9.43 | 21.11 | 33.51 |
| 8 | 200 | 221.23 | 31.03 | 68.85 | 108.34 |
| 16 | 200 | 156.49 | 65.89 | 296.8 | 429.27 |

Higher concurrency did not monotonically improve this hot-pair workload: both accounts require serialization and this was a shared host with no controlled warmup/soak protocol. The experiment does not establish a maximum sustainable rate. Broker acknowledgement time is measured separately by the audit pipeline, not included as a payment-response requirement.
