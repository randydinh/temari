import { createService } from './service.js';
import { loadWindowsToken } from './credential.js';
loadWindowsToken();
const service = createService({ writeEnabled: false });
try {
  const statuses = await service.call('testmo_metadata', { kind: 'statuses' });
  const cases = await service.call('testmo_list_cases', { page: 1 });
  if (!Array.isArray(statuses.result) || !Array.isArray(cases.result))
    throw new Error('Unexpected API response shape');
  if (cases.result.some((c) => c.project_id !== service.scope.projectId))
    throw new Error('Unexpected case project ownership');
  console.log(
    JSON.stringify({
      verified_at: new Date().toISOString(),
      instance: new URL(service.scope.baseUrl).hostname,
      project_id: service.scope.projectId,
      mode: 'read-only',
      statuses: statuses.result.length,
      first_page_cases: cases.result.length,
      has_more_cases: Boolean(cases.next_page),
    }),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
