import { HttpError, isRecord } from './http.js';

/**
 * The inventory assistant behind api/ask. The page builds the instructions and a compact copy
 * of the site's inventory (it already holds both); the server adds the key, picks the quick
 * model and streams the answer back as plain text, so the first words show within a second.
 * The inventory is sent as a cached system block, so follow-up questions are faster still.
 */

export const MAX_ASK_BODY = 640 * 1024;
export const MAX_SYSTEM_CHARS = 400_000;
export const MAX_TURNS = 20;
export const MAX_TURN_CHARS = 4_000;
export const ASK_MAX_TOKENS = 1_024;

export interface AskTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AskRequest {
  readonly system: string;
  readonly messages: readonly AskTurn[];
}

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_argument', message);
}

/** Checks the request; keeps the latest turns, starting with a question and ending with one. */
export function parseAsk(body: unknown): AskRequest {
  if (!isRecord(body)) throw invalid('Send a JSON object with system and messages.');
  const { system, messages } = body;
  if (typeof system !== 'string' || !system.trim()) throw invalid('system must be a non-empty string.');
  if (system.length > MAX_SYSTEM_CHARS) throw new HttpError(413, 'too_large', 'The inventory is too large to ask about in one go.');
  if (!Array.isArray(messages) || messages.length === 0) throw invalid('messages must be a non-empty array.');
  const turns: AskTurn[] = messages.map((m: unknown, i): AskTurn => {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw invalid(`Message ${i + 1} needs a role (user or assistant) and text content.`);
    const content = m.content.trim().slice(0, MAX_TURN_CHARS);
    if (!content) throw invalid(`Message ${i + 1} is empty.`);
    return { role: m.role, content };
  });
  let recent = turns.slice(-MAX_TURNS);
  while (recent.length && recent[0]?.role !== 'user') recent = recent.slice(1);
  if (!recent.length || recent[recent.length - 1]?.role !== 'user') throw invalid('The last message must be a question.');
  // The Messages API wants turns to alternate; merge any two in a row from the same side.
  const merged: AskTurn[] = [];
  for (const t of recent) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) merged[merged.length - 1] = { role: t.role, content: `${last.content}\n\n${t.content}` };
    else merged.push(t);
  }
  return { system, messages: merged };
}

export function askBody(req: AskRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: ASK_MAX_TOKENS,
    stream: true,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

/**
 * Turns the Messages API's server-sent events into the answer's text, chunk by chunk. An error
 * event mid-answer ends the text with a short note rather than failing what was already shown.
 */
export function sseToText(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let buffer = '';
  let ended = false;
  let sent = 0;
  const handle = (event: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const data = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.type === 'content_block_delta' && isRecord(msg.delta) && msg.delta.type === 'text_delta' && typeof msg.delta.text === 'string') {
      controller.enqueue(encoder.encode(msg.delta.text));
      sent += 1;
    } else if (msg.type === 'error') {
      controller.enqueue(encoder.encode('\n\n(The answer stopped early. Ask again in a moment.)'));
      sent += 1;
      ended = true;
    } else if (msg.type === 'message_stop') {
      ended = true;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const before = sent;
      while (sent === before) {
        if (ended) {
          controller.close();
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (done) {
          if (buffer.trim()) handle(buffer, controller);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const event = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          handle(event, controller);
          cut = buffer.indexOf('\n\n');
        }
      }
    },
    cancel() {
      return reader.cancel().catch(() => undefined);
    },
  });
}
