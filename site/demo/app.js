import { DemoBank, parseAmount, reconcile } from "./engine.js";
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
const bank = new DemoBank();
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
  return `<article class="account-card"><div class="account-card-top"><span class="account-avatar tone-${index % 3}">${escape(initials)}</span><span class="currency-tag">USD ACCOUNT</span></div><h3>${escape(account.name)}</h3><code>AC · ${escape(account.id.slice(-8))}</code><strong>${money(account.balanceMinor)}</strong><div class="account-card-actions"><button data-transfer-from="${account.id}">Transfer ↗</button><button data-fund-to="${account.id}">Add funds ＋</button></div></article>`;
}
function activityTable(transfers) {
  if (!transfers.length)
    return '<div class="empty-state"><span>↔</span><h3>No movements found.</h3><p>Try another search, add demo funds, or make your first transfer.</p></div>';
  return `<div class="activity-scroll"><table><thead><tr><th>Movement</th><th>From → To</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${transfers.map((transfer) => `<tr><td><div class="movement"><span class="movement-icon ${transfer.operation === "DEPOSIT" ? "deposit" : ""}">${transfer.operation === "DEPOSIT" ? "+" : "↗"}</span><div><strong>${transfer.operation === "DEPOSIT" ? "Demo deposit" : "Account transfer"}</strong><small>${new Date(transfer.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div></td><td><div class="account-route"><span>${escape(name(transfer.sourceId))}</span><small>→ ${escape(name(transfer.destinationId))}</small></div></td><td class="amount-cell">${money(transfer.amountMinor)}</td><td><span class="status-pill">✓ Posted</span></td><td><button class="receipt-link" data-receipt="${transfer.id}" aria-label="View receipt for ${escape(money(transfer.amountMinor))} ${transfer.operation === "DEPOSIT" ? "deposit" : "transfer"}">View ↗</button></td></tr>`).join("")}</tbody></table></div>`;
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
    : money(0);
  $("#unbalanced-count").textContent = health.unbalancedTransfers;
  $("#ledger-summary").innerHTML =
    `<div><span>POSTED MOVEMENTS</span><strong>${state.transfers.length}</strong></div><div><span>JOURNAL ENTRIES</span><strong>${state.entries.length}</strong></div><div><span>NET JOURNAL BALANCE</span><strong>${money(health.netBalanceMinor)}</strong></div><div><span>RECONCILIATION</span><strong class="${health.balanced ? "text-green" : "text-red"}">${health.balanced ? "Balanced ✓" : "Needs review"}</strong></div>`;
  renderLedger();
  updateAvailable();
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
  if (!["overview", "accounts", "ledger", "lab"].includes(next))
    next = "overview";
  activeView = next;
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
      option.textContent = `${account.name} · ${money(account.balanceMinor)}`;
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
    ? `Available: ${money(source.balanceMinor)} · No overdrafts`
    : "";
}
function receipt(transfer, replayed = false) {
  const rows = state.entries.filter(
    (entry) => entry.transferId === transfer.id,
  );
  $("#receipt-content").innerHTML =
    `<div class="receipt-success">✓</div><h2 id="receipt-title">${replayed ? "Same receipt. No new charge." : "Movement posted."}</h2><div class="receipt-amount">${money(transfer.amountMinor)} <small>USD</small></div><p>${escape(name(transfer.sourceId))} → ${escape(name(transfer.destinationId))}</p>${replayed ? '<div class="replay-confirmed">Idempotency verified. No additional funds moved.</div>' : ""}<div class="receipt-journal"><div class="receipt-journal-head"><span>DOUBLE-ENTRY JOURNAL</span><span>AMOUNT</span></div>${rows.map((entry) => `<div><span><b>${entry.side === "DEBIT" ? "DR" : "CR"}</b> ${escape(name(entry.accountId))}</span><strong>${entry.side === "DEBIT" ? "−" : "+"} ${money(entry.amountMinor)}</strong></div>`).join("")}<div class="receipt-net"><span>Net movement</span><strong>${money(rows.reduce((sum, entry) => sum + (entry.side === "CREDIT" ? entry.amountMinor : -entry.amountMinor), 0))}</strong></div></div><dl class="receipt-meta"><dt>Transfer ID</dt><dd>${escape(transfer.id)}</dd><dt>Posted</dt><dd>${new Date(transfer.createdAt).toLocaleString()}</dd><dt>Engine</dt><dd>Browser sandbox · IndexedDB</dd></dl><button class="button subtle full" id="replay-request" data-id="${transfer.id}">Retry this exact request <span>↻</span></button><p class="dialog-note">Retrying returns this receipt without moving money again.</p>`;
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
        crypto.randomUUID(),
        request,
      );
      await refresh(true);
      form.closest("dialog").close();
      receipt(result.transfer, result.replayed);
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
      const key = Object.keys(state.keys).find(
        (key) => state.keys[key].id === transfer.id,
      );
      const result = await bank[
        transfer.operation === "DEPOSIT" ? "deposit" : "transfer"
      ](key, transfer);
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
    engine: "browser-sandbox",
    currency: "USD",
    accounts: state.accounts,
    transfers: state.transfers,
    entries: state.entries,
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
channel?.addEventListener("message", () => refresh().catch(report));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(report);
});
window.addEventListener("hashchange", () => view(location.hash.slice(1)));
try {
  await refresh();
  $("#loading").hidden = true;
  $("#workspace").hidden = false;
  view(location.hash.slice(1));
} catch (error) {
  $("#loading").hidden = true;
  $("#fatal").hidden = false;
  $("#fatal-message").textContent = error.message;
}
