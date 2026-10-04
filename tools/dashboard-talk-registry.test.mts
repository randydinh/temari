import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test,{type TestContext} from 'node:test';
import { FileConversationStore, FileTaskStore, TaskRuntime, conversationDigest } from '../libs/runtime/src/index.js';
import type { ModelRequest, ModelTransport } from '../libs/host-adapters/src/index.js';
import { createDashboardTalk, TalkRequestError } from './dashboard-talk.mjs';
import { createDashboardTalkRegistry, loadDashboardTalkConfiguration, validateDashboardTalkRegistryRoots, type DashboardTalkRegistryConfig, type DashboardTalkRegistryService, type DashboardTalkWorkspaceSelection } from './dashboard-talk-registry.mjs';

function transport(response:string|((request:ModelRequest)=>Promise<string>)) {
  const calls:ModelRequest[]=[];let disposed=0;
  const port:ModelTransport={async complete(request){calls.push(structuredClone(request));const text=typeof response==='string'?response:await response(request);return {text,coverage:'host-mediated-text',displayText(){throw new Error('No display restoration allowed.');},dispose(){disposed++;}};}};
  return {port,calls,get disposed(){return disposed;}};
}
async function waitFor<T>(observe:()=>Promise<T>|T,ready:(value:T)=>boolean) {
  for(let i=0;i<250;i++){const value=await observe();if(ready(value))return value;await new Promise((resolve)=>setTimeout(resolve,5));}
  throw new Error('Bounded fictional observation did not settle.');
}
async function fixture(t:TestContext,port?:ModelTransport,count=3) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'temari-talk-registry-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspaces:DashboardTalkWorkspaceSelection[]=[];for(let i=0;i<count;i++){const workspaceRoot=join(root,'source-'+i);await mkdir(workspaceRoot);workspaces.push({key:'w'+i,workspaceId:'workspace-'+i,label:'Workspace '+i,workspaceRoot});}
  const config:DashboardTalkRegistryConfig={schema:2,root:join(root,'registry'),registryId:'fictional-registry',hostId:'fictional-host',taskStoreId:'fictional-tasks',workspaces};
  const tasks=await FileTaskStore.create(join(root,'tasks')),runtime=new TaskRuntime({store:tasks});
  const options={config,taskStore:tasks,runtime,...(port?{transport:port,transportIdentity:{adapter:'fixture-only',model:'fixture-model'}}:{})};
  const create=()=>createDashboardTalkRegistry(options),service=await create();
  const child=async(key:string)=>FileConversationStore.openExisting(join(config.root,'workspaces',key),{hostId:config.hostId,workspaceId:workspaces.find((w)=>w.key===key)!.workspaceId,taskStoreId:config.taskStoreId});
  return {root,config,tasks,runtime,options,service,create,child};
}
async function topicAt(service:DashboardTalkRegistryService,id:string,state:string) {
  return waitFor(()=>service.topic(id),(view)=>view.turns.at(-1)?.state===state);
}
const proposal=JSON.stringify({kind:'task-proposal',text:'Offer one goal for explicit acceptance.',proposedTask:{title:'Fictional offered goal',goal:'Keep a workspace-bound OPEN goal without starting work.'}});

test('one Talk inventory keeps three topic/task scopes exact and acknowledgment does not accept tasks',async(t)=>{
  const f=await fixture(t),bytesBefore=await readFile(join(f.tasks.root,'tasks.json'));
  const empty=await f.service.describe();assert.equal(empty.capabilities.canSendTurn,false);assert.match(empty.setupReason!,/transport/);assert.equal(empty.workspaces.length,3);
  const topics=[];
  for(const workspace of f.config.workspaces) {
    const task=await f.tasks.createTask({taskId:'parent-'+workspace.key,actor:'fixture',idempotencyKey:'create-parent-'+workspace.key,title:workspace.label+' parent',goal:'Retain existing parent goal',workspaceRoot:workspace.workspaceRoot});
    const created=await f.service.create({requestId:'same-create',title:'Topic '+workspace.key,workspaceKey:workspace.key});
    assert.equal(created.topic.topicId,'mw.'+workspace.key+'.topic-same-create');assert.equal(created.topic.binding.workspaceId,workspace.workspaceId);
    const linked=await f.service.link(created.topic.topicId,{requestId:'same-link',expectedVersion:created.topic.version as number,taskId:task.taskId});
    assert.equal(linked.topic.workspaceId,workspace.workspaceId);assert.equal(linked.linkedTasks[0]!.binding.workspaceId,workspace.workspaceId);assert.equal(linked.linkedTasks[0]!.status,'OPEN');assert.equal(linked.linkedTasks[0]!.semanticAcceptance,false);
    const local=(await (await f.child(workspace.key)).load('topic-same-create'))!;assert.deepEqual(local.linkedTasks,[{taskId:task.taskId,workspaceId:workspace.workspaceId,taskStoreId:f.config.taskStoreId}]);topics.push(linked);
  }
  const taskBytes=await readFile(join(f.tasks.root,'tasks.json'));assert.notDeepEqual(taskBytes,bytesBefore);
  await assert.rejects(f.service.link(topics[0]!.topic.topicId,{requestId:'foreign',expectedVersion:topics[0]!.topic.version as number,taskId:'parent-w1'}),(e)=>e instanceof TalkRequestError&&e.status===409);
  await assert.rejects(f.service.create({requestId:'browser-root',title:'Refuse',workspaceKey:'w0',workspaceRoot:f.root} as any),/Unknown/);
  const all=await f.service.describe();assert.equal(all.topics.length,3);assert.equal(all.page.total,3);assert.equal(all.attentionPage.total,3);assert.equal(all.observationWindow.atomicAcrossStores,false);
  assert.equal(new Set(all.topics.map((v)=>v.topicId)).size,3);assert.doesNotMatch(JSON.stringify(all),new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const selected=await f.service.topic(topics[0]!.topic.topicId),attention=selected.attention[0]!;
  await assert.rejects(f.service.ack(selected.topic.topicId,topics[1]!.attention[0]!.attentionId,{requestId:'wrong-child',expectedVersion:selected.topic.version as number}),(e)=>e instanceof TalkRequestError&&e.status===409);
  await f.service.ack(selected.topic.topicId,attention.attentionId,{requestId:'seen',expectedVersion:selected.topic.version as number});
  assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);assert((await f.tasks.list()).every((task)=>task.acceptance===null&&task.runs.length===0));
  const restarted=await f.create();assert.equal((await restarted.describe()).topics.length,3);assert.deepEqual(await restarted.recover(),{topics:0,turns:0,proposals:0});
});

test('same request/proposal IDs in different children create distinct OPEN goals and a lost create ACK retries exact retained identity',async(t)=>{
  const model=transport(proposal),f=await fixture(t,model.port,2);
  const a=await f.service.create({requestId:'proposal-topic',title:'A',workspaceKey:'w0'}),b=await f.service.create({requestId:'proposal-topic',title:'B',workspaceKey:'w1'});
  const request=(version:number)=>({requestId:'same-turn',expectedVersion:version,text:'Offer a goal in this topic.'});
  const [ackA,ackB]=await Promise.all([f.service.turn(a.topic.topicId,request(a.topic.version as number)),f.service.turn(b.topic.topicId,request(b.topic.version as number))]);
  const [offeredA,offeredB]=await Promise.all([topicAt(f.service,a.topic.topicId,'responded'),topicAt(f.service,b.topic.topicId,'responded')]);
  assert.equal(model.calls.length,2);assert.equal(offeredA.turns[0]!.requestId,'same-turn');assert.equal(offeredA.turns[0]!.retainedContext.topicId,'topic-proposal-topic');assert.equal(offeredA.turns[0]!.topicId,a.topic.topicId);assert.notEqual(offeredA.turns[0]!.proposedTask!.proposalId,offeredB.turns[0]!.proposedTask!.proposalId);
  const packets=model.calls.map((call)=>(call.context![0] as {value:any}).value);assert.deepEqual(new Set(packets.map((packet)=>packet.host.workspaceId)),new Set(['workspace-0','workspace-1']));for(const packet of packets){assert.equal(packet.history.turns.length,0);assert.equal(packet.linkedTasks.length,0);assert.equal(packet.topicId,'topic-proposal-topic');}
  await assert.rejects(f.service.accept(a.topic.topicId,ackB.turnId,{requestId:'wrong-turn',expectedVersion:offeredA.topic.version as number}),(e)=>e instanceof TalkRequestError&&e.status===409);
  const original=f.tasks.createTask.bind(f.tasks);let lose=true;
  f.tasks.createTask=async(input)=>{const actual=await original(input);if(lose){lose=false;throw new Error('Fixture lost task creation ACK');}return actual;};
  await assert.rejects(f.service.accept(a.topic.topicId,ackA.turnId,{requestId:'first',expectedVersion:offeredA.topic.version as number}),/lost task creation ACK/);
  const uncertain=await f.service.topic(a.topic.topicId),retainedTaskId=uncertain.turns[0]!.proposedTask!.taskId!;assert.equal(uncertain.turns[0]!.proposedTask!.state,'uncertain');assert.match(retainedTaskId,/^task-talk-[a-f0-9]{64}$/);
  const bytes=await readFile(join(f.tasks.root,'tasks.json')),restarted=await f.create();await restarted.recover();
  const acceptedA=await restarted.accept(a.topic.topicId,ackA.turnId,{requestId:'explicit-retry',expectedVersion:uncertain.topic.version as number});assert.equal(acceptedA.turns[0]!.proposedTask!.taskId,retainedTaskId);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),bytes);
  const acceptedB=await restarted.accept(b.topic.topicId,ackB.turnId,{requestId:'first',expectedVersion:offeredB.topic.version as number});assert.notEqual(acceptedB.turns[0]!.proposedTask!.taskId,retainedTaskId);
  const tasks=await f.tasks.list();assert.equal(tasks.length,2);assert.deepEqual(new Set(tasks.map((task)=>task.workspaceRoot)),new Set(f.config.workspaces.map((w)=>w.workspaceRoot)));assert(tasks.every((task)=>task.acceptance===null&&task.currentRunId===null&&task.runs.length===0));
  await restarted.turn(a.topic.topicId,request(a.topic.version as number));assert.equal(model.calls.length,2,'lost response/restart never launches the same model turn twice');
});

test('full-roster read-only validation refuses storage under any source, aliases, duplicates, and malformed transport before initialization',async(t)=>{
  const f=await fixture(t);const good={...f.config,root:join(f.root,'not-created')};
  for(const config of [
    {...good,root:join(f.config.workspaces[1]!.workspaceRoot,'talk')},
    {...good,workspaces:[f.config.workspaces[0]!,{...f.config.workspaces[1]!,workspaceRoot:f.config.workspaces[0]!.workspaceRoot}]},
    {...good,workspaces:[...f.config.workspaces,{...f.config.workspaces[0]!,key:'w0'}]},
    {...good,transport:{kind:'openai-responses',model:'fixture-model',credential:'never-serialized'}},
  ])await assert.rejects(validateDashboardTalkRegistryRoots(config as any,f.tasks.root));
  await assert.rejects(validateDashboardTalkRegistryRoots(good,join(f.config.workspaces[2]!.workspaceRoot,'tasks')),/outside|disjoint/);
  await assert.rejects(validateDashboardTalkRegistryRoots({...good,root:f.root+'/./ambiguous'},f.tasks.root),/segments/);
  const storageAlias=join(f.root,'storage-alias');await symlink(f.config.root,storageAlias,'dir');await assert.rejects(validateDashboardTalkRegistryRoots({...good,root:storageAlias},f.tasks.root),/symlinks/);
  assert(!((await readdir(f.root)).includes('not-created')));assert(!((await readdir(f.config.workspaces[1]!.workspaceRoot)).includes('talk')));
  const path=join(f.root,'config.json');await writeFile(path,JSON.stringify(good));assert.deepEqual(await loadDashboardTalkConfiguration(path),good);
  await writeFile(path,JSON.stringify({...good,paths:[]}));await assert.rejects(loadDashboardTalkConfiguration(path),/Unknown/);
});

test('immutable roster refuses retargeting, same-path directory replacement, missing child pins and legacy nonempty adoption without rewriting bytes',async(t)=>{
  const f=await fixture(t);await f.service.create({requestId:'retained',title:'Keep this topic',workspaceKey:'w0'});
  const markerPath=join(f.config.root,'.talk-registry-selection.json'),markerBytes=await readFile(markerPath),taskBytes=await readFile(join(f.tasks.root,'tasks.json')),childPath=join(f.config.root,'workspaces','w0'),ledgerBytes=await readFile(join(childPath,'conversations.json'));
  const replacement=join(f.root,'replacement');await mkdir(replacement);
  await assert.rejects(createDashboardTalkRegistry({...f.options,config:{...f.config,workspaces:f.config.workspaces.map((w)=>w.key==='w0'?{...w,workspaceRoot:replacement}:w)}}),(e)=>e instanceof TalkRequestError&&e.status===409);
  const oldSource=f.config.workspaces[0]!.workspaceRoot;await rename(oldSource,oldSource+'-retained');await mkdir(oldSource);
  const unavailable=await f.service.topic('mw.w0.topic-retained');assert.equal(unavailable.topic.binding.available,false);assert.equal(unavailable.capabilities.canCreateTopic,false);assert.equal(unavailable.capabilities.canSendTurn,false);
  await assert.rejects(f.service.create({requestId:'new',title:'Refuse new',workspaceKey:'w0'}),(e)=>e instanceof TalkRequestError&&e.status===409);
  await assert.rejects(f.create(),(e)=>e instanceof TalkRequestError&&e.status===409);await rm(oldSource,{recursive:true});await rename(oldSource+'-retained',oldSource);
  const childMarker=join(childPath,'.talk-host-selection.json'),retainedChild=await readFile(childMarker);await unlink(childMarker);await assert.rejects(f.create(),{code:'ENOENT'});await assert.rejects(readFile(childMarker),{code:'ENOENT'});await writeFile(childMarker,retainedChild);
  const oldRegistry=f.config.root+'-retained';await rename(f.config.root,oldRegistry);await mkdir(f.config.root);await writeFile(join(f.config.root,'.talk-registry-selection.json'),markerBytes);
  await assert.rejects(f.service.describe(),(e)=>e instanceof TalkRequestError&&e.status===409);await rm(f.config.root,{recursive:true});await rename(oldRegistry,f.config.root);
  assert.deepEqual(await readFile(markerPath),markerBytes);assert.deepEqual(await readFile(join(childPath,'conversations.json')),ledgerBytes);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
  const legacyRoot=join(f.root,'legacy-talk');await createDashboardTalk({config:{schema:1,root:legacyRoot,workspaceRoot:oldSource,hostId:f.config.hostId,workspaceId:'workspace-0',taskStoreId:f.config.taskStoreId},taskStore:f.tasks,runtime:f.runtime});const legacyEntries=await readdir(legacyRoot);
  await assert.rejects(createDashboardTalkRegistry({...f.options,config:{...f.config,root:legacyRoot}}),(e)=>e instanceof TalkRequestError&&e.status===409&&/nonempty/.test(e.message));assert.deepEqual(await readdir(legacyRoot),legacyEntries);
  const corrupt=JSON.parse(markerBytes.toString());corrupt.sha256='0'.repeat(64);await writeFile(markerPath,JSON.stringify(corrupt));await assert.rejects(f.create(),(e)=>e instanceof assert.AssertionError&&/digest/.test(e.message));
});

test('workspace selection drift during a fake pending reply refuses durable success and recovery never replays it',async(t)=>{
  let release!:(value:string)=>void;const model=transport(()=>new Promise((resolve)=>{release=resolve;})),f=await fixture(t,model.port,1);
  const created=await f.service.create({requestId:'drift',title:'Pending topic',workspaceKey:'w0'}),ack=await f.service.turn(created.topic.topicId,{requestId:'pending',expectedVersion:created.topic.version as number,text:'Offer a goal.'});await waitFor(()=>model.calls.length,(v)=>v===1);
  const store=await f.child('w0'),packetPath=join(f.config.root,'workspaces','w0','turn-context','turn-pending.json'),packetBytes=await readFile(packetPath),taskBytes=await readFile(join(f.tasks.root,'tasks.json'));
  const path=f.config.workspaces[0]!.workspaceRoot;await rename(path,path+'-retained');await mkdir(path);release(proposal);await waitFor(()=>model.disposed,(v)=>v===1);
  const retained=(await store.load('topic-drift'))!;assert.equal(retained.turns[0]!.state,'running');assert.equal(retained.turns[0]!.assistantMessage,null);assert.equal(retained.turns[0]!.proposedTask,null);assert.deepEqual(await readFile(packetPath),packetBytes);assert.deepEqual(await readFile(join(f.tasks.root,'tasks.json')),taskBytes);
  await assert.rejects(f.service.turn(created.topic.topicId,{requestId:'new',expectedVersion:retained.version,text:'Do not launch while selection changed.'}),(e)=>e instanceof TalkRequestError&&e.status===409);
  await rm(path,{recursive:true});await rename(path+'-retained',path);const reopened=await f.create();assert.deepEqual(await reopened.recover(),{topics:1,turns:1,proposals:0});
  const recovered=await reopened.topic(created.topic.topicId);assert.equal(recovered.turns[0]!.state,'uncertain');await reopened.turn(created.topic.topicId,{requestId:'pending',expectedVersion:created.topic.version as number,text:'Offer a goal.'});assert.equal(model.calls.length,1);assert.equal(model.disposed,1);assert.equal(ack.turnId,'mw.w0.turn-pending');
});

test('global128 topic bound serializes cross-workspace creates; latest50 attention retains totals and exact routed acknowledgment',async(t)=>{
  const f=await fixture(t,undefined,2);
  for(let i=0;i<127;i++)await f.service.create({requestId:'bounded-'+i,title:'Bounded '+i,workspaceKey:i%2?'w1':'w0'});
  const results=await Promise.allSettled([f.service.create({requestId:'last-a',title:'Final A',workspaceKey:'w0'}),f.service.create({requestId:'last-b',title:'Final B',workspaceKey:'w1'})]);assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal(results.filter((r)=>r.status==='rejected').length,1);
  for(const key of ['w0','w1']) {
    const store=await f.child(key);let topic=(await store.load('topic-bounded-'+(key==='w0'?0:1)))!;
    topic=(await store.linkTask({topicId:topic.topicId,actor:'fixture',idempotencyKey:'attention-link',expectedVersion:topic.version,task:{taskId:'missing-'+key,workspaceId:topic.workspaceId,taskStoreId:topic.taskStoreId}})).topic;
    for(let i=0;i<30;i++)topic=(await store.observeAttention({topicId:topic.topicId,actor:'fixture',idempotencyKey:'attention-'+i,expectedVersion:topic.version,attentionId:'attention-'+i,taskId:'missing-'+key,taskVersion:i+1,runId:null,kind:'update',summary:'Actual retained fictional observation '+i,observationSha256:conversationDigest({key,i})})).topic;
  }
  const all=await f.service.describe();assert.equal(all.topics.length,128);assert.equal(all.page.total,128);assert.equal(all.page.hasMore,false);assert.equal(new Set(all.topics.map((v)=>v.topicId)).size,128);assert.equal(all.attention.length,50);assert.equal(all.attentionPage.total,60);assert.equal(all.attentionPage.omittedAfter,10);assert.equal(all.attentionPage.hasMore,true);assert.equal(new Set(all.attention.map((v)=>v.attentionId)).size,50);
  const item=all.attention[0]!,detail=await f.service.topic(item.topicId);await f.service.ack(item.topicId,item.attentionId,{requestId:'aggregate-ack',expectedVersion:detail.topic.version as number});assert.equal((await f.service.describe()).attentionPage.total,59);
});
