import { expect, test } from "@playwright/test";

const shotsDir = "test-results/screenshots";

test("页面与各 Tab 可渲染（用于排版自测）", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "codex_session_migration_sync" })).toBeVisible();
  const tabs = page.locator("nav.tabs");

  // Sessions
  await expect(page.getByRole("heading", { level: 2, name: "会话列表" })).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/01-会话.png`, fullPage: true });

  // Export
  await tabs.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "导出" })).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/02-导出.png`, fullPage: true });

  // Import
  await tabs.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "导入" })).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/03-导入.png`, fullPage: true });

  // Change ID
  await tabs.getByRole("button", { name: "更换会话ID", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "更换会话ID" })).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/04-更换会话ID.png`, fullPage: true });

  // History
  await tabs.getByRole("button", { name: "历史", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "历史" })).toBeVisible();
  await expect(
    page.locator("table").getByRole("cell", { name: "示例：mac -> win 传递" }),
  ).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/05-历史.png`, fullPage: true });

  // Settings
  await tabs.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "设置" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "存档库占用" })).toBeVisible();
  await page.screenshot({ path: `${shotsDir}/06-设置.png`, fullPage: true });
});
