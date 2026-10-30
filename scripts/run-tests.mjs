// Roda todos os tests/*.test.ts com o test runner nativo do Node (via tsx).
// Existe porque o npm no Windows (cmd) nao expande "tests/*.test.ts".
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testDir = path.join(process.cwd(), 'tests');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('tests', name));

if (files.length === 0) {
  console.error('Nenhum arquivo tests/*.test.ts encontrado.');
  process.exit(1);
}

const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
