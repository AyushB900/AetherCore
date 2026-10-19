/** Local-only demo engine. IndexedDB serializes writes across tabs; this is not the Java service. */
export class BankError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const DB_NAME = "aethercore-banking-demo-v1";
const CLEARING = "clearing";
const MAX_AMOUNT = 100_000_000; // $1m per simulated posting; bounded integer arithmetic.
const MAX_TRANSFERS = 1000;
function fail(code, message) {
  throw new BankError(code, message);
}
function empty() {
  return {
    version: 1,
    accounts: [
      {
        id: CLEARING,
        name: "External clearing",
        kind: "CLEARING",
        balanceMinor: 0,
      },
    ],
    transfers: [],
    entries: [],
    keys: {},
  };
}
function validAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT)
    fail(
      "INVALID_AMOUNT",
      "Enter an amount between $0.01 and $1,000,000.00, with at most two decimal places.",
    );
}
function newAccount(state, name) {
  name = String(name).trim();
  if (name.length < 1 || name.length > 60)
    fail("INVALID_NAME", "Use an account name between 1 and 60 characters.");
  if (state.accounts.length > 20)
    fail(
      "ACCOUNT_LIMIT",
      "This sandbox supports 20 accounts. Reset it to start fresh.",
    );
  const account = {
    id: crypto.randomUUID(),
    name,
    kind: "CUSTOMER",
    balanceMinor: 0,
  };
  state.accounts.push(account);
  return structuredClone(account);
}
function post(state, key, request) {
  validAmount(request.amountMinor);
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    fail("INVALID_KEY", "A valid request key is required.");
  const fingerprint = JSON.stringify([
    request.operation,
    request.sourceId,
    request.destinationId,
    request.amountMinor,
    "USD",
  ]);
  const existing = Object.hasOwn(state.keys, key) ? state.keys[key] : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This request key already belongs to a different payment.",
      );
    return {
      transfer: structuredClone(
        state.transfers.find((t) => t.id === existing.id),
      ),
      replayed: true,
    };
  }
  if (state.transfers.length >= MAX_TRANSFERS)
    fail(
      "DEMO_LIMIT",
      "This sandbox has reached 1,000 postings. Reset it to start fresh.",
    );
  const source = state.accounts.find((a) => a.id === request.sourceId);
  const destination = state.accounts.find(
    (a) => a.id === request.destinationId,
  );
  if (!source || !destination)
    fail(
      "NOT_FOUND",
      "One of these accounts no longer exists. Refresh and try again.",
    );
  if (source.id === destination.id)
    fail("SAME_ACCOUNT", "Choose two different accounts.");
  if (
    !["TRANSFER", "DEPOSIT"].includes(request.operation) ||
    destination.kind !== "CUSTOMER" ||
    (request.operation === "TRANSFER" && source.kind !== "CUSTOMER") ||
    (request.operation === "DEPOSIT" && source.id !== CLEARING)
  )
    fail("ACCOUNT_KIND", "This movement is not supported.");
  if (source.kind === "CUSTOMER" && source.balanceMinor < request.amountMinor)
    fail(
      "INSUFFICIENT_FUNDS",
      "There isn’t enough money in the source account. Add demo funds or enter a smaller amount.",
    );
  if (!Number.isSafeInteger(destination.balanceMinor + request.amountMinor))
    fail("BALANCE_LIMIT", "Account balance limit reached.");
  const transfer = {
    id: crypto.randomUUID(),
    sourceId: source.id,
    destinationId: destination.id,
    amountMinor: request.amountMinor,
    currency: "USD",
    operation: request.operation,
    createdAt: new Date().toISOString(),
  };
  source.balanceMinor -= request.amountMinor;
  destination.balanceMinor += request.amountMinor;
  state.transfers.push(transfer);
  for (const [account, side] of [
    [source, "DEBIT"],
    [destination, "CREDIT"],
  ])
    state.entries.push({
      id: state.entries.length + 1,
      transferId: transfer.id,
      accountId: account.id,
      side,
      amountMinor: transfer.amountMinor,
      createdAt: transfer.createdAt,
    });
  Object.defineProperty(state.keys, key, {
    value: { fingerprint, id: transfer.id },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { transfer: structuredClone(transfer), replayed: false };
}
function seed() {
  const state = empty();
  for (const [name, balance] of [
    ["Operating account", 1_250_000],
    ["Reserve account", 800_000],
    ["Payroll account", 450_000],
  ]) {
    const account = newAccount(state, name);
    post(state, crypto.randomUUID(), {
      operation: "DEPOSIT",
      sourceId: CLEARING,
      destinationId: account.id,
      amountMinor: balance,
    });
  }
  return state;
}
export function parseAmount(value) {
  const text = String(value).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text))
    fail(
      "INVALID_AMOUNT",
      "Use a positive dollar amount with up to two decimal places.",
    );
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  validAmount(minor);
  return minor;
}
export function reconcile(state) {
  let driftedAccounts = 0,
    unbalancedTransfers = 0;
  const totals = new Map(state.accounts.map((a) => [a.id, 0]));
  for (const entry of state.entries)
    totals.set(
      entry.accountId,
      (totals.get(entry.accountId) || 0) +
        (entry.side === "CREDIT" ? entry.amountMinor : -entry.amountMinor),
    );
  for (const account of state.accounts)
    if (totals.get(account.id) !== account.balanceMinor) driftedAccounts++;
  for (const transfer of state.transfers) {
    const entries = state.entries.filter((e) => e.transferId === transfer.id);
    if (
      entries.length !== 2 ||
      !entries.some(
        (e) =>
          e.side === "DEBIT" &&
          e.accountId === transfer.sourceId &&
          e.amountMinor === transfer.amountMinor,
      ) ||
      !entries.some(
        (e) =>
          e.side === "CREDIT" &&
          e.accountId === transfer.destinationId &&
          e.amountMinor === transfer.amountMinor,
      )
    )
      unbalancedTransfers++;
  }
  const netBalanceMinor = state.accounts.reduce(
    (sum, a) => sum + a.balanceMinor,
    0,
  );
  return {
    driftedAccounts,
    unbalancedTransfers,
    netBalanceMinor,
    balanced:
      driftedAccounts === 0 &&
      unbalancedTransfers === 0 &&
      netBalanceMinor === 0,
  };
}
export class DemoBank {
  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(
          new BankError(
            "STORAGE_UNAVAILABLE",
            "Browser storage is unavailable. Allow site storage or try a regular browsing window.",
          ),
        );
      request.onblocked = () =>
        reject(
          new BankError(
            "STORAGE_BLOCKED",
            "Close other AetherCore tabs and reload.",
          ),
        );
    });
  }
  async transact(mutator) {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const tx = database.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      const request = store.get("bank");
      let result, error;
      request.onsuccess = () => {
        try {
          const state = request.result || seed();
          result = mutator(state);
          store.put(state, "bank");
        } catch (cause) {
          error = cause;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          error ||
            new BankError(
              "STORAGE_FAILED",
              "The change could not be saved. No money was moved. Try again.",
            ),
        );
      tx.onerror = () => {
        /* onabort reports the transaction failure. */
      };
    });
  }
  snapshot() {
    return this.transact((state) => structuredClone(state));
  }
  createAccount(name) {
    return this.transact((state) => newAccount(state, name));
  }
  transfer(key, request) {
    return this.transact((state) =>
      post(state, key, { ...request, operation: "TRANSFER" }),
    );
  }
  deposit(key, request) {
    return this.transact((state) =>
      post(state, key, {
        ...request,
        sourceId: CLEARING,
        operation: "DEPOSIT",
      }),
    );
  }
  reset() {
    return this.transact((state) => {
      const next = seed();
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, next);
      return structuredClone(state);
    });
  }
}
