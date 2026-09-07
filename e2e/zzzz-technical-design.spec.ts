import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("demo-password-please-change");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1400) < 801) await page.getByLabel("Open navigation", { exact: true }).click();
  const nav = page.getByLabel("Primary navigation", { exact: true });
  await nav.getByRole("button", { name: name === "Projects" ? /^Projects/u : name, exact: name !== "Projects" }).click();
}
async function theme(page: Page, name: string) {
  await page.getByLabel("Workspace appearance", { exact: true }).click();
  await page.getByRole("radio", { name, exact: true }).check();
  await page.keyboard.press("Escape");
}
for (const width of [1536, 390, 320]) for (const mode of ["Light", "Dark"]) test(`technical workspace stays readable in ${mode} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await signIn(page); await theme(page, mode);
  for (const section of ["Workbench", "Inventory", "Projects", "Settings"]) {
    await navigate(page, section);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode.toLowerCase());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator("main").evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
  }
  await page.getByLabel("Open workspace commands").click();
  await expect(page.getByRole("dialog", { name: "Workspace commands", exact: true })).toBeVisible();
  expect(await page.getByRole("dialog").evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })).toBe(true);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("appearance and compact navigation persist without business-data writes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await signIn(page);
  const writes: string[] = []; page.on("request", (request) => { if (request.url().includes("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
  await navigate(page, "Inventory"); await expect(page.locator(".inventory-table tbody tr").first()).toBeVisible();
  const before = await page.locator(".inventory-table tbody tr").first().evaluate((row) => row.getBoundingClientRect().height);
  await page.getByLabel("Workspace appearance").click(); await page.getByRole("radio", { name: "Compact", exact: true }).check(); await page.getByRole("radio", { name: "Dark", exact: true }).check(); await page.keyboard.press("Escape");
  const after = await page.locator(".inventory-table tbody tr").first().evaluate((row) => row.getBoundingClientRect().height);
  expect(after).toBeLessThan(before);
  await page.getByLabel("Collapse navigation", { exact: true }).click();
  expect(await page.getByLabel("Primary navigation", { exact: true }).evaluate((nav) => nav.getBoundingClientRect().width)).toBe(64);
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); await expect(page.locator("html")).toHaveAttribute("data-density", "compact"); await expect(page.locator("html")).toHaveAttribute("data-nav", "rail");
  await navigate(page, "Workbench"); await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  await page.getByLabel("Expand navigation", { exact: true }).click(); expect(writes).toEqual([]);
});
test("commands open pages and forms by keyboard while retaining focus boundaries", async ({ page }) => {
  await signIn(page); await page.keyboard.press("Control+Shift+K");
  const input = page.getByRole("combobox", { name: "Find a page, project or action", exact: true }); await expect(input).toBeFocused();
  await input.fill("settings"); await input.press("Enter"); await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Open workspace commands").click(); await input.fill("new project"); await input.press("Enter");
  await expect(page.getByRole("dialog", { name: "Create project", exact: true })).toBeVisible(); await expect(page.locator(".app-background")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+k"); await expect(page.getByPlaceholder("Search name, model, tag, or location")).toBeFocused();
});
test("system colour changes and reduced motion work without reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" }); await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" }); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Open workspace commands").click(); expect(await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.keyboard.press("Escape"); await expect(page.getByLabel("Open workspace commands")).toBeFocused();
});
test("the skip link moves focus without changing the selected page", async ({ page }) => {
  await signIn(page); await navigate(page, "Inventory"); const url = page.url();
  await page.getByRole("link", { name: "Skip to workspace", exact: true }).focus();
  await page.keyboard.press("Enter"); await expect(page.locator("#main-content")).toBeFocused(); expect(page.url()).toBe(url);
  await expect(page.getByRole("heading", { name: "Inventory", exact: true })).toBeVisible();
});
test("both themes retain text contrast and serve fonts from the application", async ({ page }) => {
  const fontOrigins: string[] = []; page.on("request", (request) => { if (/\.woff2?(?:\?|$)/u.test(request.url())) fontOrigins.push(new URL(request.url()).origin); });
  await signIn(page); await page.evaluate(() => document.fonts.ready);
  expect(fontOrigins.length).toBeGreaterThan(0); expect(new Set(fontOrigins)).toEqual(new Set([new URL(page.url()).origin]));
  for (const name of ["Light", "Dark"]) {
    await theme(page, name);
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      // CSS minifiers may shorten hex values or emit named/rgb colours.
      // Measure the browser's rendered sRGB value instead of assuming six hex digits.
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const luminance = (token: string) => {
        context.fillStyle = style.getPropertyValue(token).trim(); context.fillRect(0, 0, 1, 1);
        const rgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      return [["--ink", "--surface"], ["--ink-soft", "--surface-strong"], ["--ink-muted", "--surface-soft"], ["--on-accent", "--accent"], ["--moss-dark", "--moss-soft"], ["--amber-ink", "--amber-soft"], ["--red", "--red-soft"], ["--slate", "--slate-soft"]].map(([a, b]) => { const first = luminance(a!), second = luminance(b!); return { token: a, ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) }; });
    });
    for (const pair of contrast) expect(pair.ratio, `${name} ${pair.token}`).toBeGreaterThanOrEqual(4.5);
  }
});
