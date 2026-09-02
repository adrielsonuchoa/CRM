import fs from 'fs';
import path from 'path';

const envPaths = [
  path.join(process.cwd(), '.env.local'),
  path.join(process.cwd(), '.env'),
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readRuntimeEnv(key: string): string {
  const current = process.env[key]?.trim();
  if (current) return current;

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;

    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.*)$`, 'm'));
      if (match && match[1]) {
        return match[1].trim().replace(/^['"]|['"]$/g, '').trim();
      }
    } catch {
      // Ignore read errors and continue to the next candidate.
    }
  }

  return '';
}

export function getRuntimeEnv(key: string): string {
  return readRuntimeEnv(key);
}

export function isRuntimeEnvSet(key: string): boolean {
  return !!readRuntimeEnv(key);
}
