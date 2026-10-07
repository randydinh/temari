import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const id = z.number().int().positive();
const text = z.string().trim().min(1).max(20000);
const key = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
const page = { page: id.default(1) };
const fields = z.record(
  z.string().regex(/^custom_[a-zA-Z0-9_]+$/),
  z.union([
    z.string().max(50000),
    z.number(),
    z.boolean(),
    z.null(),
    z
      .array(
        z
          .object({
            text1: z.string(),
            text2: z.string().optional(),
            text3: z.string(),
            text4: z.string().optional(),
          })
          .strict(),
      )
      .max(100),
  ]),
);
export const definitions = {
  testmo_list_cases: {
    description:
      'Read one page of the configured project cases including content.',
    schema: z.object(page).strict(),
  },
  testmo_get_case: {
    description:
      'Find a case in the configured project by ID; fails if a bounded scan cannot find it.',
    schema: z.object({ case_id: id }).strict(),
  },
  testmo_metadata: {
    description:
      'Discover the configured project statuses, run states, configs, fields, templates or folders before writing.',
    schema: z
      .object({
        kind: z.enum([
          'statuses',
          'states',
          'configs',
          'fields',
          'templates',
          'folders',
        ]),
        ...page,
      })
      .strict(),
  },
  testmo_list_runs: {
    description: 'Read one page of the configured project manual runs.',
    schema: z.object(page).strict(),
  },
  testmo_get_run: {
    description: 'Read a manual run after checking project ownership.',
    schema: z.object({ run_id: id }).strict(),
  },
  testmo_list_results: {
    description:
      'Read result history. test_id is a run test ID, not a case ID.',
    schema: z.object({ run_id: id, ...page }).strict(),
  },
  testmo_operation: {
    description:
      'Read a local write receipt. Reconcile uncertain writes before using another key.',
    schema: z.object({ operation_key: key }).strict(),
  },
  testmo_create_case: {
    write: true,
    description:
      'Create one requirement-based case with a unique operation key.',
    schema: z
      .object({
        operation_key: key,
        name: text,
        folder_id: id.optional(),
        template_id: id.optional(),
        state_id: id.optional(),
        custom_fields: fields.default({}),
      })
      .strict(),
  },
  testmo_update_case: {
    write: true,
    description:
      'Update one case with expected updated_at. Omitted fields are preserved; supplied steps replace that field.',
    schema: z
      .object({
        operation_key: key,
        case_id: id,
        expected_updated_at: z.string().nullable(),
        name: text.optional(),
        custom_fields: fields.optional(),
      })
      .strict(),
  },
  testmo_create_run: {
    write: true,
    description:
      'Create a run with an explicit subset of the configured project cases, without assigning results.',
    schema: z
      .object({
        operation_key: key,
        name: text,
        state_id: id,
        case_ids: z.array(id).min(1).max(100),
        docs: text,
      })
      .strict(),
  },
  testmo_add_result: {
    write: true,
    description:
      'Append an executed result with candidate and evidence provenance. Partial checks never imply ticket acceptance. History is preserved.',
    schema: z
      .object({
        operation_key: key,
        run_id: id,
        test_id: id,
        status_id: id,
        executed: z.literal(true),
        candidate_commit: z.string().regex(/^[0-9a-f]{40}$/i),
        served_build: text,
        environment: text,
        scope: z.enum(['partial-check', 'full-ticket-acceptance']),
        assertions: text,
        remaining_scenarios: z.string().max(20000),
        evidence: z.array(text).min(1).max(20),
        ticket: z.string().trim().min(1).max(200),
        elapsed: z.number().int().nonnegative().optional(),
      })
      .strict(),
  },
};
const escape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function checkFields(actual, expected) {
  for (const [field, value] of Object.entries(expected)) {
    const got = actual[field];
    const matches = Array.isArray(value)
      ? Array.isArray(got) &&
        got.length === value.length &&
        value.every((step, i) =>
          Object.entries(step).every(([k, v]) => got[i][k] === v),
        )
      : (got && typeof got === 'object' && 'id' in got ? got.id : got) ===
        value;
    if (!matches) throw new Error(`Case readback mismatch for ${field}`);
  }
}

export function createService({
  baseUrl = process.env.TESTMO_BASE_URL,
  projectId = process.env.TESTMO_PROJECT_ID,
  token = process.env.TESTMO_TOKEN,
  writeEnabled = process.env.TESTMO_MCP_WRITE_ENABLED === 'true',
  stateDir = process.env.TESTMO_MCP_STATE_DIR ||
    join(homedir(), '.temari', 'testmo-mcp'),
  fetchImpl = fetch,
} = {}) {
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('Set TESTMO_BASE_URL to a hosted Testmo HTTPS origin.');
  }
  if (
    endpoint.protocol !== 'https:' ||
    !endpoint.hostname.endsWith('.testmo.net') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'TESTMO_BASE_URL must be a hosted Testmo HTTPS origin without credentials, port, path, query or fragment.',
    );
  if (typeof projectId === 'string' && /^\d+$/.test(projectId))
    projectId = Number(projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0)
    throw new Error('TESTMO_PROJECT_ID must be a positive safe integer.');
  baseUrl = endpoint.origin;
  const scope = Object.freeze({ baseUrl, projectId });
  const scopeId = createHash('sha256')
    .update(JSON.stringify(scope))
    .digest('hex');
  const scopedStateDir = join(stateDir, scopeId);
  async function request(path, method = 'GET', body) {
    if (!token)
      throw new Error(
        'TESTMO_TOKEN is missing. Save a token using the secure setup script.',
      );
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        `${method} failed or timed out; write outcome may be unknown. No automatic retry was performed.`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Testmo HTTP ${response.status}; remote body omitted to protect private data.`,
      );
    try {
      return await response.json();
    } catch {
      throw new Error(
        'Invalid Testmo JSON; reconcile any write before retrying.',
      );
    }
  }
  const list = (path, n = 1) => request(`${path}?page=${n}&per_page=100`);
  async function findCase(caseId) {
    for (let n = 1; n <= 100; n++) {
      const data = await list(`/projects/${projectId}/cases`, n);
      const found = data.result.find((c) => c.id === caseId);
      if (found) {
        if (found.project_id !== projectId)
          throw new Error('Case is outside the configured project');
        return found;
      }
      if (!data.next_page) break;
      if (data.next_page !== n + 1) throw new Error('Unexpected pagination');
    }
    throw new Error(
      'Case not found in bounded scan of the configured project; no write performed',
    );
  }
  async function run(runId) {
    const data = await request(`/runs/${runId}`);
    if (data.result.project_id !== projectId)
      throw new Error('Run is outside the configured project');
    return data;
  }
  async function receipt(operationKey) {
    try {
      const entry = JSON.parse(
        await readFile(join(scopedStateDir, `${operationKey}.json`), 'utf8'),
      );
      if (
        entry.scope?.baseUrl !== baseUrl ||
        entry.scope?.projectId !== projectId
      )
        throw new Error('Journal scope mismatch');
      return entry;
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw new Error('Cannot read operation journal or scope binding');
      try {
        await readFile(join(stateDir, `${operationKey}.json`));
      } catch (legacy) {
        if (legacy.code === 'ENOENT') return null;
        throw new Error('Cannot inspect legacy operation journal');
      }
      throw new Error(
        'Legacy unscoped operation exists; reconcile it before using a scoped journal.',
      );
    }
  }
  async function mutate(a, method, path, body, verify) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ scope, method, path, body }))
      .digest('hex');
    const existing = await receipt(a.operation_key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error('Operation key already used for different content');
      if (existing.state === 'verified') return existing;
      throw new Error(
        'Operation pending or uncertain. Inspect receipt and reconcile Testmo; do not resend with another key.',
      );
    }
    await mkdir(scopedStateDir, { recursive: true, mode: 0o700 });
    const file = join(scopedStateDir, `${a.operation_key}.json`);
    const entry = {
      scope,
      fingerprint,
      input_hash: createHash('sha256').update(JSON.stringify(a)).digest('hex'),
      method,
      path,
      state: 'pending',
      started_at: new Date().toISOString(),
    };
    // Exclusive reservation prevents concurrent writes and survives restart.
    await writeFile(file, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    try {
      const response = await request(path, method, body);
      entry.response = response;
      await writeFile(file, JSON.stringify(entry));
      entry.readback = await verify(response);
      entry.state = 'verified';
      await writeFile(file, JSON.stringify(entry));
      return entry;
    } catch (e) {
      entry.state = 'uncertain';
      await writeFile(file, JSON.stringify(entry));
      throw e;
    }
  }
  async function call(name, raw) {
    const def = definitions[name];
    if (!def) throw new Error('Unknown tool');
    const a = def.schema.parse(raw);
    if (def.write && !writeEnabled) throw new Error('Write mode is disabled');
    if (def.write) {
      const saved = await receipt(a.operation_key);
      if (saved) {
        if (
          saved.input_hash !==
          createHash('sha256').update(JSON.stringify(a)).digest('hex')
        )
          throw new Error('Operation key already used for different content');
        if (saved.state === 'verified') return saved;
        throw new Error(
          'Operation pending or uncertain. Inspect receipt and reconcile Testmo; do not resend with another key.',
        );
      }
    }
    switch (name) {
      case 'testmo_list_cases':
        return list(`/projects/${projectId}/cases`, a.page);
      case 'testmo_get_case':
        return { result: await findCase(a.case_id) };
      case 'testmo_metadata':
        return list(`/projects/${projectId}/${a.kind}`, a.page);
      case 'testmo_list_runs':
        return list(`/projects/${projectId}/runs`, a.page);
      case 'testmo_get_run':
        return run(a.run_id);
      case 'testmo_list_results':
        await run(a.run_id);
        return list(`/runs/${a.run_id}/results`, a.page);
      case 'testmo_operation':
        return (await receipt(a.operation_key)) || { state: 'not-started' };
      case 'testmo_create_case': {
        const { operation_key, custom_fields, ...base } = a;
        return mutate(
          a,
          'POST',
          `/projects/${projectId}/cases`,
          { cases: [{ ...base, ...custom_fields }] },
          async (r) => {
            const c = await findCase(r.result[0].id);
            if (c.name !== a.name) throw new Error('Case readback mismatch');
            checkFields(c, {
              ...custom_fields,
              ...Object.fromEntries(
                Object.entries(base).filter(([k]) => k !== 'name'),
              ),
            });
            return c;
          },
        );
      }
      case 'testmo_update_case': {
        const c = await findCase(a.case_id);
        if ((c.updated_at ?? null) !== a.expected_updated_at)
          throw new Error('Case changed since inspection; read it again');
        if (!a.name && !a.custom_fields)
          throw new Error('No update fields supplied');
        return mutate(
          a,
          'PATCH',
          `/projects/${projectId}/cases`,
          {
            ids: [a.case_id],
            ...(a.name ? { name: a.name } : {}),
            ...a.custom_fields,
          },
          async () => {
            const updated = await findCase(a.case_id);
            if (a.name && updated.name !== a.name)
              throw new Error('Case readback mismatch');
            checkFields(updated, a.custom_fields || {});
            return updated;
          },
        );
      }
      case 'testmo_create_run': {
        for (const c of a.case_ids) await findCase(c);
        const states = await request(`/projects/${projectId}/states`);
        if (!states.result.some((s) => s.id === a.state_id))
          throw new Error('Unknown workflow state');
        return mutate(
          a,
          'POST',
          `/projects/${projectId}/runs`,
          {
            name: a.name,
            state_id: a.state_id,
            include_all: false,
            cases: a.case_ids,
            docs: a.docs,
          },
          async (r) => {
            const value = await run(r.result.id);
            if (
              value.result.name !== a.name ||
              value.result.state_id !== a.state_id ||
              value.result.include_all !== false ||
              value.result.total_count !== new Set(a.case_ids).size
            )
              throw new Error('Run readback mismatch');
            return value;
          },
        );
      }
      case 'testmo_add_result': {
        await run(a.run_id);
        if (
          a.scope === 'full-ticket-acceptance' &&
          a.remaining_scenarios.trim()
        )
          throw new Error('Full acceptance cannot have remaining scenarios');
        const statuses = await request(`/projects/${projectId}/statuses`);
        const status = statuses.result.find(
          (s) => s.id === a.status_id && s.is_active === true,
        );
        if (!status) throw new Error('Unknown or inactive result status');
        if (a.scope === 'full-ticket-acceptance' && !status.is_passed)
          throw new Error('Full acceptance requires a passing status');
        const comment = `<pre>${escape(JSON.stringify({ ticket: a.ticket, candidate_commit: a.candidate_commit, served_build: a.served_build, environment: a.environment, scope: a.scope, assertions: a.assertions, remaining_scenarios: a.remaining_scenarios, evidence: a.evidence, operation_key: a.operation_key }, null, 2))}</pre>`;
        return mutate(
          a,
          'POST',
          `/runs/${a.run_id}/tests/${a.test_id}/results`,
          {
            status_id: a.status_id,
            comment,
            ...(a.elapsed !== undefined ? { elapsed: a.elapsed } : {}),
          },
          async (r) => {
            for (let n = 1; n <= 100; n++) {
              const data = await list(`/runs/${a.run_id}/results`, n);
              const value = data.result.find((x) => x.id === r.result.id);
              if (value) {
                if (
                  value.test_id !== a.test_id ||
                  value.status_id !== a.status_id ||
                  value.note !== comment
                )
                  throw new Error('Result readback mismatch');
                return value;
              }
              if (!data.next_page) break;
            }
            throw new Error('Submitted result not found in readback');
          },
        );
      }
    }
  }
  return { call, writeEnabled, scope };
}
