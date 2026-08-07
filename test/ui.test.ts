import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { guestPage } from "../src/ui/guest-page.js";
import { ownerPage } from "../src/ui/owner-page.js";

function inlineScript(page: string): string {
  const start = page.indexOf("<script>");
  const end = page.lastIndexOf("</script>");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return page.slice(start + "<script>".length, end);
}

test("Owner Hub renders product workflows with valid client JavaScript", () => {
  const page = ownerPage();
  assert.match(page, /今天/);
  assert.match(page, /待处理/);
  assert.match(page, /跨 AI 任务板/);
  assert.match(page, /知识库/);
  assert.doesNotThrow(() => new vm.Script(inlineScript(page)));
});

test("guest chat survives missed SSE status events through polling", () => {
  const page = guestPage();
  assert.match(page, /等待 Owner 批准/);
  assert.match(page, /setInterval\(pollStatus,1500\)/);
  assert.match(page, /fetch\('\/guest\/sessions\/'\+session\.id\)/);
  assert.match(page, /value\.events\|\|\[\]/);
  assert.doesNotThrow(() => new vm.Script(inlineScript(page)));
});
