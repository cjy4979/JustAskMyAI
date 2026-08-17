export function extractAssistantText(events, startIndex = 0) {
  const messages = events.slice(startIndex)
    .filter(event => event?.type === 'assistant/message')
    .map(event => event.data)
  const message = messages.at(-1)
  // DSH >= 0.1.0-rc.5 carries the assistant message at data.message.content;
  // earlier snapshots placed it at data.content. Accept both so the provider
  // survives the pinned-preview boundary.
  const content = message?.message?.content ?? message?.content
  if (!message || !Array.isArray(content)) {
    throw new Error('DeepSeek Harness completed without an assistant message')
  }
  const text = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
  if (!text) throw new Error('DeepSeek Harness completed without text output')
  return text
}
