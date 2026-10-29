/** Typed failures for the Project Beta plugin. */

export type ProjectErrorCode =
  /** No `.dsh-project/manifest.json` yet — run `/project init`. */
  | 'PROJECT_NOT_INITIALIZED'
  /** A write presented a stale `revision`. */
  | 'STALE_REVISION'
  /** The daily thread quota would be exceeded. */
  | 'QUOTA_EXCEEDED'
  /** Unknown thread id. */
  | 'THREAD_NOT_FOUND'
  /** Unknown memory key. */
  | 'MEMORY_NOT_FOUND'
  /** Git or GitHub CLI failure surfaced verbatim. */
  | 'VCS_FAILED'
  /** A subagent backend refusal (provider missing, activation rejected). */
  | 'SPAWN_FAILED'
  /** Bad caller input that passed JSON-schema validation but is semantically wrong. */
  | 'INVALID_INPUT'
  /** The project is paused — resume it before starting or advancing any thread. */
  | 'PROJECT_PAUSED'
  /** The project is archived — unarchive it before starting or advancing any thread. */
  | 'PROJECT_ARCHIVED'
  /** This project asks for human sign-off before an irreversible git action. */
  | 'APPROVAL_REQUIRED';

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ProjectErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isProjectError(error: unknown): error is ProjectError {
  return error instanceof ProjectError;
}

/** Normalise any thrown value into a stable one-line message. */
export function describeError(error: unknown): string {
  if (error instanceof ProjectError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
