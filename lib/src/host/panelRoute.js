/**
 * The panel's data route: one read-only JSON endpoint the client bundle fetches.
 *
 * The browser half cannot read `.dsh-project` itself, and the Host gives a client bundle no
 * supported way to call its own Host face, so the panel asks the Host over HTTP. That choice
 * is deliberate: `webServer.register` is a documented contract (named route in, disposer
 * out), while the client-side `host.call` RPC has no documented Host-side registration and no
 * use among installed plugins.
 *
 * Read-only by construction. The handler resolves an engine and serialises its overview —
 * exactly the call `project_overview` makes — and never writes a manifest, an index or a
 * session event. The carrier owns no authentication (Connection guards the Host API routes,
 * not an arbitrary named route), so a mutation endpoint here would be reachable by anything
 * that can reach the bound interface.
 *
 * @module dsh-newprojects/host/panelRoute
 */
import { ProjectError } from '../core/errors.js';
/** Exact path this plugin claims on the Host's browser carrier. */
export const PANEL_STATE_PATH = '/newprojects/state';
const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    // A panel that renders yesterday's threads is worse than one that renders none.
    'cache-control': 'no-store',
};
/**
 * Turn a Connection rejection into an HTTP status.
 *
 * `requestRejection` is documented as "rejection status, or undefined when the route may
 * accept the request", but the concrete shape is the Host's, not ours, so both a bare number
 * and an object with a `status` are accepted. Anything unrecognised is treated as a refusal:
 * a panel route that guesses "allowed" on an unknown answer would be an open read endpoint.
 */
export function admissionStatus(rejection) {
    if (rejection === undefined || rejection === null)
        return undefined;
    if (typeof rejection === 'number')
        return rejection;
    if (typeof rejection === 'object') {
        const status = rejection.status;
        if (typeof status === 'number')
            return status;
    }
    return 401;
}
function json(status, value) {
    return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(value) };
}
/**
 * Answer one panel request.
 *
 * `resolveEngine` is injected so the route can be tested without a Host, and so the caller
 * decides what "the project at this path" means (the runtime caches one engine per root).
 * `admit` is the caller's Connection check: the carrier owns no authentication, so this route
 * asks Connection the same question it asks every Host API route.
 */
export async function panelStateResponse(request, resolveEngine, options = {}) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        return json(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'the panel route only reads' });
    }
    const refusal = admissionStatus(options.admit?.());
    if (refusal !== undefined) {
        return json(refusal, {
            ok: false,
            code: 'UNAUTHORIZED',
            message: 'this route answers the browser session that owns this Host; authenticate first',
        });
    }
    let pathname;
    let rootDir;
    try {
        const url = new URL(request.url ?? '/', 'http://host.invalid');
        pathname = url.pathname;
        rootDir = (url.searchParams.get('rootDir') ?? '').trim();
    }
    catch {
        return json(400, { ok: false, code: 'INVALID_INPUT', message: 'the request URL is not a URL' });
    }
    if (pathname !== PANEL_STATE_PATH) {
        return json(404, { ok: false, code: 'NOT_FOUND', message: `this plugin owns ${PANEL_STATE_PATH} only` });
    }
    if (rootDir.length === 0) {
        return json(400, { ok: false, code: 'INVALID_INPUT', message: 'rootDir is required; the panel asks for one project' });
    }
    try {
        const engine = await resolveEngine(rootDir);
        return json(200, { ok: true, rootDir, overview: await engine.overviewJson() });
    }
    catch (error) {
        if (error instanceof ProjectError) {
            const status = error.code === 'PROJECT_NOT_INITIALIZED' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 500;
            return json(status, { ok: false, code: error.code, message: error.message });
        }
        return json(500, {
            ok: false,
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
