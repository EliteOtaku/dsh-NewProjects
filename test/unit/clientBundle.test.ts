import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The browser half is not executable under `node --test`, so these checks guard
 * the *packaging* contract instead: the manifest must declare the half, the
 * emitted bundle must stay a classic script, and the two slots it fills must be
 * the ones the sidebar dispatches. A regression here shows up as a panel that
 * silently never appears — or, worse, as a desktop host whose whole Web UI
 * fails to boot, which is exactly the failure this file exists to prevent.
 */

const root = process.cwd()

async function text(relative: string): Promise<string> {
  return await readFile(join(root, relative), 'utf8')
}

describe('client bundle', () => {
  it('declares the browser half and points the client export at the built file', async () => {
    const manifest = JSON.parse(await text('package.json')) as {
      name?: string
      files?: string[]
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string; inject?: unknown } }
    }
    assert.equal(manifest.dsh?.client?.platform, 'web')
    assert.ok(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject must be a static array')
    assert.equal(manifest.exports?.['./client'], './lib/src/client.js')
    assert.ok(manifest.files?.includes('lib/src'), 'the built client bundle must ship')
    assert.deepEqual(manifest.dsh?.client?.inject, [], 'the bundle needs no other client half')
  })

  it('keeps the bundle a classic script, which is what the loader executes', async () => {
    const source = await text('src/client.ts')
    assert.ok(
      !/^\s*(?:import|export)\s/m.test(source),
      'a module shape would stop the loader from seeing the registration',
    )
    // tsconfig files are JSONC: drop whole-line comments before parsing.
    const clientConfig = JSON.parse(
      (await text('tsconfig.client.json')).replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions?: { moduleDetection?: string } }
    assert.equal(clientConfig.compilerOptions?.moduleDetection, 'legacy')
  })

  it('registers the sidebar rail entry and the main panel it dispatches to', async () => {
    const source = await text('src/client.ts')
    assert.ok(source.includes("name: 'main', key: PANEL_KEY"), 'the main cell is keyed by the rail id')
    assert.ok(source.includes("name: 'sidebar.panellist', id: PANEL_KEY"), 'the rail entry owns the id')
    assert.ok(source.includes("id: 'dsh-newprojects'"), 'the loader id must equal the package name')
    assert.ok(source.includes('/newprojects/state?rootDir='), 'the panel reads the route the host half registers')
  })

  it('satisfies the rc.3 browser-half contract that once crashed the desktop host', async () => {
    const source = await text('src/client.ts')
    // The guarded context only exposes services the plugin declares; an
    // undeclared read throws, and the boot audit turns that into a fatal
    // `did not activate` that costs the whole Web UI.
    assert.ok(source.includes("inject: ['slots'] as const"), 'the plugin must declare the slot service')
    // React is neither a context service nor a page global: the factory's
    // require is the only source.
    assert.ok(source.includes("requireModule?.('react')"), 'React must come from the loader require')
    // A direct register throws while the slot tree is still being built.
    assert.ok(source.includes("slots.inject('sidebar.panellist'"), 'the rail entry must wait for its slot')
    assert.ok(source.includes("slots.inject('main'"), 'the panel must wait for the slot its entry dispatches')
    // A top-level return is an `Illegal return statement` in the classic script
    // the loader evaluates — the first rc.3 attempt failed exactly there.
    assert.ok(
      !source.split('\n').some((line) => line.startsWith('return ')),
      'the bundle must not return at top level',
    )
  })
})
