import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  createCodexModelDriver,
  type CodexModelDriverOptions,
} from './codex-model-driver.js';
import {
  createProtectedModelTransport,
  type ModelDriverRequest,
} from './model-transport.js';

const syntheticCredential = 'synthetic-only-not-a-live-api-credential';
const request: ModelDriverRequest = {
  prompt: 'Supplied safe text',
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  tools: [
    {
      name: 'temari_host_1',
      description: 'Read authorized text',
      inputSchema: {
        type: 'object',
        properties: { resource: { type: 'string' } },
      },
    },
  ],
};

type Trace = {
  kind: string;
  method?: string;
  params?: Record<string, any>;
  [key: string]: any;
};
async function fixture(t: TestContext, behavior = 'valid', timeoutMs = 5000) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-codex-fixture-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracePath = join(root, 'trace.jsonl');
  const executable = join(root, 'fake-codex');
  // Real subprocess/stdio/lifetime, but no provider, network or real key.
  // Parses only the quoted inline TOML subset this bounded driver emits.
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const behavior = ${JSON.stringify(behavior)};
const tracePath = ${JSON.stringify(tracePath)};
const trace = value => appendFileSync(tracePath, JSON.stringify(value) + '\n');
const key = process.env.TEMARI_MODEL_API_KEY;
trace({kind:'launch',args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,codexHome:process.env.CODEX_HOME,tmp:process.env.TMPDIR,pid:process.pid,environmentKeys:Object.keys(process.env).sort(),hasCredential:!!key});
if(process.argv[2]==='--version') {
  process.stdout.write(behavior==='version'?'codex-cli 0.154.0\n':'codex-cli 0.155.0-alpha.16.4\n');
  process.exit(0);
}
const parse = value => {
  let quoted=false, escaped=false, out='';
  for(const c of value) {
    if(quoted) { out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false; }
    else if(c==='"'){quoted=true;out+=c;} else out+=c==='='?':':c;
  }
  return JSON.parse(out);
};
const config={};const argv=process.argv.slice(2);
for(let i=0;i<argv.length;i++) if(argv[i]==='-c') {const arg=argv[++i];const end=arg.indexOf('=');config[arg.slice(0,end)]=parse(arg.slice(end+1));}
let thread;let done=false;let dynamic;const items=[];
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const respond = (id,result) => emit({id,result});
const notice = (method,params) => emit({method,params});
const bind = () => ({threadId:thread.id,turnId:'turn_1'});
const started = item => notice('item/started',{...bind(),item});
const completed = item => {items.push(item);notice('item/completed',{...bind(),item});};
function finish(answer) {
  const item={id:'answer_1',type:'agentMessage',text:answer,phase:'final_answer',memoryCitation:null,delivery:null,questions:null};
  if(behavior==='credential-echo') item.text=key;
  started({...item,text:''});completed(item);
  done=true;
  notice('turn/completed',{threadId:thread.id,turn:{id:'turn_1',status:'completed',items:behavior==='forged-final'?[{...item,text:'forged'}]:items,error:null}});
  if(behavior==='late-native')notice('item/commandExecution/outputDelta',{...bind(),itemId:'native',delta:'private'});
}
for await(const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  trace({kind:'message',...m});
  if(!m.method) {
    if(m.id==='host_request_1') {
      if(behavior==='tool-media') m.result.contentItems=[{type:'inputImage',imageUrl:'data:image/png;base64,AAAA'}];
      completed({...dynamic,status:'completed',contentItems:m.result.contentItems,success:m.result.success});
      finish(m.result.contentItems[0].text ?? 'media');
    }
    continue;
  }
  if(m.method==='initialized')continue;
  if(m.method==='initialize') {
    respond(m.id,{userAgent:'temari_protected/0.155.0-alpha.16.4 (test)',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:'macos'});
    notice('remoteControl/status/changed',{status:'disabled'});
  } else if(m.method==='config/read') {
    const effective=structuredClone(config);
    if(behavior==='provider')effective.model_providers.temari_protected.base_url='https://untrusted.invalid/v1';
    if(behavior==='effective-feature')effective.features.shell_tool=true;
    if(behavior==='extra-config')effective.unrecognized_source='private';
    if(behavior==='postflight-drift'&&done)effective.developer_instructions='changed';
    const layers=[{name:{type:'sessionFlags'},version:'fixture',config}, {name:{type:'user',file:process.env.CODEX_HOME+'/config.toml'},version:'fixture',config:{}}, {name:{type:'system'},version:'fixture',config:{}}];
    if(behavior==='layer')layers.push({name:{type:'project'},version:'fixture',config:{}});
    respond(m.id,{config:effective,layers,origins:{}});
  } else if(m.method==='configRequirements/read')respond(m.id,{requirements:behavior==='requirements'?{additionalDeveloperInstructions:'private'}:null});
  else if(m.method==='experimentalFeature/list') {
    let data=Object.entries(config.features).map(([name,enabled])=>({name,enabled,stage:'stable',defaultEnabled:false}));
    if(behavior==='native-enabled') data=data.map(f=>f.name==='unified_exec'?{...f,enabled:true}:f);
    if(behavior==='feature-unknown') data.push({name:'new_native_tool',enabled:false});
    if(behavior==='feature-missing') data=data.slice(1);
    if(behavior==='feature-duplicate') data.push(data[0]);
    const cursor=m.params.cursor;
    respond(m.id,{data:cursor?data.slice(80):data.slice(0,80),nextCursor:behavior==='cursor-loop'?'again':cursor?null:'page_two'});
  } else if(m.method==='permissionProfile/list')respond(m.id,{data:behavior==='profile-missing'?[]:[{id:'temari_protected',allowed:behavior!=='profile-denied',description:null}],nextCursor:null});
  else if(m.method==='thread/start') {
    thread={id:'thread_1',ephemeral:behavior!=='persistent',turns:[]};
    const response={thread,cwd:behavior==='cwd'?'/unexpected':m.params.cwd,model:behavior==='model'?'wrong':m.params.model,modelProvider:m.params.modelProvider,reasoningEffort:config.model_reasoning_effort,approvalPolicy:'never',activePermissionProfile:{id:'temari_protected',extends:null},sandbox:{type:'readOnly',networkAccess:behavior==='network'},runtimeWorkspaceRoots:behavior==='roots'?['/unexpected']:[],instructionSources:behavior==='instructions'?['/private/AGENTS.md']:[]};
    notice('thread/started',{thread});respond(m.id,response);
  } else if(m.method==='mcpServerStatus/list')respond(m.id,{data:behavior==='mcp'?[{name:'unexpected'}]:[],nextCursor:null});
  else if(m.method==='turn/start') {
    const turn={id:'turn_1',status:'inProgress',items:[],error:null};
    respond(m.id,{turn});notice('turn/started',{threadId:thread.id,turn});
    if(behavior==='timeout')continue;
    if(behavior==='early-exit')process.exit(0);
    if(behavior==='stderr-overflow'){process.stderr.write('X'.repeat(70000));continue;}
    if(behavior==='stderr-secret')process.stderr.write(key);
    if(behavior==='stdout-overflow'){process.stdout.write('X'.repeat(2200000));continue;}
    if(behavior==='malformed'){process.stdout.write('{broken\n');continue;}
    if(behavior==='error-secret'){emit({method:'error',params:{message:key}});continue;}
    if(behavior==='approval'){emit({id:'approval',method:'item/commandExecution/requestApproval',params:bind()});continue;}
    if(behavior==='native-event'){notice('item/fileChange/outputDelta',{...bind(),delta:'private'});continue;}
    if(behavior==='native-item'){started({id:'native',type:'commandExecution',command:'cat private'});continue;}
    if(behavior==='media-user'){started({id:'user',type:'userMessage',content:[{type:'localImage',path:'/private/image.png'}]});continue;}
    const user={id:'user_1',type:'userMessage',content:m.params.input};started(user);completed(user);
    if(!key)throw new Error('preflight attempted a model turn');
    dynamic={id:'call_1',type:'dynamicToolCall',namespace:null,tool:'temari_host_1',arguments:{resource:'file_1'},status:'inProgress',contentItems:null,success:null};
    if(behavior==='unknown-tool')dynamic.tool='shell';
    started(dynamic);
    const params={...bind(),callId:dynamic.id,namespace:null,tool:dynamic.tool,arguments:dynamic.arguments};
    if(behavior==='wrong-thread')params.threadId='other_thread';
    if(behavior==='wrong-turn')params.turnId='other_turn';
    if(behavior==='wrong-args')params.arguments={resource:'other'};
    emit({id:'host_request_1',method:'item/tool/call',params});
    if(behavior==='duplicate-call')emit({id:'host_request_2',method:'item/tool/call',params});
    if(behavior==='duplicate-rpc')emit({id:'host_request_1',method:'item/tool/call',params});
  } else throw new Error('unexpected method');
}
`,
    { mode: 0o700 },
  );
  let credentialCalls = 0;
  const options: CodexModelDriverOptions = {
    executable,
    model: 'test-model',
    reasoning: 'high',
    timeoutMs,
    credential: async () => {
      credentialCalls++;
      return syntheticCredential;
    },
  };
  const driver = createCodexModelDriver(options);
  const trace = async (): Promise<Trace[]> => {
    try {
      return (await readFile(tracePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const cleaned = async () => {
    for (const launch of (await trace()).filter(
      (item) => item.kind === 'launch',
    )) {
      await assert.rejects(stat(launch.tmp), { code: 'ENOENT' });
      assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
    }
  };
  return {
    driver,
    options,
    trace,
    cleaned,
    credentialCalls: () => credentialCalls,
  };
}

test('credential-free preflight checks a fresh thread without data or a turn', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.driver.preflight(), {
    runtimeVersion: '0.155.0-alpha.16.4',
    checks: 'configuration-and-thread',
    runtimeIsolationVerified: false,
  });
  const trace = await f.trace();
  assert.equal(f.credentialCalls(), 0);
  assert(
    !trace.some((item) => item.method === 'turn/start' || item.hasCredential),
  );
  assert(
    trace.some(
      (item) =>
        item.method === 'experimentalFeature/list' &&
        item.params?.threadId === 'thread_1',
    ),
  );
  await f.cleaned();
});

test('only allowlisted environment and protected text reach the fresh model process', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const answer = await f.driver.complete(request, async (name, args) => {
    calls++;
    assert.equal(name, 'temari_host_1');
    assert.deepEqual(args, { resource: 'file_1' });
    return 'safe tool result café 計画';
  });
  assert.equal(answer, 'safe tool result café 計画');
  assert.equal(calls, 1);
  assert.equal(f.credentialCalls(), 1);
  const trace = await f.trace();
  const launches = trace.filter((item) => item.kind === 'launch');
  assert.equal(launches.length, 4);
  for (const launch of launches) {
    // macOS may synthesize this locale variable inside a launched process.
    const keys = launch.environmentKeys.filter(
      (name: string) =>
        process.platform !== 'darwin' || name !== '__CF_USER_TEXT_ENCODING',
    );
    assert.deepEqual(
      keys,
      [
        'CODEX_HOME',
        'HOME',
        'LANG',
        'PATH',
        'TMPDIR',
        ...(launch.hasCredential ? ['TEMARI_MODEL_API_KEY'] : []),
      ].sort(),
    );
    assert(
      launch.cwd.startsWith(launch.tmp + '/') &&
        launch.home.startsWith(launch.tmp + '/') &&
        launch.codexHome.startsWith(launch.tmp + '/'),
    );
    if (launch.args[0] === '--version')
      assert.equal(launch.hasCredential, false);
  }
  const args = launches.find((item) => item.hasCredential)!.args.join('\n');
  for (const flag of [
    'shell_tool',
    'unified_exec',
    'code_mode_host',
    'view_image',
    'apps',
    'plugins',
    'hooks',
    'memories',
    'computer_use',
    'browser_use',
    'network_proxy',
  ])
    assert(args.includes(`"${flag}"=false`));
  assert(args.includes('https://api.openai.com/v1'));
  const start = trace.filter((item) => item.method === 'thread/start').at(-1)!;
  assert.deepEqual(start.params?.environments, []);
  assert.deepEqual(start.params?.selectedCapabilityRoots, []);
  assert.equal(start.params?.ephemeral, true);
  assert.equal(start.params?.dynamicTools[0].type, 'function');
  const turn = trace.find((item) => item.method === 'turn/start')!;
  assert.deepEqual(turn.params?.input, [
    { type: 'text', text: request.prompt, text_elements: [] },
  ]);
  assert.deepEqual(turn.params?.outputSchema, request.outputSchema);
  assert.equal(JSON.stringify(trace).includes(syntheticCredential), false);
  await f.cleaned();
});

test('host boundary masks prompt, screenshot extraction and tool replies through the subprocess', async (t) => {
  const f = await fixture(t);
  const transport = createProtectedModelTransport(f.driver, {
    screenshotText: { screen: async () => 'owner@example.invalid' },
    tools: [
      {
        description: 'lookup',
        inputSchema: { type: 'object' },
        async execute() {
          return [
            {
              kind: 'text',
              text: 'Contact owner@example.invalid; password=local-only-secret',
            },
          ];
        },
      },
    ],
  });
  const reply = await transport.complete({
    prompt: 'Help owner@example.invalid',
    context: [{ kind: 'screenshot', id: 'screen' }],
  });
  const wire = JSON.stringify(await f.trace());
  assert(
    !wire.includes('owner@example.invalid') &&
      !wire.includes('local-only-secret'),
  );
  assert(!reply.text.includes('owner@example.invalid'));
  assert(reply.displayText().includes('owner@example.invalid'));
  reply.dispose();
  await f.cleaned();
});

for (const behavior of [
  'version',
  'provider',
  'effective-feature',
  'extra-config',
  'layer',
  'requirements',
  'native-enabled',
  'feature-unknown',
  'feature-missing',
  'feature-duplicate',
  'cursor-loop',
  'profile-missing',
  'profile-denied',
  'persistent',
  'cwd',
  'model',
  'network',
  'roots',
  'instructions',
  'mcp',
]) {
  test(`preflight refuses ${behavior} before credentials or a turn`, async (t) => {
    const f = await fixture(t, behavior);
    await assert.rejects(
      f.driver.complete(request, async () => 'should not run'),
      /Protected Codex/,
    );
    assert.equal(f.credentialCalls(), 0);
    assert(
      !(await f.trace()).some(
        (item) => item.method === 'turn/start' || item.hasCredential,
      ),
    );
    await f.cleaned();
  });
}

for (const behavior of [
  'wrong-thread',
  'wrong-turn',
  'wrong-args',
  'unknown-tool',
  'duplicate-call',
  'duplicate-rpc',
  'native-item',
  'native-event',
  'media-user',
  'tool-media',
  'approval',
  'forged-final',
  'late-native',
  'postflight-drift',
  'malformed',
  'stdout-overflow',
  'stderr-overflow',
  'early-exit',
  'credential-echo',
  'error-secret',
]) {
  test(`active turn fails closed for ${behavior}`, async (t) => {
    const f = await fixture(t, behavior);
    let calls = 0;
    await assert.rejects(
      f.driver.complete(request, async () => {
        calls++;
        return 'safe tool output';
      }),
      (error: Error) => {
        assert(
          !error.message.includes(syntheticCredential) &&
            error.cause === undefined,
        );
        return /Protected Codex/.test(error.message);
      },
    );
    assert(calls <= 1);
    await f.cleaned();
  });
}

test('stderr containing a credential is discarded', async (t) => {
  const f = await fixture(t, 'stderr-secret');
  assert.equal(await f.driver.complete(request, async () => 'safe'), 'safe');
  assert(!JSON.stringify(await f.trace()).includes(syntheticCredential));
  await f.cleaned();
});

test('deadline covers a pending credential and a hung app-server', async (t) => {
  const f = await fixture(t, 'timeout', 2000);
  await assert.rejects(
    f.driver.complete(request, async () => 'unused'),
    /Protected Codex/,
  );
  assert((await f.trace()).some((item) => item.method === 'turn/start'));
  await f.cleaned();
  const g = await fixture(t, 'valid', 2000);
  let requested = 0;
  const driver = createCodexModelDriver({
    ...g.options,
    credential: () => {
      requested++;
      return new Promise(() => undefined);
    },
  });
  await assert.rejects(
    driver.complete(request, async () => 'unused'),
    /Protected Codex/,
  );
  assert.equal(requested, 1);
  assert(!(await g.trace()).some((item) => item.hasCredential));
  await g.cleaned();
});

test('abort during a host callback kills the subprocess and prevents a late response', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let release!: (value: string) => void;
  let invoked!: () => void;
  const running = new Promise<void>((resolve) => {
    invoked = resolve;
  });
  const completion = f.driver.complete(
    request,
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
        invoked();
      }),
    controller.signal,
  );
  const refusal = assert.rejects(completion, /Protected Codex/);
  await running;
  controller.abort();
  await refusal;
  release('late private result');
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    !(await f.trace()).some(
      (item) => !item.method && item.id === 'host_request_1',
    ),
  );
  await f.cleaned();
});

test('pre-aborted requests never spawn or resolve credentials', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.driver.preflight(controller.signal),
    /Protected Codex/,
  );
  assert.deepEqual(await f.trace(), []);
  assert.equal(f.credentialCalls(), 0);
});

test('refuses caller overrides, media and malformed tool definitions', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      createCodexModelDriver({
        ...f.options,
        env: {},
      } as CodexModelDriverOptions),
    /Protected Codex/,
  );
  assert.throws(
    () => createCodexModelDriver({ ...f.options, executable: 'codex' }),
    /Protected Codex/,
  );
  for (const bad of [
    { ...request, images: ['raw'] },
    {
      ...request,
      tools: [{ name: 'shell', description: '', inputSchema: {} }],
    },
    { ...request, tools: [...request.tools, ...request.tools] },
  ])
    await assert.rejects(
      f.driver.complete(bad, async () => 'unused'),
      /Protected Codex/,
    );
  assert(
    !(await f.trace()).some(
      (item) => item.hasCredential || item.method === 'turn/start',
    ),
  );
});

test('independent completions use distinct homes, callbacks and lifetimes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await Promise.all([
      f.driver.complete(request, async () => 'first'),
      f.driver.complete(request, async () => 'second'),
    ]),
    ['first', 'second'],
  );
  const launches = (await f.trace()).filter(
    (item) => item.kind === 'launch' && item.args[0] === 'app-server',
  );
  assert.equal(new Set(launches.map((item) => item.tmp)).size, 4);
  await f.cleaned();
});
