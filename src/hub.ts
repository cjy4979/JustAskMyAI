import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

interface Hello {
  type: "hello";
  nodeId: string;
  groups?: string[];
}

interface Route {
  type: "route";
  to?: string;
  group?: string;
  envelope: unknown;
}

const port = Number(process.env.JAMAI_HUB_PORT ?? 43121);
const nodes = new Map<string, WebSocket>();
const groups = new Map<string, Set<string>>();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, nodes: nodes.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on("connection", (socket) => {
  let nodeId: string | undefined;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Hello | Route;
    if (message.type === "hello") {
      nodeId = message.nodeId;
      nodes.set(nodeId, socket);
      for (const group of message.groups ?? []) {
        const members = groups.get(group) ?? new Set<string>();
        members.add(nodeId);
        groups.set(group, members);
      }
      return;
    }
    if (message.type !== "route" || !nodeId) return;
    const recipients = message.to
      ? [message.to]
      : [...(groups.get(message.group ?? "") ?? [])].filter((id) => id !== nodeId);
    const frame = JSON.stringify({ type: "deliver", from: nodeId, envelope: message.envelope });
    for (const recipient of recipients) nodes.get(recipient)?.send(frame);
  });
  socket.on("close", () => {
    if (!nodeId) return;
    nodes.delete(nodeId);
    for (const members of groups.values()) members.delete(nodeId);
  });
});

server.listen(port, () => console.log(`JustAskMyAI relay listening on :${port}`));
