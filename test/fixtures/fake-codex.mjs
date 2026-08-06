const args = process.argv.slice(2);
const resumeIndex = args.indexOf("resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "codex-thread-1";

console.log(JSON.stringify({ type: "thread.started", thread_id: sessionId }));
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({ args }),
  },
}));
console.log(JSON.stringify({ type: "turn.completed" }));

