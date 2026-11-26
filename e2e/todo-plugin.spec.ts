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
import { addWorkspace, callCanvasTool, createProfile, signIn, untilFramePainted } from "./helpers.ts";
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

async function startConversation(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

test("the To-do tab adds, ticks, edits and deletes a workspace's to-dos, and the agent and the slash menu reach them", async ({ page }) => {
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

  await test.step("a picked time wins over the words, and one that has passed is overdue", async () => {
    await line.fill("renew the certificate");
    await tabView(page).getByLabel("Due", { exact: true }).fill("2020-01-01T10:00");
    await expect(tabView(page).locator(".preview .due-chip")).toHaveText("Due Wed 1 Jan 10:00");
    await line.press("Enter");
    await expect(group(page, "Overdue").locator("li.row .text")).toHaveText(["renew the certificate"]);
    await expect(tabView(page).locator(".counts")).toHaveText("3 open · 1 overdue");
    await expect(tabView(page).getByLabel("Due", { exact: true })).toHaveValue("");
  });

  await test.step("ticking one off moves it to Done, and Undo brings it back", async () => {
    await row(page, "renew the certificate").getByRole("checkbox").check();
    await expect(group(page, "Overdue")).toHaveCount(0);
    await expect(tabView(page).locator("details.done summary")).toHaveText("Done · 1");
    await tabView(page).getByRole("button", { name: "Undo" }).click();
    await expect(group(page, "Overdue").locator("li.row .text")).toHaveText(["renew the certificate"]);
    await expect(tabView(page).locator("details.done")).toBeHidden();
  });

  await test.step("Edit changes the text, the note and the time", async () => {
    await row(page, "read the chapter").hover();
    await row(page, "read the chapter").getByRole("button", { name: "Edit" }).click();
    const editor = tabView(page).locator("li.editor");
    await editor.getByRole("textbox", { name: "To-do" }).fill("read the design chapter");
    await editor.getByRole("textbox", { name: "Note" }).fill("the one on storage");
    await editor.getByLabel("Due").fill("2099-03-02T08:30");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);
    await expect(group(page, "Coming up").locator("li.row", { hasText: "read the design chapter" }).locator(".note")).toHaveText("the one on storage");
    await expect(row(page, "read the design chapter").locator(".due")).toHaveText("Mon 2 Mar 08:30");
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
    expect(listed).toContain("Open to-dos in every workspace, the soonest due first (4)");
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
    await expect(tabView(page).locator(".counts")).toHaveText("3 open");
  });

  await test.step("/todo:todo_add in the slash menu adds one, reading its time from the text, without the agent hearing of it", async () => {
    const composer = page.locator(".composer:visible textarea");
    await composer.fill('/todo:todo_add text="book the room tomorrow 11:00"');
    await composer.press("Enter");
    await expect(page.locator(".plugin-command-reply:visible")).toContainText("Added to the To-do tab of project");
    await expect(row(page, "book the room").locator(".due")).toHaveText(/^(Today|Tomorrow) 11:00$/);
    await expect(composer).toHaveValue("");
  });
});
