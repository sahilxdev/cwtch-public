import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !['node_modules', '.git'].includes(e.name)
      ? files(`${dir}/${e.name}`)
      : e.isFile()
        ? [`${dir}/${e.name}`]
        : [],
  );
}
for (const file of [...files('extension'), ...files('relay/src')].filter((f) =>
  f.endsWith('.js'),
)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
const manifest = JSON.parse(readFileSync('extension/manifest.json'));
for (const script of manifest.content_scripts.flatMap((c) => c.js))
  readFileSync(`extension/${script}`);
console.log(`Syntax and manifest resources valid. Extension ${manifest.version}.`);
