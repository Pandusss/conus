import { DomainError } from '@conus/core';
import type { z } from 'zod';

// Input is `unknown` so T is inferred from the schema's output only (defaults like `.default()` make the
// input type optional while the parsed output is required).
export function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new DomainError('validation', 'Invalid request body.', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
