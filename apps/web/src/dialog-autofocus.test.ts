// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { watchLateAutofocus } from "./dialog-autofocus";

afterEach(() => { document.body.innerHTML = ""; });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function openDialog() {
  const dialog = document.createElement("section"); dialog.tabIndex = -1;
  const close = document.createElement("button"); close.textContent = "Close dialog";
  dialog.append(close); document.body.append(dialog); close.focus();
  return { dialog, close };
}

function lateContent(dialog: HTMLElement) {
  const field = document.createElement("textarea"); field.setAttribute("data-autofocus", "");
  dialog.append(field); return field;
}

it("moves focus to a data-autofocus control that mounts after the dialog opened", async () => {
  const { dialog, close } = openDialog();
  const stop = watchLateAutofocus(dialog, close);
  const field = lateContent(dialog); await tick();
  expect(document.activeElement).toBe(field);
  stop();
});

it("does not take focus from a control the user already moved to", async () => {
  const { dialog, close } = openDialog();
  const other = document.createElement("button"); dialog.append(other);
  const stop = watchLateAutofocus(dialog, close);
  other.focus(); await tick();
  lateContent(dialog); await tick();
  expect(document.activeElement).toBe(other);
  stop();
});

it("stops watching once disposed", async () => {
  const { dialog, close } = openDialog();
  watchLateAutofocus(dialog, close)();
  lateContent(dialog); await tick();
  expect(document.activeElement).toBe(close);
});
