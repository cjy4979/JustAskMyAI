export function extractAssistantText(events, startIndex = 0) {
  const messages = events.slice(startIndex)
    .filter(event => event?.type === 'assistant/message')
    .map(event => event.data)
  const message = messages.at(-1)
  if (!message || !Array.isArray(message.content)) {
    throw new Error('DeepSeek Harness completed without an assistant message')
  }
  const text = message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
  if (!text) throw new Error('DeepSeek Harness completed without text output')
  return text
}
