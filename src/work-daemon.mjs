import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { work } from './work.mjs';
import { writeTasks } from './store.mjs';
import { safeStatus } from './privacy.mjs';

async function main(configFile) {
  let config;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { config = JSON.parse(await readFile(configFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(25); }
  }
  if (!config || config.pid !== process.pid) throw new Error('Нет конфигурации с подтверждённым PID; задачи не запускались.');
  let state = JSON.parse(await readFile(config.stateFile, 'utf8'));
  if (state.id !== config.id || state.pid !== process.pid) throw new Error('Владелец фоновой задачи изменился; запуск отменён.');
  const save = async patch => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await writeTasks(state, config.stateFile);
  };
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const request = JSON.parse(await readFile(path.join(path.dirname(configFile), 'stop.json'), 'utf8'));
      if (request.id === config.id) controller.abort();
    } catch (error) {
      if (error.code !== 'ENOENT') { console.error(safeStatus(error.message)); controller.abort(); }
    } finally { checking = false; }
  }, 100);
  try {
    const result = await work({ ...config.options, signal: controller.signal, handleSignals: true,
      onReady: () => save({ status: 'running' }),
      onProgress: event => console.log(safeStatus(`${event.type}: ${event.text}${event.error ? ` — ${event.error}` : ''}`)),
    });
    await save({ status: result.status, exitCode: result.exitCode, reason: result.reason, finishedAt: new Date().toISOString() });
    process.exitCode = result.exitCode;
  } catch (error) {
    await save({ status: 'failed', exitCode: 1, reason: safeStatus(error.message), finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  } finally { clearInterval(timer); }
}

main(process.argv[2]).catch(error => { console.error(safeStatus(error.message)); process.exitCode = 1; });
