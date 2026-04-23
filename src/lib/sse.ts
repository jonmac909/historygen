export type SseEvent = {
  event: string;
  data: string;
};

export async function readSseStream(
  response: Response,
  onEvent: (event: SseEvent) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (!dataLines.length && eventName === 'message') return;
    const data = dataLines.join('\n');
    onEvent({ event: eventName || 'message', data });
    eventName = 'message';
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (line === '') {
        flushEvent();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (buffer.length > 0) {
    let line = buffer;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  flushEvent();
}
