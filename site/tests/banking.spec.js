const { test, expect } = require("@playwright/test");
test.beforeEach(async ({ page }) => {
  await page.goto("/demo/");
  await expect(page.locator("#workspace")).toBeVisible();
});

test("create, fund, transfer, replay, and retain a workspace", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#total-balance")).toHaveText("$25,000.00");
  await page.getByRole("button", { name: /Create an account/ }).click();
  await page.getByLabel("Account name").fill("Equipment fund");
  await page
    .locator("#account-form")
    .getByRole("button", { name: /Create account/ })
    .click();
  const card = page
    .locator("#all-accounts .account-card")
    .filter({ hasText: "Equipment fund" });
  await expect(card).toContainText("$0.00");
  await card.getByRole("button", { name: /Add funds/ }).click();
  const funding = page.locator("#fund-form");
  await funding.getByLabel("Amount in USD").fill("120.50");
  await funding.getByRole("button", { name: /Add demo funds/ }).click();
  await expect(page.locator("#receipt-dialog")).toContainText("$120.50");
  await page
    .locator("#receipt-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(card).toContainText("$120.50");
  await card.getByRole("button", { name: /Transfer/ }).click();
  const form = page.locator("#transfer-form");
  const destination = await form
    .locator("select[name=destinationId] option")
    .filter({ hasText: "Operating account" })
    .getAttribute("value");
  await form.getByLabel("To", { exact: true }).selectOption(destination);
  await form.getByLabel("Amount in USD").fill("20.25");
  await form.getByRole("button", { name: /Transfer demo funds/ }).click();
  await expect(page.locator("#receipt-dialog")).toContainText("$20.25");
  await expect(page.locator("#receipt-dialog")).toContainText("Net movement");
  await page.getByRole("button", { name: /Retry this exact request/ }).click();
  await expect(page.locator(".replay-confirmed")).toContainText(
    "No additional funds moved",
  );
  await page
    .locator("#receipt-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(card).toContainText("$100.25");
  await page.reload();
  await expect(page.locator("#all-accounts")).toBeVisible();
  await expect(card).toContainText("$100.25");
  expect(errors).toEqual([]);
});

test("bad precision and overdrafts leave money unchanged", async ({ page }) => {
  await page.getByRole("button", { name: /Make a transfer/ }).click();
  const form = page.locator("#transfer-form");
  await form.getByLabel("Amount in USD").fill("0.001");
  await form.getByRole("button", { name: /Transfer demo funds/ }).click();
  await expect(form.locator(".form-error")).toContainText("two decimal places");
  await form.getByLabel("Amount in USD").fill("999999");
  await form.getByRole("button", { name: /Transfer demo funds/ }).click();
  await expect(form.locator(".form-error")).toContainText("enough money");
  await expect(page.locator("#total-balance")).toHaveText("$25,000.00");
  const result = await page.evaluate(async () => {
    const { DemoBank, reconcile } = await import("/demo/engine.js");
    const state = await new DemoBank().snapshot();
    return {
      count: state.transfers.length,
      balanced: reconcile(state).balanced,
    };
  });
  expect(result).toEqual({ count: 3, balanced: true });
});

test("both reliability experiments run committed browser transactions", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: /Reliability lab/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Run retry experiment/ }).click();
  await expect(page.locator("#retry-result")).toContainText("Invariants held.");
  await expect(page.locator("#retry-result")).toContainText("31");
  await page.getByRole("button", { name: /Run overdraft experiment/ }).click();
  await expect(page.locator("#overdraft-result")).toContainText(
    "Invariants held.",
  );
  await expect(page.locator("#overdraft-result")).toContainText("30");
  const result = await page.evaluate(async () => {
    const { DemoBank, reconcile } = await import("/demo/engine.js");
    const state = await new DemoBank().snapshot();
    return {
      transfers: state.transfers.length,
      entries: state.entries.length,
      balanced: reconcile(state).balanced,
    };
  });
  expect(result).toEqual({ transfers: 16, entries: 32, balanced: true });
});

test("durable keys, changed payload conflict, and transaction rollback", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { DemoBank, reconcile } = await import("/demo/engine.js");
    const bank = new DemoBank();
    let state = await bank.snapshot();
    const [a, b] = state.accounts.filter((a) => a.kind === "CUSTOMER");
    const request = { sourceId: a.id, destinationId: b.id, amountMinor: 1000 };
    const first = await bank.transfer("constructor", request),
      replay = await bank.transfer("constructor", request);
    let conflict;
    try {
      await bank.transfer("constructor", { ...request, amountMinor: 1001 });
    } catch (error) {
      conflict = error.code;
    }
    try {
      await bank.transact((state) => {
        state.accounts[1].balanceMinor = 1;
        throw Error("injected failure");
      });
    } catch (_) {}
    state = await bank.snapshot();
    return {
      same: first.transfer.id === replay.transfer.id,
      replayed: replay.replayed,
      conflict,
      balance: state.accounts.find((x) => x.id === a.id).balanceMinor,
      count: state.transfers.length,
      balanced: reconcile(state).balanced,
    };
  });
  expect(result).toEqual({
    same: true,
    replayed: true,
    conflict: "IDEMPOTENCY_CONFLICT",
    balance: 1249000,
    count: 4,
    balanced: true,
  });
});

test("competing tabs share one serialized balance", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await second.goto("/demo/");
  await expect(second.locator("#workspace")).toBeVisible();
  const ids = await page.evaluate(async () => {
    const { DemoBank } = await import("/demo/engine.js");
    const bank = new DemoBank();
    const a = await bank.createAccount("Cross-tab sender"),
      b = await bank.createAccount("Cross-tab receiver");
    await bank.deposit("cross-tab-funding", {
      destinationId: a.id,
      amountMinor: 1000,
    });
    return { sourceId: a.id, destinationId: b.id, amountMinor: 1000 };
  });
  const results = await Promise.all(
    [page, second].map((tab, index) =>
      tab.evaluate(
        async ({ ids, index }) => {
          const { DemoBank } = await import("/demo/engine.js");
          try {
            await new DemoBank().transfer(`tab-${index}`, ids);
            return "posted";
          } catch (error) {
            return error.code;
          }
        },
        { ids, index },
      ),
    ),
  );
  expect(results.sort()).toEqual(["INSUFFICIENT_FUNDS", "posted"]);
});

test("journal search, export, reset, and responsive layout", async ({
  page,
}) => {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Ledger", exact: true }).click();
  await expect(page.locator("#all-activity tbody tr")).toHaveCount(3);
  await page
    .getByRole("searchbox", { name: "Search ledger" })
    .fill("no-such-account");
  await expect(page.locator("#all-activity")).toContainText(
    "No movements found",
  );
  await page.getByRole("searchbox", { name: "Search ledger" }).fill("Payroll");
  await expect(page.locator("#all-activity tbody tr")).toHaveCount(1);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export journal/ }).click();
  expect((await downloaded).suggestedFilename()).toBe(
    "aethercore-demo-journal.json",
  );
  await page.getByRole("button", { name: /Reset workspace/ }).click();
  await page
    .getByRole("button", { name: "Reset demo data", exact: true })
    .click();
  await expect(page.locator("#total-balance")).toHaveText("$25,000.00");
  await expect(page.locator("#overview-accounts .account-card")).toHaveCount(3);
  await expect(page.locator("#reset-dialog")).not.toBeVisible();
});

test("names render as text and separate visitors have isolated data", async ({
  page,
  browser,
}) => {
  await page.getByRole("button", { name: /Create an account/ }).click();
  await page.getByLabel("Account name").fill("<img src=x onerror=alert(1)>");
  await page
    .locator("#account-form")
    .getByRole("button", { name: /Create account/ })
    .click();
  await expect(page.locator("#all-accounts")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#all-accounts img")).toHaveCount(0);
  const other = await browser.newContext();
  const tab = await other.newPage();
  await tab.goto("/demo/");
  await expect(tab.locator("#workspace")).toBeVisible();
  await expect(tab.locator("#overview-accounts .account-card")).toHaveCount(3);
  await expect(tab.locator("#all-accounts")).not.toContainText("<img src=x");
  await other.close();
});
