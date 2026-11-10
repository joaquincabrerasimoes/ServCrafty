/**
 * Validate game definition JSON files against the v1 schema.
 *
 * Usage (from server/): npx tsx scripts/validate-game.ts games/*.json
 * Exit code 0 when every file is valid, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validateDefinition } from '../src/lib/gameDefinition.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npx tsx scripts/validate-game.ts <file.json> [...]');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`FAIL ${file}: cannot read/parse JSON: ${(e as Error).message}`);
    failed++;
    continue;
  }
  const r = validateDefinition(json);
  if (r.ok) {
    const fileId = basename(file).replace(/\.json$/i, '');
    if (fileId !== r.definition.id) {
      console.error(`FAIL ${file}: file name must be <id>.json (id is "${r.definition.id}")`);
      failed++;
      continue;
    }
    console.log(`ok   ${file} (${r.definition.id}: ${r.definition.name})`);
  } else {
    failed++;
    console.error(`FAIL ${file}`);
    for (const e of r.errors) console.error(`     ${e.path || '(root)'}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
