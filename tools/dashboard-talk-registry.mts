import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { CONVERSATION_LIMITS, conversationDigest, type ConversationAttention, type FileTaskStore, type TaskRuntime } from '../libs/runtime/src/index.js';
import type { ModelTransport } from '../libs/host-adapters/src/index.js';
import { createDashboardTalk, loadDashboardTalkConfig, TalkRequestError, validateDashboardTalkRoots, type DashboardTalkConfig, type DashboardTalkService, type DashboardTalkTransportConfig, type TalkMutationInput, type TalkTopicDetail, type TalkTurnInput } from './dashboard-talk.mjs';

export interface DashboardTalkWorkspaceSelection {
  readonly key:string; readonly workspaceId:string; readonly label:string; readonly workspaceRoot:string;
}
export interface DashboardTalkRegistryConfig {
  readonly schema:2; readonly root:string; readonly registryId:string; readonly hostId:string; readonly taskStoreId:string;
  readonly workspaces:readonly DashboardTalkWorkspaceSelection[];
  readonly transport?:DashboardTalkTransportConfig;
}
export type DashboardTalkConfiguration=DashboardTalkConfig|DashboardTalkRegistryConfig;
export interface AdmittedTalkWorkspace extends DashboardTalkWorkspaceSelection {
  readonly selectedWorkspaceRoot:string; readonly conversationRoot:string;
}
export interface DashboardTalkRegistryRoots {
  readonly registryRoot:string; readonly taskStoreRoot:string; readonly workspaces:readonly AdmittedTalkWorkspace[];
}
export interface DashboardTalkRegistryOptions {
  readonly config:DashboardTalkRegistryConfig; readonly taskStore:FileTaskStore; readonly runtime:TaskRuntime; readonly controller?:unknown;
  /** Trusted fixture/host injection; never a serialized configuration field. */
  readonly transport?:ModelTransport; readonly transportIdentity?:{adapter:string;model:string};
}
export interface TalkWorkspaceBinding {
  readonly workspaceKey:string; readonly workspaceId:string; readonly taskStoreId:string; readonly available:boolean; readonly reason:string|null;
}
const markerName='.talk-registry-selection.json';
const limits={workspaces:8,configBytes:64*1024};
type Fingerprint={dev:number;ino:number};
interface Selection {
  schema:2;kind:'temari-talk-registry-selection';registryId:string;hostId:string;taskStoreId:string;
  registryRoot:string;registryIdentity:Fingerprint;taskStoreRoot:string;taskStoreIdentity:Fingerprint;
  workspaces:Array<{key:string;workspaceId:string;selectedWorkspaceRoot:string;workspaceRoot:string;workspaceIdentity:Fingerprint;conversationRoot:string;conversationIdentity:Fingerprint;markerHashes:Record<string,string>}>;
}
type Entry={roots:AdmittedTalkWorkspace;identity:Selection['workspaces'][number];service:DashboardTalkService;markerHashes:Record<string,string>};
type ListedTopic=Awaited<ReturnType<DashboardTalkService['describe']>>['topics'][number]&{binding:TalkWorkspaceBinding};
type ListedWorkspace={workspaceKey:string;workspaceId:string;label:string;available:boolean;reason:string|null;topicCount:number};

function check(ok:unknown,message:string,status=400):asserts ok {if(!ok)throw new TalkRequestError(status,message);}
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):asserts value is Record<string,unknown> {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value),'A Talk registry object is required.');
  check(required.every((k)=>Object.hasOwn(value,k))&&Object.keys(value).every((k)=>required.includes(k)||optional.includes(k)),'Unknown or missing Talk registry fields.');
}
function id(value:unknown,max=128):asserts value is string {check(typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),'Opaque Talk registry identity required.');}
function rootPath(value:unknown):asserts value is string {check(typeof value==='string'&&isAbsolute(value)&&value.length<=4096&&!value.includes('\0'),'Host-selected absolute Talk root required.');check(value.split(sep).every((s)=>s!=='.'&&s!=='..'),'Talk roots must not contain exact dot or parent segments.');}
function shape(input:unknown):asserts input is DashboardTalkRegistryConfig {
  exact(input,['schema','root','registryId','hostId','taskStoreId','workspaces'],['transport']);check(input.schema===2,'Unsupported Talk registry schema.');rootPath(input.root);
  for(const key of ['registryId','hostId','taskStoreId'])id(input[key]);
  check(Array.isArray(input.workspaces)&&input.workspaces.length>=1&&input.workspaces.length<=limits.workspaces,'Select 1..8 Talk workspaces.');
  const keys=new Set<string>(),ids=new Set<string>();
  for(const item of input.workspaces) {
    exact(item,['key','workspaceId','label','workspaceRoot']);check(typeof item.key==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(item.key),'Portable Talk workspace key required.');id(item.workspaceId);rootPath(item.workspaceRoot);
    check(typeof item.label==='string'&&item.label.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(item.label)&&Buffer.byteLength(item.label)<=256,'Bounded Talk workspace label required.');
    check(!keys.has(item.key)&&!ids.has(item.workspaceId),'Duplicate Talk workspace identity.');keys.add(item.key);ids.add(item.workspaceId);
  }
  check(Buffer.byteLength(JSON.stringify(input))<=limits.configBytes,'Talk registry config exceeds its bound.');
}
async function regular(path:string,max=limits.configBytes):Promise<Buffer> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();assert(stat.isFile()&&stat.size<=max,'Talk registry file is not bounded regular data.');const raw=await file.readFile();assert(raw.length<=max,'Talk registry file exceeds its bound.');return raw;}finally{await file.close();}
}
async function existing(path:string) {try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function futureRoot(raw:string):Promise<string> {
  rootPath(raw);const direct=await existing(raw);check(!direct?.isSymbolicLink(),'Talk storage roots cannot be symlinks.');
  let ancestor=resolve(raw);const tail:string[]=[];
  while(true){try{const canonical=await realpath(ancestor);return join(canonical,...tail);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(ancestor);check(parent!==ancestor,'Talk root cannot be resolved.');tail.unshift(relative(parent,ancestor));ancestor=parent;}}
}
function within(parent:string,child:string) {const distance=relative(parent,child);return distance===''||!(distance==='..'||distance.startsWith('..'+sep)||isAbsolute(distance));}
function disjoint(a:string,b:string,message:string) {check(!within(a,b)&&!within(b,a),message);}
async function directory(path:string):Promise<Fingerprint> {const info=await lstat(path);check(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(path)===path,'Talk selected directory identity is unavailable.',409);return {dev:info.dev,ino:info.ino};}
function childConfig(config:DashboardTalkRegistryConfig,entry:AdmittedTalkWorkspace):DashboardTalkConfig {
  return {schema:1,root:entry.conversationRoot,workspaceRoot:entry.workspaceRoot,workspaceId:entry.workspaceId,hostId:config.hostId,taskStoreId:config.taskStoreId,...(config.transport?{transport:config.transport}:{})};
}

/** Strict config dispatch. Legacy loader/type/factory remain independently callable. */
export async function loadDashboardTalkConfiguration(path:string):Promise<DashboardTalkConfiguration> {
  rootPath(path);const raw=await regular(path),value:unknown=JSON.parse(raw.toString());
  if(value&&typeof value==='object'&&!Array.isArray(value)&&(value as {schema?:unknown}).schema===1) {
    const legacy=await loadDashboardTalkConfig(path);check(conversationDigest(legacy)===conversationDigest(value),'Talk config changed while reading.',409);return legacy;
  }
  shape(value);return structuredClone(value);
}
/** Read-only full-roster admission before the CLI creates any data store. */
export async function validateDashboardTalkRegistryRoots(config:DashboardTalkRegistryConfig,taskRoot:string):Promise<DashboardTalkRegistryRoots> {
  shape(config);const [registryRoot,taskStoreRoot]=await Promise.all([futureRoot(config.root),futureRoot(taskRoot)]);disjoint(registryRoot,taskStoreRoot,'Talk registry and task storage must be disjoint.');
  const roots:AdmittedTalkWorkspace[]=[];const seen=new Set<string>();
  for(const entry of config.workspaces) {
    const workspaceRoot=await realpath(entry.workspaceRoot);await directory(workspaceRoot);check(!seen.has(workspaceRoot),'Duplicate canonical Talk workspace.');seen.add(workspaceRoot);
    const conversationRoot=join(registryRoot,'workspaces',entry.key);roots.push({...entry,selectedWorkspaceRoot:entry.workspaceRoot,workspaceRoot,conversationRoot});
    // Reuse the current protected transport and source-boundary validation.
    await validateDashboardTalkRoots(childConfig(config,roots[roots.length-1]!),taskStoreRoot);
  }
  for(const entry of roots) {
    disjoint(entry.workspaceRoot,registryRoot,'Talk registry must be disjoint from every source workspace.');disjoint(entry.workspaceRoot,taskStoreRoot,'Task storage must be disjoint from every Talk workspace.');
    for(const other of roots)disjoint(entry.workspaceRoot,other.conversationRoot,'Talk child storage must be disjoint from every source workspace.');
  }
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)disjoint(roots[i]!.conversationRoot,roots[j]!.conversationRoot,'Talk child roots must be disjoint.');
  return {registryRoot,taskStoreRoot,workspaces:roots};
}
async function childMarkers(root:string):Promise<Record<string,string>> {
  const result:Record<string,string>={};for(const name of ['.conversation-store.json','.talk-host-selection.json'])result[name]=createHash('sha256').update(await regular(join(root,name),16*1024)).digest('hex');return result;
}
async function selection(config:DashboardTalkRegistryConfig,roots:DashboardTalkRegistryRoots):Promise<Selection> {
  return {schema:2,kind:'temari-talk-registry-selection',registryId:config.registryId,hostId:config.hostId,taskStoreId:config.taskStoreId,registryRoot:roots.registryRoot,registryIdentity:await directory(roots.registryRoot),taskStoreRoot:roots.taskStoreRoot,taskStoreIdentity:await directory(roots.taskStoreRoot),workspaces:await Promise.all(roots.workspaces.map(async(e)=>({key:e.key,workspaceId:e.workspaceId,selectedWorkspaceRoot:e.selectedWorkspaceRoot,workspaceRoot:e.workspaceRoot,workspaceIdentity:await directory(e.workspaceRoot),conversationRoot:e.conversationRoot,conversationIdentity:await directory(e.conversationRoot),markerHashes:await childMarkers(e.conversationRoot)})))};
}
async function publishMarker(root:string,payload:Selection):Promise<Buffer> {
  const body=Buffer.from(JSON.stringify({...payload,sha256:conversationDigest(payload)}));check(body.length<=limits.configBytes,'Talk registry selection exceeds its bound.');const temporary=join(root,'.registry-'+randomUUID()+'.tmp'),file=await open(temporary,'wx',0o600);
  try{try{await file.writeFile(body);await file.sync();}finally{await file.close();}await link(temporary,join(root,markerName));}finally{await unlink(temporary).catch(()=>undefined);}
  const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}const actual=await regular(join(root,markerName));assert(actual.equals(body),'Talk registry marker readback differs.');return actual;
}
async function checkMarker(root:string,payload:Selection):Promise<Buffer> {
  const raw=await regular(join(root,markerName));const value:unknown=JSON.parse(raw.toString());
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Talk registry marker is corrupt.');const {sha256,...retained}=value as Record<string,unknown>;
  assert(typeof sha256==='string'&&sha256===conversationDigest(retained),'Talk registry marker digest is corrupt.');
  check(conversationDigest(retained)===conversationDigest(payload),'Talk registry host selection changed; retained storage cannot be adopted.',409);return raw;
}
function scopedId(key:string,local:string) {id(local);check(local.length<=92,'Stored Talk routing identity exceeds its bound.',409);const value='mw.'+key+'.'+local;id(value);return value;}
function localId(key:string,value:string,prefix:string) {id(value);const selected='mw.'+key+'.';check(value.startsWith(selected),'Talk identity belongs to another workspace.',409);const local=value.slice(selected.length);check(local.startsWith(prefix),'Unknown Talk routing identity.',404);id(local);return local;}
const unavailable='The selected Talk workspace is unavailable or changed. Restore its original selection before making changes.';

export class DashboardTalkRegistryService {
  readonly topicCreationScope='workspace-registry' as const;
  private createQueue:Promise<void>=Promise.resolve();
  constructor(private readonly config:DashboardTalkRegistryConfig,private readonly roots:DashboardTalkRegistryRoots,private readonly pinned:Selection,private readonly markerBytes:Buffer,private readonly entries:readonly Entry[],private readonly hasTransport:boolean) {}
  private entry(topicId:string):Entry {id(topicId);const match=/^mw\.([A-Za-z0-9][A-Za-z0-9_-]{0,31})\.(.+)$/.exec(topicId);check(match,'Opaque qualified Talk topic required.',404);const entry=this.entries.find((e)=>e.roots.key===match[1]);check(entry,'Talk workspace is not selected.',404);localId(entry.roots.key,topicId,'topic-');return entry;}
  private async base():Promise<void> {
    check(conversationDigest(await directory(this.roots.registryRoot))===conversationDigest(this.pinned.registryIdentity),'Talk registry directory changed.',409);
    check(conversationDigest(await directory(this.roots.taskStoreRoot))===conversationDigest(this.pinned.taskStoreIdentity),'Talk task store directory changed.',409);
    check(await realpath(this.config.root)===this.roots.registryRoot,'Talk registry root was retargeted.',409);
    const raw=await regular(join(this.roots.registryRoot,markerName));assert(raw.equals(this.markerBytes),'Talk registry selection marker changed.');
  }
  private async storage(entry:Entry):Promise<void> {await this.base();check(conversationDigest(await directory(entry.roots.conversationRoot))===conversationDigest(entry.identity.conversationIdentity),'Talk child directory changed.',409);for(const [name,digest] of Object.entries(entry.markerHashes))assert.equal(createHash('sha256').update(await regular(join(entry.roots.conversationRoot,name),16*1024)).digest('hex'),digest,'Talk child host marker changed.');}
  private async workspace(entry:Entry):Promise<void> {check(await realpath(entry.roots.selectedWorkspaceRoot)===entry.roots.workspaceRoot,unavailable,409);check(conversationDigest(await directory(entry.roots.workspaceRoot))===conversationDigest(entry.identity.workspaceIdentity),unavailable,409);}
  async validateHostSelection(workspaceKey:string):Promise<void> {const entry=this.entries.find((item)=>item.roots.key===workspaceKey);check(entry,'Talk workspace is not selected.',409);await this.storage(entry);await this.workspace(entry);}
  private async validateEntry(entry:Entry):Promise<void> {await this.validateHostSelection(entry.roots.key);}
  private async available(entry:Entry):Promise<boolean> {await this.storage(entry);try{await this.workspace(entry);return true;}catch(error){if(error instanceof TalkRequestError||(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')))return false;throw error;}}
  private binding(entry:Entry,available:boolean):TalkWorkspaceBinding {return {workspaceKey:entry.roots.key,workspaceId:entry.roots.workspaceId,taskStoreId:this.config.taskStoreId,available,reason:available?null:unavailable};}
  private capabilities(available=true) {return {canSendTurn:available&&this.hasTransport,canCreateTopic:available,canLinkTask:available,canAcknowledge:available,canAcceptProposal:available,canStartTask:false as const};}
  private projectTopic<T extends {topicId:string;pendingTurnId:string|null}>(entry:Entry,topic:T,available:boolean) {return {...topic,topicId:scopedId(entry.roots.key,topic.topicId),pendingTurnId:topic.pendingTurnId===null?null:scopedId(entry.roots.key,topic.pendingTurnId),binding:this.binding(entry,available)};}
  private projectAttention(entry:Entry,item:ConversationAttention) {return {...item,topicId:scopedId(entry.roots.key,item.topicId),attentionId:scopedId(entry.roots.key,item.attentionId)};}
  private projectDetail(entry:Entry,detail:TalkTopicDetail,available:boolean) {
    return {...detail,topic:this.projectTopic(entry,detail.topic,available),capabilities:this.capabilities(available),turns:detail.turns.map(({context,proposedTask,...turn})=>({...turn,topicId:scopedId(entry.roots.key,turn.topicId),turnId:scopedId(entry.roots.key,turn.turnId),retainedContext:context,proposedTask:proposedTask?{...proposedTask,proposalId:scopedId(entry.roots.key,proposedTask.proposalId)}:null})),linkedTasks:detail.linkedTasks.map((card)=>({...card,binding:this.binding(entry,available)})),attention:detail.attention.map((item)=>this.projectAttention(entry,item))};
  }
  async describe() {
    const beganAt=new Date().toISOString();await this.base();const topics:ListedTopic[]=[],attention:Array<ReturnType<DashboardTalkRegistryService['projectAttention']>>=[],workspaces:ListedWorkspace[]=[];let unreadTotal=0;
    for(const entry of this.entries) {
      const available=await this.available(entry);
      if(available) {
        const view=await entry.service.describe();topics.push(...view.topics.map((t)=>this.projectTopic(entry,t,true)));attention.push(...view.attention.map((a)=>this.projectAttention(entry,a)));unreadTotal+=view.attentionPage.total;
      } else {
        const selected=await entry.service.store.listAllTopicSummaries(),page=await entry.service.store.listAttention({unreadOnly:true,limit:50});topics.push(...selected.map((t)=>this.projectTopic(entry,{...t,unread:t.unreadAttentionCount,attentionCount:t.actionableAttentionCount,turnState:t.lastTurnState},false)));attention.push(...page.items.map((a)=>this.projectAttention(entry,a)));unreadTotal+=page.total;
      }
      workspaces.push({workspaceKey:entry.roots.key,workspaceId:entry.roots.workspaceId,label:entry.roots.label,available,reason:available?null:unavailable,topicCount:topics.filter((t)=>t.binding.workspaceKey===entry.roots.key).length});
    }
    check(topics.length<=CONVERSATION_LIMITS.topics,'Talk registry topic limit exceeded; retain all stores for recovery.',409);
    topics.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))||String(a.topicId).localeCompare(String(b.topicId)));attention.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.attentionId.localeCompare(b.attentionId));
    const setupReason=this.hasTransport?null:'Configure a host-selected model transport to send messages. Topics and task links are available.';
    return {configured:true,scopeMode:'workspace-registry' as const,capabilities:this.capabilities(workspaces.some((w)=>w.available)),setupReason,reason:setupReason,workspaces,topics,page:{total:topics.length,offset:0,limit:128,omittedBefore:0,omittedAfter:0,hasMore:false},attention:attention.slice(0,50),attentionPage:{total:unreadTotal,offset:0,limit:50,omittedBefore:0,omittedAfter:Math.max(0,unreadTotal-50),hasMore:unreadTotal>50},observationWindow:{beganAt,endedAt:new Date().toISOString(),atomicAcrossStores:false as const}};
  }
  async topic(topicId:string,options:{offset?:number;limit?:number}={}) {
    const entry=this.entry(topicId),local=localId(entry.roots.key,topicId,'topic-'),available=await this.available(entry);
    if(available)return this.projectDetail(entry,await entry.service.topic(local,options),true);
    check(await entry.service.store.load(local),'Topic not found.',404);const selected=await entry.service.store.readTopic(local,options);const {items,...page}=selected.turns;const detail:TalkTopicDetail={topic:selected.topic,turns:items.map((turn)=>({...turn,requestId:turn.turnId.slice(5)})),page,linkedTasks:selected.linkedTasks.map((task)=>({taskId:task.taskId,available:false,version:null,title:'Unavailable linked task',goal:'',status:'UNKNOWN',currentRunId:null,nextAction:null,blocker:null,semanticAcceptance:false,evidence:null,observedAt:new Date().toISOString(),reason:unavailable,omittedFields:[]})),attention:selected.attention};return this.projectDetail(entry,detail,false);
  }
  async create(input:{requestId:string;title:string;workspaceKey:string}) {
    exact(input,['requestId','title','workspaceKey']);id(input.requestId,64);const entry=this.entries.find((e)=>e.roots.key===input.workspaceKey);check(entry,'Select one admitted Talk workspace.');
    const command=structuredClone(input);const job=this.createQueue.then(async()=>{await this.validateEntry(entry);const existing=await entry.service.store.load('topic-'+command.requestId);if(!existing){let total=0;for(const child of this.entries){await this.storage(child);total+=(await child.service.store.listAllTopicSummaries()).length;}check(total<128,'Talk registry topic limit reached.',409);}const result=await entry.service.create({requestId:command.requestId,title:command.title});return this.topic(scopedId(entry.roots.key,result.topic.topicId));});this.createQueue=job.then(()=>undefined,()=>undefined);return job;
  }
  async turn(topicId:string,input:TalkTurnInput) {const entry=this.entry(topicId);await this.validateEntry(entry);const result=await entry.service.turn(localId(entry.roots.key,topicId,'topic-'),input);return {...result,topicId,turnId:scopedId(entry.roots.key,result.turnId)};}
  async link(topicId:string,input:TalkMutationInput&{taskId:string}) {const entry=this.entry(topicId);await this.validateEntry(entry);await entry.service.link(localId(entry.roots.key,topicId,'topic-'),input);return this.topic(topicId);}
  async ack(topicId:string,attentionId:string,input:TalkMutationInput) {const entry=this.entry(topicId);await this.validateEntry(entry);const result=await entry.service.ack(localId(entry.roots.key,topicId,'topic-'),localId(entry.roots.key,attentionId,'attention-'),input);return {...result,topicId,attentionId};}
  async accept(topicId:string,turnId:string,input:TalkMutationInput) {const entry=this.entry(topicId);await this.validateEntry(entry);await entry.service.accept(localId(entry.roots.key,topicId,'topic-'),localId(entry.roots.key,turnId,'turn-'),input);return this.topic(topicId);}
  async recover() {let topics=0,turns=0,proposals=0;for(const entry of this.entries){await this.validateEntry(entry);const result=await entry.service.recover();topics+=result.topics;turns+=result.turns;proposals+=result.proposals;}return {topics,turns,proposals};}
}

export async function createDashboardTalkRegistry(options:DashboardTalkRegistryOptions):Promise<DashboardTalkRegistryService> {
  const config=structuredClone(options.config),roots=await validateDashboardTalkRegistryRoots(config,options.taskStore.root);await directory(roots.taskStoreRoot);
  const present=await existing(roots.registryRoot),marker=present?await existing(join(roots.registryRoot,markerName)):null;
  if(!marker) {
    check(!present||(await readdir(roots.registryRoot)).length===0,'Refusing to adopt nonempty legacy or unmarked Talk registry storage.',409);
    await mkdir(roots.registryRoot,{recursive:true,mode:0o700});for(const entry of roots.workspaces)await mkdir(entry.conversationRoot,{recursive:true,mode:0o700});
  }
  // Existing immutable selection and all child markers are checked before any child factory.
  // An interrupted unpublished initialization is visibly nonempty and requires host recovery.
  let pinned=marker?await selection(config,roots):null,markerBytes=marker?await checkMarker(roots.registryRoot,pinned!):null;const entries:Entry[]=[];
  let registry!:DashboardTalkRegistryService;
  for(const entry of roots.workspaces) {
    // Stable namespace derives only from immutable registry/workspace/task identities;
    // it does not depend on mutable ledger bytes or initialization order.
    const namespace=conversationDigest({registryId:config.registryId,registryRoot:roots.registryRoot,hostId:config.hostId,taskStoreId:config.taskStoreId,taskStoreRoot:roots.taskStoreRoot,workspaceKey:entry.key,workspaceId:entry.workspaceId,workspaceRoot:entry.workspaceRoot});
    const service=await createDashboardTalk({config:childConfig(config,entry),taskStore:options.taskStore,runtime:options.runtime,...(options.controller?{controller:options.controller}:{}),...(options.transport?{transport:options.transport}:{}),...(options.transportIdentity?{transportIdentity:options.transportIdentity}:{}),proposalIdentityNamespace:namespace,validateHostSelection:async()=>registry.validateHostSelection(entry.key)});
    const markerHashes=await childMarkers(entry.conversationRoot);entries.push({roots:entry,identity:undefined as unknown as Entry['identity'],service,markerHashes});
  }
  pinned??=await selection(config,roots);markerBytes??=await publishMarker(roots.registryRoot,pinned);for(const entry of entries)entry.identity=pinned.workspaces.find((e)=>e.key===entry.roots.key)!;
  let total=0;for(const entry of entries)total+=(await entry.service.store.listAllTopicSummaries()).length;check(total<=128,'Talk registry topic limit exceeded; no effects may begin.',409);
  registry=new DashboardTalkRegistryService(config,roots,pinned,markerBytes,entries,Boolean(options.transport||config.transport));return registry;
}
