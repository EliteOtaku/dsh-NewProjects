import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectError } from '../../src/core/errors.js';
import { PANEL_STATE_PATH, admissionStatus, panelStateResponse } from '../../src/host/panelRoute.js';
import type { ProjectEngine } from '../../src/core/engine.js';

/** A stand-in engine: the route only serialises its overview. */
function fakeEngine(overview: Record<string, unknown> = { projectId: 'proj-1', totals: { threads: 0 } }) {
  const seen: string[] = [];
  const engine = {
    async overviewJson() {
      seen.push('overview');
      return overview;
    },
  };
  return { engine: engine as unknown as ProjectEngine, seen };
}

const okResolve = () => Promise.resolve(fakeEngine().engine);

describe('panel state route', () => {
  it('answers one project with the same overview the tool returns', async () => {
    const { engine } = fakeEngine();
    const result = await panelStateResponse(
      { method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=${encodeURIComponent('D:\\AI\\test')}` },
      () => Promise.resolve(engine),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'no-store');
    const body = JSON.parse(result.body) as { ok: boolean; rootDir: string; overview: { projectId: string } };
    assert.equal(body.ok, true);
    assert.equal(body.rootDir, 'D:\\AI\\test');
    assert.equal(body.overview.projectId, 'proj-1');
  });

  it('refuses to guess which project it was asked about', async () => {
    const result = await panelStateResponse({ method: 'GET', url: PANEL_STATE_PATH }, okResolve);
    assert.equal(result.status, 400);
    const body = JSON.parse(result.body) as { code: string };
    assert.equal(body.code, 'INVALID_INPUT');
  });

  it('treats a blank rootDir as absent', async () => {
    const result = await panelStateResponse({ method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=%20%20` }, okResolve);
    assert.equal(result.status, 400);
  });

  it('stays read-only: anything but GET and HEAD is refused', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = await panelStateResponse({ method, url: `${PANEL_STATE_PATH}?rootDir=x` }, okResolve);
      assert.equal(result.status, 405, method);
      assert.equal(JSON.parse(result.body).code, 'METHOD_NOT_ALLOWED');
    }
  });

  it('allows HEAD so a link checker or a browser preflight does not fail', async () => {
    const result = await panelStateResponse({ method: 'HEAD', url: `${PANEL_STATE_PATH}?rootDir=x` }, okResolve);
    assert.equal(result.status, 200);
  });

  it('answers nothing for a path this plugin does not own', async () => {
    const result = await panelStateResponse({ method: 'GET', url: `/newprojects/other?rootDir=x` }, okResolve);
    assert.equal(result.status, 404);
    assert.equal(JSON.parse(result.body).code, 'NOT_FOUND');
  });

  it('maps a missing project to 404 and a bad argument to 400', async () => {
    const missing = await panelStateResponse({ method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` }, () =>
      Promise.reject(new ProjectError('PROJECT_NOT_INITIALIZED', 'no project record at x')),
    );
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).code, 'PROJECT_NOT_INITIALIZED');

    const bad = await panelStateResponse({ method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` }, () =>
      Promise.reject(new ProjectError('INVALID_INPUT', 'not a directory')),
    );
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).code, 'INVALID_INPUT');
  });

  it('reports an unexpected failure as 500 instead of throwing at the carrier', async () => {
    const result = await panelStateResponse({ method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` }, () =>
      Promise.reject(new Error('boom')),
    );
    assert.equal(result.status, 500);
    const body = JSON.parse(result.body) as { code: string; message: string };
    assert.equal(body.code, 'INTERNAL');
    assert.equal(body.message, 'boom');
  });

  it('refuses a request Connection would refuse', async () => {
    const result = await panelStateResponse(
      { method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` },
      okResolve,
      { admit: () => ({ status: 403 }) },
    );
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).code, 'UNAUTHORIZED');
  });

  it('treats an unrecognised admission answer as a refusal, never as permission', async () => {
    for (const answer of [true, 'ok', {}, 401]) {
      const result = await panelStateResponse({ method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` }, okResolve, {
        admit: () => answer,
      });
      assert.equal(result.status, 401, JSON.stringify(answer));
    }
  });

  it('serves the request once Connection admits it', async () => {
    const result = await panelStateResponse(
      { method: 'GET', url: `${PANEL_STATE_PATH}?rootDir=x` },
      okResolve,
      { admit: () => undefined },
    );
    assert.equal(result.status, 200);
  });

  it('reads a bare number as the rejection status', () => {
    assert.equal(admissionStatus(undefined), undefined);
    assert.equal(admissionStatus(null), undefined);
    assert.equal(admissionStatus(403), 403);
    assert.equal(admissionStatus({ status: 401 }), 401);
    assert.equal(admissionStatus({ reason: 'origin' }), 401);
    assert.equal(admissionStatus('no'), 401);
  });
});
