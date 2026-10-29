/** Atomic file replacement that survives the transient failures Windows reports. */
import { rename } from 'node:fs/promises';
/** Codes Windows uses when another process briefly holds the destination. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Attempts before a rename is treated as a real failure. */
const RENAME_ATTEMPTS = 5;
/**
 * Replace `to` with `from`, retrying the transient Windows failures.
 *
 * On POSIX a rename over an open file succeeds, so this is a no-op there. On Windows it fails
 * with `EPERM`/`EBUSY` whenever an indexer, an antivirus scanner, or a second reader holds the
 * destination for a moment — a condition that clears by itself in milliseconds. Retrying is the
 * difference between a write that occasionally fails for no reason the user can act on and one
 * that does not; a genuine permission problem still fails after the last attempt.
 */
export async function renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            const code = error.code;
            if (typeof code !== 'string' || !RETRYABLE_RENAME.has(code))
                throw error;
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
        }
    }
    throw lastError;
}
