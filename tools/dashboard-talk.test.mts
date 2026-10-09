import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test,{type TestContext} from 'node:test';
import { FileTaskStore,TaskRuntime,conversationDigest } from '../libs/runtime/src/index.js';
import type { ModelRequest,ModelTransport } from '../libs/host-adapters/src/index.js';
import { createDashboardTalk,loadDashboardTalkConfig,validateDashboardTalkRoots,TalkRequestError,type DashboardTalkConfig,type DashboardTalkService,type DashboardTalkTaskBridge } from './dashboard-talk.mjs';

const answer=(text='Safe retained answer')=>JSON.stringify({kind:'answer',text,proposedTask:null});
function transport(response:string|((request:ModelRequest)=>Promise<string>)) {
  const calls:ModelRequest[]=[];let disposed=0;
  const port:ModelTransport={async complete(request){calls.push(structuredClone(request));const text=typeof response==='string'?response:await response(request);return {text,coverage:'host-mediated-text',displayText(){throw new Error('Restoration must not be used for history.');},dispose(){disposed++;}};}};
  return {port,calls,get disposed(){return disposed;}};
}
async function fixture(t:TestContext,port?:ModelTransport,taskBridge?:DashboardTalkTaskBridge) {
  const root=await mkdtemp(join(tmpdir(),'temari-talk-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspaceRoot=join(root,'workspace');await mkdir(workspaceRoot);
  const config:DashboardTalkConfig={schema:1,root:join(root,'conversation'),workspaceRoot,hostId:'fixture-host',workspaceId:'fixture-workspace',taskStoreId:'fixture-tasks'};
  if(taskBridge)(taskBridge as {workspaceRoot:string}).workspaceRoot=workspaceRoot;
  const tasks=await FileTaskStore.create(join(root,'tasks')),runtime=new TaskRuntime({store:tasks});
  const create=()=>createDashboardTalk({config,taskStore:tasks,runtime,...(port?{transport:port,transportIdentity:{adapter:'fixture-only',model:'fixture-model'}}:{}),...(taskBridge?{taskBridge}:{})});
  const service=await create();return {root,config,tasks,runtime,service,create};
}
async function settle(service:DashboardTalkService,topicId:string,state:string) {
  for(let i=0;i<200;i++) {
    const topic=await service.store.load(topicId);
    if(topic?.turns.at(-1)?.state===state)return topic;
    await new Promise((resolve)=>setTimeout(resolve,5));
  }
  throw new Error('Fixture turn did not settle: '+state);
}
async function countCalls(calls:readonly unknown[],count:number) {
  for(let i=0;i<200;i++){if(calls.length===count)return;await new Promise((resolve)=>setTimeout(resolve,5));}
  throw new Error('Fixture transport did not receive expected calls.');
}
function context(request:ModelRequest):Record<string,any> {
  assert.equal(request.context?.length,1);assert.equal(request.context[0]!.kind,'json');
  return (request.context[0] as {kind:'json';value:Record<string,any>}).value;
}

test('transport omitted supports organizing without a model; strict host config and requests reject paths/unknown fields',async(t)=>{
  const f=await fixture(t);const description=await f.service.describe();assert.equal(description.capabilities.canSendTurn,false);assert.match(description.setupReason!,/transport/);
  const created=await f.service.create({requestId:'new-topic',title:'Planning topic'});assert.equal(created.topic.topicId,'topic-new-topic');
  assert.equal((await f.service.create({requestId:'new-topic',title:'Planning topic'})).topic.version,created.topic.version);
  await assert.rejects(f.service.create({requestId:'new-topic',title:'Different title'}),(error)=>error instanceof TalkRequestError&&error.status===409);
  await assert.rejects(f.service.turn(created.topic.topicId,{requestId:'no-model',expectedVersion:created.topic.version,text:'A question'}),(error)=>error instanceof TalkRequestError&&error.status===503&&error.name==='TalkRequestError');
  assert.equal((await f.service.store.load(created.topic.topicId))!.turns.length,0);
  await assert.rejects(f.service.create({requestId:'unsafe/path',title:'Unsafe'}),(error)=>error instanceof TalkRequestError&&error.status===400);
  await assert.rejects(f.service.create({requestId:'extra',title:'Unknown',path:'/private/forbidden'} as any),/Unknown/);
  const configPath=join(f.root,'config.json');await writeFile(configPath,JSON.stringify(f.config));assert.deepEqual(await loadDashboardTalkConfig(configPath),f.config);
  await writeFile(configPath,JSON.stringify({...f.config,transport:{kind:'openai-responses',model:'fixture-model',credential:'embedded-secret'}}));await assert.rejects(loadDashboardTalkConfig(configPath),/Unknown or missing/);
  for(const path of ['conversation','..talk','nested/..talk']) {
    const illegal=join(f.config.workspaceRoot,path);await assert.rejects(createDashboardTalk({config:{...f.config,root:illegal},taskStore:f.tasks,runtime:f.runtime}),/outside/);
    await assert.rejects(readFile(join(illegal,'.conversation-store.json')),{code:'ENOENT'});
  }
});

test('lost response replay retains exact context and task versions, never calls model twice and disposes safe reply',async(t)=>{
  let release!:(text:string)=>void;const model=transport(()=>new Promise((resolve)=>{release=resolve;}));const f=await fixture(t,model.port);
  const task=await f.tasks.createTask({taskId:'linked-task',actor:'fixture',idempotencyKey:'task-create',title:'Linked goal',goal:'Only this linked task',workspaceRoot:f.config.workspaceRoot});
  const created=await f.service.create({requestId:'replay-topic',title:'Replay'});
  const linked=await f.service.link(created.topic.topicId,{requestId:'link',expectedVersion:created.topic.version,taskId:task.taskId});
  const request={requestId:'lost-response',expectedVersion:linked.topic.version,text:'Original immutable message'};
  const ack=await f.service.turn(created.topic.topicId,request);assert.equal(ack.turnId,'turn-lost-response');await countCalls(model.calls,1);
  const path=join(f.config.root,'turn-context',ack.turnId+'.json'),packetBytes=await readFile(path),packet=JSON.parse(packetBytes.toString());
  const retained=(await f.service.store.load(created.topic.topicId))!.turns[0]!;
  assert.equal(retained.context.sha256,conversationDigest(packet));assert.equal(retained.context.taskVersions[0]!.version,task.version);
  await f.tasks.updateTask({taskId:task.taskId,actor:'fixture',idempotencyKey:'changed-task',expectedVersion:task.version,title:'New task title'});
  await f.service.turn(created.topic.topicId,request);assert.equal(model.calls.length,1);assert.deepEqual(await readFile(path),packetBytes);
  await assert.rejects(f.service.turn(created.topic.topicId,{...request,text:'Changed retry'}),(error)=>error instanceof TalkRequestError&&error.status===409);
  const other=await f.service.create({requestId:'other-topic',title:'Other'});await assert.rejects(f.service.turn(other.topic.topicId,{...request,expectedVersion:other.topic.version}),(error)=>error instanceof TalkRequestError&&error.status===409);
  release(answer());await settle(f.service,created.topic.topicId,'responded');
  // Atomic publication is visible before finishTurn returns and its reply cleanup runs.
  // Wait for actual cleanup, retaining a bounded failure if disposal never happens.
  for(let i=0;i<200&&model.disposed===0;i++)await new Promise((resolve)=>setTimeout(resolve,5));
  assert.equal(model.disposed,1);
  const reopened=await f.create();assert.deepEqual(await reopened.recover(),{topics:0,turns:0,proposals:0});await reopened.turn(created.topic.topicId,request);assert.equal(model.calls.length,1);
  assert.equal(model.disposed,1,'replay must not dispose the retained reply twice');
  const detail=await reopened.topic(created.topic.topicId);assert.equal(detail.turns[0]!.requestId,request.requestId);assert.equal(detail.turns[0]!.assistantMessage,'Safe retained answer');assert.equal(detail.linkedTasks[0]!.title,'New task title');
});

test('different topics launch independently and context admits only their own messages and explicit task links',async(t)=>{
  const releases:Array<(text:string)=>void>=[];const model=transport(()=>new Promise((resolve)=>releases.push(resolve)));const f=await fixture(t,model.port);
  const makeTask=(id:string,goal:string)=>f.tasks.createTask({taskId:id,actor:'fixture',idempotencyKey:'create-'+id,title:id,goal,workspaceRoot:f.config.workspaceRoot});
  await makeTask('task-alpha','Alpha linked goal');await makeTask('task-beta','Beta linked goal');await makeTask('unrelated-task','Unrelated private corpus marker');
  const a=await f.service.create({requestId:'alpha',title:'Alpha'}),b=await f.service.create({requestId:'beta',title:'Beta'});
  const linkedA=await f.service.link(a.topic.topicId,{requestId:'link-alpha',expectedVersion:a.topic.version,taskId:'task-alpha'}),linkedB=await f.service.link(b.topic.topicId,{requestId:'link-beta',expectedVersion:b.topic.version,taskId:'task-beta'});
  await Promise.all([f.service.turn(a.topic.topicId,{requestId:'alpha-turn',expectedVersion:linkedA.topic.version,text:'Alpha question'}),f.service.turn(b.topic.topicId,{requestId:'beta-turn',expectedVersion:linkedB.topic.version,text:'Beta question'})]);await countCalls(model.calls,2);
  for(const call of model.calls){const packet=context(call),serialized=JSON.stringify(packet);assert.doesNotMatch(serialized,/Unrelated private corpus/);if(packet.topicId===a.topic.topicId){assert.match(serialized,/Alpha linked/);assert.doesNotMatch(serialized,/Beta linked|Beta question/);}else{assert.match(serialized,/Beta linked/);assert.doesNotMatch(serialized,/Alpha linked|Alpha question/);}}
  releases.forEach((release)=>release(answer()));await settle(f.service,a.topic.topicId,'responded');await settle(f.service,b.topic.topicId,'responded');
});

test('restart recovers uncertainty without replay; late completion cannot overwrite it and new submission is explicit',async(t)=>{
  let release!:(value:string)=>void;const oldModel=transport(()=>new Promise((resolve)=>{release=resolve;}));const f=await fixture(t,oldModel.port);
  const created=await f.service.create({requestId:'restart',title:'Restart'});await f.service.turn(created.topic.topicId,{requestId:'interrupted',expectedVersion:created.topic.version,text:'First question'});await countCalls(oldModel.calls,1);
  const newModel=transport(answer('Explicit new reply')),next=await createDashboardTalk({config:f.config,taskStore:f.tasks,runtime:f.runtime,transport:newModel.port,transportIdentity:{adapter:'fixture-only',model:'fixture-model'}});
  assert.deepEqual(await next.recover(),{topics:1,turns:1,proposals:0});assert.equal(newModel.calls.length,0);
  release(answer('Stale late completion'));await new Promise((resolve)=>setTimeout(resolve,25));
  const recovered=(await next.store.load(created.topic.topicId))!;assert.equal(recovered.turns[0]!.state,'uncertain');assert.equal(recovered.turns[0]!.assistantMessage,null);assert.equal(oldModel.disposed,1);
  await next.turn(created.topic.topicId,{requestId:'explicit-new',expectedVersion:recovered.version,text:'New question after visible uncertainty'});await settle(next,created.topic.topicId,'responded');assert.equal(newModel.calls.length,1);assert.equal(context(newModel.calls[0]!).history.turns[0].state,'uncertain');
});

test('rejected model packet blocks safely with no task effect and no display restoration',async(t)=>{
  const model=transport(JSON.stringify({kind:'task-proposal',text:'Offer',proposedTask:{title:'Title',goal:'Goal',command:'forbidden'}}));const f=await fixture(t,model.port);
  const before=await readFile(join(f.tasks.root,'tasks.json')),created=await f.service.create({requestId:'invalid',title:'Invalid output'});
  await f.service.turn(created.topic.topicId,{requestId:'invalid-output',expectedVersion:created.topic.version,text:'A proposal question'});const retained=await settle(f.service,created.topic.topicId,'blocked');
  assert.equal(retained.turns[0]!.proposedTask,null);assert.equal(retained.turns[0]!.assistantMessage,null);assert.equal(model.disposed,1);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),before);
});

test('proposal create ACK loss becomes uncertain and explicit retry links exactly one OPEN task using unchanged creation body',async(t)=>{
  const model=transport(JSON.stringify({kind:'task-proposal',text:'Explicitly accept this goal.',proposedTask:{title:'Proposed task',goal:'Retain a goal without running it'}}));const f=await fixture(t,model.port);
  const created=await f.service.create({requestId:'proposal',title:'Proposal'});await f.service.turn(created.topic.topicId,{requestId:'offered',expectedVersion:created.topic.version,text:'Please propose a goal'});let topic=await settle(f.service,created.topic.topicId,'responded');
  const original=f.tasks.createTask.bind(f.tasks);let lose=true;
  f.tasks.createTask=async(request)=>{const task=await original(request);if(lose){lose=false;throw new Error('Fixture lost creation acknowledgment');}return task;};
  await assert.rejects(f.service.accept(topic.topicId,'turn-offered',{requestId:'first-accept',expectedVersion:topic.version}),/Fixture lost/);
  topic=(await f.service.store.load(topic.topicId))!;assert.equal(topic.turns[0]!.proposedTask!.state,'uncertain');assert.equal(topic.linkedTasks.length,0);
  const taskBytes=await readFile(join(f.tasks.root,'tasks.json'));assert.equal((await f.tasks.list()).length,1);
  const accepted=await f.service.accept(topic.topicId,'turn-offered',{requestId:'explicit-retry',expectedVersion:topic.version});
  assert.equal(accepted.turns[0]!.proposedTask!.state,'linked');assert.equal(accepted.linkedTasks[0]!.status,'OPEN');assert.equal(accepted.linkedTasks[0]!.semanticAcceptance,false);assert.equal(accepted.linkedTasks[0]!.currentRunId,null);
  assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);assert.equal((await f.tasks.list())[0]!.acceptance,null);assert.equal((await f.tasks.list())[0]!.runs.length,0);
  await f.service.accept(topic.topicId,'turn-offered',{requestId:'explicit-retry',expectedVersion:topic.version});assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
});

test('accepted proposal uses one host bridge identity and starts its configured planner exactly once across uncertain retry',async(t)=>{
  const model=transport(JSON.stringify({kind:'task-proposal',text:'Explicit proposal.',proposedTask:{title:'Planned task',goal:'Plan this bounded change'}}));
  let f:Awaited<ReturnType<typeof fixture>>;let calls=0,starts=0,lose=true;
  const seen=new Set<string>();
  const bridge:DashboardTalkTaskBridge={workspaceRoot:'pending',async intake(input){calls++;const taskId='task-'+input.requestId;
    await f.tasks.createTask({taskId,actor:'fixture-controller',idempotencyKey:'intake-'+input.requestId,title:input.title,goal:input.goal,workspaceRoot:f.config.workspaceRoot});
    if(!seen.has(input.requestId)){seen.add(input.requestId);starts++;}
    if(lose){lose=false;throw new Error('Fixture lost planning intake acknowledgment');}
    return {taskId};},async project(){return null;}};
  f=await fixture(t,model.port,bridge);
  const created=await f.service.create({requestId:'planned-proposal',title:'Planned proposal'});
  await f.service.turn(created.topic.topicId,{requestId:'planned-offer',expectedVersion:created.topic.version,text:'Offer the goal'});
  let topic=await settle(f.service,created.topic.topicId,'responded');
  await assert.rejects(f.service.accept(topic.topicId,'turn-planned-offer',{requestId:'accept-once',expectedVersion:topic.version}),/lost planning/);
  topic=(await f.service.store.load(topic.topicId))!;
  const accepted=await f.service.accept(topic.topicId,'turn-planned-offer',{requestId:'accept-retry',expectedVersion:topic.version});
  assert.equal(calls,2);assert.equal(starts,1);assert.equal((await f.tasks.list()).length,1);
  assert.equal(accepted.linkedTasks[0]!.taskId,'task-talk-proposal-planned-offer');
  assert.equal((await f.service.describe()).capabilities.canStartTask,true);
});

test('linked cards expose at most one host-admitted task action while controller absence remains save-only',async(t)=>{
  let f:Awaited<ReturnType<typeof fixture>>;
  const bridge:DashboardTalkTaskBridge={workspaceRoot:'pending',async intake(){throw new Error('unused');},async project(){return {phase:'planning',state:'READY',message:'Validated plan is ready.',action:{action:'prepare-plan',label:'Prepare implementation plan',proposalSha256:'a'.repeat(64)}};}};
  f=await fixture(t,undefined,bridge);
  const task=await f.tasks.createTask({taskId:'action-task',actor:'fixture',idempotencyKey:'action-task',title:'Action task',goal:'A bounded goal',workspaceRoot:f.config.workspaceRoot});
  const created=await f.service.create({requestId:'action-topic',title:'Action topic'});
  const detail=await f.service.link(created.topic.topicId,{requestId:'action-link',expectedVersion:created.topic.version,taskId:task.taskId});
  assert.deepEqual(detail.linkedTasks[0]!.controller,{phase:'planning',state:'READY',message:'Validated plan is ready.',action:{action:'prepare-plan',label:'Prepare implementation plan',proposalSha256:'a'.repeat(64)}});
  const noController=await fixture(t);assert.equal((await noController.service.describe()).capabilities.canStartTask,false);
});

test('linked task status and attention are current runtime facts, acknowledgment is separate and wrong workspace refuses',async(t)=>{
  const f=await fixture(t);const task=await f.tasks.createTask({taskId:'status-task',actor:'fixture',idempotencyKey:'status-create',title:'Status task',goal:'Runtime observation',workspaceRoot:f.config.workspaceRoot});
  const other=join(f.root,'other-workspace');await mkdir(other);await f.tasks.createTask({taskId:'wrong-workspace',actor:'fixture',idempotencyKey:'wrong-create',title:'Other workspace task',goal:'Do not link',workspaceRoot:other});
  const created=await f.service.create({requestId:'status',title:'Status'});await assert.rejects(f.service.link(created.topic.topicId,{requestId:'wrong-link',expectedVersion:created.topic.version,taskId:'wrong-workspace'}),(error)=>error instanceof TalkRequestError&&error.status===409);
  let detail=await f.service.link(created.topic.topicId,{requestId:'status-link',expectedVersion:created.topic.version,taskId:task.taskId});assert.equal(detail.linkedTasks[0]!.status,'OPEN');
  await f.tasks.updateTask({taskId:task.taskId,actor:'fixture',idempotencyKey:'block',expectedVersion:task.version,blocker:'Evidence review remains required'});
  detail=await f.service.topic(created.topic.topicId);assert.equal(detail.linkedTasks[0]!.status,'BLOCKED');assert.equal(detail.linkedTasks[0]!.semanticAcceptance,false);
  const repeated=await f.service.topic(created.topic.topicId);assert.equal(repeated.topic.version,detail.topic.version,'identical poll does not add a command');
  const attention=detail.attention.find((item)=>item.kind==='blocked')!,bytes=await readFile(join(f.tasks.root,'tasks.json'));
  const ack=await f.service.ack(created.topic.topicId,attention.attentionId,{requestId:'seen',expectedVersion:detail.topic.version});assert.equal(ack.topicId,created.topic.topicId);assert.equal(ack.attentionId,attention.attentionId);
  assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),bytes);assert.equal((await f.tasks.load(task.taskId))!.acceptance,null);
  const summary=await f.service.describe();assert.equal(summary.topics[0]!.attentionCount,0);
});

test('ledger corruption remains internal instead of a409 request conflict',async(t)=>{
  const f=await fixture(t);const created=await f.service.create({requestId:'corruption',title:'Corruption'});
  const path=join(f.config.root,'conversations.json'),ledger=JSON.parse((await readFile(path)).toString());ledger.sha256='0'.repeat(64);await writeFile(path,JSON.stringify(ledger));
  await assert.rejects(f.service.create({requestId:'new-after-corruption',title:'Do not conceal'}),(error)=>error instanceof assert.AssertionError&&!(error instanceof TalkRequestError));
  await assert.rejects(f.service.ack(created.topic.topicId,'attention-missing',{requestId:'ack-corrupt',expectedVersion:created.topic.version}),(error)=>error instanceof assert.AssertionError&&!(error instanceof TalkRequestError));
});

test('verified workspace aliases link without rewriting tasks; missing aliases become unknown and refuse new links',async(t)=>{
  const f=await fixture(t),alias=join(f.root,'workspace-alias');await symlink(f.config.workspaceRoot,alias,'dir');
  const task=await f.tasks.createTask({taskId:'alias-task',actor:'fixture',idempotencyKey:'alias-task-create',title:'Alias workspace',goal:'Keep lexical TaskStore bytes intact',workspaceRoot:alias});
  assert.equal(task.workspaceRoot,alias);const taskBytes=await readFile(join(f.tasks.root,'tasks.json'));
  const created=await f.service.create({requestId:'alias-topic',title:'Alias'});
  const linked=await f.service.link(created.topic.topicId,{requestId:'alias-link',expectedVersion:created.topic.version,taskId:task.taskId});
  assert.equal(linked.linkedTasks[0]!.available,true);assert.equal(linked.linkedTasks[0]!.status,'OPEN');assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
  await unlink(alias);
  const unavailable=await f.service.topic(created.topic.topicId);assert.equal(unavailable.linkedTasks[0]!.available,false);assert.equal(unavailable.linkedTasks[0]!.status,'UNKNOWN');assert.equal(unavailable.linkedTasks[0]!.semanticAcceptance,false);
  const other=await f.service.create({requestId:'missing-alias-topic',title:'Missing'});
  await assert.rejects(f.service.link(other.topic.topicId,{requestId:'missing-alias-link',expectedVersion:other.topic.version,taskId:task.taskId}),(error)=>error instanceof TalkRequestError&&error.status===409);
  assert.equal((await f.service.store.load(other.topic.topicId))!.linkedTasks.length,0);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
});

test('durable host selection refuses an alternate same-ID task store before adoption or effects',async(t)=>{
  const model=transport(answer()),f=await fixture(t,model.port);
  const original=await f.tasks.createTask({taskId:'same-task-id',actor:'fixture',idempotencyKey:'original-create',title:'Original task',goal:'Original work',workspaceRoot:f.config.workspaceRoot});
  const created=await f.service.create({requestId:'selection-topic',title:'Selection'});await f.service.link(created.topic.topicId,{requestId:'selection-link',expectedVersion:created.topic.version,taskId:original.taskId});
  const alternate=await FileTaskStore.create(join(f.root,'alternate-tasks'));await alternate.createTask({taskId:original.taskId,actor:'fixture',idempotencyKey:'alternate-create',title:'Unrelated alternate task',goal:'Must not enter original conversation',workspaceRoot:f.config.workspaceRoot});
  const conversationPath=join(f.config.root,'conversations.json'),markerPath=join(f.config.root,'.talk-host-selection.json');
  const before=await Promise.all([readFile(conversationPath),readFile(markerPath),readFile(join(f.tasks.root,'tasks.json')),readFile(join(alternate.root,'tasks.json'))]);
  const marker=JSON.parse(before[1]!.toString());assert.equal(marker.taskStoreRoot,f.tasks.root);assert.equal(marker.scope.taskStoreId,f.config.taskStoreId);assert(!Object.hasOwn(marker,'transport'));assert(!Object.hasOwn(marker,'model'));assert(!Object.hasOwn(marker,'credentialEnv'));
  await f.create();
  await assert.rejects(createDashboardTalk({config:f.config,taskStore:alternate,runtime:new TaskRuntime({store:alternate}),transport:model.port}),(error)=>error instanceof TalkRequestError&&error.status===409);
  const different=join(f.root,'different-workspace');await mkdir(different);
  await assert.rejects(createDashboardTalk({config:{...f.config,workspaceRoot:different},taskStore:f.tasks,runtime:f.runtime,transport:model.port}),(error)=>error instanceof TalkRequestError&&error.status===409);
  await assert.rejects(createDashboardTalk({config:{...f.config,taskStoreId:'changed-opaque-id'},taskStore:f.tasks,runtime:f.runtime,transport:model.port}),(error)=>error instanceof TalkRequestError&&error.status===409);
  assert.deepEqual(await Promise.all([readFile(conversationPath),readFile(markerPath),readFile(join(f.tasks.root,'tasks.json')),readFile(join(alternate.root,'tasks.json'))]),before);assert.equal(model.calls.length,0);
  const invalidTaskRoot=join(f.config.workspaceRoot,'..tasks');await assert.rejects(validateDashboardTalkRoots(f.config,invalidTaskRoot),/outside/);await assert.rejects(readFile(join(invalidTaskRoot,'tasks.json')),{code:'ENOENT'});
});

test('missing or corrupt host selection on retained conversations stays internal and cannot silently adopt',async(t)=>{
  const model=transport(answer()),f=await fixture(t,model.port);await f.service.create({requestId:'retained-marker',title:'Retained history'});
  const markerPath=join(f.config.root,'.talk-host-selection.json'),conversationPath=join(f.config.root,'conversations.json');
  const markerBytes=await readFile(markerPath),conversationBytes=await readFile(conversationPath),taskBytes=await readFile(join(f.tasks.root,'tasks.json'));
  await unlink(markerPath);
  await assert.rejects(f.create(),(error)=>error instanceof assert.AssertionError&&!(error instanceof TalkRequestError)&&/marker is missing/.test(error.message));
  assert.deepEqual(await readFile(conversationPath),conversationBytes);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
  const corrupt=JSON.parse(markerBytes.toString());corrupt.sha256='0'.repeat(64);await writeFile(markerPath,JSON.stringify(corrupt));
  await assert.rejects(f.create(),(error)=>error instanceof assert.AssertionError&&!(error instanceof TalkRequestError)&&/digest mismatch/.test(error.message));
  assert.equal(model.calls.length,0);assert.deepEqual(await readFile(conversationPath),conversationBytes);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
});

test('topic detail retains one version of links and attention despite a deterministic mutation after page capture',async(t)=>{
  const f=await fixture(t);
  for(const taskId of ['original-link','later-link'])await f.tasks.createTask({taskId,actor:'fixture',idempotencyKey:'create-'+taskId,title:taskId,goal:'Isolated topic detail observation',workspaceRoot:f.config.workspaceRoot});
  const created=await f.service.create({requestId:'atomic-detail',title:'Atomic detail'});
  await f.service.link(created.topic.topicId,{requestId:'original-link-request',expectedVersion:created.topic.version,taskId:'original-link'});
  const originalRead=f.service.store.readTopic.bind(f.service.store);let captured:Awaited<ReturnType<typeof originalRead>>|undefined;
  f.service.store.readTopic=async(id,options)=>{
    const selected=await originalRead(id,options);captured=selected;
    let topic=(await f.service.store.linkTask({topicId:id,actor:'fixture',idempotencyKey:'interleaved-link',expectedVersion:selected.topic.version,task:{taskId:'later-link',workspaceId:f.config.workspaceId,taskStoreId:f.config.taskStoreId}})).topic;
    topic=(await f.service.store.observeAttention({topicId:id,actor:'fixture',idempotencyKey:'interleaved-attention',expectedVersion:topic.version,attentionId:'later-attention',taskId:'later-link',taskVersion:1,runId:null,kind:'update',summary:'Later retained task link',observationSha256:conversationDigest({task:'later-link',version:1,status:'OPEN'})})).topic;
    return selected;
  };
  const detail=await f.service.topic(created.topic.topicId),current=(await f.service.store.load(created.topic.topicId))!;
  assert(captured);assert(current.version>detail.topic.version);assert.equal(detail.topic.version,captured.topic.version);
  assert.deepEqual(detail.linkedTasks.map((task)=>task.taskId),captured.linkedTasks.map((task)=>task.taskId));assert.deepEqual(detail.linkedTasks.map((task)=>task.taskId),['original-link']);
  assert.deepEqual(detail.attention,captured.attention);assert(!detail.attention.some((item)=>item.attentionId==='later-attention'));assert.equal(detail.topic.linkedTaskCount,detail.linkedTasks.length);assert.equal(detail.topic.unreadAttentionCount,detail.attention.filter((item)=>item.acknowledgedAt===null).length);
});

test('raw dot and parent storage segments refuse before symlink traversal or store writes',async(t)=>{
  const f=await fixture(t),target=join(f.config.workspaceRoot,'nested');await mkdir(target);
  const alias=join(f.root,'source-parent-alias');await symlink(target,alias,'dir');
  const rawTask=alias+'/../new-task-data',rawConversation=alias+'/../new-talk-data';
  await assert.rejects(validateDashboardTalkRoots(f.config,rawTask),(error)=>error instanceof TalkRequestError&&error.status===400&&/segments/.test(error.message));
  await assert.rejects(createDashboardTalk({config:{...f.config,root:rawConversation},taskStore:f.tasks,runtime:f.runtime}),(error)=>error instanceof TalkRequestError&&error.status===400&&/segments/.test(error.message));
  await assert.rejects(validateDashboardTalkRoots(f.config,f.root+'/./dot-task-data'),/segments/);
  for(const root of [join(f.root,'new-task-data'),join(f.config.workspaceRoot,'new-task-data'),join(f.root,'new-talk-data'),join(f.config.workspaceRoot,'new-talk-data'),join(f.root,'dot-task-data')])await assert.rejects(readFile(join(root,'tasks.json')),{code:'ENOENT'});
  for(const root of [join(f.root,'new-talk-data'),join(f.config.workspaceRoot,'new-talk-data')])await assert.rejects(readFile(join(root,'.conversation-store.json')),{code:'ENOENT'});
  const accepted=await validateDashboardTalkRoots({...f.config,root:join(f.root,'..talk')},f.tasks.root);assert.equal(accepted.conversationRoot,join(f.service.store.root,'..','..talk'));
});

test('topic inventory crosses the store page boundary without hiding older conversations',async(t)=>{
  const f=await fixture(t);
  for(let i=0;i<51;i++)await f.service.create({requestId:'inventory-'+i,title:'Conversation '+i});
  f.service.store.listTopics=async()=>{throw new Error('A moving pagination cursor must not be used for full inventory.');};
  f.service.store.load=async()=>{throw new Error('An empty-topic inventory must not read each topic history.');};
  const list=await f.service.describe();assert.equal(list.topics.length,51);assert.equal(list.page.total,51);assert.equal(list.page.omittedAfter,0);assert.equal(list.page.hasMore,false);
  assert(list.topics.some((topic)=>topic.topicId==='topic-inventory-0'));assert.equal(new Set(list.topics.map((topic)=>topic.topicId)).size,51);
});

test('frozen context retains the latest bounded history with exact omissions under the byte budget',async(t)=>{
  const model=transport(answer()),f=await fixture(t,model.port);let topic=(await f.service.create({requestId:'history',title:'History'})).topic;
  for(let i=0;i<21;i++) {
    const context={topicId:topic.topicId,topicVersion:topic.version,revision:'fixture-'+i,sha256:conversationDigest({fixture:i}),taskVersions:[]};
    topic=(await f.service.store.enqueueTurn({topicId:topic.topicId,actor:'fixture',idempotencyKey:'old-enqueue-'+i,expectedVersion:topic.version,turnId:'turn-old-'+i,userMessage:'u'.repeat(8192),context})).topic;
    topic=(await f.service.store.beginTurn({topicId:topic.topicId,actor:'fixture',idempotencyKey:'old-begin-'+i,expectedVersion:topic.version,turnId:'turn-old-'+i})).topic;
    topic=(await f.service.store.finishTurn({topicId:topic.topicId,actor:'fixture',idempotencyKey:'old-finish-'+i,expectedVersion:topic.version,turnId:'turn-old-'+i,state:'responded',assistantMessage:('Fixture reply '+i+' '+'a'.repeat(16384)).slice(0,16384),reason:null})).topic;
  }
  await f.service.turn(topic.topicId,{requestId:'bounded-history',expectedVersion:topic.version,text:'Use the latest history'});await settle(f.service,topic.topicId,'responded');
  const packet=context(model.calls[0]!);assert(Buffer.byteLength(JSON.stringify(packet))<=256*1024);assert(packet.history.page.omittedBefore>1);assert.equal(packet.history.page.omittedAfter,0);assert.equal(packet.history.page.total,21);assert.equal(packet.history.page.offset,packet.history.page.omittedBefore);assert.equal(packet.history.turns.at(-1).turnId,'turn-old-20');assert.match(packet.history.turns.at(-1).assistantMessage,/^Fixture reply 20 /);assert.equal(packet.history.turns.length+packet.history.page.omittedBefore,21);
});
