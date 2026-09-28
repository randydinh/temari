import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, sep } from 'node:path';
import {
  mask,
  assertJsonValue,
  restoreForDisplay,
  disposePrivacySession,
  PrivacyError,
  type JsonValue,
  type PrivacyPolicy,
  type PrivacySession,
} from '@temari/privacy';

export type HostContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly value: JsonValue }
  | { readonly kind: 'file'; readonly id: string }
  | { readonly kind: 'screenshot'; readonly id: string };

export interface ModelRequest {
  readonly prompt: string;
  readonly context?: readonly HostContent[];
  /**
   * Enables structural JSON response masking. Without a schema, replies are
   * plain text (even JSON-looking text); semantic field-name rules do not apply.
   */
  readonly outputSchema?: JsonValue;
}

export interface ModelReply {
  /** Safe for history and receipts. Restoration is explicit and local. */
  readonly text: string;
  readonly coverage: 'host-mediated-text';
  displayText(): string;
  dispose(): void;
}

export interface ModelTransport {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface ModelDriverRequest {
  readonly prompt: string;
  readonly outputSchema?: JsonValue;
  readonly tools: readonly ModelToolDefinition[];
}

/** A trusted provider implementation that has no implicit data sources. */
export interface ModelDriver {
  complete(
    request: ModelDriverRequest,
    callTool: (name: string, args: JsonValue) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface HostTool {
  readonly description: string;
  readonly inputSchema: JsonValue;
  /** Receives original schema property names and masked values. */
  execute(
    args: JsonValue,
    signal?: AbortSignal,
  ): Promise<readonly HostContent[]>;
}

export interface PrivacyHost {
  readonly policy?: PrivacyPolicy;
  /** Explicit, absolute file allowlist. Model-supplied paths are never opened. */
  readonly files?: Readonly<Record<string, string>>;
  readonly tools?: readonly HostTool[];
  /** Trusted local extraction only. Pixels never enter a model request. */
  readonly screenshotText?: Readonly<
    Record<string, (signal?: AbortSignal) => Promise<string>>
  >;
}

const maxBytes = 1024 * 1024;
const maxItems = 64;

function jsonRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: JsonValue): JsonValue {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new PrivacyError('Model context exceeds the privacy boundary limit.');
  return value;
}

/** Keep decoded schema strings visible without treating schema keys as data fields. */
export function encodeSchemaForPrivacy(schema: JsonValue): JsonValue {
  assertJsonValue(schema);
  bounded(schema);
  const encode = (value: JsonValue): JsonValue => {
    if (value === null) return ['null'];
    if (Array.isArray(value)) return ['array', value.map(encode)];
    if (typeof value === 'object')
      return [
        'object',
        Object.entries(value).map(([key, child]) => [key, encode(child)]),
      ];
    return [typeof value, value];
  };
  const encoded = encode(schema);
  assertJsonValue(encoded);
  return bounded(encoded);
}

/** Reject malformed or policy-altered structure instead of recovering raw schema text. */
export function decodeSchemaForPrivacy(encoded: JsonValue): JsonValue {
  assertJsonValue(encoded);
  bounded(encoded);
  const invalid = (): never => {
    throw new PrivacyError('Invalid protected schema structure.');
  };
  const decode = (node: JsonValue): JsonValue => {
    if (!Array.isArray(node)) return invalid();
    if (node[0] === 'null' && node.length === 1) return null;
    if (node.length !== 2) return invalid();
    const [tag, value] = node;
    if (
      (tag === 'string' && typeof value === 'string') ||
      (tag === 'number' && typeof value === 'number') ||
      (tag === 'boolean' && typeof value === 'boolean')
    )
      return value;
    if (tag === 'array' && Array.isArray(value)) return value.map(decode);
    if (tag === 'object' && Array.isArray(value)) {
      const keys = new Set<string>();
      return Object.fromEntries(
        value.map((entry) => {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            keys.has(entry[0])
          )
            return invalid();
          keys.add(entry[0]);
          return [entry[0], decode(entry[1])];
        }),
      );
    }
    return invalid();
  };
  return bounded(decode(encoded));
}

function schemaPropertyNames(
  originalEncoding: JsonValue,
  protectedEncoding: JsonValue,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const identities = new Map<string, string>();
  const visit = (
    before: JsonValue,
    after: JsonValue,
    properties: boolean,
  ): void => {
    if (
      !Array.isArray(before) ||
      !Array.isArray(after) ||
      before.length !== 2 ||
      after.length !== 2 ||
      before[0] !== after[0]
    )
      throw new PrivacyError('Privacy policy altered schema structure.');
    const [tag, originalValue] = before;
    const safeValue = after[1];
    if (tag !== 'object' && tag !== 'array') return;
    if (
      !Array.isArray(originalValue) ||
      !Array.isArray(safeValue) ||
      originalValue.length !== safeValue.length
    )
      throw new PrivacyError('Privacy policy altered schema structure.');
    originalValue.forEach((entry, index) => {
      const safeEntry = safeValue[index];
      if (tag === 'array') {
        visit(entry, safeEntry, false);
        return;
      }
      if (
        !Array.isArray(entry) ||
        !Array.isArray(safeEntry) ||
        entry.length !== 2 ||
        safeEntry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof safeEntry[0] !== 'string'
      )
        throw new PrivacyError('Privacy policy altered schema structure.');
      const [key, child] = entry;
      const [safeKey, safeChild] = safeEntry;
      if (properties) {
        const prior = identities.get(safeKey);
        if (prior !== undefined && prior !== key)
          throw new PrivacyError('Ambiguous protected schema key.');
        identities.set(safeKey, key);
      }
      if (key !== safeKey) {
        if (!properties)
          throw new PrivacyError('Privacy policy altered schema keys.');
        names.set(safeKey, key);
      }
      visit(child, safeChild, !properties && key === 'properties');
    });
  };
  // Encoded object entries are arrays. Their indices remain stable even when
  // decoding an integer-index property name changes JavaScript key order.
  visit(originalEncoding, protectedEncoding, false);
  return names;
}

function restoreToolPropertyNames(
  args: JsonValue,
  names: ReadonlyMap<string, string>,
): JsonValue {
  if (Array.isArray(args))
    return args.map((item) => restoreToolPropertyNames(item, names));
  if (!jsonRecord(args)) return args;
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.includes('[[TM_PRIVACY_') && !names.has(key))
      throw new PrivacyError(
        'Tool arguments contain an unknown protected property name.',
      );
    const original = names.get(key) ?? key;
    if (Object.hasOwn(result, original))
      throw new PrivacyError(
        'Tool arguments contain duplicate property names.',
      );
    Object.defineProperty(result, original, {
      value: restoreToolPropertyNames(value, names),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

async function assertTrustedFilePath(path: string): Promise<void> {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new PrivacyError('Private file must be an allowlisted regular path.');
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new PrivacyError('Private file ownership cannot be verified.');
  const root = parse(path).root;
  let current = root;
  let parent = await lstat(root);
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (entry.uid !== 0 && entry.uid !== uid))
      throw new PrivacyError('Private file path has an untrusted ancestor.');
    if (parent.mode & 0o022) {
      if (!(parent.mode & 0o1000) || parent.uid !== 0 || entry.uid !== uid)
        throw new PrivacyError('Private file path has a writable ancestor.');
    }
    parent = entry;
  }
}

async function readAllowedFile(path: string): Promise<string> {
  await assertTrustedFilePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new PrivacyError('Private file is unsupported or too large.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes)
      throw new PrivacyError('Private file exceeds the limit.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, total),
    );
    if (text.includes('\0'))
      throw new PrivacyError('Binary files are not supported.');
    return text;
  } finally {
    await handle.close();
  }
}

export function createProtectedModelTransport(
  driver: ModelDriver,
  host: PrivacyHost = {},
): ModelTransport {
  const policy = structuredClone(host.policy ?? {});
  const files = new Map(Object.entries(host.files ?? {}));
  const screenshots = new Map(Object.entries(host.screenshotText ?? {}));
  const tools = (host.tools ?? []).map((tool, index) => {
    assertJsonValue(tool.inputSchema);
    return {
      name: `temari_host_${index + 1}`,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      execute: tool.execute,
    };
  });
  if (tools.length > maxItems) throw new PrivacyError('Too many host tools.');

  return {
    async complete(request, signal) {
      const sessions: PrivacySession[] = [];
      let disposed = false;
      let acceptingTools = true;
      let calls = 0;
      const dispose = () => {
        disposed = true;
        sessions.forEach(disposePrivacySession);
        sessions.length = 0;
      };
      const protect = (value: JsonValue): JsonValue => {
        if (disposed) throw new PrivacyError('Privacy request is closed.');
        signal?.throwIfAborted();
        assertJsonValue(value);
        bounded(value);
        const prepared = mask(value, policy, sessions);
        sessions.push(prepared.session);
        return bounded(prepared.payload);
      };
      const materialize = async (
        items: readonly HostContent[],
      ): Promise<JsonValue[]> => {
        if (!Array.isArray(items) || items.length > maxItems)
          throw new PrivacyError('Unsupported host content.');
        const result: JsonValue[] = [];
        for (const item of items) {
          signal?.throwIfAborted();
          if (!item || typeof item !== 'object')
            throw new PrivacyError('Unsupported host content.');
          switch (item.kind) {
            case 'text':
              if (typeof item.text !== 'string')
                throw new PrivacyError('Invalid host text.');
              result.push({ kind: 'text', text: item.text });
              break;
            case 'json':
              result.push({ kind: 'json', value: item.value });
              break;
            case 'file': {
              const path = files.get(item.id);
              if (!path)
                throw new PrivacyError('File reference is not authorized.');
              result.push({ kind: 'file', text: await readAllowedFile(path) });
              break;
            }
            case 'screenshot': {
              const extract = screenshots.get(item.id);
              if (!extract)
                throw new PrivacyError(
                  'Screenshot requires an authorized local text extractor.',
                );
              const text = await extract(signal);
              if (typeof text !== 'string')
                throw new PrivacyError(
                  'Screenshot extraction must return text.',
                );
              result.push({ kind: 'screenshot-text', text });
              break;
            }
            default:
              throw new PrivacyError('Unsupported host content.');
          }
        }
        return result;
      };
      try {
        if (typeof request.prompt !== 'string')
          throw new PrivacyError('Invalid model prompt.');
        const structuredReply = request.outputSchema !== undefined;
        const outputSchema = structuredReply
          ? encodeSchemaForPrivacy(request.outputSchema!)
          : null;
        // One batch allows identities discovered in a file to mask the prompt too.
        const prepared = protect({
          prompt: request.prompt,
          context: await materialize(request.context ?? []),
          outputSchema,
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            schema: encodeSchemaForPrivacy(inputSchema),
          })),
        });
        if (!jsonRecord(prepared))
          throw new PrivacyError('Invalid protected request.');
        const safeTools = prepared.tools;
        if (!Array.isArray(safeTools) || safeTools.length !== tools.length)
          throw new PrivacyError('Invalid protected tool definitions.');
        const propertyNames = new Map<string, ReadonlyMap<string, string>>();
        const definitions: ModelToolDefinition[] = safeTools.map(
          (tool, index) => {
            if (
              !tool ||
              Array.isArray(tool) ||
              typeof tool !== 'object' ||
              tool.name !== tools[index]?.name ||
              typeof tool.description !== 'string' ||
              !Object.hasOwn(tool, 'schema')
            )
              throw new PrivacyError('Privacy policy altered tool routing.');
            const inputSchema = decodeSchemaForPrivacy(tool.schema);
            propertyNames.set(
              tool.name,
              schemaPropertyNames(
                encodeSchemaForPrivacy(tools[index].inputSchema),
                tool.schema,
              ),
            );
            return {
              name: tools[index].name,
              description: tool.description,
              inputSchema,
            };
          },
        );
        const safeRequest: ModelDriverRequest = {
          prompt: JSON.stringify({
            prompt: prepared.prompt,
            context: prepared.context,
          }),
          ...(structuredReply
            ? {
                outputSchema: decodeSchemaForPrivacy(prepared.outputSchema),
              }
            : {}),
          tools: definitions,
        };
        const text = await driver.complete(
          safeRequest,
          async (name, args) => {
            if (!acceptingTools || ++calls > maxItems)
              throw new PrivacyError('Host tool call is not permitted.');
            const tool = tools.find((candidate) => candidate.name === name);
            if (!tool) throw new PrivacyError('Unknown host tool.');
            try {
              const safeArgs = protect(args);
              const result = await tool.execute(
                restoreToolPropertyNames(safeArgs, propertyNames.get(name)!),
                signal,
              );
              const content = await materialize(result);
              if (!acceptingTools)
                throw new PrivacyError(
                  'Host tool result arrived after completion.',
                );
              return JSON.stringify(protect(content));
            } catch {
              throw new PrivacyError(
                'Host tool failed at the privacy boundary.',
              );
            }
          },
          signal,
        );
        acceptingTools = false;
        if (typeof text !== 'string')
          throw new PrivacyError('Invalid model reply.');
        const safeValue = protect(
          structuredReply ? (JSON.parse(text) as JsonValue) : text,
        );
        const safeText = structuredReply
          ? JSON.stringify(safeValue)
          : safeValue;
        if (typeof safeText !== 'string')
          throw new PrivacyError('Invalid model reply.');
        return Object.freeze({
          text: safeText,
          coverage: 'host-mediated-text' as const,
          displayText() {
            if (disposed) throw new PrivacyError('Privacy request is closed.');
            const restoredValue = restoreForDisplay(safeValue, sessions);
            const restored = structuredReply
              ? JSON.stringify(restoredValue)
              : restoredValue;
            if (typeof restored !== 'string')
              throw new PrivacyError('Invalid display reply.');
            return restored;
          },
          dispose,
        });
      } catch {
        acceptingTools = false;
        dispose();
        throw new PrivacyError(
          'Protected model request failed. No unfiltered fallback was attempted.',
        );
      }
    },
  };
}
