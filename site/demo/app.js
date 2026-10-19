import { DemoBank, parseAmount, reconcile } from "./engine.js";
import { RemoteBank } from "./remote.js";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
let bank = new DemoBank();
const pendingRequests = new WeakMap();
const actionKeys = new Map();
function actionKey(action) {
  if (!actionKeys.has(action)) actionKeys.set(action, crypto.randomUUID());
  return actionKeys.get(action);
}
function requestKey(form, request) {
  const text = JSON.stringify(request);
  const previous = pendingRequests.get(form);
  if (previous?.text === text) return previous.key;
  const value = { text, key: crypto.randomUUID() };
  pendingRequests.set(form, value);
  return value.key;
}
const selectedBackend =
  sessionStorage.getItem("aether-selected-backend") ||
  (window.AETHERCORE_BACKEND === "same-origin"
    ? location.origin
    : window.AETHERCORE_BACKEND);
if (selectedBackend) {
  try {
    bank = new RemoteBank(selectedBackend);
  } catch (_) {
    sessionStorage.removeItem("aether-selected-backend");
  }
}
const channel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("aethercore-demo-updates")
    : null;
let state,
  activeView = "overview",
  ledgerLimit = 50,
  toastTimer,
  labBusy = false;
const customers = () =>
  state.accounts.filter((account) => account.kind === "CUSTOMER");
const name = (id) =>
  state.accounts.find((account) => account.id === id)?.name ||
  "Unknown account";
function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
function report(error, form) {
  const message = error.message || "Something went wrong. Please try again.";
  if (form) {
    const target = $(".form-error", form);
    target.textContent = message;
    target.hidden = false;
  } else notify(message);
}
async function refresh(broadcast = false) {
  state = await bank.snapshot();
  render();
  if (broadcast) channel?.postMessage("updated");
}
function accountCard(account, index) {
  const initials = account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return `<article class="account-card"><div class="account-card-top"><span class="account-avatar tone-${index % 3}">${escape(initials)}</span><span class="currency-tag">USD ACCOUNT</span></div><h3>${escape(account.name)}</h3><code>AC · ${escape(account.id.slice(-8))}</code><strong>${money(account.balanceMinor)}</strong><div class="account-availability"><span>Available ${money(account.balanceMinor - (account.heldMinor || 0))}</span><span>Held ${money(account.heldMinor || 0)}</span></div><div class="account-card-actions"><button data-transfer-from="${account.id}">Transfer ↗</button><button data-fund-to="${account.id}">Add funds ＋</button></div></article>`;
}
function activityTable(transfers) {
  if (!transfers.length)
    return '<div class="empty-state"><span>↔</span><h3>No movements found.</h3><p>Try another search, add demo funds, or make your first transfer.</p></div>';
  return `<div class="activity-scroll"><table><thead><tr><th>Movement</th><th>From → To</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${transfers.map((transfer) => `<tr><td><div class="movement"><span class="movement-icon ${transfer.operation === "DEPOSIT" ? "deposit" : ""}">${transfer.operation === "DEPOSIT" ? "+" : "↗"}</span><div><strong>${{ DEPOSIT: "Demo deposit", TRANSFER: "Account transfer", CAPTURE: "Hold capture", REVERSAL: "Compensating reversal" }[transfer.operation] || "Account movement"}</strong><small>${new Date(transfer.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div></td><td><div class="account-route"><span>${escape(name(transfer.sourceId))}</span><small>→ ${escape(name(transfer.destinationId))}</small></div></td><td class="amount-cell">${money(transfer.amountMinor)}</td><td><span class="status-pill">✓ Posted</span></td><td><button class="receipt-link" data-receipt="${transfer.id}" aria-label="View receipt for ${escape(money(transfer.amountMinor))} ${transfer.operation === "DEPOSIT" ? "deposit" : "transfer"}">View ↗</button></td></tr>`).join("")}</tbody></table></div>`;
}
function render() {
  const accounts = customers();
  $("#total-balance").textContent = money(
    accounts.reduce((sum, account) => sum + account.balanceMinor, 0),
  );
  $("#balance-accounts").textContent = accounts.length;
  $("#account-count").textContent = accounts.length;
  $("#nav-account-count").textContent = accounts.length;
  $("#overview-accounts").innerHTML = accounts
    .slice(0, 3)
    .map(accountCard)
    .join("");
  $("#all-accounts").innerHTML = accounts.map(accountCard).join("");
  $("#recent-activity").innerHTML = activityTable(
    state.transfers.slice(-5).reverse(),
  );
  const health = reconcile(state);
  $("#health-title").textContent = health.balanced
    ? "Everything balances."
    : "A mismatch needs attention.";
  $("#health-icon").textContent = health.balanced ? "✓" : "!";
  $("#drift-amount").textContent = health.driftedAccounts
    ? `${health.driftedAccounts} account(s)`
    : health.driftedHolds
      ? `${health.driftedHolds} hold projection(s)`
      : money(0);
  $("#unbalanced-count").textContent = health.unbalancedTransfers;
  $("#ledger-summary").innerHTML =
    `<div><span>POSTED MOVEMENTS</span><strong>${state.transfers.length}</strong></div><div><span>JOURNAL ENTRIES</span><strong>${state.entries.length}</strong></div><div><span>NET JOURNAL BALANCE</span><strong>${money(health.netBalanceMinor)}</strong></div><div><span>RECONCILIATION</span><strong class="${health.balanced ? "text-green" : "text-red"}">${health.balanced ? "Balanced ✓" : "Needs review"}</strong></div>`;
  renderLedger();
  updateAvailable();
  renderUpgrades();
}
function renderLedger() {
  const query = $("#ledger-search").value.trim().toLowerCase();
  const filter = $("#ledger-filter").value;
  const rows = state.transfers
    .slice()
    .reverse()
    .filter(
      (transfer) =>
        (filter === "ALL" || filter === transfer.operation) &&
        `${transfer.id} ${name(transfer.sourceId)} ${name(transfer.destinationId)}`
          .toLowerCase()
          .includes(query),
    );
  $("#all-activity").innerHTML = activityTable(rows.slice(0, ledgerLimit));
  $("#ledger-count").textContent =
    `Showing ${Math.min(ledgerLimit, rows.length)} of ${rows.length} movements · Select View for the full double-entry receipt`;
  $("#load-more").hidden = ledgerLimit >= rows.length;
}
function view(next, focus = false) {
  if (
    !["overview", "accounts", "ledger", "lab", "holds", "audit"].includes(next)
  )
    next = "overview";
  activeView = next;
  $("#performance-panel").hidden = next !== "lab";
  $$(".view").forEach(
    (section) => (section.hidden = section.id !== `view-${next}`),
  );
  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === next);
    if (button.dataset.view === next)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#breadcrumb-current").textContent = {
    overview: "Overview",
    accounts: "Accounts",
    ledger: "Ledger",
    lab: "Reliability lab",
    holds: "Payment holds",
    audit: "Audit events",
  }[next];
  history.replaceState(null, "", `#${next}`);
  if (focus) {
    $("#main").focus();
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
}
function populate(select, preferred) {
  select.replaceChildren(
    ...customers().map((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.name} · ${money(account.balanceMinor - (account.heldMinor || 0))} available`;
      return option;
    }),
  );
  if (preferred) select.value = preferred;
}
function openAction(action, preferred) {
  if (labBusy) {
    notify("Let the reliability experiment finish first.");
    return;
  }
  const dialog = $(`#${action}-dialog`);
  const form = $("form", dialog);
  form.reset();
  $(".form-error", form).hidden = true;
  if (action === "transfer") {
    if (customers().length < 2) {
      notify("Create two accounts before making a transfer.");
      return;
    }
    populate(form.elements.sourceId, preferred || customers()[0].id);
    populate(
      form.elements.destinationId,
      customers().find((account) => account.id !== form.elements.sourceId.value)
        ?.id,
    );
    updateAvailable();
  } else if (action === "fund")
    populate(form.elements.destinationId, preferred);
  dialog.showModal();
}
function updateAvailable() {
  const source = state?.accounts.find(
    (account) => account.id === $("#transfer-form").elements.sourceId.value,
  );
  $("#available-balance").textContent = source
    ? `Available: ${money(source.balanceMinor - (source.heldMinor || 0))} · No overdrafts`
    : "";
}
function receipt(transfer, replayed = false) {
  const rows = state.entries.filter(
    (entry) => entry.transferId === transfer.id,
  );
  $("#receipt-content").innerHTML =
    `<div class="receipt-success">✓</div><h2 id="receipt-title">${replayed ? "Same receipt. No new charge." : "Movement posted."}</h2><div class="receipt-amount">${money(transfer.amountMinor)} <small>USD</small></div><p>${escape(name(transfer.sourceId))} → ${escape(name(transfer.destinationId))}</p>${replayed ? '<div class="replay-confirmed">Idempotency verified. No additional funds moved.</div>' : ""}<div class="receipt-journal"><div class="receipt-journal-head"><span>DOUBLE-ENTRY JOURNAL</span><span>AMOUNT</span></div>${rows.map((entry) => `<div><span><b>${entry.side === "DEBIT" ? "DR" : "CR"}</b> ${escape(name(entry.accountId))}</span><strong>${entry.side === "DEBIT" ? "−" : "+"} ${money(entry.amountMinor)}</strong></div>`).join("")}<div class="receipt-net"><span>Net movement</span><strong>${money(rows.reduce((sum, entry) => sum + (entry.side === "CREDIT" ? entry.amountMinor : -entry.amountMinor), 0))}</strong></div></div><dl class="receipt-meta"><dt>Transfer ID</dt><dd>${escape(transfer.id)}</dd><dt>Posted</dt><dd>${new Date(transfer.createdAt).toLocaleString()}</dd><dt>Engine</dt><dd>${bank.live ? "Live Java · PostgreSQL" : "Browser sandbox · IndexedDB"}</dd></dl><button class="button subtle full" id="replay-request" data-id="${transfer.id}">Retry this exact request <span>↻</span></button><p class="dialog-note">Retrying returns this receipt without moving money again.</p>${["TRANSFER", "CAPTURE"].includes(transfer.operation) && !state.transfers.some((t) => t.reversalOf === transfer.id) ? `<button class="button subtle full" data-reverse="${transfer.id}">Reverse with a new transfer ↩</button>` : ""}${transfer.reversalOf ? `<p class="dialog-note">Compensates original transfer ${escape(transfer.reversalOf)}</p>` : ""}`;
  if (!$("#receipt-dialog").open) $("#receipt-dialog").showModal();
}
async function mutation(form, action) {
  const button = $('button[type="submit"]', form);
  if (button.disabled) return;
  button.disabled = true;
  $(".form-error", form).hidden = true;
  try {
    await action();
  } catch (error) {
    report(error, form);
  } finally {
    button.disabled = false;
  }
}
$("#account-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  mutation(form, async () => {
    const account = await bank.createAccount(form.elements.name.value);
    await refresh(true);
    form.closest("dialog").close();
    view("accounts");
    notify(`${account.name} is ready. Add demo funds to get started.`);
  });
});
for (const type of ["transfer", "fund"])
  $(`#${type}-form`).addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    mutation(form, async () => {
      const request = {
        destinationId: form.elements.destinationId.value,
        amountMinor: parseAmount(form.elements.amount.value),
      };
      if (type === "transfer") request.sourceId = form.elements.sourceId.value;
      // One key per submit, reused for explicit receipt retries. IndexedDB commits before resolving.
      const result = await bank[type === "fund" ? "deposit" : "transfer"](
        requestKey(form, request),
        request,
      );
      await refresh(true);
      form.closest("dialog").close();
      receipt(result.transfer, result.replayed);
      pendingRequests.delete(form);
    });
  });
$("#transfer-form").elements.sourceId.addEventListener("change", () => {
  const form = $("#transfer-form");
  if (form.elements.sourceId.value === form.elements.destinationId.value)
    form.elements.destinationId.value =
      customers().find((account) => account.id !== form.elements.sourceId.value)
        ?.id || "";
  updateAvailable();
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-close")) {
    button.closest("dialog").close();
    return;
  }
  if (button.dataset.view || button.dataset.go) {
    view(button.dataset.view || button.dataset.go, true);
    return;
  }
  if (button.dataset.action) {
    openAction(button.dataset.action);
    return;
  }
  if (button.dataset.transferFrom) {
    openAction("transfer", button.dataset.transferFrom);
    return;
  }
  if (button.dataset.fundTo) {
    openAction("fund", button.dataset.fundTo);
    return;
  }
  if (button.dataset.receipt) {
    receipt(
      state.transfers.find(
        (transfer) => transfer.id === button.dataset.receipt,
      ),
    );
    return;
  }
  if (button.id === "replay-request") {
    button.disabled = true;
    try {
      const transfer = state.transfers.find(
        (item) => item.id === button.dataset.id,
      );
      const result = await bank.replay(transfer.id);
      await refresh(true);
      receipt(result.transfer, result.replayed);
    } catch (error) {
      report(error);
      button.disabled = false;
    }
  }
});
for (const id of ["about-open", "banner-about"])
  $(`#${id}`).addEventListener("click", () => $("#about-dialog").showModal());
$("#reset-open").addEventListener("click", () => {
  if (labBusy) {
    notify("Let the reliability experiment finish before resetting.");
    return;
  }
  $("#reset-dialog").showModal();
});
$("#reset-confirm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await bank.reset();
    await refresh(true);
    $("#reset-dialog").close();
    for (const id of ["retry-result", "overdraft-result"])
      $(`#${id}`).hidden = true;
    $("#workspace").hidden = false;
    $("#fatal").hidden = true;
    view("overview");
    notify("Workspace reset. Your three starter accounts are ready.");
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
});
for (const type of ["retry", "overdraft"])
  $(`#${type}-run`).addEventListener("click", async () => {
    if (labBusy) return;
    labBusy = true;
    $$("#view-lab button").forEach((button) => (button.disabled = true));
    const target = $(`#${type}-result`);
    target.hidden = false;
    target.textContent =
      "Creating isolated test accounts and running concurrent requests…";
    try {
      const label = type === "retry" ? "Retry lab" : "Overdraft lab";
      const a = await bank.createAccount(`${label} sender`);
      const b = await bank.createAccount(`${label} receiver`);
      await bank.deposit(crypto.randomUUID(), {
        destinationId: a.id,
        amountMinor: 10000,
      });
      const key = crypto.randomUUID();
      const request = {
        sourceId: a.id,
        destinationId: b.id,
        amountMinor: type === "retry" ? 2500 : 1000,
      };
      const outcomes = await Promise.all(
        Array.from({ length: type === "retry" ? 32 : 40 }, async () => {
          try {
            const result = await bank.transfer(
              type === "retry" ? key : crypto.randomUUID(),
              request,
            );
            return result.replayed ? "replayed" : "posted";
          } catch (error) {
            if (error.code === "INSUFFICIENT_FUNDS") return "rejected";
            throw error;
          }
        }),
      );
      await refresh(true);
      const posted = outcomes.filter((value) => value === "posted").length;
      const replays = outcomes.filter((value) => value === "replayed").length;
      const rejected = outcomes.filter((value) => value === "rejected").length;
      const source = state.accounts.find((account) => account.id === a.id);
      const pass =
        reconcile(state).balanced &&
        (type === "retry"
          ? posted === 1 && replays === 31 && source.balanceMinor === 7500
          : posted === 10 && rejected === 30 && source.balanceMinor === 0);
      target.classList.toggle("failed", !pass);
      target.innerHTML = `<strong>${pass ? "✓ Invariants held." : "! Unexpected result — inspect the ledger."}</strong><div class="result-numbers"><span><b>${posted}</b>posted</span><span><b>${type === "retry" ? replays : rejected}</b>${type === "retry" ? "safe replays" : "rejected"}</span><span><b>${money(type === "retry" ? 2500 * posted : source.balanceMinor)}</b>${type === "retry" ? "moved once" : "remaining"}</span></div><p>These are committed browser transactions. Open the ledger to inspect every entry.</p>`;
    } catch (error) {
      target.textContent = error.message;
      target.classList.add("failed");
      await refresh(true).catch(() => {});
    } finally {
      labBusy = false;
      $$("#view-lab button").forEach((button) => (button.disabled = false));
    }
  });
for (const event of ["input", "change"])
  $("#ledger-search").addEventListener(event, () => {
    ledgerLimit = 50;
    renderLedger();
  });
$("#ledger-filter").addEventListener("change", () => {
  ledgerLimit = 50;
  renderLedger();
});
$("#load-more").addEventListener("click", () => {
  ledgerLimit += 50;
  renderLedger();
});
$("#export-ledger").addEventListener("click", () => {
  // JSON avoids spreadsheet formula injection from user-provided account names.
  const data = {
    exportedAt: new Date().toISOString(),
    engine: bank.live ? "java-postgresql" : "browser-sandbox",
    currency: "USD",
    accounts: state.accounts,
    transfers: state.transfers,
    entries: state.entries,
    holds: state.holds,
    events: state.events,
    reconciliation: reconcile(state),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "aethercore-demo-journal.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
channel?.addEventListener("message", () => {
  if (!bank.live) refresh().catch(report);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(report);
});
window.addEventListener("hashchange", () => view(location.hash.slice(1)));
try {
  await refresh();
  $("#loading").hidden = true;
  $("#workspace").hidden = false;
  $("#fatal").hidden = true;
  view(location.hash.slice(1));
} catch (error) {
  $("#loading").hidden = true;
  $("#fatal").hidden = false;
  $("#fatal-message").textContent = error.message;
}

function renderUpgrades() {
  const live = !!bank.live;
  $("#about-open").innerHTML =
    `<i></i> ${live ? "Live Java engine" : "Browser sandbox"} <span>ⓘ</span>`;
  $("#connection-label").textContent = live
    ? "Connected to Java · isolated 24-hour session"
    : "Browser mode · data stays on this device";
  $(".demo-banner p").textContent = live
    ? "Demo funds only. Your requests execute on the Java/PostgreSQL engine, in an isolated visitor workspace."
    : "Demo funds only. This workspace uses browser storage. Connect a deployed Java backend to exercise the server engine.";
  const about = $$("#about-dialog p");
  about[0].textContent = live
    ? "You are connected to the real Java API. Your session token scopes every request to your own accounts; it does not grant access to the internal service API."
    : "This is a working browser sandbox. Accounts, balances, holds, request keys, events, and journal entries are saved in IndexedDB on this device.";
  about[1].textContent = live
    ? "The backend commits postings in PostgreSQL and retains Kafka audit events in an outbox. The audit dashboard distinguishes queued events from broker acknowledgements. Your session expires after 24 hours."
    : "Browser mode does not call Java, PostgreSQL, Redis, or Kafka. The local event-delivery control is a simulation; select Connect live backend when you have deployed the server.";
  $("#reset-dialog p").textContent = live
    ? "Start a new isolated backend session with three starter accounts and $25,000 in demo funds? Existing server journals remain immutable and your old session expires independently. Export the current journal first if you want to retain it."
    : "This removes this browser’s demo accounts, holds, transfers, and journal, then restores the three starter accounts with $25,000 in demo funds. Export the journal first if you want to keep it.";
  const labMode = $("#view-lab .lab-mode");
  $("span", labMode).textContent = live ? "LIVE JAVA ENGINE" : "LOCAL ENGINE";
  $("p", labMode).textContent = live
    ? "These requests execute against Java/PostgreSQL. The public session coordinator serializes requests to enforce ownership and quotas; internal-service tests and load tests independently exercise concurrent account locks."
    : "IndexedDB transactions serialize browser writes, including across tabs. This demonstrates behavior; Java/PostgreSQL concurrency is tested separately.";
  const held = (state.holds || []).filter((h) => h.status === "HELD");
  $("#hold-summary").innerHTML =
    `<div><span>ACTIVE HOLDS</span><strong>${held.length}</strong></div><div><span>RESERVED FUNDS</span><strong>${money(held.reduce((n, h) => n + h.amountMinor, 0))}</strong></div><div><span>AVAILABLE FUNDS</span><strong>${money(customers().reduce((n, a) => n + a.balanceMinor - (a.heldMinor || 0), 0))}</strong></div><div><span>POSTED BALANCE</span><strong>${money(customers().reduce((n, a) => n + a.balanceMinor, 0))}</strong></div>`;
  $("#holds-list").innerHTML = (state.holds || []).length
    ? state.holds
        .slice()
        .reverse()
        .map(
          (h) =>
            `<article class="hold-card"><div><span class="status-pill">${escape(h.status)}</span><h3>${escape(h.description)}</h3><p>${escape(name(h.accountId))} · ${new Date(h.createdAt).toLocaleString()}</p></div><strong>${money(h.amountMinor)}</strong><div class="hold-actions">${h.status === "HELD" ? `<button class="button primary" data-capture="${h.id}">Capture →</button><button class="button subtle" data-release="${h.id}">Release</button>` : h.captureId ? `<button class="button subtle" data-receipt="${h.captureId}">View receipt ↗</button>` : "<span>Funds made available again.</span>"}</div></article>`,
        )
        .join("")
    : '<div class="empty-state"><span>◷</span><h3>No reservations yet.</h3><p>Create a hold to see how posted and available balances differ.</p></div>';
  const events = state.events || [];
  const pending = events.filter((e) => !e.publishedAt).length;
  $("#audit-explainer").textContent = live
    ? "Each event is committed with its transfer. Published means Kafka acknowledged the event; it does not prove downstream consumption or external settlement."
    : "Local outbox simulation. These are saved browser events, not messages sent to Kafka. Connect the Java backend to see actual broker acknowledgements.";
  $("#local-delivery-controls").hidden = live;
  $("#delivery-toggle").textContent = state.deliveryPaused
    ? "Resume local delivery"
    : "Pause local delivery";
  $("#audit-summary").innerHTML =
    `<div><span>EVENTS</span><strong>${events.length}</strong></div><div><span>PENDING</span><strong>${pending}</strong></div><div><span>${live ? "BROKER ACKNOWLEDGED" : "LOCALLY DELIVERED"}</span><strong>${events.length - pending}</strong></div><div><span>DELIVERY MODEL</span><strong class="audit-model">${live ? "At least once" : "Local simulation"}</strong></div>`;
  $("#audit-events").innerHTML = events.length
    ? `<div class="activity-scroll"><table><thead><tr><th>Transfer / event</th><th>Pipeline</th><th>Recorded</th><th>Delivery status</th></tr></thead><tbody>${events
        .slice(-100)
        .reverse()
        .map(
          (e) =>
            `<tr><td><button class="receipt-link" data-receipt="${e.transferId}">${escape(e.transferId.slice(0, 8))}… ↗</button><small class="event-id">event ${escape(e.id.slice(0, 8))}…</small></td><td><span class="audit-stages">Ledger ✓ → Outbox ✓ → ${live ? "Kafka" : "Local"} ${e.publishedAt ? "✓" : "…"}</span></td><td>${new Date(e.createdAt).toLocaleTimeString()}</td><td><span class="status-pill ${e.publishedAt ? "" : "pending"}">${e.publishedAt ? (live ? "Broker acknowledged" : "Local delivery") : "Queued for retry"}</span></td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<div class="empty-state"><h3>No events yet.</h3></div>';
}
let captureHold = null,
  reversalTransfer = null,
  guide = null;
$("#hold-open").addEventListener("click", () => {
  const form = $("#hold-form");
  form.reset();
  $(".form-error", form).hidden = true;
  populate(form.elements.accountId);
  $("#hold-dialog").showModal();
});
$("#hold-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  mutation(form, async () => {
    const request = {
      accountId: form.elements.accountId.value,
      amountMinor: parseAmount(form.elements.amount.value),
      description: form.elements.description.value.trim(),
    };
    await bank.reserve(requestKey(form, request), request);
    await refresh(true);
    pendingRequests.delete(form);
    $("#hold-dialog").close();
    notify("Funds reserved. Posted balance unchanged.");
  });
});
$("#capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  mutation(form, async () => {
    const request = {
      holdId: captureHold,
      destinationId: form.elements.destinationId.value,
    };
    const result = await bank.capture(
      requestKey(form, request),
      captureHold,
      request.destinationId,
    );
    await refresh(true);
    pendingRequests.delete(form);
    $("#capture-dialog").close();
    receipt(result.transfer, result.replayed);
  });
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.capture) {
    captureHold = button.dataset.capture;
    const hold = state.holds.find((h) => h.id === captureHold);
    const form = $("#capture-form");
    $(".form-error", form).hidden = true;
    populate(
      form.elements.destinationId,
      customers().find((a) => a.id !== hold.accountId)?.id,
    );
    $("#capture-description").textContent =
      `Capture ${money(hold.amountMinor)} from ${name(hold.accountId)}. The reservation and transfer commit together.`;
    $("#capture-dialog").showModal();
  }
  if (button.dataset.release) {
    button.disabled = true;
    try {
      await bank.release(button.dataset.release);
      await refresh(true);
      notify("Hold released. Funds are available again.");
    } catch (error) {
      report(error);
      button.disabled = false;
    }
  }
  if (button.dataset.reverse) {
    reversalTransfer = button.dataset.reverse;
    const t = state.transfers.find((t) => t.id === reversalTransfer);
    $("#reversal-description").textContent =
      `Return ${money(t.amountMinor)} from ${name(t.destinationId)} to ${name(t.sourceId)}.`;
    $("#reversal-error").hidden = true;
    $("#receipt-dialog").close();
    $("#reversal-dialog").showModal();
  }
});
$("#reversal-confirm").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await bank.reverse(
      actionKey("reverse:" + reversalTransfer),
      reversalTransfer,
    );
    await refresh(true);
    $("#reversal-dialog").close();
    receipt(result.transfer, result.replayed);
  } catch (error) {
    $("#reversal-error").textContent = error.message;
    $("#reversal-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("#audit-refresh").addEventListener("click", () => refresh().catch(report));
$("#delivery-toggle").addEventListener("click", async () => {
  try {
    await bank.setDeliveryPaused(!state.deliveryPaused);
    await refresh(true);
  } catch (error) {
    report(error);
  }
});
$("#connect-open").addEventListener("click", () => {
  $("#connect-form").elements.url.value = bank.live ? bank.base : "";
  $(".form-error", $("#connect-form")).hidden = true;
  $("#connect-dialog").showModal();
});
$("#connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  mutation(form, async () => {
    const candidate = new RemoteBank(form.elements.url.value.trim());
    const snapshot = await candidate.snapshot();
    bank = candidate;
    state = snapshot;
    sessionStorage.setItem("aether-selected-backend", bank.base);
    render();
    $("#loading").hidden = true;
    $("#fatal").hidden = true;
    $("#workspace").hidden = false;
    $("#connect-dialog").close();
    notify("Connected to Java. This is your isolated demo session.");
  });
});
$("#use-browser").addEventListener("click", async () => {
  bank = new DemoBank();
  sessionStorage.removeItem("aether-selected-backend");
  await refresh();
  $("#connect-dialog").close();
  $("#loading").hidden = true;
  $("#fatal").hidden = true;
  $("#workspace").hidden = false;
  notify("Browser sandbox restored. Your local workspace is unchanged.");
});
$("#guide-open").addEventListener("click", () => {
  guide = null;
  $("#guide-title").textContent = "Banking, in two minutes.";
  $("#guide-copy").textContent =
    "Explore a payment, a safe retry, a hold, and a reversal using dedicated accounts. Your other accounts stay untouched.";
  $("#guide-next").textContent = "Start guided demo →";
  $("#guide-next").disabled = false;
  $("#guide-progress").textContent = "GUIDED DEMO";
  $("#guide-error").hidden = true;
  $("#guide-evidence").textContent = "";
  $("#guide-dialog").showModal();
});
$("#guide-next").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  $("#guide-error").hidden = true;
  try {
    if (!guide) {
      const a = await bank.createAccount("Guided demo sender"),
        b = await bank.createAccount("Guided demo recipient");
      await bank.deposit(crypto.randomUUID(), {
        destinationId: a.id,
        amountMinor: 10000,
      });
      guide = { step: 0, a: a.id, b: b.id, key: crypto.randomUUID() };
      $("#guide-title").textContent = "1. Make a payment.";
      $("#guide-copy").textContent =
        "Your dedicated sender has $100. Move $25 to the recipient. Both sides must post together.";
      button.textContent = "Transfer $25 →";
    } else if (guide.step === 0) {
      const result = await bank.transfer(guide.key, {
        sourceId: guide.a,
        destinationId: guide.b,
        amountMinor: 2500,
      });
      guide.transfer = result.transfer;
      guide.step = 1;
      $("#guide-title").textContent = "2. Retry the same request.";
      $("#guide-copy").textContent =
        "Imagine the successful response was lost. Repeat the identical request with the same key. It should return the original receipt.";
      button.textContent = "Retry payment ↻";
    } else if (guide.step === 1) {
      const result = await bank.replay(guide.transfer.id);
      if (!result.replayed || result.transfer.id !== guide.transfer.id)
        throw Error("Retry did not return the original receipt.");
      guide.step = 2;
      $("#guide-title").textContent = "3. Reserve, then release.";
      $("#guide-copy").textContent =
        "Reserve $20 without debiting the posted balance. Then release it, making the funds available again.";
      button.textContent = "Create and release a $20 hold →";
    } else if (guide.step === 2) {
      const hold = await bank.reserve(crypto.randomUUID(), {
        accountId: guide.a,
        amountMinor: 2000,
        description: "Guided authorization",
      });
      await bank.release(hold.id);
      guide.step = 3;
      $("#guide-title").textContent = "4. Reverse without erasing.";
      $("#guide-copy").textContent =
        "Return the $25 through a compensating transfer. The original payment and its journal remain unchanged.";
      button.textContent = "Post reversal →";
    } else if (guide.step === 3) {
      await bank.reverse(
        actionKey("guide-reverse:" + guide.transfer.id),
        guide.transfer.id,
      );
      guide.step = 4;
      $("#guide-title").textContent = "5. Follow the evidence.";
      $("#guide-copy").textContent = bank.live
        ? "The sender is back at $100, the recipient at $0. The journal balances. Open Audit events to see whether Kafka has acknowledged each posting."
        : "The sender is back at $100, the recipient at $0. The journal balances. Open Audit events for the local outbox simulation; connect Java for actual Kafka acknowledgements.";
      button.textContent = "Inspect audit events →";
    } else {
      $("#guide-dialog").close();
      view("audit", true);
    }
    await refresh(true);
    if (guide) {
      $("#guide-progress").textContent =
        `STEP ${Math.min(guide.step + 1, 5)} OF 5`;
      const a = state.accounts.find((a) => a.id === guide.a),
        b = state.accounts.find((a) => a.id === guide.b);
      $("#guide-evidence").textContent =
        `Sender ${money(a.balanceMinor)} · Recipient ${money(b.balanceMinor)} · ${reconcile(state).balanced ? "Ledger balanced ✓" : "Reconciliation needs review"}`;
    }
  } catch (error) {
    $("#guide-error").textContent = error.message;
    $("#guide-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
setInterval(() => {
  if (bank.live && !document.hidden && state) refresh().catch(() => {});
}, 5000);

fetch("./benchmarks.json")
  .then((response) => {
    if (!response.ok) throw Error("Reports unavailable");
    return response.json();
  })
  .then((reports) => {
    $("#performance-results").innerHTML =
      `<div class="activity-scroll"><table><thead><tr><th>Requests / workers</th><th>Observed req/s</th><th>p50</th><th>p95</th><th>p99</th><th>Reconciliation</th></tr></thead><tbody>${reports.map((r) => `<tr><td>${Number(r.requests)} / ${Number(r.concurrency)}</td><td>${Number(r.successful_requests_per_second)}</td><td>${Number(r.latency_ms.p50)} ms</td><td>${Number(r.latency_ms.p95)} ms</td><td>${Number(r.latency_ms.p99)} ms</td><td>${Object.values(r.reconciliation).every((x) => x === 0) ? "Zero drift ✓" : "Needs review"}</td></tr>`).join("")}</tbody></table></div><p class="table-note">Source ${escape(reports[0].commit.slice(0, 8))} · ${escape(reports[0].environment.java_runtime)} · ${Number(reports[0].environment.available_cpus)} available CPUs</p>`;
  })
  .catch(() => {});
