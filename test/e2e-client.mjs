import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";

const url = process.argv[2] ?? "http://127.0.0.1:43120";
const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
const client = await factory.createFromUrl(url);
const result = await client.sendMessage({
  tenant: "",
  message: {
    role: Role.ROLE_USER,
    messageId: randomUUID(),
    contextId: "",
    taskId: "",
    parts: [{
      content: { $case: "text", value: "hello from e2e" },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: undefined,
  metadata: undefined,
});
console.log(JSON.stringify(result));
