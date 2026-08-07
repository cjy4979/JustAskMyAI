import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderAdapter } from "../src/adapters/provider.js";
import { ProviderStore } from "../src/provider/store.js";
import { GatewayStore } from "../src/storage/sqlite.js";

const capabilities = {
  isolatedSessions: true,
  sessionResume: true,
  structuredContextualOutput: true,
  separateMemoryNamespace: true,
  supportsCancellation: true,
  maxConcurrency: 2,
  operations: ["ask", "task", "review"],
  artifactTypes: ["text", "report"],
  isolationAssurance: "self-reported" as const,
};

test("Provider registration requires Owner activation before claiming work", () => {
  const gateway = new GatewayStore(":memory:");
  const providers = new ProviderStore(gateway);
  const registered = providers.register({
    instanceKey: "test-agent",
    name: "Test Agent",
    capabilities,
  });
  assert.equal(registered.created, true);
  assert.ok(registered.accessToken);
  assert.equal(registered.agent.status, "pending");
  providers.enqueue({
    prompt: "hello",
    contextId: "context-1",
    taskId: "task-1",
    approvedScopes: [],
    deniedScopes: [],
    allowedResources: [],
    deniedResources: [],
  });
  assert.equal(
    providers.claim(registered.agent.id, registered.accessToken!),
    undefined,
  );
  providers.approve(registered.agent.id);
  const claimed = providers.claim(registered.agent.id, registered.accessToken!);
  assert.equal(claimed?.request.prompt, "hello");
  assert.equal(claimed?.attempt, 1);
  gateway.close();
});

test("ProviderAdapter persists an Agent session and resumes it after adapter restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamai-provider-test-"));
  const filename = path.join(root, "gateway.db");
  const gateway = new GatewayStore(filename);
  try {
    const providers = new ProviderStore(gateway);
    const registered = providers.register({
      instanceKey: "persistent-agent",
      name: "Persistent Agent",
      capabilities,
    });
    providers.approve(registered.agent.id);
    const token = registered.accessToken!;
    const adapter = new ProviderAdapter(gateway, { timeoutMs: 3000 });
    const firstWorker = serviceOne(providers, registered.agent.id, token, (job) => {
      assert.equal(job.request.externalSessionId, "external-1");
      assert.equal(job.request.resumeSessionId, undefined);
      return { text: "first answer", sessionId: "native-session-1" };
    });
    const first = await adapter.run(request("turn-1"));
    await firstWorker;
    assert.equal(first.sessionId, "native-session-1");
    assert.equal(
      gateway.getAgentSession("external-1")?.localSessionId,
      "native-session-1",
    );

    const restartedAdapter = new ProviderAdapter(gateway, { timeoutMs: 3000 });
    const other = providers.register({
      instanceKey: "other-agent",
      name: "Other Agent",
      capabilities,
    });
    providers.approve(other.agent.id);
    const secondPromise = restartedAdapter.run(request("turn-2"));
    assert.equal(
      providers.claim(other.agent.id, other.accessToken!),
      undefined,
      "another provider must not receive a native session owned by the first provider",
    );
    const secondWorker = serviceOne(providers, registered.agent.id, token, (job) => {
      assert.equal(job.request.resumeSessionId, "native-session-1");
      return { text: "second answer", sessionId: "native-session-1" };
    });
    const second = await secondPromise;
    await secondWorker;
    assert.equal(second.text, "second answer");
  } finally {
    gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function request(taskId: string) {
  return {
    prompt: `prompt ${taskId}`,
    contextId: "a2a-context-1",
    externalSessionId: "external-1",
    taskId,
    signal: new AbortController().signal,
    approvedScopes: [],
    deniedScopes: [],
    allowedResources: [],
    deniedResources: [],
  };
}

async function serviceOne(
  providers: ProviderStore,
  agentId: string,
  accessToken: string,
  answer: (job: NonNullable<ReturnType<ProviderStore["claim"]>>) => {
    text: string;
    sessionId: string;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = providers.claim(agentId, accessToken);
    if (job) {
      providers.complete(agentId, accessToken, job.id, job.leaseToken, answer(job));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("provider job was not claimed");
}
