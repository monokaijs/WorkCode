import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = path.join(root, 'dist/code');
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(site, 'THIRD_PARTY_NOTICES.md'));
const entries = await readdir(site, { recursive: true, withFileTypes: true });
const files = entries.filter(entry => entry.isFile() && entry.name !== 'sw.js')
  .map(entry => path.relative(site, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
const version = createHash('sha256');
for (const name of files) {
  version.update(name + '\0').update(createHash('sha256').update(await readFile(path.join(site, name))).digest());
}
const worker = await readFile(path.join(root, 'apps/code/sw.template.js'), 'utf8');
await writeFile(path.join(site, 'sw.js'), worker.replace('__VERSION__', version.digest('hex')).replace('__FILES__', JSON.stringify(files)));
