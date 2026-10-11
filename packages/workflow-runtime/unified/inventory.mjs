import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function inventory(root) {
  assert(isAbsolute(root), 'Distribution root must be absolute.');
  assert((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink());
  const physical = await realpath(root), records = [];
  let total = 0;
  async function walk(path = '') {
    for (const name of (await readdir(join(root, path))).sort()) {
      assert(!/[\\:\x00-\x1f]/u.test(name), 'Unsafe distribution member.');
      const member = path ? `${path}/${name}` : name;
      if (member === 'UNIFIED.json') continue;
      const location = join(root, member), stat = await lstat(location);
      assert(records.length < 100000, 'Distribution inventory exceeds its bound.');
      if (stat.isSymbolicLink()) {
        assert(member.startsWith('runtime/'), `Unexpected distribution symlink: ${member}`);
        const target = await readlink(location);
        const componentRoot = join(physical, ...member.split('/').slice(0, 2));
        assert(!isAbsolute(target) && inside(componentRoot, await realpath(location)), `Runtime symlink escapes distribution component: ${member}`);
        records.push({ path: member, kind: 'symlink', target });
      } else if (stat.isDirectory()) {
        records.push({ path: member, kind: 'directory' });
        await walk(member);
      } else {
        assert(stat.isFile() && stat.size <= 256 * 1024 * 1024, `Invalid distribution file: ${member}`);
        total += stat.size;
        assert(total <= 2 * 1024 * 1024 * 1024, 'Distribution exceeds its byte bound.');
        records.push({ path: member, kind: 'file', bytes: stat.size, sha256: digest(await readFile(location)), executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  await walk();
  return records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function verifyDistribution(root, expectedSha256) {
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/u, 'An independently supplied distribution digest is required.');
  const path = join(root, 'UNIFIED.json'), stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 32 * 1024 * 1024, 'Invalid unified manifest.');
  const bytes = await readFile(path);
  assert.equal(digest(bytes), expectedSha256, 'Unified manifest digest differs.');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.kind, 'temari-unified-distribution');
  assert(isDeepStrictEqual(await inventory(root), manifest.files), 'Unified distribution files changed.');
  for (const component of ['node', 'python', 'archon']) {
    const selected = manifest.assets?.[component];
    assert(selected && typeof selected.executable === 'string');
    assert(inside(root, join(root, selected.executable)), 'Runtime executable escapes distribution.');
    const actual = manifest.files.find((f) => f.path === selected.executable);
    assert(actual?.kind === 'file' || actual?.kind === 'symlink', 'Runtime executable is not inventoried.');
  }
  return manifest;
}
