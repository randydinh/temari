import type {
  InvestigationRequest,
  InvestigationTask,
  KnowledgeSource,
  WorkerBrief,
} from '@temari/contracts';
import type { LocalRegistrarOptions } from '@temari/knowledge';
import type {
  CommandJudgmentConfiguration,
  CommandJudgmentRole,
  ConversationDraftCommand,
} from './index.js';

export interface PilotConfiguration {
  readonly schema: 1;
  readonly registrar: Omit<LocalRegistrarOptions, 'onCommand'>;
  readonly judgments: CommandJudgmentConfiguration;
  readonly command: ConversationDraftCommand;
}

function invalid(): never {
  throw new Error('Invalid pilot configuration shape');
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = object(value);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    return invalid();
  return result;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalid();
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const option of choices) if (value === option) return option;
  return invalid();
}

function array<T>(value: unknown, decode: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(decode) : invalid();
}

function strings(value: unknown): string[] {
  return array(value, string);
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, item]) => [key, string(item)]),
  );
}

function task(value: unknown): InvestigationTask {
  const v = fields(value, ['id', 'directory', 'authorityRef']);
  return {
    id: string(v['id']),
    directory: string(v['directory']),
    authorityRef: string(v['authorityRef']),
  };
}

function source(value: unknown): KnowledgeSource {
  const v = fields(value, ['provider', 'id', 'locator']);
  return {
    provider: string(v['provider']),
    id: string(v['id']),
    locator: string(v['locator']),
  };
}

function brief(value: unknown): WorkerBrief {
  const v = fields(value, [
    'goal',
    'context',
    'scope',
    'acceptanceCriteria',
    'verificationCommand',
    'reportFormat',
    'forbiddenActions',
  ]);
  return {
    goal: string(v['goal']),
    context: string(v['context']),
    scope: string(v['scope']),
    acceptanceCriteria: strings(v['acceptanceCriteria']),
    verificationCommand:
      v['verificationCommand'] === null
        ? null
        : string(v['verificationCommand']),
    reportFormat: choice(v['reportFormat'], ['json', 'markdown']),
    forbiddenActions: strings(v['forbiddenActions']),
  };
}

function request(value: unknown): InvestigationRequest {
  const v = fields(value, [
    'scope',
    'query',
    'selections',
    'questions',
    'budget',
  ]);
  const budget = fields(v['budget'], [
    'discoveryPages',
    'documentsPerPage',
    'readPagesPerDocument',
    'codePointsPerRead',
    'responseBytes',
    'contextCodePoints',
  ]);
  return {
    scope: array(v['scope'], source),
    query: string(v['query']),
    selections: array(v['selections'], (item) => {
      const selection = fields(item, ['id', 'document', 'role', 'requires']);
      const document = fields(selection['document'], ['source', 'path']);
      return {
        id: string(selection['id']),
        document: {
          source: source(document['source']),
          path: string(document['path']),
        },
        role: choice(selection['role'], [
          'plan',
          'update',
          'constraint',
          'dependency',
        ]),
        requires: strings(selection['requires']),
      };
    }),
    questions: strings(v['questions']),
    budget: {
      discoveryPages: number(budget['discoveryPages']),
      documentsPerPage: number(budget['documentsPerPage']),
      readPagesPerDocument: number(budget['readPagesPerDocument']),
      codePointsPerRead: number(budget['codePointsPerRead']),
      responseBytes: number(budget['responseBytes']),
      contextCodePoints: number(budget['contextCodePoints']),
    },
  };
}

function command(value: unknown): ConversationDraftCommand {
  const kind = choice(object(value)['kind'], ['start', 'resume']);
  if (kind === 'resume') {
    const v = fields(value, ['kind', 'task', 'destination']);
    return {
      kind,
      task: task(v['task']),
      destination: string(v['destination']),
    };
  }
  const v = fields(value, ['kind', 'intent']);
  const intent = fields(v['intent'], [
    'task',
    'brief',
    'request',
    'destination',
    'title',
    'authority',
  ]);
  const authority = fields(intent['authority'], ['path', 'sha256']);
  return {
    kind,
    intent: {
      task: task(intent['task']),
      brief: brief(intent['brief']),
      request: request(intent['request']),
      destination: string(intent['destination']),
      title: string(intent['title']),
      authority: {
        path: string(authority['path']),
        sha256: string(authority['sha256']),
      },
    },
  };
}

function role(value: unknown): CommandJudgmentRole {
  const v = fields(value, [
    'executable',
    'args',
    'cwd',
    'environment',
    'artifacts',
    'behaviorRevision',
    'service',
    'timeoutMs',
  ]);
  const service = fields(v['service'], ['id', 'configurationRevision']);
  return {
    executable: string(v['executable']),
    args: strings(v['args']),
    cwd: string(v['cwd']),
    environment: stringMap(v['environment']),
    artifacts: stringMap(v['artifacts']),
    behaviorRevision: string(v['behaviorRevision']),
    service: {
      id: string(service['id']),
      configurationRevision: string(service['configurationRevision']),
    },
    timeoutMs: number(v['timeoutMs']),
  };
}

export function decodePilotConfiguration(value: unknown): PilotConfiguration {
  const v = fields(value, ['schema', 'registrar', 'judgments', 'command']);
  if (v['schema'] !== 1) return invalid();
  const registrar = fields(
    v['registrar'],
    ['python', 'registrarSource', 'preparation', 'readScope'],
    ['timeoutMs', 'maxStdoutBytes'],
  );
  const judgments = fields(v['judgments'], ['instance', 'roles']);
  const roles = fields(judgments['roles'], ['assess', 'propose', 'review']);
  return {
    schema: 1,
    registrar: {
      python: string(registrar['python']),
      registrarSource: string(registrar['registrarSource']),
      preparation: string(registrar['preparation']),
      readScope: choice(registrar['readScope'], ['source-root']),
      ...(Object.hasOwn(registrar, 'timeoutMs')
        ? { timeoutMs: number(registrar['timeoutMs']) }
        : {}),
      ...(Object.hasOwn(registrar, 'maxStdoutBytes')
        ? { maxStdoutBytes: number(registrar['maxStdoutBytes']) }
        : {}),
    },
    judgments: {
      instance: string(judgments['instance']),
      roles: {
        assess: role(roles['assess']),
        propose: role(roles['propose']),
        review: role(roles['review']),
      },
    },
    command: command(v['command']),
  };
}
