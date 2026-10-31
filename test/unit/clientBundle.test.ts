import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The browser half is not executable under `node --test`, so these checks guard
 * the *packaging* contract instead: the manifest must declare the half, the
 * emitted bundle must stay a classic script, and the two slots it fills must be
 * the ones the sidebar dispatches. A regression here shows up as a panel that
 * silently never appears, which is exactly the failure this file exists to
 * prevent.
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
  })

  it('keeps the bundle a classic script, which is what the loader executes', async () => {
    const source = await text('src/client.ts')
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, 'a module shape would stop the loader from seeing the registration')
    // tsconfig files are JSONC: drop whole-line comments before parsing.
    const clientConfig = JSON.parse(
      (await text('tsconfig.client.json')).replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions?: { moduleDetection?: string } }
    assert.equal(clientConfig.compilerOptions?.moduleDetection, 'legacy')
  })

  it('registers the sidebar rail entry and the main panel it dispatches to', async () => {
    const source = await text('src/client.ts')
    assert.match(source, /name: 'main', key: PANEL_KEY/)
    assert.match(source, /name: 'sidebar\.panellist', id: PANEL_KEY/)
    assert.match(source, /id: 'dsh-newprojects'/, 'the loader id must equal the package name')
    assert.match(source, /\/newprojects\/state\?rootDir=/, 'the panel must read the route the host half registers')
  })
})
