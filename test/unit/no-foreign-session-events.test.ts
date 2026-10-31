/**
 * 防回归：本插件不得向会话事件流写入自定义事件类型。
 *
 * 2026-10-31 事故：插件把项目快照写成 `project-beta/state` 事件，并注册一个 Host 投影
 * 想把它读回来。但仓库外声明的事件类型不在宿主的持久化白名单里，`Session.append()`
 * 也无法设置读回所需的 `ignorable` 标记——于是事件写得进去、会话重启后读不出来，
 * 整条会话被静默丢弃。详见 docs/INCIDENT-2026-10-31.md。
 *
 * 这条测试守住失败模式本身：源码里一旦再出现向会话追加事件、或出现仓库外命名空间的
 * 事件类型字符串，测试就红。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 测试产物在 `build/test/unit/`，仓库根在往上三层。 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = join(repositoryRoot, 'src');

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

function relative(path: string): string {
  return path.slice(repositoryRoot.length + 1);
}

describe('no foreign session events', () => {
  it('never appends to a session log', () => {
    // 若将来确实需要写入，先把文件路径加进这里 —— 但先确认宿主支持该写入路径
    // （`append()` 无法设置 ignorable，直接把事件塞进日志会让会话下次加载失败）。
    const allowed: readonly string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      if (allowed.includes(relative(file))) continue;
      if (/\.append\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(relative(file));
    }
    assert.deepEqual(offenders, []);
  });

  it('never names an event type outside the Host catalog', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('project-beta/')) offenders.push(relative(file));
    }
    assert.deepEqual(offenders, []);
  });
});
