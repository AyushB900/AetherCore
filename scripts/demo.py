#!/usr/bin/env python3
"""HTTP smoke + concurrency demo. Uses fresh accounts and a real running server."""
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("AETHER_URL", "http://localhost:8080")
KEY = os.environ["AETHER_API_KEY"]

def call(method, path, payload=None, key=None):
    headers = {"X-API-Key": KEY, "Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(BASE + "/api/v1" + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)

def check(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    def account(name):
        status, body = call("POST", "/accounts", {"ownerName": name, "currency": "USD"})
        check(status == 201, f"Account creation failed: {status} {body}")
        return body["id"]
    a, b = account("Demo sender"), account("Demo beneficiary")
    status, _ = call("POST", "/deposits", {"destinationId": a, "amountMinor": 10000, "currency": "USD"}, str(uuid.uuid4()))
    check(status == 201, "Demo funding failed")
    transfer = {"sourceId": a, "destinationId": b, "amountMinor": 2500, "currency": "USD"}
    key = str(uuid.uuid4())
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        replies = list(pool.map(lambda _: call("POST", "/transfers", transfer, key), range(32)))
    elapsed = time.perf_counter() - started
    check(sum(status == 201 for status, _ in replies) == 1, "Expected one committed transfer")
    check(sum(status == 200 for status, _ in replies) == 31, "Expected 31 safe replays")
    check(len({body["id"] for _, body in replies}) == 1, "Replays returned different transfer IDs")
    check(call("GET", f"/accounts/{a}")[1]["balanceMinor"] == 7500, "Sender charged more than once")
    check(call("GET", f"/accounts/{b}")[1]["balanceMinor"] == 2500, "Beneficiary credited incorrectly")
    conflict, _ = call("POST", "/transfers", {**transfer, "amountMinor": 2501}, key)
    check(conflict == 409, "Key reuse must be rejected")
    # 40 contenders, each requesting $10, compete for $75 remaining.
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        withdrawals = list(pool.map(lambda _: call("POST", "/transfers", {**transfer, "amountMinor": 1000}, str(uuid.uuid4())), range(40)))
    check(sum(status == 201 for status, _ in withdrawals) == 7, "Overdraft protection failed")
    check(sum(status == 422 for status, _ in withdrawals) == 33, "Unexpected withdrawal errors")
    _, report = call("GET", "/reconciliation")
    check(report["drifted_accounts"] == 0 and report["unbalanced_transfers"] == 0 and report["net_balance_minor"] == 0, "Reconciliation drift detected")
    print(json.dumps({"duplicate_requests": 32, "committed": 1, "replayed": 31,
        "duplicate_batch_seconds": round(elapsed, 3), "overdraft_contenders": 40,
        "withdrawals_posted": 7, "withdrawals_rejected": 33, "reconciliation": report}, indent=2))

if __name__ == "__main__":
    main()
