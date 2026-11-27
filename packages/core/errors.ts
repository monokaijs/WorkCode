export type WorkspaceErrorCode =
  | 'E_CONFLICT' | 'E_NOT_FOUND' | 'E_VALIDATION' | 'E_STORAGE' | 'E_POLICY'
  | 'E_TIMEOUT' | 'E_PROTOCOL' | 'E_UNAVAILABLE' | 'E_QUOTA'
  | `E_${string}`;

/** Consumers can branch on code without parsing human-readable messages. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export function storageError(cause: unknown, message = 'The workspace storage operation failed.'): WorkspaceError {
  if (cause instanceof WorkspaceError) return cause;
  return new WorkspaceError('E_STORAGE', message, cause);
}

export function invalid(message: string): never {
  throw new WorkspaceError('E_VALIDATION', message);
}
