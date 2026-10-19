import { BankError, replayReceipt } from "./engine.js";
export function validatedBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new BankError(
      "INVALID_URL",
      "Enter a complete backend URL, such as https://bank.example.com.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new BankError(
      "INVALID_URL",
      "Use HTTPS, or HTTP on localhost for development. Do not include credentials.",
    );
  return url.href.replace(/\/$/, "");
}
export class RemoteBank {
  constructor(base) {
    this.base = validatedBase(base);
    this.live = true;
    const saved = JSON.parse(
      sessionStorage.getItem("aether-live-session") || "null",
    );
    this.token = saved?.base === this.base ? saved.token : null;
  }
  async request(method, path, body, key) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["X-Demo-Token"] = this.token;
    if (key) headers["Idempotency-Key"] = key;
    let response;
    try {
      response = await fetch(this.base + "/demo-api" + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (_) {
      throw new BankError(
        "NETWORK_UNCERTAIN",
        "The backend did not respond. For payments, retry with unchanged details to reuse the request key. Never assume a timeout means a payment failed.",
      );
    }
    let result;
    try {
      result = await response.json();
    } catch (_) {
      throw new BankError(
        "INVALID_BACKEND",
        "This URL did not return a banking API response.",
      );
    }
    if (!response.ok)
      throw new BankError(
        result.code || "BACKEND_ERROR",
        result.detail || "The backend rejected this request.",
      );
    return result;
  }
  async start() {
    const session = await this.request("POST", "/sessions");
    this.token = session.token;
    sessionStorage.setItem(
      "aether-live-session",
      JSON.stringify({ base: this.base, token: this.token }),
    );
  }
  async snapshot() {
    if (!this.token) await this.start();
    const snapshot = await this.request("GET", "/workspace");
    snapshot.accounts = snapshot.accounts.map((a) => ({
      ...a,
      name: a.ownerName,
    }));
    return snapshot;
  }
  createAccount(name) {
    return this.request("POST", "/accounts", {
      ownerName: name,
      currency: "USD",
    });
  }
  transfer(key, r) {
    return this.request(
      "POST",
      "/transfers",
      {
        sourceId: r.sourceId,
        destinationId: r.destinationId,
        amountMinor: r.amountMinor,
        currency: "USD",
      },
      key,
    );
  }
  deposit(key, r) {
    return this.request(
      "POST",
      "/deposits",
      {
        destinationId: r.destinationId,
        amountMinor: r.amountMinor,
        currency: "USD",
      },
      key,
    );
  }
  reserve(key, r) {
    return this.request("POST", "/holds", r, key);
  }
  release(id) {
    return this.request("POST", `/holds/${encodeURIComponent(id)}/release`);
  }
  capture(key, id, destinationId) {
    return this.request(
      "POST",
      `/holds/${encodeURIComponent(id)}/capture`,
      { destinationId },
      key,
    );
  }
  reverse(key, id) {
    return this.request(
      "POST",
      `/transfers/${encodeURIComponent(id)}/reversal`,
      undefined,
      key,
    );
  }
  async replay(id) {
    return replayReceipt(this, await this.snapshot(), id);
  }
  async reset() {
    await this.start();
    return this.snapshot();
  }
}
