/**
 * Plugin activation, exercised through `apply` with a fake Cordis context.
 *
 * What is asserted here is the composition contract, not the orchestration logic (the
 * engine has its own suite): every registration is disposed by the ActivateEffect, a Host
 * without `subagents` still serves `/project`, and a missing `subprocess` fails loudly
 * instead of pretending isolation works.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply, MIN_CI_POLL_INTERVAL_MS } from '../src/index.js';
import type {
  HostCommandDefinition,
  HostContext,
  HostPromptSection,
  HostToolDefinition,
} from '../src/host/hostTypes.js';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A fake Cordis context that records registrations and honours effects. */
class FakeContext {
  readonly tools: HostToolDefinition[] = [];
  readonly commands: HostCommandDefinition[] = [];
  readonly sections: HostPromptSection[] = [];
  readonly intervals: number[] = [];
  /** Services whose callbacks never ran because they were absent at activation. */
  readonly deferred: string[][] = [];
  private readonly effects: Array<() => void> = [];
  private readonly services = new Map<string, unknown>();

  constructor(services: Record<string, unknown> = {}) {
    for (const [name, service] of Object.entries(services)) this.services.set(name, service);
  }

  get(name: string): unknown {
    return this.services.get(name);
  }

  on(): () => void {
    return () => undefined;
  }

  /**
   * Emulate Cordis `inject`: run the callback on a scoped context once every named service
   * resolves, and stay deferred (never running) while any is missing.
   */
  inject(names: string[], callback: (scoped: HostContext) => void): () => void {
    if (!names.every((name) => this.services.has(name))) {
      this.deferred.push([...names]);
      return () => undefined;
    }
    callback(this.asContext());
    return () => undefined;
  }

  effect(setup: () => () => void): () => void {
    this.effects.push(setup());
    return () => undefined;
  }

  /** Run every cleanup exactly as the Host does on unload. */
  dispose(): void {
    for (const cleanup of this.effects.splice(0)) cleanup();
  }

  /** A context shape this class can be handed to `apply` as. */
  asContext(): HostContext {
    return this as unknown as HostContext;
  }
}

/** A `subprocess` service that never actually runs anything. */
function fakeSubprocess(): { spawn: () => never } {
  return {
    spawn: () => {
      throw new Error('the fake subprocess must not be asked to spawn in these tests');
    },
  };
}

/** A `tools` service that records definitions. */
function fakeTools(sink: HostToolDefinition[]): { register: (definition: HostToolDefinition) => () => void } {
  return {
    register: (definition) => {
      sink.push(definition);
      return () => {
        const at = sink.indexOf(definition);
        if (at >= 0) sink.splice(at, 1);
      };
    },
  };
}

/** A `commands` service that records definitions. */
function fakeCommands(sink: HostCommandDefinition[]): { register: (definition: HostCommandDefinition) => () => void } {
  return {
    register: (definition) => {
      sink.push(definition);
      return () => {
        const at = sink.indexOf(definition);
        if (at >= 0) sink.splice(at, 1);
      };
    },
  };
}

/** A `systemPrompt` service that records sections. */
function fakeSystemPrompt(sink: HostPromptSection[]): { section: (section: HostPromptSection) => () => void } {
  return {
    section: (section) => {
      sink.push(section);
      return () => {
        const at = sink.indexOf(section);
        if (at >= 0) sink.splice(at, 1);
      };
    },
  };
}

/** A `timer` service that records the interval instead of scheduling it. */
function fakeTimer(sink: number[]): { interval: (callback: () => void, delay: number) => () => void; timeout: () => () => void } {
  return {
    interval: (_callback, delay) => {
      sink.push(delay);
      return () => undefined;
    },
    timeout: () => () => undefined,
  };
}

/** A `workingDirectory` service pinned to one root. */
async function fakeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-index-'));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

describe('apply', () => {
  it('refuses to activate without the subprocess service', async () => {
    // Coordination would claim to isolate work it cannot isolate, so this is fatal rather
    // than a silent degradation.
    const ctx = new FakeContext({});
    assert.throws(() => apply(ctx.asContext()), /needs the "subprocess" service/);
  });

  it('registers every tool and the one command', async () => {
    const tools: HostToolDefinition[] = [];
    const commands: HostCommandDefinition[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      tools: fakeTools(tools),
      commands: fakeCommands(commands),
    });
    apply(ctx.asContext());
    assert.deepEqual(tools.map((tool) => tool.name), [
      'project_coordinate',
      'project_memory_sync',
      'project_thread_manage',
      'project_overview',
      'project_knowledge_search',
      'project_knowledge',
      'project_library',
    ]);
    assert.deepEqual(commands.map((command) => command.name), ['project']);
  });

  it('registers a stable prompt section with a synchronous text getter', async () => {
    const sections: HostPromptSection[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      systemPrompt: fakeSystemPrompt(sections),
    });
    apply(ctx.asContext());
    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.ok(section !== undefined);
    assert.equal(section.name, 'project-beta-charter');
    // A function rather than a string: the Host assembles the prompt synchronously and the
    // charter must be re-read between assemblies.
    assert.equal(typeof section.text, 'function');
  });

  it('places the section in the documented free gap', async () => {
    const sections: HostPromptSection[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      systemPrompt: fakeSystemPrompt(sections),
    });
    apply(ctx.asContext());
    // After the Host's tool sections (which end at 5000) and before its output scaffolding
    // (which starts at 9000).
    assert.equal(sections[0]?.order, 5_100);
  });

  it('honours a configured section order', async () => {
    const sections: HostPromptSection[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      systemPrompt: fakeSystemPrompt(sections),
    });
    apply(ctx.asContext(), { promptSectionOrder: 6_321 });
    assert.equal(sections[0]?.order, 6_321);
  });

  it('still serves commands and tools without a subagents service', async () => {
    // Reading project state is useful even when this Host cannot spawn; the plugin degrades
    // to a readable project record rather than disappearing.
    const tools: HostToolDefinition[] = [];
    const commands: HostCommandDefinition[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      tools: fakeTools(tools),
      commands: fakeCommands(commands),
    });
    apply(ctx.asContext());
    assert.equal(tools.length, 7);
    assert.equal(commands.length, 1);
  });

  it('does not start the watcher without a thread runtime', async () => {
    // Healing means waking a child session; with no subagents there is nothing to wake.
    const intervals: number[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      timer: fakeTimer(intervals),
    });
    apply(ctx.asContext());
    assert.deepEqual(intervals, []);
  });

  it('does not start the watcher when the interval is zero', async () => {
    const intervals: number[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      timer: fakeTimer(intervals),
    });
    apply(ctx.asContext(), { ciPollIntervalMs: 0 });
    assert.deepEqual(intervals, []);
  });

  it('clamps a too-small poll interval up to the minimum', async () => {
    const intervals: number[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      timer: fakeTimer(intervals),
      subagents: { list: () => [] },
    });
    apply(ctx.asContext(), { ciPollIntervalMs: 1 });
    assert.deepEqual(intervals, [MIN_CI_POLL_INTERVAL_MS]);
  });

  it('removes every registration when the activation is disposed', async () => {
    // Creator Mode reloads rely on this: a leaked tool or timer survives the plugin.
    const tools: HostToolDefinition[] = [];
    const commands: HostCommandDefinition[] = [];
    const sections: HostPromptSection[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      tools: fakeTools(tools),
      commands: fakeCommands(commands),
      systemPrompt: fakeSystemPrompt(sections),
    });
    apply(ctx.asContext());
    assert.equal(tools.length, 7);
    ctx.dispose();
    assert.deepEqual(tools, []);
    assert.deepEqual(commands, []);
    assert.deepEqual(sections, []);
  });

  it('resolves relative rootDir arguments against the process cwd', async () => {
    // Users type `--root src` style arguments; the engine needs an absolute path or two
    // spellings of one project become two engines with two turn-end subscriptions.
    const root = await fakeWorkspace();
    const tools: HostToolDefinition[] = [];
    const ctx = new FakeContext({
      subprocess: fakeSubprocess(),
      tools: fakeTools(tools),
      workingDirectory: { defaultDirectory: root, get: () => root },
    });
    apply(ctx.asContext());
    const overview = tools.find((tool) => tool.name === 'project_overview');
    assert.ok(overview !== undefined);
    const relative = 'dsh-relative-root-probe';
    const result = (await overview.execute({ rootDir: relative }, {
      callId: 'c1',
      agent: { id: 'session-parent' },
      signal: AbortSignal.timeout(5000),
      deferContext: () => undefined,
      concludeTurn: () => undefined,
    })) as Record<string, unknown>;
    // A relative argument resolves against the process cwd, and the answer still names the
    // absolute path it landed on. The directory is deliberately one no checkout can hold a
    // project record at: `'.'` only worked while this repository was not itself a project,
    // which stops being true the moment it is dogfooded.
    assert.equal(result['code'], 'PROJECT_NOT_INITIALIZED');
    assert.ok(String(result['message']).includes(join(process.cwd(), relative)), String(result['message']));
    assert.match(String(result['message']), /run `\/project init` first/);
  });

  it('defers optional capabilities instead of sampling them once', async () => {
    // `ctx.get` reads the registry at one instant; a service mounted later would be lost.
    // Every optional capability must therefore go through `inject`, which is what this
    // asserts: with only `subprocess` present, all four optional services stay deferred.
    const ctx = new FakeContext({ subprocess: fakeSubprocess() });
    apply(ctx.asContext());
    const requested = ctx.deferred.map((names) => names.join(','));
    assert.ok(requested.includes('tools'), JSON.stringify(requested));
    assert.ok(requested.includes('commands'), JSON.stringify(requested));
    assert.ok(requested.includes('systemPrompt'), JSON.stringify(requested));
    assert.ok(requested.includes('timer,subagents'), JSON.stringify(requested));
  });

  it('declares subprocess as a dependency so activation cannot race it', async () => {
    // Written into the patch row, not sampled: the Host holds activation until the service
    // exists, which is the only way `apply` never sees `undefined` in a real profile.
    const { inject } = (await import('../src/index.js')) as { inject: readonly string[] };
    assert.deepEqual([...inject], ['subprocess']);
  });
});
