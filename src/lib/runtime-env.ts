export function readRuntimeEnv(key: string): string {
  return process.env[key]?.trim() ?? '';
}

export function getRuntimeEnv(key: string): string {
  return readRuntimeEnv(key);
}

export function isRuntimeEnvSet(key: string): boolean {
  return !!readRuntimeEnv(key);
}
