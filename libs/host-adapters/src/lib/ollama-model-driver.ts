import { PrivacyError, assertJsonValue, type JsonValue } from '@temari/privacy';
import type { ModelDriver, ModelDriverRequest } from './model-transport.js';

const maxBytes = 4 * 1024 * 1024;
const maxTurns = 8;
const maxCalls = 32;

export interface OllamaModelDriverOptions {
  /** A host-selected model already installed in the local Ollama service. */
  readonly model: string;
  /** Defaults to the native loopback service; non-loopback endpoints are refused. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new PrivacyError('Local model response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes)
        throw new PrivacyError('Local model response exceeds the size limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PrivacyError('Invalid local model response.');
  }
}

/** Native Ollama adapter behind the provider-neutral protected host boundary. */
export function createOllamaModelDriver(
  options: OllamaModelDriverOptions,
): ModelDriver {
  if (
    !options ||
    typeof options.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(options.model)
  )
    throw new PrivacyError('Invalid local model configuration.');
  const origin = new URL(options.baseUrl ?? 'http://127.0.0.1:11434');
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new PrivacyError('Local model endpoint must be a loopback origin.');
  const send = options.fetchImpl ?? fetch;
  return {
    async complete(request: ModelDriverRequest, callTool, signal) {
      signal?.throwIfAborted();
      if (
        !request ||
        typeof request.prompt !== 'string' ||
        Buffer.byteLength(request.prompt) > 1024 * 1024 ||
        !Array.isArray(request.tools) ||
        request.tools.length > 64
      )
        throw new PrivacyError('Invalid local model request.');
      const names = new Set<string>();
      const tools = request.tools.map((tool) => {
        if (
          !tool ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
          names.has(tool.name) ||
          typeof tool.description !== 'string' ||
          !record(tool.inputSchema)
        )
          throw new PrivacyError('Invalid local model tool.');
        assertJsonValue(tool.inputSchema);
        names.add(tool.name);
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };
      });
      if (request.outputSchema !== undefined) {
        assertJsonValue(request.outputSchema);
        if (!record(request.outputSchema))
          throw new PrivacyError('Invalid local model output schema.');
      }
      // A final-answer grammar can suppress Ollama's native tool-call syntax.
      // Finish retrieval first, then render the packet with tools disabled and
      // the native schema enabled. The caller still validates the final packet.
      const toolSchema = tools.length > 0 && request.outputSchema !== undefined;
      const messages: unknown[] = [{ role: 'user', content: request.prompt + (toolSchema
        ? '\nAfter all tool calls, return only JSON matching this final schema: ' + JSON.stringify(request.outputSchema)
        : '') }];
      let calls = 0;
      let rendering = false;
      for (let turn = 0; turn < maxTurns; turn++) {
        signal?.throwIfAborted();
        const body = JSON.stringify({
          model: options.model,
          messages,
          stream: false,
          tools: rendering ? [] : tools,
          ...(request.outputSchema === undefined || (toolSchema && !rendering)
            ? {}
            : { format: request.outputSchema }),
        });
        if (Buffer.byteLength(body) > maxBytes)
          throw new PrivacyError('Local model request exceeds the size limit.');
        let response: Response;
        try {
          response = await send(new URL('/api/chat', origin), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          });
        } catch {
          throw new PrivacyError('Local model transport failed.');
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new PrivacyError('Local model refused the request.');
        }
        const result = await boundedJson(response);
        if (
          !record(result) ||
          result.done !== true ||
          !record(result.message) ||
          result.message.role !== 'assistant'
        )
          throw new PrivacyError('Incomplete local model response.');
        const message = result.message;
        if (typeof message.content !== 'string')
          throw new PrivacyError('Invalid local model message.');
        const toolCalls = message.tool_calls ?? [];
        if (!Array.isArray(toolCalls) || toolCalls.length > 32)
          throw new PrivacyError('Invalid local model tool sequence.');
        if (rendering && toolCalls.length > 0)
          throw new PrivacyError('Tools are unavailable during final packet rendering.');
        if (toolCalls.length === 0) {
          if (
            !message.content ||
            Buffer.byteLength(message.content) > 1024 * 1024
          )
            throw new PrivacyError('Invalid local model text.');
          if (toolSchema && !rendering) {
            messages.push({ role: 'assistant', content: message.content }, {
              role: 'user', content: 'The tool phase is complete. Use the retrieved source evidence and citations when relevant. Return only the required final JSON packet, not the schema. Do not request further tools.',
            });
            rendering = true;
            continue;
          }
          return message.content;
        }
        if (message.content || calls + toolCalls.length > maxCalls)
          throw new PrivacyError('Unsupported local model tool sequence.');
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: toolCalls,
        });
        for (const item of toolCalls) {
          if (
            !record(item) ||
            !record(item.function) ||
            typeof item.function.name !== 'string' ||
            !names.has(item.function.name)
          )
            throw new PrivacyError('Unknown local model tool.');
          let args: JsonValue;
          try {
            args =
              typeof item.function.arguments === 'string'
                ? (JSON.parse(item.function.arguments) as JsonValue)
                : (item.function.arguments as JsonValue);
            assertJsonValue(args);
            if (!record(args))
              throw new Error('Tool arguments must be an object.');
          } catch {
            throw new PrivacyError('Invalid local model tool arguments.');
          }
          signal?.throwIfAborted();
          const value = await callTool(item.function.name, args);
          if (
            typeof value !== 'string' ||
            Buffer.byteLength(value) > 1024 * 1024
          )
            throw new PrivacyError('Invalid host tool result.');
          messages.push({
            role: 'tool',
            content: value,
            tool_name: item.function.name,
          });
          calls++;
        }
      }
      throw new PrivacyError('Local model turn limit exceeded.');
    },
  };
}
