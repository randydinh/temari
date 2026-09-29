import { PrivacyError, assertJsonValue, type JsonValue } from '@temari/privacy';
import type { ModelDriver, ModelDriverRequest } from './model-transport.js';

const endpoint = 'https://api.openai.com/v1/responses';
const maxResponseBytes = 4 * 1024 * 1024;
const maxTurns = 8;
const maxCalls = 32;

export interface OpenAIResponsesDriverOptions {
  /** Selected by the host, never by model output or a workflow request. */
  readonly model: string;
  /** Obtained from the host's approved credential store for each completion. */
  readonly credential: () => Promise<string>;
  /** Test seam; production uses the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new PrivacyError('Model response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes)
        throw new PrivacyError('Model response exceeds the size limit.');
      chunks.push(value);
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
    throw new PrivacyError('Invalid model response.');
  }
}

/** Stateless, host-mediated Responses adapter. Other providers implement ModelDriver. */
export function createOpenAIResponsesDriver(
  options: OpenAIResponsesDriverOptions,
): ModelDriver {
  if (
    !options ||
    typeof options.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.model) ||
    typeof options.credential !== 'function'
  )
    throw new PrivacyError('Invalid model driver configuration.');
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
        throw new PrivacyError('Invalid model request.');
      const names = new Set<string>();
      const tools = request.tools.map((tool) => {
        if (
          !tool ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
          names.has(tool.name) ||
          typeof tool.description !== 'string' ||
          !record(tool.inputSchema)
        )
          throw new PrivacyError('Invalid model tool.');
        assertJsonValue(tool.inputSchema);
        names.add(tool.name);
        return {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        };
      });
      if (request.outputSchema !== undefined) {
        assertJsonValue(request.outputSchema);
        if (!record(request.outputSchema))
          throw new PrivacyError('Invalid model output schema.');
      }
      let credential: string;
      try {
        credential = await options.credential();
      } catch {
        throw new PrivacyError('Model credential is unavailable.');
      }
      if (
        typeof credential !== 'string' ||
        !credential ||
        /[\r\n]/.test(credential)
      )
        throw new PrivacyError('Model credential is unavailable.');
      const input: unknown[] = [{ role: 'user', content: request.prompt }];
      let calls = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        signal?.throwIfAborted();
        let response: Response;
        const body = JSON.stringify({
          model: options.model,
          store: false,
          input,
          tools,
          parallel_tool_calls: false,
          ...(request.outputSchema === undefined
            ? {}
            : {
                text: {
                  format: {
                    type: 'json_schema',
                    name: 'temari_response',
                    strict: true,
                    schema: request.outputSchema,
                  },
                },
              }),
        });
        if (Buffer.byteLength(body) > maxResponseBytes)
          throw new PrivacyError('Model request exceeds the size limit.');
        try {
          response = await send(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${credential}`,
              'content-type': 'application/json',
            },
            body,
            signal,
          });
        } catch {
          throw new PrivacyError('Model transport failed.');
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new PrivacyError('Model provider refused the request.');
        }
        const result = await boundedJson(response);
        if (
          !record(result) ||
          result.status !== 'completed' ||
          !Array.isArray(result.output) ||
          result.output.length > 64
        )
          throw new PrivacyError('Incomplete model response.');
        const outputs: { name: string; callId: string; args: JsonValue }[] = [];
        const text: string[] = [];
        for (const item of result.output) {
          if (!record(item))
            throw new PrivacyError('Invalid model output item.');
          if (item.type === 'function_call') {
            if (
              typeof item.name !== 'string' ||
              !names.has(item.name) ||
              typeof item.call_id !== 'string' ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(item.call_id) ||
              typeof item.arguments !== 'string' ||
              Buffer.byteLength(item.arguments) > 1024 * 1024
            )
              throw new PrivacyError('Invalid model tool call.');
            let args: JsonValue;
            try {
              args = JSON.parse(item.arguments) as JsonValue;
              assertJsonValue(args);
              if (!record(args))
                throw new PrivacyError('Invalid model tool arguments.');
            } catch {
              throw new PrivacyError('Invalid model tool arguments.');
            }
            outputs.push({ name: item.name, callId: item.call_id, args });
          } else if (item.type === 'message') {
            if (!Array.isArray(item.content))
              throw new PrivacyError('Invalid model message.');
            for (const part of item.content) {
              if (
                !record(part) ||
                part.type !== 'output_text' ||
                typeof part.text !== 'string'
              )
                throw new PrivacyError('Unsupported model message.');
              text.push(part.text);
            }
          } else if (item.type !== 'reasoning') {
            throw new PrivacyError('Unsupported model output item.');
          }
        }
        if (outputs.length === 0) {
          if (text.length === 0)
            throw new PrivacyError('Model returned no text.');
          const final = text.join('');
          if (Buffer.byteLength(final) > 1024 * 1024)
            throw new PrivacyError('Model text exceeds the size limit.');
          return final;
        }
        if (text.length !== 0 || calls + outputs.length > maxCalls)
          throw new PrivacyError('Unsupported model tool sequence.');
        // Responses input items preserve reasoning state without server storage.
        input.push(...result.output);
        for (const output of outputs) {
          signal?.throwIfAborted();
          const value = await callTool(output.name, output.args);
          if (
            typeof value !== 'string' ||
            Buffer.byteLength(value) > 1024 * 1024
          )
            throw new PrivacyError('Invalid host tool result.');
          input.push({
            type: 'function_call_output',
            call_id: output.callId,
            output: value,
          });
          calls++;
        }
      }
      throw new PrivacyError('Model tool sequence exceeded the turn limit.');
    },
  };
}
