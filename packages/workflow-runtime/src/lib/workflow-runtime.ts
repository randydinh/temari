import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Lane = 'portable' | 'archon';
export interface RuntimeFile {
  readonly path: string;
  readonly lane: Lane;
  readonly sourceSha256: string;
  readonly artifactSha256: string;
  readonly executable: boolean;
  readonly transformation: string | null;
}
export interface Inventory {
  readonly schema: 1;
  readonly sourceRevision: string;
  readonly files: readonly RuntimeFile[];
}

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const payloadRoot = join(packageRoot, 'assets/v4.1');
const receiptName = '.temari-distribution.json';
const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const within = (parent: string, child: string) =>
  child === parent || child.startsWith(parent + sep);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join() !== [...expected].sort().join())
    throw new Error('Unknown or missing inventory fields');
}

export function parseInventory(value: unknown): Inventory {
  const raw = object(value);
  keys(raw, ['schema', 'sourceRevision', 'files']);
  if (
    raw.schema !== 1 ||
    typeof raw.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(raw.sourceRevision) ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0
  )
    throw new Error('Invalid inventory header');
  const paths = new Set<string>();
  const files = raw.files.map((item: unknown): RuntimeFile => {
    const file = object(item);
    keys(file, [
      'path',
      'lane',
      'sourceSha256',
      'artifactSha256',
      'executable',
      'transformation',
    ]);
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(file.path))
      throw new Error('Invalid inventory path');
    const parts = file.path.split('/');
    // Windows lstat cannot report the executable bit recorded by Git.
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['node_modules', '.git', 'evidence', 'eval-replication'].includes(
            part.toLowerCase(),
          ),
      ) ||
      /opconnect/i.test(file.path)
    )
      throw new Error(`Excluded or unsafe path: ${file.path}`);
    const folded = file.path.toLowerCase();
    if (
      paths.has(folded) ||
      [...paths].some(
        (path) =>
          folded.startsWith(path + '/') || path.startsWith(folded + '/'),
      )
    )
      throw new Error(`Path collision: ${file.path}`);
    paths.add(folded);
    if (
      file.lane !==
      (file.path.startsWith('integrations/archon/') ? 'archon' : 'portable')
    )
      throw new Error(`Wrong distribution lane: ${file.path}`);
    if (
      typeof file.sourceSha256 !== 'string' ||
      !digestPattern.test(file.sourceSha256) ||
      typeof file.artifactSha256 !== 'string' ||
      !digestPattern.test(file.artifactSha256)
    )
      throw new Error(`Invalid hash: ${file.path}`);
    if (
      typeof file.executable !== 'boolean' ||
      !(
        file.transformation === null ||
        (typeof file.transformation === 'string' && file.transformation.trim())
      )
    )
      throw new Error(`Invalid provenance: ${file.path}`);
    if (
      file.sourceSha256 !== file.artifactSha256 &&
      file.transformation === null
    )
      throw new Error(`Unexplained transformation: ${file.path}`);
    return file as unknown as RuntimeFile;
  });
  if (
    files.map((file) => file.path).join('\n') !==
    files
      .map((file) => file.path)
      .sort()
      .join('\n')
  )
    throw new Error('Inventory paths must be sorted');
  return { schema: 1, sourceRevision: raw.sourceRevision, files };
}

export async function readInventory(root = packageRoot): Promise<Inventory> {
  if (!(await lstat(join(root, 'provenance.json'))).isFile())
    throw new Error('Inventory must be a regular file');
  return parseInventory(
    JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8')),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalTarget(path: string): Promise<string> {
  let ancestor = resolve(path);
  while (!(await exists(ancestor))) ancestor = dirname(ancestor);
  return resolve(await realpath(ancestor), relative(ancestor, path));
}

async function filePaths(root: string, prefix = ''): Promise<string[]> {
  if (!(await lstat(join(root, prefix))).isDirectory())
    throw new Error(`Not a regular directory: ${prefix || root}`);
  const paths: string[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? prefix + '/' + name : name;
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) paths.push(...(await filePaths(root, path)));
    else if (stat.isFile()) paths.push(path);
    else throw new Error(`Symlink or special file rejected: ${path}`);
  }
  return paths.sort();
}

export async function checkPayload(
  root: string,
  files: readonly RuntimeFile[],
  artifact = false,
): Promise<void> {
  const paths = await filePaths(root);
  const expected = [
    ...files.map((file) => file.path),
    ...(artifact ? [receiptName] : []),
  ].sort();
  if (paths.join('\n') !== expected.join('\n'))
    throw new Error('Payload has missing or unknown files');
  for (const file of files) {
    const path = join(root, file.path);
    if (sha256(await readFile(path)) !== file.artifactSha256)
      throw new Error(`Hash mismatch: ${file.path}`);
    if (
      process.platform !== 'win32' &&
      Boolean((await lstat(path)).mode & 0o111) !== file.executable
    )
      throw new Error(`Executable mode mismatch: ${file.path}`);
  }
}

function selected(inventory: Inventory, lane: Lane): readonly RuntimeFile[] {
  if (lane !== 'portable' && lane !== 'archon')
    throw new Error('Lane must be portable or archon');
  return inventory.files.filter(
    (file) => file.lane === 'portable' || lane === 'archon',
  );
}

function receipt(inventory: Inventory, lane: Lane) {
  const files = selected(inventory, lane);
  return {
    owner: '@temari/workflow-runtime',
    schema: 1,
    lane,
    sourceRevision: inventory.sourceRevision,
    digest: sha256(JSON.stringify(files)),
    files,
  };
}

export async function checkArtifact(
  root: string,
  inventory: Inventory,
  lane: Lane,
): Promise<void> {
  const expected = receipt(inventory, lane);
  await checkPayload(root, expected.files, true);
  const actual = JSON.parse(await readFile(join(root, receiptName), 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      'Distribution receipt does not match the selected inventory',
    );
}

export async function packageRuntime(
  lane: Lane,
  output?: string,
  root = packageRoot,
): Promise<{
  root: string;
  lane: Lane;
  digest: string;
  files: number;
  status: 'created' | 'unchanged';
}> {
  const inventory = await readInventory(root);
  const source = join(root, 'assets/v4.1');
  if (!(await lstat(join(root, 'assets'))).isDirectory())
    throw new Error('Assets must be a regular directory');
  await checkPayload(source, inventory.files);
  const record = receipt(inventory, lane);
  const target = output ?? join(root, 'dist', `${lane}-${record.digest}`);
  if (!isAbsolute(target) || resolve(target) === dirname(resolve(target)))
    throw new Error('Output must be an absolute non-root path');
  const sourceCanonical = await realpath(source);
  if (
    within(sourceCanonical, resolve(target)) ||
    within(resolve(target), sourceCanonical)
  )
    throw new Error('Output overlaps the payload');
  const destination = await canonicalTarget(target);
  if (
    within(sourceCanonical, destination) ||
    within(destination, sourceCanonical)
  )
    throw new Error('Output overlaps the payload');
  const result = {
    root: destination,
    lane,
    digest: record.digest,
    files: record.files.length,
  };
  if (await exists(destination)) {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error('Output symlink rejected');
    await checkArtifact(destination, inventory, lane);
    return { ...result, status: 'unchanged' };
  }
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), '.temari-stage-'));
  let reserved = false;
  try {
    for (const file of record.files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true });
      await copyFile(join(source, file.path), path);
      await chmod(path, file.executable ? 0o755 : 0o644);
    }
    await writeFile(
      join(stage, receiptName),
      JSON.stringify(record, null, 2) + '\n',
      { flag: 'wx' },
    );
    await checkArtifact(stage, inventory, lane);
    await mkdir(destination);
    reserved = true;
    await rename(stage, destination);
    reserved = false;
    return { ...result, status: 'created' };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (reserved) await rmdir(destination).catch(() => undefined);
  }
}
