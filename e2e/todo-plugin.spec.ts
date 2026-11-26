/**
 * Drives the To-do tab, its tools and its slash command in a real Mirador. It needs Mirador's own e2e helpers, so run it
 * from a Mirador checkout with this plugin's folder named, and the spec inside that checkout's e2e folder:
 *
 *   cp e2e/todo-plugin.spec.ts ~/prj/mirador/e2e/
 *   MIRADOR_TODO_PLUGIN=$PWD scripts/e2e.sh e2e/todo-plugin.spec.ts
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, allowNotifications, callCanvasTool, chooseInSettings, createProfile, notificationsShown, openSettings, signIn, untilFramePainted } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const PLUGIN = process.env.MIRADOR_TODO_PLUGIN ?? import.meta.dirname;
const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(PLUGIN, join(host.dataDir, "plugins", "todo"));
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const tabFrame = (page: Page) => page.locator(".canvas-panel:visible .canvas-frame.workspace-tab iframe");
const tabView = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.workspace-tab iframe");
const tabToggle = (page: Page) => page.locator(".canvas-panel:visible .workspace-tab-toggle", { hasText: "To-do" });
const group = (page: Page, name: string) => tabView(page).getByRole("region", { name });
const row = (page: Page, text: string) => tabView(page).locator("li.row", { hasText: text });
const composerOf = (page: Page) => tabView(page).locator(".composer");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The 15th of the month some months from now, as the calendar names its day and the tab shows its time. */
const fifteenthIn = (months: number) => {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth() + months, 15);
  const shown = `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
  return { name: `${shown} ${day.getFullYear()}`, shown };
};

async function startConversation(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

test("the To-do tab adds, ticks, edits and deletes a workspace's to-dos, and the agent and the slash menu reach them", async ({ page }) => {
  await allowNotifications(page);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "helper", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "helper · opencode" });
  const conversationId = await startConversation(page);
  const line = tabView(page).getByRole("textbox", { name: "New to-do" });

  await test.step("the empty tab says how to add one", async () => {
    await tabToggle(page).click();
    await untilFramePainted(page, tabFrame(page));
    await expect(tabView(page).locator("h1")).toHaveText("To-do");
    await expect(tabView(page).getByText("Nothing to do here yet.")).toBeVisible();
  });

  await test.step("a line with its time in words at the end previews that time, and adds without the words", async () => {
    await line.fill("send the summary tomorrow 14:00");
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText(/^Due (Today|Tomorrow) 14:00$/);
    await expect(tabView(page).locator(".preview")).toContainText("“send the summary”");
    await line.press("Enter");
    await expect(row(page, "send the summary").locator(".due")).toHaveText(/^(Today|Tomorrow) 14:00$/);
    await expect(row(page, "send the summary").locator(".text")).toHaveText("send the summary");
    await expect(line).toHaveValue("");
    await expect(line).toBeFocused();
    await expect(tabView(page).getByText("Nothing to do here yet.")).toBeHidden();
  });

  await test.step("Keep the words adds the line as typed, with no time", async () => {
    await line.fill("read the chapter on friday");
    await tabView(page).getByRole("button", { name: "Keep the words" }).click();
    await expect(tabView(page).locator(".preview")).toContainText("No time; the words stay as typed.");
    await tabView(page).getByRole("button", { name: "Add" }).click();
    await expect(group(page, "No time").locator("li.row .text")).toHaveText(["read the chapter on friday"]);
  });

  await test.step("a day without a time means the morning set in Mirador's settings", async () => {
    const settings = await openSettings(page, "Conversations");
    await settings.getByLabel("Morning starts at").fill("07:30");
    await settings.getByRole("button", { name: "Close" }).click();
    await line.fill("water the plants tomorrow");
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText(/^Due (Today|Tomorrow) 07:30$/);
    await line.fill("");
  });

  await test.step("a quick pick sets the time over the words, and Clear gives the words back", async () => {
    await line.fill("call the bank tomorrow");
    await composerOf(page).getByRole("button", { name: /^In 3 hours \d{2}:\d{2}$/ }).click();
    await expect(composerOf(page).getByRole("button", { name: /^In 3 hours/ })).toHaveAttribute("aria-pressed", "true");
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText(/^Due (Today|Tomorrow) \d{2}:\d{2}$/);
    await expect(tabView(page).locator(".preview")).toContainText("in 3h");
    await composerOf(page).getByRole("button", { name: "Clear" }).click();
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText(/^Due (Today|Tomorrow) 07:30$/);
    await line.fill("");
  });

  await test.step("the calendar picks a day and a time, which win over the words, and Esc closes only the calendar", async () => {
    const fifteenth = fifteenthIn(1);
    await line.fill("plan the offsite fri 14:00");
    await composerOf(page).getByRole("button", { name: "Pick a day…" }).click();
    await composerOf(page).getByRole("button", { name: "Next month" }).click();
    await composerOf(page).getByRole("button", { name: fifteenth.name, exact: true }).click();
    await expect(composerOf(page).locator(".picked b")).toHaveText(`${fifteenth.shown} 07:30`);
    await expect(tabView(page).locator(".preview")).toBeHidden();
    await composerOf(page).getByRole("button", { name: "17:00", exact: true }).click();
    await expect(composerOf(page).locator(".picked b")).toHaveText(`${fifteenth.shown} 17:00`);
    await composerOf(page).getByLabel("Other time").fill("16:45");
    await expect(composerOf(page).locator(".picked b")).toHaveText(`${fifteenth.shown} 16:45`);
    await composerOf(page).getByLabel("Other time").press("Escape");
    await expect(composerOf(page).locator(".calendar")).toHaveCount(0);
    await expect(composerOf(page).locator(".picker")).toHaveText(/^In 3 hours.*Pick a day…$/);
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText(`Due ${fifteenth.shown} 16:45`);
    await expect(line).toHaveValue("plan the offsite fri 14:00");
    await composerOf(page).getByRole("button", { name: "Add" }).click();
    await expect(row(page, "plan the offsite").locator(".due")).toHaveText(`${fifteenth.shown} 16:45`);
    await expect(tabView(page).locator(".preview")).toBeHidden();
  });

  await test.step("one already past is overdue", async () => {
    await callCanvasTool(host, conversationId, "use_tool", { tool: "todo_add", input: { text: "renew the certificate", due: "2020-01-01T10:00:00+01:00" } });
    await expect(group(page, "Overdue").locator("li.row .text")).toHaveText(["renew the certificate"]);
    await expect(tabView(page).locator(".counts")).toHaveText("4 open · 1 overdue");
  });

  await test.step("ticking one off moves it to Done, and Undo brings it back", async () => {
    await row(page, "renew the certificate").getByRole("checkbox").check();
    await expect(group(page, "Overdue")).toHaveCount(0);
    await expect(tabView(page).locator("details.done summary")).toHaveText("Done · 1");
    await tabView(page).getByRole("button", { name: "Undo" }).click();
    await expect(group(page, "Overdue").locator("li.row .text")).toHaveText(["renew the certificate"]);
    await expect(tabView(page).locator("details.done")).toBeHidden();
  });

  await test.step("Edit changes the text, the note and the time, its calendar closing on Esc while the editor stays", async () => {
    const fifteenth = fifteenthIn(2);
    await row(page, "read the chapter").hover();
    await row(page, "read the chapter").getByRole("button", { name: "Edit" }).click();
    const editor = tabView(page).locator("li.editor");
    await expect(editor.getByRole("button", { name: "No time" })).toHaveAttribute("aria-pressed", "true");
    await editor.getByRole("textbox", { name: "To-do" }).fill("read the design chapter");
    await editor.getByRole("textbox", { name: "Note" }).fill("the one on storage");
    await editor.getByRole("button", { name: "Pick a day…" }).click();
    await editor.getByRole("button", { name: "Next month" }).click();
    await editor.getByRole("button", { name: "Next month" }).focus();
    await editor.getByRole("button", { name: "Next month" }).press("Escape");
    await expect(editor.locator(".calendar")).toHaveCount(0);
    await expect(editor).toHaveCount(1);
    await editor.getByRole("button", { name: "Pick a day…" }).click();
    await editor.getByRole("button", { name: "Next month" }).click();
    await editor.getByRole("button", { name: fifteenth.name, exact: true }).click();
    await editor.getByLabel("Other time").fill("08:30");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);
    await expect(group(page, "Coming up").locator("li.row", { hasText: "read the design chapter" }).locator(".note")).toHaveText("the one on storage");
    await expect(row(page, "read the design chapter").locator(".due")).toHaveText(`${fifteenth.shown} 08:30`);
  });

  await test.step("No time in the editor takes the time off", async () => {
    await row(page, "plan the offsite").hover();
    await row(page, "plan the offsite").getByRole("button", { name: "Edit" }).click();
    const editor = tabView(page).locator("li.editor");
    await editor.getByRole("button", { name: "No time" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(group(page, "No time").locator("li.row .text")).toHaveText(["plan the offsite fri 14:00"]);
  });

  await test.step("Delete takes it out, and Undo puts it back", async () => {
    await row(page, "renew the certificate").hover();
    await row(page, "renew the certificate").getByRole("button", { name: "Delete" }).click();
    await expect(row(page, "renew the certificate")).toHaveCount(0);
    await tabView(page).getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "renew the certificate")).toHaveCount(1);
  });

  await test.step("the agent adds and lists to-dos through use_tool, and the open tab shows what it added", async () => {
    const added = await callCanvasTool(host, conversationId, "use_tool", {
      tool: "todo_add",
      input: { text: "reply to the release thread", due: "2099-01-05T09:00:00+01:00", note: "the one about the freeze" },
    });
    expect(added).toContain("Added to the To-do tab of project");
    await expect(row(page, "reply to the release thread").locator(".note")).toHaveText("the one about the freeze");
    const listed = await callCanvasTool(host, conversationId, "use_tool", { tool: "todo_list", input: { all_workspaces: true } });
    expect(listed).toContain("Open to-dos in every workspace, the soonest due first (5)");
    expect(listed).toContain("[project]: renew the certificate");
    expect(listed.indexOf("renew the certificate")).toBeLessThan(listed.indexOf("reply to the release thread"));
  });

  await test.step("the agent ticks one off by its id", async () => {
    const listed = await callCanvasTool(host, conversationId, "use_tool", { tool: "todo_list", input: {} });
    const id = /- ([0-9a-f-]{36}): renew the certificate/.exec(listed)![1]!;
    expect(await callCanvasTool(host, conversationId, "use_tool", { tool: "todo_update", input: { id, done: true } })).toContain("renew the certificate");
    await expect(tabView(page).locator("details.done summary")).toHaveText("Done · 1");
    await tabView(page).locator("details.done summary").click();
    await expect(row(page, "renew the certificate").getByRole("checkbox")).toBeChecked();
    await expect(tabView(page).locator(".counts")).toHaveText("4 open");
  });

  await test.step("/todo:todo_add in the slash menu adds one, reading its time from the text, without the agent hearing of it", async () => {
    const composer = page.locator(".composer:visible textarea");
    await composer.fill('/todo:todo_add text="book the room tomorrow 11:00"');
    await composer.press("Enter");
    await expect(page.locator(".plugin-command-reply:visible")).toContainText("Added to the To-do tab of project");
    await expect(row(page, "book the room").locator(".due")).toHaveText(/^(Today|Tomorrow) 11:00$/);
    await expect(composer).toHaveValue("");
  });

  await test.step("a to-do rings on this computer as it comes due, naming its workspace, while one already overdue as it was added never did", async () => {
    const inAFewSeconds = new Date(Date.now() + 3_000).toISOString();
    await callCanvasTool(host, conversationId, "use_tool", { tool: "todo_add", input: { text: "post the stand-up notes", due: inAFewSeconds } });
    await expect
      .poll(() => notificationsShown(page), { timeout: 15_000 })
      .toEqual([{ title: "post the stand-up notes", body: expect.stringMatching(/^project · Due today \d{2}:\d{2}$/), tag: expect.stringMatching(/^[0-9a-f-]{36}$/), closed: false }]);
  });

  const screenshots = process.env.TODO_SCREENSHOTS;
  if (screenshots) {
    await test.step("screenshots of the tab, light and dark", async () => {
      await page.setViewportSize({ width: 1500, height: 1000 });
      const shoot = async (name: string) => {
        await page.waitForTimeout(400);
        await tabFrame(page).screenshot({ path: join(screenshots, `${name}.png`) });
      };
      for (const theme of ["Light", "Dark"]) {
        await chooseInSettings(page, "Theme", theme);
        await line.fill("send the summary fri 14:00");
        await composerOf(page).getByRole("button", { name: "Pick a day…" }).click();
        await shoot(`composer-${theme.toLowerCase()}`);
        await line.press("Escape");
        await row(page, "read the design chapter").hover();
        await row(page, "read the design chapter").getByRole("button", { name: "Edit" }).click();
        await tabView(page).locator("li.editor").getByRole("button", { name: "Pick a day…" }).click();
        await shoot(`editor-${theme.toLowerCase()}`);
        await tabView(page).locator("li.editor").getByRole("button", { name: "Cancel" }).click();
      }
    });
  }
});
