import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  FileConversationStore, conversationDigest, CONVERSATION_LIMITS,
  type ConversationCommand, type ConversationContext, type ConversationTopicRecord,
} from './conversation-store.js';
import { FileTaskStore } from './task-store.js';

const scope = {hostId:'local-host',workspaceId:'workspace-1',taskStoreId:'tasks-1'};
async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),'temari-conversation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await FileConversationStore.create(join(root,'conversations'),scope);
  return {root,store};
}
function command(topic:ConversationTopicRecord,key:string):ConversationCommand {
  return {topicId:topic.topicId,actor:'temari',idempotencyKey:key,expectedVersion:topic.version};
}
async function topic(store:FileConversationStore,id='topic-1') {
  return (await store.createTopic({topicId:id,title:'Discuss '+id,actor:'temari',idempotencyKey:'create-'+id,expectedVersion:0})).topic;
}
function context(topic:ConversationTopicRecord):ConversationContext {
  return {topicId:topic.topicId,topicVersion:topic.version,revision:'context-'+topic.version,sha256:conversationDigest({topicId:topic.topicId,version:topic.version}),taskVersions:topic.linkedTasks.map((task)=>({taskId:task.taskId,version:7}))};
}
async function enqueue(store:FileConversationStore,record:ConversationTopicRecord,id='turn-1') {
  return (await store.enqueueTurn({...command(record,'enqueue-'+id),turnId:id,userMessage:'Help with '+record.topicId,context:context(record)})).topic;
}

test('immutable turn/context and exact changed-body retry checks survive reopening',async(t)=>{
  const f=await fixture(t);let record=await topic(f.store);
  record=(await f.store.linkTask({...command(record,'link-1'),task:{taskId:'task-1',workspaceId:scope.workspaceId,taskStoreId:scope.taskStoreId}})).topic;
  const request={...command(record,'enqueue-immutable'),turnId:'turn-1',userMessage:'Original user request',context:context(record)};
  const original=structuredClone(request),pending=f.store.enqueueTurn(request);
  request.userMessage='Changed after submission';(request.context.taskVersions[0] as {version:number}).version=99;
  const result=await pending;assert.equal(result.topic.turns[0]!.userMessage,original.userMessage);assert.equal(result.topic.turns[0]!.context.taskVersions[0]!.version,7);
  const reopened=await FileConversationStore.openExisting(f.store.root,scope);
  const replay=await reopened.enqueueTurn(original);assert.equal(replay.applied,false);assert.equal(replay.topic.version,result.topic.version);
  await assert.rejects(reopened.enqueueTurn({...original,userMessage:'Changed retry'}),/Idempotency/);
  await assert.rejects(reopened.enqueueTurn({...original,expectedVersion:result.topic.version,context:{...original.context,topicVersion:result.topic.version}}),/Idempotency/);
  await assert.rejects(reopened.enqueueTurn({...original,actor:'another-caller'}),/Idempotency/);
  await assert.rejects(reopened.linkTask({...command(record,'new-link-key'),task:{taskId:'task-2',workspaceId:scope.workspaceId,taskStoreId:scope.taskStoreId}}),/version conflict/);
  (replay.topic.turns[0] as {userMessage:string}).userMessage='Changed returned copy';
  assert.equal((await reopened.load(record.topicId))!.turns[0]!.userMessage,'Original user request');
});

test('one same-topic turn claim and duplicate begin cannot launch a second effect; topics remain independent',async(t)=>{
  const f=await fixture(t);let a=await topic(f.store,'topic-a'),b=await topic(f.store,'topic-b');
  a=await enqueue(f.store,a,'turn-a');b=await enqueue(f.store,b,'turn-b');
  await assert.rejects(enqueue(f.store,a,'turn-a-second'),/already pending/);
  let effects=0;
  const begin={...command(a,'begin-a'),turnId:'turn-a'};
  const first=await f.store.beginTurn(begin);if(first.applied)effects++;
  const replay=await f.store.beginTurn(begin);if(replay.applied)effects++;
  assert.equal(effects,1);assert.equal(replay.applied,false);
  await assert.rejects(f.store.beginTurn({...command(first.topic,'another-begin'),turnId:'turn-a'}),/cannot be launched again/);
  const other=await f.store.beginTurn({...command(b,'begin-b'),turnId:'turn-b'});assert.equal(other.applied,true);
  assert.equal((await f.store.load('topic-a'))!.turns[0]!.state,'running');assert.equal(other.topic.turns[0]!.state,'running');
});

test('restart never replays queued/running turns; explicit new submission can follow visible uncertainty',async(t)=>{
  const f=await fixture(t);let queued=await topic(f.store,'queued-topic'),running=await topic(f.store,'running-topic');
  queued=await enqueue(f.store,queued,'queued-turn');running=await enqueue(f.store,running,'running-turn');
  running=(await f.store.beginTurn({...command(running,'begin-running'),turnId:'running-turn'})).topic;
  const before=await readFile(join(f.store.root,'conversations.json'));
  const reopened=await FileConversationStore.openExisting(f.store.root,scope);
  assert.deepEqual(await readFile(join(f.store.root,'conversations.json')),before,'opening has no implicit recovery/effect');
  for(const previous of [queued,running]) {
    const recovered=(await reopened.recoverTopic({...command(previous,'recover-'+previous.topicId)})).topic;
    assert.equal(recovered.turns[0]!.state,'uncertain');assert.match(recovered.turns[0]!.reason!,/will not be replayed/);
    await assert.rejects(reopened.beginTurn({...command(recovered,'rebegin-'+previous.topicId),turnId:previous.turns[0]!.turnId}),/cannot be launched again/);
    await assert.rejects(reopened.finishTurn({...command(recovered,'refinish-'+previous.topicId),turnId:previous.turns[0]!.turnId,state:'responded',assistantMessage:'Invented recovery',reason:null}),/terminal/);
    const next=await enqueue(reopened,recovered,'new-'+previous.topicId);assert.equal(next.turns.length,2);assert.equal(next.turns[0]!.state,'uncertain');assert.equal(next.turns[1]!.state,'queued');
  }
});

test('wrong topic, workspace, unknown task joins and browser paths refuse without writing',async(t)=>{
  const f=await fixture(t);const a=await topic(f.store,'topic-a'),b=await topic(f.store,'topic-b');const submitted=await enqueue(f.store,a,'turn-a');
  const before=await readFile(join(f.store.root,'conversations.json'));
  await assert.rejects(f.store.beginTurn({...command(b,'wrong-topic-begin'),turnId:'turn-a'}),/does not belong/);
  await assert.rejects(f.store.enqueueTurn({...command(b,'wrong-context'),turnId:'turn-b',userMessage:'Other topic',context:context(submitted)}),/another topic/);
  await assert.rejects(f.store.enqueueTurn({...command(b,'unknown-task'),turnId:'turn-b',userMessage:'Unknown join',context:{...context(b),taskVersions:[{taskId:'not-linked',version:1}]}}),/exactly the linked/);
  await assert.rejects(f.store.linkTask({...command(b,'wrong-workspace'),task:{taskId:'task-1',workspaceId:'other-workspace',taskStoreId:scope.taskStoreId}}),/scope conflict/);
  await assert.rejects(f.store.linkTask({...command(b,'path-link'),task:{taskId:'/private/secret',workspaceId:scope.workspaceId,taskStoreId:scope.taskStoreId}}),/paths are not allowed/);
  await assert.rejects(FileConversationStore.openExisting(f.store.root,{...scope,hostId:'another-host'}),/scope conflict/);
  assert.deepEqual(await readFile(join(f.store.root,'conversations.json')),before);
});

test('attention coalesces observations and acknowledgment cannot change linked task acceptance',async(t)=>{
  const f=await fixture(t);const tasks=await FileTaskStore.create(join(f.root,'tasks'));
  await tasks.createTask({taskId:'task-1',actor:'temari',idempotencyKey:'create-task',title:'Actual retained task',goal:'Keep task acceptance separate',workspaceRoot:f.root});
  const taskBytes=await readFile(join(tasks.root,'tasks.json'));let record=await topic(f.store);
  record=(await f.store.linkTask({...command(record,'link-task'),task:{taskId:'task-1',workspaceId:scope.workspaceId,taskStoreId:scope.taskStoreId}})).topic;
  const observation={attentionId:'attention-1',taskId:'task-1',taskVersion:1,runId:null,kind:'needs-review' as const,summary:'Findings need review',observationSha256:conversationDigest({task:'task-1',version:1,status:'needs-review'})};
  record=(await f.store.observeAttention({...command(record,'observe-1'),...observation})).topic;
  record=(await f.store.observeAttention({...command(record,'observe-repeat'),...observation,attentionId:'same-observation-new-id'})).topic;
  assert.equal(record.attention.length,1);assert.equal((await f.store.listAttention({unreadOnly:true})).total,1);
  const pendingSummary=(await f.store.listAllTopicSummaries())[0]!;assert.equal(pendingSummary.unreadAttentionCount,1);assert.equal(pendingSummary.actionableAttentionCount,1);assert.equal(pendingSummary.lastTurnState,null);
  record=(await f.store.acknowledgeAttention({...command(record,'ack-1'),attentionId:'attention-1'})).topic;
  const acknowledgedAt=record.attention[0]!.acknowledgedAt;
  record=(await f.store.observeAttention({...command(record,'observe-after-ack'),...observation})).topic;
  assert.equal(record.attention.length,1);assert.equal(record.attention[0]!.acknowledgedAt,acknowledgedAt);assert.equal((await f.store.listAttention({unreadOnly:true})).total,0);
  const acknowledgedSummary=(await f.store.listAllTopicSummaries())[0]!;assert.equal(acknowledgedSummary.actionableAttentionCount,0);assert.equal(acknowledgedSummary.unreadAttentionCount,0);
  record=(await f.store.observeAttention({...command(record,'observe-new-version'),...observation,attentionId:'attention-2',taskVersion:2,observationSha256:conversationDigest({version:2})})).topic;
  assert.equal((await f.store.listAttention({unreadOnly:true})).total,1);
  const other=await topic(f.store,'other-topic');await assert.rejects(f.store.acknowledgeAttention({...command(other,'wrong-ack'),attentionId:'attention-2'}),/does not belong/);
  assert.deepEqual(await readFile(join(tasks.root,'tasks.json')),taskBytes);assert.equal((await tasks.load('task-1'))!.acceptance,null);
});

test('interrupted task create/link retains its fixed identity; explicit retry cannot duplicate a task or accept it',async(t)=>{
  const f=await fixture(t),tasks=await FileTaskStore.create(join(f.root,'tasks'));
  let record=await topic(f.store);
  record=await enqueue(f.store,record,'proposal-turn');
  const frozenUser=structuredClone(record.turns[0]!);
  record=(await f.store.beginTurn({...command(record,'begin-proposal-turn'),turnId:'proposal-turn'})).topic;
  const offered={proposalId:'proposal-1',title:'Prepare a task plan',goal:'Retain one task without executing engineering',state:'offered' as const,taskId:null};
  await assert.rejects(f.store.finishTurn({...command(record,'invented-linked-proposal'),turnId:'proposal-turn',state:'responded',assistantMessage:'Proposed goal',reason:null,proposedTask:{...offered,state:'linked',taskId:'proposal-task-1'}}),/must be offered/);
  record=(await f.store.finishTurn({...command(record,'finish-proposal-turn'),turnId:'proposal-turn',state:'responded',assistantMessage:'You can accept this task proposal.',reason:null,proposedTask:offered})).topic;
  const initialTaskBytes=await readFile(join(tasks.root,'tasks.json'));
  const begin={...command(record,'accept-proposal-1'),turnId:'proposal-turn',taskId:'proposal-task-1'};
  const first=await f.store.beginTaskProposal(begin);
  assert.equal(first.applied,true);assert.equal(first.topic.turns[0]!.proposedTask!.state,'linking');
  assert.deepEqual(await readFile(join(tasks.root,'tasks.json')),initialTaskBytes,'the journal does not create a task');
  assert.equal((await f.store.beginTaskProposal(begin)).applied,false,'same claim cannot start another intake effect');
  const create={taskId:'proposal-task-1',actor:'temari',idempotencyKey:'task-create-proposal-1',title:offered.title,goal:offered.goal,workspaceRoot:f.root};
  await tasks.createTask(create);
  const createdTaskBytes=await readFile(join(tasks.root,'tasks.json'));
  // Deliberately omit finishTaskProposal to represent interruption after durable creation.
  const reopened=await FileConversationStore.openExisting(f.store.root,scope);
  record=(await reopened.recoverTopic({...command(first.topic,'recover-proposal')})).topic;
  assert.equal(record.turns[0]!.proposedTask!.state,'uncertain');
  assert.equal(record.turns[0]!.proposedTask!.taskId,create.taskId);
  assert.equal(record.linkedTasks.length,0);assert.deepEqual(await readFile(join(tasks.root,'tasks.json')),createdTaskBytes);
  assert.equal((await reopened.beginTaskProposal(begin)).applied,false,'old claim never replays after recovery');
  await assert.rejects(reopened.beginTaskProposal({...command(record,'changed-proposal-task'),turnId:'proposal-turn',taskId:'another-task'}),/must retain/);
  await assert.rejects(reopened.finishTaskProposal({...command(record,'finish-without-retry'),turnId:'proposal-turn',taskId:create.taskId}),/active intake claim/);
  record=(await reopened.beginTaskProposal({...command(record,'explicit-proposal-retry'),turnId:'proposal-turn',taskId:create.taskId})).topic;
  await tasks.createTask(create);
  assert.equal((await tasks.list()).length,1);assert.deepEqual(await readFile(join(tasks.root,'tasks.json')),createdTaskBytes);
  await assert.rejects(reopened.finishTaskProposal({...command(record,'wrong-proposal-result'),turnId:'proposal-turn',taskId:'another-task'}),/changed its selected/);
  const finish={...command(record,'finish-proposal-link'),turnId:'proposal-turn',taskId:create.taskId};
  record=(await reopened.finishTaskProposal(finish)).topic;
  assert.equal((await reopened.finishTaskProposal(finish)).applied,false);
  assert.deepEqual(record.linkedTasks,[{taskId:create.taskId,workspaceId:scope.workspaceId,taskStoreId:scope.taskStoreId}]);
  assert.equal(record.turns[0]!.proposedTask!.state,'linked');
  assert.equal(record.turns[0]!.userMessage,frozenUser.userMessage);assert.deepEqual(record.turns[0]!.context,frozenUser.context);
  const retainedTask=(await tasks.load(create.taskId))!;
  assert.equal(retainedTask.acceptance,null);assert.equal(retainedTask.currentRunId,null);assert.equal(retainedTask.runs.length,0);
  assert.deepEqual(await readFile(join(tasks.root,'tasks.json')),createdTaskBytes);
});

test('bounded pages expose exact omission markers and oversize requests cannot alter history',async(t)=>{
  const f=await fixture(t);let record=await topic(f.store);
  for(let i=0;i<4;i++) {
    record=await enqueue(f.store,record,'turn-'+i);
    record=(await f.store.beginTurn({...command(record,'begin-'+i),turnId:'turn-'+i})).topic;
    record=(await f.store.finishTurn({...command(record,'finish-'+i),turnId:'turn-'+i,state:'responded',assistantMessage:'Actual fixture reply '+i,reason:null})).topic;
  }
  const selected=await f.store.readTopic(record.topicId,{offset:1,limit:2});
  assert.deepEqual(selected.turns.items.map((turn)=>turn.turnId),['turn-1','turn-2']);assert.equal(selected.turns.omittedBefore,1);assert.equal(selected.turns.omittedAfter,1);assert.equal(selected.turns.hasMore,true);
  const beyond=await f.store.readTopic(record.topicId,{offset:100,limit:2});assert.equal(beyond.turns.omittedBefore,4);assert.equal(beyond.turns.omittedAfter,0);assert.equal(beyond.turns.items.length,0);
  const before=await readFile(join(f.store.root,'conversations.json'));
  await assert.rejects(f.store.readTopic(record.topicId,{limit:CONVERSATION_LIMITS.pageSize+1}),/too large/);
  await assert.rejects(f.store.enqueueTurn({...command(record,'oversize'),turnId:'too-big',userMessage:'a'.repeat(CONVERSATION_LIMITS.userMessageBytes+1),context:context(record)}),/bound/);
  await assert.rejects(f.store.createTopic({topicId:'unsafe/identifier',title:'Unsafe',actor:'temari',idempotencyKey:'unsafe-create',expectedVersion:0}),/paths are not allowed/);
  assert.deepEqual(await readFile(join(f.store.root,'conversations.json')),before);
});

test('missing/corrupt ledger and retained lock fail visibly without initialization or takeover',async(t)=>{
  const f=await fixture(t);const record=await topic(f.store);const path=join(f.store.root,'conversations.json');
  const original=await readFile(path);await mkdir(join(f.store.root,'.conversation.lock'));
  await assert.rejects(f.store.recoverTopic({...command(record,'locked-recovery')}),/No automatic takeover/);
  assert.deepEqual(await readFile(path),original);await rm(join(f.store.root,'.conversation.lock'),{recursive:true});
  const ledger=JSON.parse(original.toString());ledger.topics[0].workspaceId='another-workspace';ledger.sha256=conversationDigest(ledger.topics);await writeFile(path,JSON.stringify(ledger));
  await assert.rejects(FileConversationStore.openExisting(f.store.root,scope),/scope conflict/);
  await writeFile(path,original);await unlink(path);
  await assert.rejects(FileConversationStore.openExisting(f.store.root,scope),/ENOENT/);
  await assert.rejects(FileConversationStore.create(f.store.root,scope),/ENOENT/);
});

test('one ledger summary snapshot retains every topic while a concurrent write changes sort order',async(t)=>{
  const f=await fixture(t);
  for(let index=0;index<51;index++)await topic(f.store,'snapshot-'+index);
  const before=await f.store.listAllTopicSummaries();const moved=before.at(-1)!,record=(await f.store.load(moved.topicId))!;
  const [observed]=await Promise.all([f.store.listAllTopicSummaries(),f.store.recoverTopic({...command(record,'move-summary')})]);
  assert.equal(observed.length,51);assert.equal(new Set(observed.map((item)=>item.topicId)).size,51);
  assert.deepEqual([...observed.map((item)=>item.topicId)].sort(),[...before.map((item)=>item.topicId)].sort());
  const version=observed.find((item)=>item.topicId===record.topicId)!.version;assert(version===record.version||version===record.version+1,'snapshot sees one complete old or new record');
  (observed[0] as {title:string}).title='Changed returned summary';assert.notEqual((await f.store.load(observed[0]!.topicId))!.title,'Changed returned summary');
});

test('latest history page selects a complete chronological suffix under the byte bound',async(t)=>{
  const f=await fixture(t);let record=await topic(f.store);
  for(let index=0;index<13;index++) {
    record=(await f.store.enqueueTurn({...command(record,'large-enqueue-'+index),turnId:'large-turn-'+index,userMessage:'u'.repeat(CONVERSATION_LIMITS.userMessageBytes),context:context(record)})).topic;
    record=(await f.store.beginTurn({...command(record,'large-begin-'+index),turnId:'large-turn-'+index})).topic;
    record=(await f.store.finishTurn({...command(record,'large-finish-'+index),turnId:'large-turn-'+index,state:'responded',assistantMessage:('Latest fixture reply '+index+' '+ 'a'.repeat(CONVERSATION_LIMITS.assistantMessageBytes)).slice(0,CONVERSATION_LIMITS.assistantMessageBytes),reason:null})).topic;
  }
  const selected=await f.store.readLatestTopic(record.topicId,{limit:20});assert(selected.turns.omittedBefore>0);assert.equal(selected.turns.omittedAfter,0);assert.equal(selected.turns.hasMore,false);
  const observedSummary=(await f.store.listAllTopicSummaries())[0]!;assert.equal(observedSummary.lastTurnState,record.turns.at(-1)!.state);assert.equal(observedSummary.actionableAttentionCount,0);
  assert.equal(selected.turns.total,13);assert.equal(selected.turns.offset,selected.turns.omittedBefore);assert.equal(selected.turns.items.length+selected.turns.omittedBefore,13);
  assert(Buffer.byteLength(JSON.stringify(selected.turns.items))<=CONVERSATION_LIMITS.pageBytes);
  assert.equal(selected.turns.items.at(-1)!.turnId,'large-turn-12');assert.match(selected.turns.items.at(-1)!.assistantMessage!,/^Latest fixture reply 12 /);
  assert.deepEqual(selected.turns.items.map((turn)=>turn.sequence),record.turns.slice(selected.turns.offset).map((turn)=>turn.sequence));
});
