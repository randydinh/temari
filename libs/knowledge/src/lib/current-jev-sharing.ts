/** Current Registrar policy is checked for every hosted Jev attempt. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadArchivePublication } from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { canonical, list, object, text } from './codec.js';

export type CurrentJevSharing =
  'allowed' | 'current-local-only' | 'policy-unavailable';

const guardBrand: unique symbol = Symbol('temari-current-jev-sharing');
const issuedGuards = new WeakSet<object>();
export interface CurrentJevSharingGuard {
  readonly [guardBrand]: true;
  readonly check: () => Promise<CurrentJevSharing>;
}
function issueGuard(
  check: () => Promise<CurrentJevSharing>,
): CurrentJevSharingGuard {
  const guard = Object.freeze({ [guardBrand]: true as const, check });
  issuedGuards.add(guard);
  return guard;
}
export async function checkCurrentJevSharing(
  guard: CurrentJevSharingGuard | undefined,
): Promise<CurrentJevSharing> {
  if (!guard || !issuedGuards.has(guard)) return 'policy-unavailable';
  try {
    const result = await guard.check();
    return result === 'allowed' || result === 'current-local-only'
      ? result
      : 'policy-unavailable';
  } catch {
    return 'policy-unavailable';
  }
}

/** The checker closes over exact pinned publications; callers cannot supply row claims. */
export function currentJevSharingGuard(
  publicationPaths: readonly string[],
  sourceIds: readonly string[],
): CurrentJevSharingGuard {
  const paths = [...publicationPaths];
  const ids = [...sourceIds];
  assert(paths.length >= 1 && paths.length <= 8);
  assert(ids.length >= 1 && ids.length <= 8);
  assert.equal(new Set(ids).size, ids.length);
  return issueGuard(async () => {
    try {
      const publications = await Promise.all(paths.map(loadArchivePublication));
      const selected = ids.map((id) => {
        const matches = publications.filter(
          (publication) => publication.source.id === id,
        );
        assert.equal(
          matches.length,
          1,
          'One pinned publication per selected source',
        );
        return matches[0];
      });
      const transport = await archiveTransport(selected[0].transport);
      assert(
        selected.every(
          (publication) =>
            canonical(publication.transport) ===
            canonical(selected[0].transport),
        ),
      );
      for (const publication of selected) {
        assert.equal(transport.implementation, publication.implementation);
        assert.equal(transport.protocolSha256, publication.protocolSha256);
      }
      const rows = list((await transport.invoke('list', []))['sources']).map(
        object,
      );
      let localOnly = false;
      for (const publication of selected) {
        const source = publication.source;
        const matches = rows.filter((row) => row['id'] === source.id);
        assert.equal(matches.length, 1, 'Current source admission unavailable');
        const row = matches[0];
        assert.equal(row['enabled'], true, 'Current source disabled');
        assert.equal(pathToFileURL(text(row['root'])).href, source.locator);
        assert(!['testmo', 'shortcut', 'notion'].includes(String(row['kind'])));
        assert(typeof row['recursive'] === 'boolean');
        // Sharing is deliberately absent from this registration identity.
        assert.equal(
          canonical({
            source,
            root: row['root'],
            kind: row['kind'] ?? 'local',
            recursive: row['recursive'],
            exclude: list(row['exclude']).map(text),
            enabled: true,
          }),
          publication.registration,
          'Pinned registration changed',
        );
        const sharing = row['sharing'];
        assert(
          sharing === 'registered-sources' || sharing === 'local-only',
          'Current sharing policy unavailable',
        );
        if (sharing === 'local-only') localOnly = true;
      }
      return localOnly ? 'current-local-only' : 'allowed';
    } catch {
      return 'policy-unavailable';
    }
  });
}
