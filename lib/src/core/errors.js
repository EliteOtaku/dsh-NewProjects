/** Typed failures for the Project Beta plugin. */
export class ProjectError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProjectError';
        this.code = code;
        this.details = details;
    }
    toJSON() {
        return { code: this.code, message: this.message, ...this.details };
    }
}
export function isProjectError(error) {
    return error instanceof ProjectError;
}
/** Normalise any thrown value into a stable one-line message. */
export function describeError(error) {
    if (error instanceof ProjectError)
        return `${error.code}: ${error.message}`;
    if (error instanceof Error)
        return error.message;
    return String(error);
}
