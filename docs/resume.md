# Presenting AetherCore honestly

After you run the project and can explain its transaction model, adapt these bullets to your own work:

- Built a Java 21/Spring Boot banking ledger with PostgreSQL-enforced double-entry postings, immutable journal records, and atomic balance/outbox updates.
- Implemented durable request idempotency and ordered pessimistic row locking; validated retry safety and overdraft prevention with concurrent integration tests against real PostgreSQL, Redis, and Kafka containers.
- Designed a transactional outbox for at-least-once Kafka audit events, with stable event IDs, retry-safe publication, and reconciliation queries detecting ledger/projection drift.

Do not claim institutional deployment, regulatory certification, real customer funds, or an unmeasured transactions-per-second number. Replace generic testing claims with results you personally reproduce. The demo prints elapsed time for a concurrent retry batch, not a representative production throughput measurement.

Additional bullets you can use after reproducing the upgraded flows:

- Implemented authorization holds, atomic full capture, and compensating reversals with database-protected accounting history and idempotent lifecycle operations.
- Built an isolated public demo API using hashed, expiring visitor tokens and scoped account access; integrated a browser interface that distinguishes live Kafka acknowledgements from local simulations.

See `docs/benchmarks/` for measured results when available. Discuss the actual workload and its limits rather than treating a small hot-account experiment as a production capacity claim.

## Five-minute interview walkthrough

1. Run `docker compose up -d --build`, then `python3 scripts/demo.py` with the environment loaded.
2. Show the one new transfer and 31 identical receipts. Explain why a Redis TTL alone cannot guarantee durable idempotency after expiry or restart.
3. Show seven successful withdrawals among 40 contenders. Walk through the ordered PostgreSQL row locks and the nonnegative balance constraint.
4. Show `V1__ledger.sql`: the deferred balanced-journal check and trigger-updated balances. Explain why a failure at commit must roll back the receipt, postings, and outbox together.
5. Show the Kafka test and outbox crash window. Explain why consumers still deduplicate even with Kafka producer idempotence.

## Questions to prepare for

- Why integer minor units rather than `double`? How would you support currencies with different scales?
- Why `FOR NO KEY UPDATE` rather than an in-memory mutex, Redis-only lock, or `FOR UPDATE` after foreign-key inserts?
- What happens if the first request commits but the HTTP response disappears?
- What happens if one process dies after Kafka acknowledgement but before the published marker commits?
- Which operations are ACID, and which cross-system effects are eventually consistent?
- How would you introduce customer authorization, holds/reservations, reversals, FX, fees, and real settlement?
- What security assumptions are intentionally simplified in this portfolio version?

Keep measured results, test counts, hardware, and the exact commit SHA together if you publish a benchmark later. Demonstrating a subtle failure model clearly is more credible than claiming unrealistic scale.
