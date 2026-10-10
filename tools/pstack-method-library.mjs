import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';

export const PSTACK_METHOD_PREFIX = 'method/pstack';
export const PSTACK_PROVENANCE_SOURCE =
  'packages/workflow-runtime/provenance.json';
export const PSTACK_ASSET_SOURCE = 'packages/workflow-runtime/assets/v4.1';
const metadataPaths = ['catalog.json', 'provenance.json'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safePath(path) {
  assert(
    typeof path === 'string' &&
      /^[A-Za-z0-9_./-]+$/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part &&
            part !== '.' &&
            part !== '..' &&
            !['node_modules', '.git', 'evidence', 'eval-replication'].includes(
              part.toLowerCase(),
            ),
        ) &&
      !/opconnect/i.test(path),
    `Unsafe method inventory path: ${path}`,
  );
  return path;
}

function exactKeys(value, keys, label) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `Invalid ${label}`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `Invalid ${label} fields`,
  );
}

/** The source provenance is the allowlist; neither traversal nor discovery adds files. */
export function pstackMethodInventory(bytes) {
  const provenance = JSON.parse(bytes.toString('utf8'));
  exactKeys(provenance, ['schema', 'sourceRevision', 'files'], 'provenance');
  assert.equal(provenance.schema, 1);
  assert.match(provenance.sourceRevision, /^[a-f0-9]{40}$/);
  assert(Array.isArray(provenance.files), 'Invalid provenance files');
  const seen = new Set(metadataPaths);
  for (const file of provenance.files) {
    exactKeys(
      file,
      [
        'path',
        'lane',
        'sourceSha256',
        'artifactSha256',
        'executable',
        'transformation',
      ],
      'provenance entry',
    );
    safePath(file.path);
    const folded = file.path.toLowerCase();
    assert(
      ![...seen].some(
        (prior) =>
          prior === folded ||
          prior.startsWith(`${folded}/`) ||
          folded.startsWith(`${prior}/`),
      ),
      `Duplicate or conflicting method inventory path: ${file.path}`,
    );
    seen.add(folded);
    assert.equal(
      file.lane,
      file.path.startsWith('integrations/archon/') ? 'archon' : 'portable',
      `Invalid lane: ${file.path}`,
    );
    assert.match(file.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(file.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof file.executable, 'boolean');
    assert(
      file.transformation === null ||
        (typeof file.transformation === 'string' && file.transformation.trim()),
      `Invalid transformation: ${file.path}`,
    );
    assert(
      file.sourceSha256 === file.artifactSha256 || file.transformation !== null,
      `Missing transformation: ${file.path}`,
    );
  }
  assert.deepEqual(
    provenance.files.map((file) => file.path),
    provenance.files.map((file) => file.path).sort(compare),
    'Method provenance inventory must be sorted',
  );
  assert(
    provenance.files.some((file) => file.lane === 'portable'),
    'Empty portable method inventory',
  );
  return provenance;
}

async function regularFile(root, path) {
  safePath(path);
  let current = root;
  const rootStat = await lstat(root);
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    `Unsafe method root: ${root}`,
  );
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    assert(!stat.isSymbolicLink(), `Method symlink not permitted: ${path}`);
    assert(
      index === parts.length - 1 ? stat.isFile() : stat.isDirectory(),
      `Nonregular method path: ${path}`,
    );
    if (index === parts.length - 1) return stat;
  }
}

function checkBytes(file, bytes) {
  assert(bytes, `Missing method inventory file: ${file.path}`);
  assert.equal(
    hash(bytes),
    file.artifactSha256,
    `Method inventory hash drift: ${file.path}`,
  );
}

function checkMode(file, stat) {
  // Git's executable flag cannot be recovered from Windows lstat.
  if (process.platform !== 'win32')
    assert.equal(
      Boolean(stat.mode & 0o111),
      file.executable,
      `Method executable-mode drift: ${file.path}`,
    );
}

// These are verification inputs outside the portable method, retained as requirements.
// Exact document/path pairs prevent a broken local reference from becoming an exemption.
const externalReferences = new Map([
  [
    'verification/verify-temari/features/closeout.md:scripts/check-host-adapters.sh',
    'Historical source-only host-adapter test; not a packaged executable.',
  ],
  [
    'verification/verify-temari/features/integration-discovery.md:scripts/check-host-adapters.sh',
    'Historical source-only host-adapter test; not a packaged executable.',
  ],
  [
    'verification/verify-temari/features/routing-chain.md:scripts/check-host-adapters.sh',
    'Historical source-only host-adapter test; not a packaged executable.',
  ],
  [
    'verification/verify-temari/features/routing-chain.md:scripts/check-routing-evals.py',
    'Historical source-only routing test; not a packaged executable.',
  ],
  [
    'verification/verify-temari/features/orch-bookkeeping.md:05-store/status.md',
    'Operator-owned legacy Orchestrate store; not method source or a completion receipt.',
  ],
  [
    'verification/verify-temari/features/plugin-catalog.md:.cursor-plugin/plugin.json',
    'Cursor installation metadata is host-owned and is not shipped by the public Codex package.',
  ],
  [
    'verification/verify-temari/features/workflow-conformance.md:initial/AGENTS.md',
    'Verification fixture input produced by the journey, not a packaged method file.',
  ],
  ...['swarm', 'how', 'interrogate', 'show-me-your-work'].map((name) => [
    `skills/poteto-mode/playbooks/multi-phase-plan.md:pstack/skills/${name}/SKILL.md`,
    'Plan skeleton uses the target repository source layout; substitute the installed method root before execution.',
  ]),
]);

function requirementKind(document, path) {
  if (document === 'skills/poteto-mode/playbooks/multi-phase-plan.md')
    return 'template-source-layout';
  if (path === '05-store/status.md') return 'runtime-output';
  if (path === 'initial/AGENTS.md') return 'fixture-pointer';
  return 'historical-source-check';
}

/** Resolve static links and concrete code paths against documents, skill roots, and package root. */
export function validatePstackReferences(files) {
  const paths = new Set(files.keys());
  const directories = new Set();
  for (const path of paths) {
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir))
      directories.add(dir);
  }
  const requirements = new Map();
  for (const [document, bytes] of files) {
    if (!document.endsWith('.md')) continue;
    const text = bytes.toString('utf8');
    const principles = [
      ...[...text.matchAll(/(?:\*\*|`)(principle-[a-z0-9-]+)(?:\*\*|`)/g)].map(
        (match) => match[1],
      ),
      ...[...text.matchAll(/\*\*([a-z][a-z-]+)\*\* principle skill/g)].map(
        (match) =>
          match[1].startsWith('principle-')
            ? match[1]
            : `principle-${match[1]}`,
      ),
    ];
    for (const name of principles)
      assert(
        paths.has(`skills/${name}/SKILL.md`),
        `Unresolved principle skill ${name} in ${document}`,
      );
    const dir = posix.dirname(document);
    let skillRoot = dir;
    while (skillRoot !== '.' && !paths.has(`${skillRoot}/SKILL.md`))
      skillRoot = posix.dirname(skillRoot);
    const targets = [
      ...[...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => ({
        target: match[1],
        kind: 'link',
      })),
      ...[
        ...text.matchAll(
          /`([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:md|py|sh|ts|json|mjs))`/g,
        ),
      ].map((match) => ({ target: match[1], kind: 'code' })),
    ];
    for (const { target: raw, kind } of targets) {
      const target = raw.split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      if (
        kind === 'link' &&
        document === 'skills/why/references/synthesizer-prompt.md' &&
        target === 'url'
      )
        continue;
      assert(
        !posix.isAbsolute(target) &&
          !target.includes('\\') &&
          !target.includes(':'),
        `Unsafe method reference ${target} in ${document}`,
      );
      // Verification feature maps also use the owning Poteto skill's path base.
      const candidates = [
        posix.join(dir, target),
        ...(kind === 'code'
          ? [
              ...(skillRoot !== '.' ? [posix.join(skillRoot, target)] : []),
              posix.normalize(target),
              posix.join('skills/poteto-mode', target),
            ]
          : []),
      ];
      if (
        candidates.some(
          (candidate) =>
            paths.has(candidate) ||
            directories.has(candidate.replace(/\/$/, '')),
        )
      )
        continue;
      const reason = externalReferences.get(`${document}:${target}`);
      assert(
        kind === 'code' && reason,
        `Unresolved method reference ${target} in ${document}`,
      );
      requirements.set(`${document}:${target}`, {
        kind: requirementKind(document, target),
        document,
        path: target,
        reason,
      });
    }
  }
  return [...requirements.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, value]) => value);
}

/** Discovery describes source availability, never lifecycle admission or host capabilities. */
export function pstackMethodCatalog(provenance, files) {
  const portable = provenance.files.filter((file) => file.lane === 'portable');
  assert.deepEqual(
    [...files.keys()].sort(),
    portable.map((file) => file.path).sort(),
    'Method catalog inventory differs from provenance',
  );
  for (const file of portable) checkBytes(file, files.get(file.path));
  const paths = [...files.keys()].sort(compare);
  const entry = (path, kind) => ({
    name: posix.basename(posix.dirname(path)),
    path,
    kind,
  });
  const skills = paths
    .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .map((path) =>
      entry(path, path.startsWith('skills/principle-') ? 'principle' : 'skill'),
    );
  return {
    schemaVersion: 1,
    sourceRevision: provenance.sourceRevision,
    inventory: {
      path: 'provenance.json',
      lane: 'portable',
      fileCount: portable.length,
    },
    availability: 'reference-only; public policy controls execution admission',
    skills,
    principles: skills.filter((skill) => skill.kind === 'principle'),
    playbooks: paths
      .filter((path) =>
        /^skills\/poteto-mode\/playbooks\/[^/]+\.md$/.test(path),
      )
      .map((path) => ({ name: posix.basename(path, '.md'), path })),
    agents: paths
      .filter((path) => /^agents\/[^/]+\.md$/.test(path))
      .map((path) => ({ name: posix.basename(path, '.md'), path })),
    hostMappings: paths
      .filter((path) =>
        /^adapters\/[^/]+\/(?:HOST\.md|skills\/[^/]+\/SKILL\.md)$/.test(path),
      )
      .map((path) => ({ host: path.split('/')[1], path })),
    externalRequirements: [
      {
        component: 'Archon',
        reason:
          'Native Archon is excluded from the portable inventory. The public canonical runtime is packaged separately; its presence does not prove native Archon or host capabilities.',
      },
      {
        component: 'Host companion tools',
        reason:
          'Cursor team kit, model roles, forge, browser control, and worker APIs require actual host availability and authorization. Method prose does not install or prove them.',
      },
      ...validatePstackReferences(files),
    ],
  };
}

export async function readPstackMethodLibrary(assetRoot, provenancePath) {
  assert(
    isAbsolute(assetRoot) && isAbsolute(provenancePath),
    'Method source paths must be absolute',
  );
  await regularFile(dirname(provenancePath), posix.basename(provenancePath));
  const provenanceBytes = await readFile(provenancePath);
  const provenance = pstackMethodInventory(provenanceBytes);
  const files = new Map();
  for (const file of provenance.files.filter(
    (file) => file.lane === 'portable',
  )) {
    const stat = await regularFile(assetRoot, file.path);
    const bytes = await readFile(join(assetRoot, file.path));
    checkBytes(file, bytes);
    checkMode(file, stat);
    files.set(file.path, bytes);
  }
  return {
    files,
    provenance: provenanceBytes,
    catalog: pstackMethodCatalog(provenance, files),
  };
}

export async function writePstackMethodLibrary(library, root) {
  assert(isAbsolute(root), 'Method destination must be absolute');
  const provenance = pstackMethodInventory(library.provenance);
  const catalog = pstackMethodCatalog(provenance, library.files);
  assert.deepEqual(
    library.catalog,
    catalog,
    'Method catalog drift before writing',
  );
  await mkdir(dirname(root), { recursive: true });
  // Never populate a pre-existing method directory or follow its interior links.
  await mkdir(root);
  const portable = provenance.files.filter((file) => file.lane === 'portable');
  for (const file of portable) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), library.files.get(file.path), {
      flag: 'wx',
    });
    await chmod(join(root, file.path), file.executable ? 0o755 : 0o644);
  }
  await writeFile(join(root, 'provenance.json'), library.provenance, {
    flag: 'wx',
  });
  await writeFile(join(root, 'catalog.json'), json(catalog), { flag: 'wx' });
}

/** Reconstruct exclusively from the relocated artifact and its externally pinned inventory. */
export async function checkPstackMethodLibrary(root) {
  assert(isAbsolute(root), 'Method artifact path must be absolute');
  const found = new Map();
  const directories = new Set();
  const walk = async (path) => {
    const stat = await lstat(path ? join(root, path) : root);
    assert(
      !stat.isSymbolicLink(),
      `Method symlink not permitted: ${path || root}`,
    );
    if (stat.isDirectory()) {
      if (path) directories.add(path);
      for (const name of await readdir(path ? join(root, path) : root))
        await walk(path ? `${path}/${name}` : name);
    } else {
      assert(stat.isFile(), `Nonregular method file: ${path}`);
      safePath(path);
      found.set(path, { bytes: await readFile(join(root, path)), stat });
    }
  };
  await walk('');
  assert(
    found.has('provenance.json') && found.has('catalog.json'),
    'Missing method metadata',
  );
  const provenance = pstackMethodInventory(found.get('provenance.json').bytes);
  const portable = provenance.files.filter((file) => file.lane === 'portable');
  const expectedDirectories = new Set();
  for (const file of portable) {
    for (
      let dir = posix.dirname(file.path);
      dir !== '.';
      dir = posix.dirname(dir)
    )
      expectedDirectories.add(dir);
  }
  assert.deepEqual(
    [...directories].sort(),
    [...expectedDirectories].sort(),
    'Method directory membership differs from portable inventory',
  );
  assert.deepEqual(
    [...found.keys()].sort(),
    [...portable.map((file) => file.path), ...metadataPaths].sort(),
    'Method artifact membership differs from portable inventory',
  );
  const files = new Map();
  for (const file of portable) {
    const { bytes, stat } = found.get(file.path);
    checkMode(file, stat);
    files.set(file.path, bytes);
  }
  const catalog = pstackMethodCatalog(provenance, files);
  assert.deepEqual(
    found.get('catalog.json').bytes,
    json(catalog),
    'Method catalog differs from reconstructed library',
  );
  return {
    catalog,
    provenanceSha256: hash(found.get('provenance.json').bytes),
    catalogSha256: hash(found.get('catalog.json').bytes),
  };
}
