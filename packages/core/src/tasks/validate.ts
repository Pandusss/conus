import { DomainError } from '../errors';

export function requireText(value: string | null | undefined, field: string, max: number): string {
  const v = (value ?? '').trim();
  if (!v) throw new DomainError('validation', `${field} is required.`, { field });
  if (v.length > max) throw new DomainError('validation', `${field} must be at most ${max} characters.`, { field, max });
  return v;
}

export function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.length > max) throw new DomainError('validation', `${field} must be at most ${max} characters.`, { field, max });
  return v;
}
