import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addTask, readTasks, updateTask } from '../src/store.mjs';
import { classifyResult } from '../src/result.mjs';

test('task creation persists an identified queued task', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skai-'));
  try {
    const file = path.join(dir, 'tasks.json');
    const task = await addTask('Сделать безопасный прототип', file);
    const db = await readTasks(file);
    assert.equal(db.tasks.length, 1);
    assert.equal(db.tasks[0].id, task.id);
    assert.equal(db.tasks[0].status, 'queued');
    assert.equal((await readFile(file, 'utf8')).includes(task.goal), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('empty and oversized tasks are rejected', async () => {
  await assert.rejects(() => addTask('   ', path.join(os.tmpdir(), 'unused.json')));
  await assert.rejects(() => addTask('x'.repeat(4001), path.join(os.tmpdir(), 'unused.json')));
});

test('unknown task updates do not create phantom records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skai-'));
  try { await assert.rejects(() => updateTask('missing', { status: 'completed' }, path.join(dir, 'tasks.json'))); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('successful process exit is not enough to mark task complete', () => {
  const blocked = JSON.stringify({ status: 'blocked', summary: 'Нет доступа к файлам.', checks: [], filesChanged: [], blockers: ['локальная команда недоступна'] });
  assert.equal(classifyResult(0, false, blocked).status, 'blocked');
  assert.equal(classifyResult(0, false, 'Не смог выполнить задачу').status, 'failed');
  assert.equal(classifyResult(1, false, blocked).status, 'failed');
  assert.equal(classifyResult(null, true, '').status, 'interrupted');
});
