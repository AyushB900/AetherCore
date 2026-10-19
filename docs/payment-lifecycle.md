# Holds, captures, and reversals

A posted account balance is the sum of its credits minus debits. A hold reserves part of that balance without creating a debit. Available balance is `balanceMinor - heldMinor`.

- **Reserve:** create a hold with an idempotency key. The hold projection trigger increases `held_minor` and a database CHECK prevents it from exceeding the customer balance.
- **Release:** move HELD to RELEASED and restore availability. Releasing an already released hold is safe; a captured hold cannot be released.
- **Capture:** lock the hold, lock source/destination account rows in UUID order, release the reservation, post a CAPTURE debit/credit/outbox in the same transaction, and link the hold to its receipt. Any failed posting rolls back the reservation transition as well. The internal RELEASED transition is never visible as a separately committed capture state.
- **Reverse:** lock the immutable original transfer, check for an existing reversal, and post a new inverse transfer with `reversalOf`. The unique link prevents two compensations. Original entries remain unchanged. Only TRANSFER and CAPTURE are reversible; reversal itself is not recursively reversed. If the recipient has spent or held the funds, the reversal fails rather than overdrawing it.

This version captures and reverses the full amount. Partial capture, partial reversal, hold expiry, fees, and external rail settlement are future extensions. Holds do not claim money has settled or left the bank.

## APIs

The internal `/api/v1` routes require `X-API-Key`:

| Route | Body / behavior |
|---|---|
| `POST /holds` | `{accountId, amountMinor, description}`, with Idempotency-Key |
| `GET /holds/{id}` | Reservation state |
| `POST /holds/{id}/release` | No body; idempotent release |
| `POST /holds/{id}/capture` | `{destinationId}`, with Idempotency-Key; returns Receipt |
| `POST /transfers/{id}/reversal` | No body, with Idempotency-Key; returns Receipt |

Receipts contain `{transfer, replayed}` for the new capture/reversal APIs. The original transfer/deposit endpoints retain their existing response format and status semantics. Account responses now include `heldMinor` and `availableMinor`. Reconciliation also checks `drifted_holds`.

## Public visitor API

`DEMO_ENABLED=true` enables `/demo-api`; it is disabled by default. `POST /demo-api/sessions` returns a random 256-bit bearer token, its expiry, and the session ID. Only a SHA-256 hash is stored on the server. Tokens are sent in `X-Demo-Token` and kept in the visitor tab's session storage; the internal service key is never sent to the website.

`GET /demo-api/workspace` returns only the caller's accounts, postings, holds, outbox statuses, and receipt keys. POST routes `/accounts`, `/deposits`, `/transfers`, `/holds`, `/holds/{id}/release`, `/holds/{id}/capture`, and `/transfers/{id}/reversal` enforce account ownership in a session-locked transaction. Each session has its own clearing account, so even the technical side of its deposits stays isolated. Keys are namespaced by session. Public keys may be at most 80 ASCII characters; the service accepts 128.

Visitor tokens do not authenticate the internal `/api/v1` API. CORS permits only the configured Pages origin; same-origin hosting works without cross-origin permission. No cookie session is used. API calls fail explicitly if the live server is unavailable; the UI never silently substitutes a browser transfer for a failed Java transfer.

## Audit evidence

Every posted transfer has an outbox event with a stable event ID. The live dashboard shows whether PostgreSQL has marked it acknowledged by Kafka. At-least-once publication can duplicate messages across crash windows; consumers still need durable event-ID deduplication.

Browser mode models the same account/hold/reversal behaviors in IndexedDB and labels its event pipeline as a local simulation. Its Pause delivery control changes only local simulated events. It does not operate a real broker.

Migration V3 additionally rejects hold deletion, restricts the internal released-to-captured transition to the same transaction, and validates that a reversal exactly swaps the original accounts with the same amount/currency. Applied migrations V1 and V2 are retained unchanged; V3 adds these guards for both new and existing databases.
