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
  assert.match(page, /统一任务中心/);
  assert.match(page, /收到的 Provider 工作和发出的 A2A 任务不再分散/);
  assert.match(page, /运行时声明与 Owner 证明分开记录/);
  assert.match(page, /能力变化后已停止领取新工作/);
  assert.match(page, /function providerTrustView\(\)/);
  assert.match(page, /授权待续签/);
  assert.match(page, /function renewRemoteSession\(id,peerId\)/);
  assert.match(page, /\/api\/remote-external-sessions\/.*\/renew/);
  assert.match(page, /Thread、消息和 Agent 原生会话都会保留/);
  assert.match(page, /原会话与历史已保留，可直接续签/);
  assert.match(page, /同步开发版/);
  assert.match(page, /function runtimeAction\(action\)/);
  assert.match(page, /\/api\/runtime-control/);
  assert.match(page, /我发起的协作/);
  assert.match(page, /function remoteSessionDetail\(id,peerId\)/);
  assert.match(page, /开启新的 Agent 会话/);
  assert.match(page, /switch:/);
  assert.match(page, /\/api\/remote-external-sessions/);
  assert.match(page, /协作组/);
  assert.match(page, /审计 Reviewer/);
  assert.match(page, /const MOBILE_NAV=/);
  assert.match(page, /\.side \.nav span:not\(\.ico\)/);
  assert.match(page, /function unifiedTasks\(\)/);
  assert.match(page, /function createGroup\(\)/);
  assert.match(page, /function createGroupThread\(groupId\)/);
  assert.match(page, /\/api\/group-invitations/);
  assert.match(page, /function inviteGroupMember\(groupId\)/);
  assert.match(page, /function editGroupMember\(groupId,memberId\)/);
  assert.match(page, /function acceptGroupInvite\(id\)/);
  assert.match(page, /function groupDetail\(id\)/);
  assert.match(page, /知识库/);
  assert.match(page, /function groupThreadWorkspace\(groupId,threadId\)/);
  assert.match(page, /\/api\/groups\/.*\/threads\/.*\/workspace/);
  assert.match(page, /Reviewer 只读审计视图/);
  assert.match(page, /dialog\.wide/);
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
