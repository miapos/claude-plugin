#!/usr/bin/env node
// Copies the general miaPOS skills into skills/miapos-lovable-checkout/references/shared/.
//
// Lovable imports one skill directory from GitHub, so the Lovable skill cannot point at its
// sibling skills. The copies keep one source of truth: edit the general skills, then run
//   node scripts/sync-shared.mjs          write the copies
//   node scripts/sync-shared.mjs --check  exit 1 if a copy is out of date (CI)

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = 'skills/miapos-lovable-checkout/references/shared';

const SOURCES = {
  'integrate-miapos-checkout.md': 'skills/integrate-miapos-checkout/SKILL.md',
  'api.md': 'skills/integrate-miapos-checkout/references/api.md',
  'examples.md': 'skills/integrate-miapos-checkout/references/examples.md',
  'verify-miapos-callback.md': 'skills/verify-miapos-callback/SKILL.md',
  'miapos-go-live.md': 'skills/miapos-go-live/SKILL.md',
};

// Paths and skill names as they read from inside the Lovable skill directory.
const REWRITES = [
  [/`references\/(api|examples)\.md`/g, '`references/shared/$1.md`'],
  [/(?:the )?skill \*\*(integrate-miapos-checkout|verify-miapos-callback|miapos-go-live)\*\*/g, '`references/shared/$1.md`'],
];

function render(source) {
  let text = readFileSync(join(root, source), 'utf8');
  if (text.startsWith('---\n')) text = text.slice(text.indexOf('\n---\n', 4) + 5).replace(/^\n+/, '');
  for (const [pattern, replacement] of REWRITES) text = text.replace(pattern, replacement);
  return `<!-- Generated from ${source} by scripts/sync-shared.mjs. Do not edit this copy. -->\n\n${text}`;
}

const check = process.argv.includes('--check');
const dir = join(root, target);
const stale = [];
if (!check) mkdirSync(dir, { recursive: true });

for (const [name, source] of Object.entries(SOURCES)) {
  const path = join(dir, name);
  const want = render(source);
  const have = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (have === want) continue;
  if (check) stale.push(name);
  else writeFileSync(path, want);
}

const extra = existsSync(dir) ? readdirSync(dir).filter((f) => !(f in SOURCES)) : [];
if (extra.length) stale.push(...extra.map((f) => `${f} (no source)`));

if (check && stale.length) {
  console.error(`Out of date in ${target}: ${stale.join(', ')}. Run: node scripts/sync-shared.mjs`);
  process.exit(1);
}
console.log(check ? `${target}: up to date` : `${target}: ${Object.keys(SOURCES).length} files written`);
