const { test, expect } = require("@playwright/test");
for (const mode of ["browser", "live"])
  test.describe(`${mode} banking upgrades`, () => {
    test.skip(
      mode === "live" && !process.env.LIVE_BACKEND_URL,
      "Set LIVE_BACKEND_URL to exercise the actual Java service.",
    );
    test.beforeEach(async ({ page }) => {
      await page.goto("/demo/");
      await expect(page.locator("#workspace")).toBeVisible();
      if (mode === "live") {
        await page
          .getByRole("button", { name: /Connect live backend/ })
          .click();
        await page.getByLabel("Backend URL").fill(process.env.LIVE_BACKEND_URL);
        await page
          .locator("#connect-form")
          .getByRole("button", { name: /Connect with/ })
          .click();
        await expect(page.locator("#connect-dialog")).not.toBeVisible();
        await expect(page.locator("#connection-label")).toContainText(
          "Connected to Java",
        );
      }
    });
    test("reserve, capture, reverse, and release without erasing journals", async ({
      page,
    }) => {
      await page.getByRole("button", { name: "Holds", exact: true }).click();
      async function hold(amount, label) {
        await page.getByRole("button", { name: /Create a hold/ }).click();
        const form = page.locator("#hold-form");
        await form.getByLabel("Amount in USD").fill(amount);
        await form.getByLabel("Description", { exact: true }).fill(label);
        await form.getByRole("button", { name: /Reserve funds/ }).click();
        await expect(page.locator("#hold-dialog")).not.toBeVisible();
      }
      await hold("50", "Test hotel authorization");
      await expect(page.locator("#holds-list")).toContainText("HELD");
      await expect(page.locator("#hold-summary")).toContainText("$50.00");
      await page.getByRole("button", { name: /Capture →/ }).click();
      await page
        .locator("#capture-form")
        .getByRole("button", { name: /Capture and transfer/ })
        .click();
      await expect(page.locator("#receipt-dialog")).toContainText("$50.00");
      await page
        .getByRole("button", { name: /Reverse with a new transfer/ })
        .click();
      await page
        .getByRole("button", { name: /Post compensating transfer/ })
        .click();
      await expect(page.locator("#receipt-dialog")).toContainText(
        "Compensates original transfer",
      );
      await page
        .locator("#receipt-dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.locator("#holds-list")).toContainText("CAPTURED");
      await hold("25", "Authorization to release");
      await page.getByRole("button", { name: "Release", exact: true }).click();
      await expect(page.locator("#holds-list")).toContainText("RELEASED");
      await page.getByRole("button", { name: "Ledger", exact: true }).click();
      await expect(page.locator("#all-activity tbody tr")).toHaveCount(5);
      await expect(page.locator("#health-title")).toHaveText(
        "Everything balances.",
      );
    });
    test("audit dashboard distinguishes queued events and actual broker acknowledgements", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: "Audit events", exact: true })
        .click();
      if (mode === "browser")
        await page
          .getByRole("button", { name: "Pause local delivery", exact: true })
          .click();
      else
        await expect(
          page.locator("#local-delivery-controls"),
        ).not.toBeVisible();
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.getByRole("button", { name: /Make a transfer/ }).click();
      await page
        .locator("#transfer-form")
        .getByLabel("Amount in USD")
        .fill("12.34");
      await page
        .locator("#transfer-form")
        .getByRole("button", { name: /Transfer demo funds/ })
        .click();
      await expect(page.locator("#receipt-dialog")).toContainText("$12.34");
      await page
        .locator("#receipt-dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Audit events", exact: true })
        .click();
      if (mode === "browser") {
        await expect(page.locator("#audit-events")).toContainText(
          "Queued for retry",
        );
        await page
          .getByRole("button", { name: "Resume local delivery", exact: true })
          .click();
        await expect(page.locator("#audit-events")).not.toContainText(
          "Queued for retry",
        );
        await expect(page.locator("#audit-events")).toContainText(
          "Local delivery",
        );
      } else {
        await expect
          .poll(
            async () => {
              await page
                .getByRole("button", { name: /Refresh events/ })
                .click();
              return page.locator("#audit-events .status-pill.pending").count();
            },
            { timeout: 25000 },
          )
          .toBe(0);
        await expect(page.locator("#audit-events")).toContainText(
          "Broker acknowledged",
        );
      }
    });
    test("guided walkthrough proves payment, retry, hold release, and reversal", async ({
      page,
    }) => {
      await page
        .getByRole("button", { name: /Two-minute guided demo/ })
        .click();
      for (const name of [
        /Start guided demo/,
        /Transfer \$25/,
        /Retry payment/,
        /Create and release/,
        /Post reversal/,
      ])
        await page
          .locator("#guide-dialog")
          .getByRole("button", { name })
          .click();
      await expect(page.locator("#guide-evidence")).toContainText(
        "Sender $100.00 · Recipient $0.00 · Ledger balanced",
      );
      await page
        .locator("#guide-dialog")
        .getByRole("button", { name: /Inspect audit events/ })
        .click();
      await expect(page.locator("#view-audit")).toBeVisible();
    });
    if (mode === "live")
      test("lost server response retries the same key without a second debit", async ({
        page,
      }) => {
        let loseResponse = true;
        const keys = [];
        await page.route("**/demo-api/transfers", async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          keys.push(route.request().headers()["idempotency-key"]);
          if (loseResponse) {
            loseResponse = false;
            await route.fetch();
            await route.abort("failed");
          } else await route.continue();
        });
        await page.getByRole("button", { name: /Make a transfer/ }).click();
        const form = page.locator("#transfer-form");
        await form.getByLabel("Amount in USD").fill("10.00");
        await form.getByRole("button", { name: /Transfer demo funds/ }).click();
        await expect(form.locator(".form-error")).toContainText(
          "retry with unchanged details",
        );
        await form.getByRole("button", { name: /Transfer demo funds/ }).click();
        await expect(page.locator(".replay-confirmed")).toContainText(
          "No additional funds moved",
        );
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
      });
  });
