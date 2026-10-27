/**
 * Tests for deterministic goal decomposition.
 *
 * `planTasks` deliberately does not call a model: coordination must work when no
 * delegation route is available, must be reproducible in tests, and must never invent work
 * the user did not ask for. These tests therefore pin both what it splits and what it
 * refuses to split.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_PLANNED_TASKS, branchNameFor, planTasks } from '../../src/core/planner.js';

describe('planTasks', () => {
  it('treats a single-line goal as one task', () => {
    const tasks = planTasks('Add a login page');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, 'Add a login page');
    assert.equal(tasks[0]?.objective, 'Add a login page');
  });

  it('splits a dashed list into one task per bullet', () => {
    const tasks = planTasks(
      ['Ship the settings page:', '- build the form', '- wire persistence', '- add tests'].join('\n'),
    );
    assert.deepEqual(
      tasks.map((task) => task.title),
      ['build the form', 'wire persistence', 'add tests'],
    );
    // The preamble is context, not a task: it describes the batch rather than one unit
    // of work, and turning it into a thread would duplicate the bullets.
    assert.equal(
      tasks.some((task) => task.title.includes('Ship the settings page')),
      false,
    );
  });

  it('splits numbered and asterisked lists too', () => {
    assert.equal(planTasks('1. first\n2. second').length, 2);
    assert.equal(planTasks('* alpha\n* beta').length, 2);
    assert.equal(planTasks('a) one\nb) two').length, 2);
  });

  it('does not split a list with fewer than two bullets', () => {
    // One bullet is a sentence with a leading dash, not a plan. Splitting it would
    // produce a single thread whose title lost its opening word.
    const single = planTasks('- only one thing');
    assert.equal(single.length, 1);
    assert.match(single[0]?.title ?? '', /only one thing/);
  });

  it('carries the objective into every task and keeps it distinct', () => {
    const tasks = planTasks('- one\n- two\n- three', 'Fallback');
    for (const task of tasks) {
      assert.ok(task.objective.length > 0);
      assert.ok(task.objective.includes(task.title));
    }
    assert.deepEqual(
      tasks.map((task) => task.title),
      ['one', 'two', 'three'],
    );
  });

  it('caps the plan so one goal cannot flood the quota', () => {
    const goal = Array.from({ length: MAX_PLANNED_TASKS + 6 }, (_value, index) => `- task ${index}`).join('\n');
    assert.equal(planTasks(goal).length, MAX_PLANNED_TASKS);
  });

  it('extracts a backticked path as the scope hint', () => {
    const tasks = planTasks('- rewrite the parser in `src/parser.ts`\n- add a test');
    assert.equal(tasks[0]?.scopeHint, 'src/parser.ts');
  });

  it('extracts a trailing "in <path>" as the scope hint', () => {
    const tasks = planTasks('- add a route in src/routes/user.ts\n- add a test');
    assert.equal(tasks[0]?.scopeHint, 'src/routes/user.ts');
  });

  it('leaves the scope hint absent when no path is named', () => {
    const tasks = planTasks('- write the docs\n- publish them');
    assert.equal(tasks[0]?.scopeHint, undefined);
  });

  it('trims an over-long title but keeps the whole objective', () => {
    const long = 'x'.repeat(200);
    const tasks = planTasks(`- ${long}\n- short`);
    assert.ok((tasks[0]?.title.length ?? 0) <= 80);
    assert.equal(tasks[0]?.objective.includes(long), true);
  });

  it('returns nothing for an empty goal, leaving the caller to reject it', () => {
    assert.deepEqual(planTasks('   '), []);
  });

  it('ignores bullets nested inside a fenced code block', () => {
    // Instruction files are full of shell snippets whose `-` lines are not a plan.
    const goal = ['Update the docs', '```', '- not a task', '- also not a task', '```'].join('\n');
    const tasks = planTasks(goal);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0]?.title ?? '', /Update the docs/);
  });
});

describe('branchNameFor', () => {
  it('builds a namespaced, ordinal-prefixed branch name', () => {
    assert.equal(branchNameFor('demo', { title: 'Add Login Page', objective: '' }, 0), 'project/demo/1-add-login-page');
  });

  it('keeps branch names within a conservative length', () => {
    const name = branchNameFor('demo', { title: 'y'.repeat(120), objective: '' }, 3);
    assert.ok(name.length <= 80, `branch name too long: ${name}`);
  });

  it('never produces empty or repeated separators', () => {
    const name = branchNameFor('demo', { title: '  !!!  ', objective: '' }, 0);
    assert.equal(name.includes('--'), false);
    assert.equal(name.endsWith('/'), false);
    assert.match(name, /^project\/demo\/1-/);
  });
});
