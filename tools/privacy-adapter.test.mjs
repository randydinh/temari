import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterAll } from 'bun:test';
import { packageRuntime } from '../packages/workflow-runtime/src/lib/workflow-runtime.ts';
import { pathToFileURL } from 'node:url';

const roots = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test('relocated host boundary protects tool replies and restores only permitted display values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-host-relocated-'));
  roots.push(root);
  const artifact = await packageRuntime('archon', join(root, 'installed'));
  const { createProtectedModelTransport } = await import(
    pathToFileURL(join(artifact.root, 'integrations/archon/model-transport.ts'))
      .href
  );
  const secret = 'relocated-cross-batch-secret';
  const email = 'relocated@example.invalid';
  const sent = [];
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        sent.push(JSON.stringify(request));
        const result = await callTool(request.tools[0].name, {});
        sent.push(result);
        return result;
      },
    },
    {
      tools: [
        {
          description: 'Read a synthetic record',
          inputSchema: { type: 'object' },
          async execute() {
            return [{ kind: 'text', text: `${email}: ${secret}` }];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({
    prompt: 'Summarize the fixture.',
    context: [{ kind: 'json', value: { email, password: secret } }],
  });
  try {
    for (const value of [...sent, reply.text]) {
      assert.equal(value.includes(secret), false);
      assert.equal(value.includes(email), false);
    }
    assert.equal(reply.displayText().includes(secret), false);
    assert.equal(reply.displayText().includes(email), true);
  } finally {
    reply.dispose();
  }
});

test('relocated Archon transport masks bracketed credentials on all model channels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-bracket-privacy-'));
  roots.push(root);
  const artifact = await packageRuntime('archon', join(root, 'installed'));
  const { createProtectedModelTransport } = await import(
    pathToFileURL(join(artifact.root, 'integrations/archon/model-transport.ts'))
      .href
  );
  const sent = [];
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        sent.push(request.prompt, request.tools[0].description);
        sent.push(await callTool(request.tools[0].name, {}));
        return 'done';
      },
    },
    {
      tools: [
        {
          description: 'Use client_secret=SYNTHETIC[DESCRIPTION]94',
          inputSchema: { type: 'object' },
          async execute() {
            return [{ kind: 'text', text: 'password=[SYNTHETIC_RESULT_94]' }];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({
    prompt: 'password=[SYNTHETIC_PROMPT_94]',
  });
  reply.dispose();
  assert.equal(sent.length, 3);
  for (const [channel, forbidden] of [
    ['prompt', 'SYNTHETIC_PROMPT_94'],
    ['description', '[DESCRIPTION]94'],
    ['callback result', 'SYNTHETIC_RESULT_94'],
  ])
    assert.equal(
      sent[
        ['prompt', 'description', 'callback result'].indexOf(channel)
      ].includes(forbidden),
      false,
      channel,
    );
});

test('relocated Archon transport masks Basic authorization on all model channels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-basic-privacy-'));
  roots.push(root);
  const artifact = await packageRuntime('archon', join(root, 'installed'));
  const { createProtectedModelTransport } = await import(
    pathToFileURL(join(artifact.root, 'integrations/archon/model-transport.ts'))
      .href
  );
  const credential = Buffer.from('synthetic_user:synthetic_pass').toString(
    'base64',
  );
  const sent = [];
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        sent.push(request.prompt, request.tools[0].description);
        sent.push(await callTool(request.tools[0].name, {}));
        return 'done';
      },
    },
    {
      tools: [
        {
          description: `authorization : BASIC\t${credential}`,
          inputSchema: { type: 'object' },
          async execute() {
            return [
              { kind: 'text', text: `Authorization: Basic ${credential}` },
            ];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({
    prompt: `Authorization: Basic ${credential}`,
  });
  try {
    assert.equal(sent.length, 3);
    for (const channel of sent)
      assert.equal(channel.includes(credential), false);
    assert.equal(reply.displayText().includes(credential), false);
  } finally {
    reply.dispose();
  }
});

test('relocated Archon callback preserves numeric schema key identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-key-privacy-'));
  roots.push(root);
  const artifact = await packageRuntime('archon', join(root, 'installed'));
  const { createProtectedModelTransport } = await import(
    pathToFileURL(join(artifact.root, 'integrations/archon/model-transport.ts'))
      .href
  );
  let callback;
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        const properties = request.tools[0].inputSchema.properties;
        const originalKeys = ['3', '12'];
        const protectedKeys = Object.keys(properties);
        const protectedName = protectedKeys.find(
          (key) => !originalKeys.includes(key),
        );
        assert(protectedName);
        assert.deepEqual(protectedKeys, ['12', protectedName]);
        const args = { 12: 'plain-value', [protectedName]: 'protected-value' };
        assert.deepEqual(Object.keys(args), protectedKeys);
        await callTool(request.tools[0].name, args);
        return 'done';
      },
    },
    {
      policy: { literals: [{ value: '3', kind: 'CREDENTIAL' }] },
      tools: [
        {
          description: 'Synthetic numeric fields',
          inputSchema: {
            type: 'object',
            properties: { 3: { type: 'string' }, 12: { type: 'string' } },
          },
          async execute(args) {
            callback = args;
            return [];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({ prompt: 'Use the synthetic tool.' });
  reply.dispose();
  assert.deepEqual(Object.keys(callback), ['3', '12']);
  assert.notEqual(callback['3'], 'plain-value');
  assert.equal(callback['12'], 'plain-value');
});

test('relocated Archon adapter protects final request, diagnostics and artifacts with honest native coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-adapter-privacy-'));
  roots.push(root);
  const artifact = await packageRuntime('archon', join(root, 'installed'));
  const { executeCodex, createCodexModelTransport } = await import(
    pathToFileURL(join(artifact.root, 'integrations/archon/live-codex.ts')).href
  );
  assert.equal(typeof createCodexModelTransport, 'function');
  const { actorConfiguration, configurationFacts } = await import(
    pathToFileURL(
      join(artifact.root, 'integrations/archon/live-permissions.ts'),
    ).href
  );
  const executable = join(root, 'fake-codex');
  const base = {
    layers: [
      {
        name: { type: 'system', file: '/synthetic/config.toml' },
        version: 'synthetic',
        config: {},
      },
    ],
  };
  const launch = {
    role: 'build',
    task: 'charge-cost',
    executable,
    bun: process.execPath,
    cwd: root,
    context: root,
    profileArguments: ['--permission-profile', 'temari_build'],
    environment: { PATH: '/usr/bin:/bin', HOME: root },
    observation: {
      configurationSha256: configurationFacts(base, { requirements: null })
        .sha256,
    },
  };
  const config = {
    layers: [
      ...base.layers,
      {
        name: { type: 'sessionFlags' },
        version: 'session',
        config: actorConfiguration(launch),
      },
    ],
  };
  const wirePath = join(root, 'wire.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line); if(!message.id) continue;
 appendFileSync(${JSON.stringify(wirePath)}, line+'\\n');
 const p=message.params;
 if(message.method==='initialize') emit({id:message.id,result:{}});
 else if(message.method==='config/read') emit({id:message.id,result:${JSON.stringify(config)}});
 else if(message.method==='configRequirements/read') emit({id:message.id,result:{requirements:null}});
 else if(message.method==='model/list') emit({id:message.id,result:{data:[{id:'test-model',model:'test-model',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}});
 else if(message.method==='thread/start') emit({id:message.id,result:{thread:{id:'private-test-thread'},cwd:p.cwd,model:p.model,modelProvider:'openai',reasoningEffort:'high',approvalPolicy:'never',activePermissionProfile:{id:'temari_build',extends:null}}});
 else if(message.method==='mcpServerStatus/list') emit({id:message.id,result:{data:[],nextCursor:null}});
 else if(message.method==='turn/start') {
  const turn={id:'private-test-turn',status:'inProgress',items:[]};
  emit({id:message.id,result:{turn}});
  emit({method:'turn/started',params:{threadId:'private-test-thread',turn}});
  process.stderr.write('DIAGNOSTIC-SECRET-CANARY');
  emit({method:'item/commandExecution/outputDelta',params:{threadId:'private-test-thread',turnId:turn.id,delta:'EVENT-SECRET-CANARY'}});
  const item={id:'reply',type:'agentMessage',text:JSON.stringify({answer:p.input[0].text,email:'fresh@example.invalid',password:'RESPONSE-SECRET-CANARY'})};
  emit({method:'item/completed',params:{threadId:'private-test-thread',turnId:turn.id,item}});
  emit({method:'turn/completed',params:{threadId:'private-test-thread',turn:{...turn,status:'completed',error:null,items:[item]}}});
 }
}
`,
    { mode: 0o755 },
  );
  const schema = join(root, 'schema.json');
  const schemaCanaries = [
    'Quoted "Synthetic" Person',
    'Back\\slash Person',
    'Line\nBreak Person',
  ];
  await writeFile(
    schema,
    JSON.stringify({
      type: 'object',
      description: `Contact schema@example.invalid: ${schemaCanaries.join(' / ')}`,
      properties: {
        email: { type: 'string' },
        password: { type: 'string' },
        contact: { type: 'string', enum: schemaCanaries },
      },
    }),
  );
  const lastMessage = join(root, 'last.json');
  const promptArtifact = join(root, 'prompt.txt');
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let logs = '';
  process.stdout.write = process.stderr.write = (value) => {
    logs += String(value);
    return true;
  };
  let result;
  try {
    result = await executeCodex({
      launch,
      executable,
      cwd: root,
      role: 'build',
      model: 'test-model',
      reasoning: 'high',
      prompt: 'Contact person@example.invalid; password=REQUEST-SECRET-CANARY',
      schema,
      lastMessage,
      promptArtifact,
      privacyPolicy: {
        literals: schemaCanaries.map((value) => ({ value, kind: 'PERSON' })),
      },
    });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.equal(result.privacyCoverage, 'explicit-request-only');
  const wire = await readFile(wirePath, 'utf8');
  const dispatchedSchema = wire
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((message) => message.method === 'turn/start').params.outputSchema;
  assert.deepEqual(dispatchedSchema.properties.email, { type: 'string' });
  assert.deepEqual(dispatchedSchema.properties.password, { type: 'string' });
  for (const canary of schemaCanaries) {
    assert.equal(dispatchedSchema.description.includes(canary), false);
    assert.equal(
      dispatchedSchema.properties.contact.enum.includes(canary),
      false,
    );
  }
  const artifacts =
    (await readFile(lastMessage, 'utf8')) +
    (await readFile(promptArtifact, 'utf8'));
  for (const canary of [
    'person@example.invalid',
    'schema@example.invalid',
    'REQUEST-SECRET-CANARY',
  ])
    assert.equal(wire.includes(canary), false);
  for (const canary of [
    'DIAGNOSTIC-SECRET-CANARY',
    'EVENT-SECRET-CANARY',
    'RESPONSE-SECRET-CANARY',
    'person@example.invalid',
    'fresh@example.invalid',
  ]) {
    assert.equal(logs.includes(canary), false);
    assert.equal(artifacts.includes(canary), false);
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
});
