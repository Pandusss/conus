export type DomainErrorCode =
  | 'not_found' | 'invalid_transition' | 'conflict_claimed' | 'conflict_version'
  | 'validation' | 'unauthorized' | 'forbidden';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
