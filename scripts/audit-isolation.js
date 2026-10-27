import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [/fonte[-_ ]do[-_ ]sofa/i, /fonte_sofa_/i, /fontedosofa\.com\.br/i, /\b(?:milano|veneza|atlanta|bahamas|p[oó]llo|o[aá]sis)\b/i];
const ignored = new Set(['node_modules', '.git']);
const findings = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (file === fileURLToPath(import.meta.url) || file.endsWith(`${path.sep}test${path.sep}agent.test.js`)) continue;
    if (entry.isDirectory()) walk(file);
    else if (!/\.(?:js|json|txt|md|yml|yaml|sql|example)$/i.test(entry.name) && !entry.name.startsWith('.env')) continue;
    else {
      const text = fs.readFileSync(file, 'utf8');
      forbidden.forEach((pattern) => { if (pattern.test(text)) findings.push(`${path.relative(root, file)}: ${pattern}`); });
    }
  }
}
walk(root);
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log('Isolation audit passed: no Fonte do Sofa identifiers or catalog models found.');
