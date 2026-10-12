import { DomainError } from './errors';

const REF_RE = /^\s*(?:([A-Za-z][A-Za-z0-9]{0,9})-)?#?(\d{1,9})\s*$/;

export function parseTaskRef(input: string): { key: string | null; number: number } {
  const m = REF_RE.exec(input ?? '');
  if (!m) throw new DomainError('validation', `Invalid task reference "${input}". Use the form WB-42.`);
  return { key: m[1] ? m[1].toUpperCase() : null, number: Number(m[2]) };
}

export function formatRef(key: string, number: number): string {
  return `${key}-${number}`;
}
