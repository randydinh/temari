import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const CONVERSATION_LIMITS = Object.freeze({
  topics: 128, turnsPerTopic: 512, linkedTasksPerTopic: 16,
  attentionPerTopic: 256, commandsPerTopic: 4096,
  userMessageBytes: 8192, assistantMessageBytes: 16384, summaryBytes: 2048,
  proposalTitleBytes: 256, proposalGoalBytes: 8192,
  ledgerBytes: 16 * 1024 * 1024, pageSize: 50, pageBytes: 256 * 1024,
});

/** Host-selected opaque identities. These are scope bindings, not authentication. */
export interface ConversationStoreScope {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly taskStoreId: string;
}
export interface ConversationTaskLink {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly taskStoreId: string;
}
export interface ConversationContext {
  readonly topicId: string;
  readonly topicVersion: number;
  readonly revision: string;
  /** Digest of the exact host-selected context, not authority to open its sources. */
  readonly sha256: string;
  readonly taskVersions: readonly { readonly taskId: string; readonly version: number }[];
}
export type ConversationTurnState = 'queued' | 'running' | 'responded' | 'blocked' | 'uncertain';
/** Goal intake only. This journal grants no engineering execution or acceptance. */
export interface ConversationTaskProposal {
  readonly proposalId: string;
  readonly title: string;
  readonly goal: string;
  readonly state: 'offered' | 'linking' | 'linked' | 'uncertain';
  readonly taskId: string | null;
}
export interface ConversationTurn {
  readonly turnId: string;
  readonly topicId: string;
  readonly sequence: number;
  readonly userMessage: string;
  readonly context: ConversationContext;
  readonly state: ConversationTurnState;
  readonly assistantMessage: string | null;
  readonly reason: string | null;
  readonly proposedTask: ConversationTaskProposal | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type ConversationAttentionKind = 'blocked' | 'needs-review' | 'update';
export interface ConversationAttention {
  readonly attentionId: string;
  readonly topicId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly runId: string | null;
  readonly kind: ConversationAttentionKind;
  readonly summary: string;
  readonly observationSha256: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}
export interface ConversationTopicRecord extends ConversationStoreScope {
  readonly schema: 1;
  readonly topicId: string;
  readonly title: string;
  readonly version: number;
  readonly linkedTasks: readonly ConversationTaskLink[];
  readonly turns: readonly ConversationTurn[];
  readonly attention: readonly ConversationAttention[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ConversationCommand {
  readonly topicId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}
export interface ConversationMutation {
  readonly topic: ConversationTopicRecord;
  /** New receipt; only a freshly applied begin method grants its scoped launch claim. */
  readonly applied: boolean;
}
export interface ConversationPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly omittedBefore: number;
  readonly omittedAfter: number;
  readonly hasMore: boolean;
}
export interface ConversationTopicSummary extends ConversationStoreScope {
  readonly topicId: string;
  readonly title: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly linkedTaskCount: number;
  readonly turnCount: number;
  readonly pendingTurnId: string | null;
  readonly unreadAttentionCount: number;
  readonly actionableAttentionCount: number;
  readonly lastTurnState: ConversationTurnState | null;
}
export interface ConversationTopicPage {
  readonly topic: ConversationTopicSummary;
  readonly linkedTasks: readonly ConversationTaskLink[];
  readonly turns: ConversationPage<ConversationTurn>;
  readonly attention: readonly ConversationAttention[];
}
interface CommandReceipt { key: string; requestSha256: string; at: string }
interface StoredTopic extends ConversationTopicRecord { commands: CommandReceipt[] }
interface Ledger { schema: 1; scope: ConversationStoreScope; sha256: string; topics: StoredTopic[] }
const commandFields = ['topicId', 'actor', 'idempotencyKey', 'expectedVersion'];
const states = ['queued', 'running', 'responded', 'blocked', 'uncertain'];
const pending = (turn: ConversationTurn) => turn.state === 'queued' || turn.state === 'running';

function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Object required.');
  assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Plain object required.');
}
function fields(value: unknown, keys: readonly string[]): void {
  object(value);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected or missing conversation fields.');
}
function id(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value), 'Opaque conversation ID required; paths are not allowed.');
}
function text(value: unknown, max: number): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0'), 'Conversation text exceeds its bound or is empty.');
}
function integer(value: unknown, minimum = 0): asserts value is number {
  assert(Number.isSafeInteger(value) && (value as number) >= minimum, 'Conversation integer is out of range.');
}
function hash(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Conversation digest required.');
}
function timestamp(value: unknown): void {
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Conversation timestamp required.');
}
function scope(value: ConversationStoreScope): void {
  fields(value, ['hostId', 'workspaceId', 'taskStoreId']);
  id(value.hostId); id(value.workspaceId); id(value.taskStoreId);
}
/** Deterministic digest for JSON context/requests. It does not authenticate a producer. */
export function conversationDigest(value: unknown): string {
  const canonical = (item: unknown, depth: number): string => {
    assert(depth <= 32, 'Conversation JSON is too deep.');
    if (item === null) return 'null';
    if (Array.isArray(item)) return `[${item.map((entry) => canonical(entry, depth + 1)).join(',')}]`;
    if (typeof item === 'object') {
      object(item);
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key], depth + 1)}`).join(',')}}`;
    }
    assert(typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)), 'Conversation JSON value required.');
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value, 0)).digest('hex');
}
function link(value: ConversationTaskLink, selected: ConversationStoreScope): void {
  fields(value, ['taskId', 'workspaceId', 'taskStoreId']);
  id(value.taskId); id(value.workspaceId); id(value.taskStoreId);
  assert.equal(value.workspaceId, selected.workspaceId, 'Task workspace scope conflict.');
  assert.equal(value.taskStoreId, selected.taskStoreId, 'Task store scope conflict.');
}
function context(value: ConversationContext, topicId: string): void {
  fields(value, ['topicId', 'topicVersion', 'revision', 'sha256', 'taskVersions']);
  id(value.topicId); assert.equal(value.topicId, topicId, 'Context belongs to another topic.');
  integer(value.topicVersion, 1); id(value.revision); hash(value.sha256);
  assert(Array.isArray(value.taskVersions) && value.taskVersions.length <= CONVERSATION_LIMITS.linkedTasksPerTopic);
  const seen = new Set<string>();
  for (const task of value.taskVersions) {
    fields(task, ['taskId', 'version']); id(task.taskId); integer(task.version, 1);
    assert(!seen.has(task.taskId), 'Duplicate pinned task version.'); seen.add(task.taskId);
  }
}
function proposal(value: ConversationTaskProposal): void {
  fields(value, ['proposalId', 'title', 'goal', 'state', 'taskId']);
  id(value.proposalId);
  text(value.title, CONVERSATION_LIMITS.proposalTitleBytes);
  text(value.goal, CONVERSATION_LIMITS.proposalGoalBytes);
  assert(['offered', 'linking', 'linked', 'uncertain'].includes(value.state), 'Unknown task proposal state.');
  if (value.state === 'offered') assert.equal(value.taskId, null, 'Offered proposal has no selected task.');
  else id(value.taskId);
}
function publicTopic(topic: StoredTopic): ConversationTopicRecord {
  const { commands: _commands, ...record } = topic;
  return structuredClone(record);
}
function summary(topic: ConversationTopicRecord): ConversationTopicSummary {
  return {
    hostId: topic.hostId, workspaceId: topic.workspaceId, taskStoreId: topic.taskStoreId,
    topicId: topic.topicId, title: topic.title, version: topic.version,
    createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    linkedTaskCount: topic.linkedTasks.length, turnCount: topic.turns.length,
    pendingTurnId: topic.turns.find(pending)?.turnId ?? null,
    unreadAttentionCount: topic.attention.filter((item) => item.acknowledgedAt === null).length,
    actionableAttentionCount: topic.attention.filter((item) => item.acknowledgedAt === null && item.kind !== 'update').length,
    lastTurnState: topic.turns.at(-1)?.state ?? null,
  };
}
function page<T>(values: readonly T[], options: { offset?: number; limit?: number } = {}): ConversationPage<T> {
  object(options);
  assert(Object.keys(options).every((key) => key === 'offset' || key === 'limit'), 'Unknown page field.');
  const offset = options.offset ?? 0, limit = options.limit ?? 20;
  integer(offset); integer(limit, 1); assert(limit <= CONVERSATION_LIMITS.pageSize, 'Conversation page is too large.');
  const items: T[] = [];
  for (const item of values.slice(offset, offset + limit)) {
    if (Buffer.byteLength(JSON.stringify([...items, item])) > CONVERSATION_LIMITS.pageBytes) break;
    items.push(item);
  }
  const omittedBefore = Math.min(offset, values.length), omittedAfter = values.length - omittedBefore - items.length;
  return { items: structuredClone(items), total: values.length, offset, limit, omittedBefore, omittedAfter, hasMore: omittedAfter > 0 };
}

function validateTopics(topics: StoredTopic[], selected: ConversationStoreScope): void {
  assert(Array.isArray(topics) && topics.length <= CONVERSATION_LIMITS.topics, 'Conversation topic bound exceeded.');
  const topicIds = new Set<string>(), turnIds = new Set<string>(), attentionIds = new Set<string>(), keys = new Set<string>();
  const proposalIds = new Set<string>(), proposalTaskIds = new Set<string>();
  for (const t of topics) {
    fields(t, ['schema', 'hostId', 'workspaceId', 'taskStoreId', 'topicId', 'title', 'version', 'linkedTasks', 'turns', 'attention', 'createdAt', 'updatedAt', 'commands']);
    assert.equal(t.schema, 1); id(t.topicId); text(t.title, 256); integer(t.version, 1);
    assert(!topicIds.has(t.topicId), 'Duplicate topic.'); topicIds.add(t.topicId);
    assert.deepEqual({hostId:t.hostId, workspaceId:t.workspaceId, taskStoreId:t.taskStoreId}, selected, 'Conversation scope conflict.');
    timestamp(t.createdAt); timestamp(t.updatedAt);
    assert(Array.isArray(t.linkedTasks) && t.linkedTasks.length <= CONVERSATION_LIMITS.linkedTasksPerTopic);
    const taskIds = new Set<string>();
    for (const task of t.linkedTasks) { link(task, selected); assert(!taskIds.has(task.taskId)); taskIds.add(task.taskId); }
    assert(Array.isArray(t.turns) && t.turns.length <= CONVERSATION_LIMITS.turnsPerTopic);
    let active = 0;
    for (const [index, turn] of t.turns.entries()) {
      fields(turn, ['turnId', 'topicId', 'sequence', 'userMessage', 'context', 'state', 'assistantMessage', 'reason', 'proposedTask', 'createdAt', 'updatedAt']);
      id(turn.turnId); assert(!turnIds.has(turn.turnId)); turnIds.add(turn.turnId);
      assert.equal(turn.topicId, t.topicId); assert.equal(turn.sequence, index + 1);
      text(turn.userMessage, CONVERSATION_LIMITS.userMessageBytes); context(turn.context, t.topicId);
      assert(turn.context.topicVersion < t.version, 'Context must precede retained turn.');
      assert(turn.context.taskVersions.every((task: { readonly taskId: string; readonly version: number }) => taskIds.has(task.taskId)), 'Unknown context task.');
      assert(states.includes(turn.state), 'Unknown turn state.');
      if (turn.state === 'responded') { text(turn.assistantMessage, CONVERSATION_LIMITS.assistantMessageBytes); assert.equal(turn.reason, null); }
      else { assert.equal(turn.assistantMessage, null); if (turn.state === 'blocked' || turn.state === 'uncertain') text(turn.reason, CONVERSATION_LIMITS.summaryBytes); else assert.equal(turn.reason, null); }
      if (turn.proposedTask !== null) {
        assert.equal(turn.state, 'responded', 'Only a retained response can offer task intake.');
        proposal(turn.proposedTask);
        assert(!proposalIds.has(turn.proposedTask.proposalId), 'Duplicate task proposal.');
        proposalIds.add(turn.proposedTask.proposalId);
        if (turn.proposedTask.taskId !== null) {
          assert(!proposalTaskIds.has(turn.proposedTask.taskId), 'Task ID belongs to another proposal.');
          proposalTaskIds.add(turn.proposedTask.taskId);
          if (turn.proposedTask.state === 'linked') assert(taskIds.has(turn.proposedTask.taskId), 'Completed proposal must retain its task link.');
        }
      }
      timestamp(turn.createdAt); timestamp(turn.updatedAt); if (pending(turn)) active++;
    }
    assert(active <= 1, 'Same-topic turns overlap.');
    assert(Array.isArray(t.attention) && t.attention.length <= CONVERSATION_LIMITS.attentionPerTopic);
    const observations = new Set<string>();
    for (const item of t.attention) {
      fields(item, ['attentionId', 'topicId', 'taskId', 'taskVersion', 'runId', 'kind', 'summary', 'observationSha256', 'createdAt', 'acknowledgedAt']);
      id(item.attentionId); assert(!attentionIds.has(item.attentionId)); attentionIds.add(item.attentionId);
      assert.equal(item.topicId, t.topicId); assert(taskIds.has(item.taskId), 'Attention task is not linked.');
      integer(item.taskVersion, 1); if (item.runId !== null) id(item.runId);
      assert(['blocked','needs-review','update'].includes(item.kind)); text(item.summary, CONVERSATION_LIMITS.summaryBytes); hash(item.observationSha256);
      const observation = conversationDigest([item.taskId,item.taskVersion,item.runId,item.kind,item.observationSha256]);
      assert(!observations.has(observation), 'Duplicate attention observation.'); observations.add(observation);
      timestamp(item.createdAt); if (item.acknowledgedAt !== null) timestamp(item.acknowledgedAt);
    }
    assert(Array.isArray(t.commands) && t.commands.length === t.version && t.commands.length <= CONVERSATION_LIMITS.commandsPerTopic);
    for (const c of t.commands) { fields(c, ['key','requestSha256','at']); id(c.key); hash(c.requestSha256); timestamp(c.at); assert(!keys.has(c.key), 'Duplicate command key.'); keys.add(c.key); }
  }
}

/** Small trusted local store. Exclusive locks fail closed; never steal a lock.
 * Atomic files and command receipts do not provide cross-process exactly-once
 * effects, producer authentication, general memory, or task acceptance.
 */
export class FileConversationStore {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly root: string, readonly scope: ConversationStoreScope) {}
  static async create(root: string, selected: ConversationStoreScope): Promise<FileConversationStore> {
    scope(selected); assert(isAbsolute(root), 'Absolute host-selected conversation root required.');
    await mkdir(root, {recursive:true,mode:0o700});
    const info = await lstat(root); assert(info.isDirectory() && !info.isSymbolicLink());
    const store = new FileConversationStore(await realpath(root), Object.freeze(structuredClone(selected)));
    await store.withLock(async () => {
      const marker = join(store.root, '.conversation-store.json');
      if (await lstat(marker).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) { await store.read(); return; }
      assert((await readdir(store.root)).every((entry) => entry === '.conversation.lock'), 'Refusing to initialize nonempty conversation storage.');
      const file = await open(marker, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({schema:1,kind:'temari-conversation-store',scope:store.scope})); await file.sync(); } finally { await file.close(); }
      await store.publish([]);
    });
    return store;
  }
  static async openExisting(root: string, selected: ConversationStoreScope): Promise<FileConversationStore> {
    scope(selected); assert(isAbsolute(root), 'Absolute host-selected conversation root required.');
    const info = await lstat(root); assert(info.isDirectory() && !info.isSymbolicLink());
    const store = new FileConversationStore(await realpath(root), Object.freeze(structuredClone(selected))); await store.read(); return store;
  }
  async load(topicId: string): Promise<ConversationTopicRecord | null> {
    id(topicId); const t = (await this.read()).find((item) => item.topicId === topicId); return t ? publicTopic(t) : null;
  }
  async listTopics(options: {offset?:number;limit?:number} = {}): Promise<ConversationPage<ConversationTopicSummary>> {
    options = structuredClone(options);
    const topics = (await this.read()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.topicId.localeCompare(b.topicId)); return page(topics.map(summary), options);
  }
  /** One bounded ledger snapshot, without cursors over a changing sort order. */
  async listAllTopicSummaries(): Promise<readonly ConversationTopicSummary[]> {
    const topics = await this.read();
    return topics.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.topicId.localeCompare(b.topicId)).map(summary);
  }
  async readTopic(topicId: string, options: {offset?:number;limit?:number} = {}): Promise<ConversationTopicPage> {
    options = structuredClone(options);
    const t = await this.load(topicId); assert(t, 'Conversation topic not found.'); return {topic:summary(t),linkedTasks:t.linkedTasks,turns:page(t.turns,options),attention:t.attention};
  }
  /** Select complete latest turns backwards within the byte bound, then restore chronological order. */
  async readLatestTopic(topicId: string, options: {limit?:number} = {}): Promise<ConversationTopicPage> {
    options = structuredClone(options);
    object(options); assert(Object.keys(options).every((key) => key === 'limit'), 'Unknown latest page field.');
    const limit = options.limit ?? 20;
    integer(limit, 1); assert(limit <= CONVERSATION_LIMITS.pageSize, 'Conversation page is too large.');
    const topic = await this.load(topicId); assert(topic, 'Conversation topic not found.');
    const selected: ConversationTurn[] = [];
    let offset = topic.turns.length;
    for (let index = topic.turns.length - 1; index >= 0 && selected.length < limit; index--) {
      const turn = topic.turns[index]!;
      if (Buffer.byteLength(JSON.stringify([turn, ...selected])) > CONVERSATION_LIMITS.pageBytes) break;
      selected.unshift(turn); offset = index;
    }
    return {topic:summary(topic),linkedTasks:topic.linkedTasks,turns:page(topic.turns,{offset,limit}),attention:topic.attention};
  }
  async listAttention(options: {topicId?:string;offset?:number;limit?:number;unreadOnly?:boolean} = {}): Promise<ConversationPage<ConversationAttention>> {
    options = structuredClone(options);
    object(options); assert(Object.keys(options).every((key) => ['topicId','offset','limit','unreadOnly'].includes(key)));
    if (options.topicId !== undefined) id(options.topicId); if (options.unreadOnly !== undefined) assert(typeof options.unreadOnly === 'boolean');
    const topics = await this.read(); if (options.topicId !== undefined) assert(topics.some((t) => t.topicId === options.topicId), 'Conversation topic not found.');
    const items = topics.filter((t) => options.topicId === undefined || t.topicId === options.topicId).flatMap((t) => t.attention).filter((item) => !options.unreadOnly || item.acknowledgedAt === null).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.attentionId.localeCompare(b.attentionId));
    return page(items,{...(options.offset===undefined?{}:{offset:options.offset}),...(options.limit===undefined?{}:{limit:options.limit})});
  }
  async createTopic(request: ConversationCommand & {title:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'title']); text(request.title,256); assert.equal(request.expectedVersion,0);
    return this.mutate('create',request,(t,_topics,at) => { assert(!t, 'Topic already exists.'); return {schema:1,...this.scope,topicId:request.topicId,title:request.title,version:0,linkedTasks:[],turns:[],attention:[],createdAt:at,updatedAt:at,commands:[]}; });
  }
  async linkTask(request: ConversationCommand & {task:ConversationTaskLink}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'task']); link(request.task,this.scope);
    return this.mutate('link-task',request,(t) => { assert(t); const prior=t.linkedTasks.find((x)=>x.taskId===request.task.taskId); if (prior) assert.deepEqual(prior,request.task); else { assert(t.linkedTasks.length<CONVERSATION_LIMITS.linkedTasksPerTopic,'Conversation task-link bound exceeded.'); (t.linkedTasks as ConversationTaskLink[]).push(structuredClone(request.task)); } return t; });
  }
  async enqueueTurn(request: ConversationCommand & {turnId:string;userMessage:string;context:ConversationContext}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'turnId','userMessage','context']); id(request.turnId); text(request.userMessage,CONVERSATION_LIMITS.userMessageBytes); context(request.context,request.topicId); assert.equal(request.context.topicVersion,request.expectedVersion,'Context version differs from submitted topic.');
    return this.mutate('enqueue',request,(t,topics,at) => {
      assert(t); assert(!topics.some((item)=>item.turns.some((turn)=>turn.turnId===request.turnId)), 'Turn ID already belongs to a retained turn.');
      assert(!t.turns.some(pending),'A turn is already pending in this topic.'); assert(t.turns.length<CONVERSATION_LIMITS.turnsPerTopic,'Conversation turn history bound exceeded.');
      assert.deepEqual(request.context.taskVersions.map((x)=>x.taskId).sort(),t.linkedTasks.map((x)=>x.taskId).sort(),'Pin exactly the linked task versions.');
      (t.turns as ConversationTurn[]).push({turnId:request.turnId,topicId:t.topicId,sequence:t.turns.length+1,userMessage:request.userMessage,context:structuredClone(request.context),state:'queued',assistantMessage:null,reason:null,proposedTask:null,createdAt:at,updatedAt:at}); return t;
    });
  }
  async beginTurn(request: ConversationCommand & {turnId:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'turnId']); id(request.turnId);
    return this.mutate('begin',request,(t,_topics,at) => { assert(t); const turn=t.turns.find((x)=>x.turnId===request.turnId); assert(turn,'Turn does not belong to this topic.'); assert.equal(turn.state,'queued','Retained turn cannot be launched again.'); this.replaceTurn(t,{...turn,state:'running',updatedAt:at}); return t; });
  }
  async finishTurn(request: ConversationCommand & {turnId:string;state:'responded'|'blocked'|'uncertain';assistantMessage:string|null;reason:string|null;proposedTask?:ConversationTaskProposal|null}): Promise<ConversationMutation> {
    request = structuredClone(request);
    if (!Object.hasOwn(request, 'proposedTask')) request = {...request, proposedTask:null};
    fields(request,[...commandFields,'turnId','state','assistantMessage','reason','proposedTask']); id(request.turnId); assert(['responded','blocked','uncertain'].includes(request.state));
    if (request.state==='responded') { text(request.assistantMessage,CONVERSATION_LIMITS.assistantMessageBytes); assert.equal(request.reason,null); } else { assert.equal(request.assistantMessage,null); text(request.reason,CONVERSATION_LIMITS.summaryBytes); }
    const proposedTask=request.proposedTask;
    assert(proposedTask !== undefined, 'Explicit null or task proposal required.');
    if (proposedTask !== null) { proposal(proposedTask); assert.equal(request.state, 'responded'); assert.equal(proposedTask.state, 'offered', 'A new proposal must be offered.'); }
    return this.mutate('finish',request,(t,_topics,at) => { assert(t); const turn=t.turns.find((x)=>x.turnId===request.turnId); assert(turn,'Turn does not belong to this topic.'); assert(turn.state==='running'||(turn.state==='queued'&&request.state!=='responded'),'Turn outcome is terminal or was never launched.'); this.replaceTurn(t,{...turn,state:request.state,assistantMessage:request.assistantMessage,reason:request.reason,proposedTask,updatedAt:at}); return t; });
  }
  /** Explicit goal-intake claim. The host must use the retained taskId for any retry. */
  async beginTaskProposal(request: ConversationCommand & {turnId:string;taskId:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'turnId','taskId']); id(request.turnId); id(request.taskId);
    return this.mutate('begin-task-proposal',request,(t,_topics,at) => {
      assert(t); const turn=t.turns.find((x)=>x.turnId===request.turnId);
      assert(turn, 'Turn does not belong to this topic.');
      const offered=turn.proposedTask; assert(offered, 'Turn has no task proposal.');
      assert(offered.state==='offered'||offered.state==='uncertain', 'Task proposal is already claimed or linked.');
      if (offered.taskId !== null) assert.equal(request.taskId, offered.taskId, 'Task proposal retry must retain its selected task ID.');
      assert(t.linkedTasks.some((task)=>task.taskId===request.taskId)||t.linkedTasks.length<CONVERSATION_LIMITS.linkedTasksPerTopic, 'Conversation task-link bound exceeded.');
      this.replaceTurn(t,{...turn,proposedTask:{...offered,state:'linking',taskId:request.taskId},updatedAt:at});
      return t;
    });
  }
  /** Records an observed host-created task link; this method never creates a task. */
  async finishTaskProposal(request: ConversationCommand & {turnId:string;taskId:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'turnId','taskId']); id(request.turnId); id(request.taskId);
    return this.mutate('finish-task-proposal',request,(t,_topics,at) => {
      assert(t); const turn=t.turns.find((x)=>x.turnId===request.turnId);
      assert(turn, 'Turn does not belong to this topic.');
      const offered=turn.proposedTask; assert(offered, 'Turn has no task proposal.');
      assert.equal(offered.state, 'linking', 'Task proposal must have an explicit active intake claim.');
      assert.equal(request.taskId, offered.taskId, 'Task proposal result changed its selected task ID.');
      if (!t.linkedTasks.some((task)=>task.taskId===request.taskId)) {
        assert(t.linkedTasks.length<CONVERSATION_LIMITS.linkedTasksPerTopic, 'Conversation task-link bound exceeded.');
        (t.linkedTasks as ConversationTaskLink[]).push({taskId:request.taskId,workspaceId:this.scope.workspaceId,taskStoreId:this.scope.taskStoreId});
      }
      this.replaceTurn(t,{...turn,proposedTask:{...offered,state:'linked'},updatedAt:at});
      return t;
    });
  }
  /** Explicit host startup bookkeeping only. Opening a store never launches/replays. */
  async recoverTopic(request: ConversationCommand): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,commandFields);
    return this.mutate('recover',request,(t,_topics,at) => {
      assert(t);
      for (const turn of t.turns) {
        if (pending(turn)) this.replaceTurn(t,{...turn,state:'uncertain',reason:'The prior turn was interrupted. Its model/tool effects will not be replayed.',updatedAt:at});
        else if (turn.proposedTask?.state==='linking') this.replaceTurn(t,{...turn,proposedTask:{...turn.proposedTask,state:'uncertain'},updatedAt:at});
      }
      return t;
    });
  }
  async observeAttention(request: ConversationCommand & {attentionId:string;taskId:string;taskVersion:number;runId:string|null;kind:ConversationAttentionKind;summary:string;observationSha256:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'attentionId','taskId','taskVersion','runId','kind','summary','observationSha256']); id(request.attentionId); id(request.taskId); integer(request.taskVersion,1); if(request.runId!==null)id(request.runId); assert(['blocked','needs-review','update'].includes(request.kind)); text(request.summary,CONVERSATION_LIMITS.summaryBytes); hash(request.observationSha256);
    return this.mutate('observe-attention',request,(t,topics,at) => {
      assert(t); assert(t.linkedTasks.some((x)=>x.taskId===request.taskId),'Attention task is not linked.');
      const existing=topics.flatMap((x)=>x.attention).find((x)=>x.attentionId===request.attentionId);
      const matches=(x:ConversationAttention)=>x.topicId===t.topicId&&x.taskId===request.taskId&&x.taskVersion===request.taskVersion&&x.runId===request.runId&&x.kind===request.kind&&x.observationSha256===request.observationSha256;
      if(existing) assert(matches(existing),'Attention ID changed observation or topic.');
      if(!t.attention.some(matches)) { assert(t.attention.length<CONVERSATION_LIMITS.attentionPerTopic,'Conversation attention bound exceeded.'); (t.attention as ConversationAttention[]).push({attentionId:request.attentionId,topicId:t.topicId,taskId:request.taskId,taskVersion:request.taskVersion,runId:request.runId,kind:request.kind,summary:request.summary,observationSha256:request.observationSha256,createdAt:at,acknowledgedAt:null}); } return t;
    });
  }
  async acknowledgeAttention(request: ConversationCommand & {attentionId:string}): Promise<ConversationMutation> {
    request = structuredClone(request);
    fields(request,[...commandFields,'attentionId']); id(request.attentionId);
    return this.mutate('acknowledge',request,(t,_topics,at)=>{assert(t); const index=t.attention.findIndex((x)=>x.attentionId===request.attentionId); assert(index>=0,'Attention does not belong to this topic.'); const item=t.attention[index]!; (t.attention as ConversationAttention[])[index]={...item,acknowledgedAt:item.acknowledgedAt??at}; return t;});
  }
  private replaceTurn(topic:StoredTopic,turn:ConversationTurn):void { const index=topic.turns.findIndex((x)=>x.turnId===turn.turnId); assert(index>=0); (topic.turns as ConversationTurn[])[index]=turn; }
  private async mutate(kind:string,request:ConversationCommand,change:(topic:StoredTopic|undefined,topics:StoredTopic[],at:string)=>StoredTopic):Promise<ConversationMutation> {
    id(request.topicId); id(request.idempotencyKey); text(request.actor,128); integer(request.expectedVersion);
    const frozen=structuredClone(request), requestSha256=conversationDigest({kind,request:frozen});
    return this.withLock(async()=>{
      const topics=await this.read(), existing=topics.find((x)=>x.topicId===frozen.topicId);
      const receipt=topics.flatMap((t)=>t.commands.map((c)=>({topic:t,command:c}))).find((x)=>x.command.key===frozen.idempotencyKey);
      if(receipt) { assert.equal(receipt.command.requestSha256,requestSha256,'Idempotency body/actor/version/topic conflict.'); return {topic:publicTopic(receipt.topic),applied:false}; }
      assert.equal(existing?.version??0,frozen.expectedVersion,'Conversation version conflict; reload before updating.');
      assert(existing||kind==='create','Conversation topic not found.'); if(!existing)assert(topics.length<CONVERSATION_LIMITS.topics,'Conversation topic bound exceeded.');
      const at=new Date().toISOString(), next=change(existing,topics,at);
      assert(next.commands.length<CONVERSATION_LIMITS.commandsPerTopic,'Conversation command history bound exceeded.');
      const updated={...next,version:next.version+1,updatedAt:at,commands:[...next.commands,{key:frozen.idempotencyKey,requestSha256,at}]};
      if(existing)topics[topics.indexOf(existing)]=updated;else topics.push(updated);
      validateTopics(topics,this.scope); await this.publish(topics); return {topic:publicTopic(updated),applied:true};
    });
  }
  private async regular(path:string,max:number):Promise<Buffer> {
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try { const info=await file.stat(); assert(info.isFile()&&info.size<=max,'Conversation file exceeds bound or is not regular.'); const bytes=await file.readFile(); assert(bytes.length<=max); return bytes; } finally { await file.close(); }
  }
  private async read():Promise<StoredTopic[]> {
    const marker=JSON.parse((await this.regular(join(this.root,'.conversation-store.json'),4096)).toString()); fields(marker,['schema','kind','scope']); assert(marker.schema===1&&marker.kind==='temari-conversation-store'); assert.deepEqual(marker.scope,this.scope,'Stored conversation scope conflict.');
    const ledger=JSON.parse((await this.regular(join(this.root,'conversations.json'),CONVERSATION_LIMITS.ledgerBytes)).toString()) as Ledger;
    fields(ledger,['schema','scope','sha256','topics']); assert.equal(ledger.schema,1); assert.deepEqual(ledger.scope,this.scope); hash(ledger.sha256); assert.equal(ledger.sha256,conversationDigest(ledger.topics),'Conversation ledger digest mismatch.'); validateTopics(ledger.topics,this.scope); return ledger.topics;
  }
  private async publish(topics:StoredTopic[]):Promise<void> {
    const body=JSON.stringify({schema:1,scope:this.scope,sha256:conversationDigest(topics),topics}); assert(Buffer.byteLength(body)<=CONVERSATION_LIMITS.ledgerBytes,'Conversation ledger storage bound exceeded.');
    const path=join(this.root,`.conversation-${randomUUID()}.tmp`),file=await open(path,'wx',0o600);
    try { try {await file.writeFile(body);await file.sync();}finally{await file.close();} await rename(path,join(this.root,'conversations.json')); const directory=await open(this.root,'r');try{await directory.sync();}finally{await directory.close();} }finally{await unlink(path).catch(()=>undefined);}
  }
  private withLock<T>(effect:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(async()=>{
      const lock=join(this.root,'.conversation.lock');
      try{await mkdir(lock,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Conversation storage is locked. No automatic takeover.');throw error;}
      try {const file=await open(join(lock,'owner.json'),'wx',0o600);try{await file.writeFile(JSON.stringify({hostId:this.scope.hostId,pid:process.pid,nonce:randomUUID()}));await file.sync();}finally{await file.close();} return await effect();}
      finally{await unlink(join(lock,'owner.json'));await rmdir(lock);}
    });
    this.queue=next.then(()=>undefined,()=>undefined);return next;
  }
}
