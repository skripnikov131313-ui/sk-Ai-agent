import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, newTask, readTasks, transaction } from '../store.mjs';
import { createQueueController, QueueError } from '../queue-controller.mjs';
import { safeStatus } from '../privacy.mjs';
import { createWorkerProfile, evaluateTaskRoute, reconcileWaitingTasks, taskRequirements, validateDependencies } from '../routing.mjs';
import { MemoryError, readProjectMemory, summarizeOutcomes } from '../memory.mjs';
import { PROJECT_ID, ProjectError, assertProjectContext, bindProjectStore, loadProjectCatalog } from '../projects.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };

function view(task, detail = false, tasks = [task], worker = createWorkerProfile()) {
  const route = evaluateTaskRoute(task, tasks, worker);
  let requirements;
  try { requirements = taskRequirements(task); }
  catch { requirements = { target: 'invalid', dependsOn: [] }; }
  const pending = ['queued', 'waiting'].includes(task.status);
  const result = { id: task.id, goal: safeStatus(task.goal), status: pending ? route.eligible ? 'queued' : 'waiting' : task.status, attempts: task.attempts,
    ...requirements, route,
    createdAt: task.createdAt, updatedAt: task.updatedAt, hasSession: Boolean(task.sessionId),
    canResume: route.eligible && ['failed', 'blocked', 'interrupted'].includes(task.status) && Boolean(task.sessionId) && task.attempts < 3,
    error: task.error ? safeStatus(task.error) : null,
    summary: task.report?.summary ? safeStatus(task.report.summary) : null,
    checksCount: task.report?.checks?.length ?? 0,
    hasVerifiedFile: task.acceptance?.kind === 'smoke-file' && task.acceptance.verified === true };
  if (detail && task.acceptance?.kind === 'smoke-file') result.acceptance = {
    verified: task.acceptance.verified === true, file: safeStatus(task.acceptance.file),
  };
  if (detail) result.report = task.report ? { status: task.report.status, summary: safeStatus(task.report.summary),
    checks: task.report.checks.map(safeStatus), filesChanged: task.report.filesChanged.map(safeStatus),
    blockers: task.report.blockers.map(safeStatus) } : null;
  return result;
}

async function body(request, allowed) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new QueueError('Ожидается JSON-запрос.', 415);
  let bytes = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    let oversized = false;
    request.on('data', chunk => {
      if (oversized) return;
      bytes += chunk.length;
      if (bytes > 20_000) { oversized = true; chunks.length = 0; reject(new QueueError('Запрос слишком большой.', 413)); }
      else chunks.push(chunk);
    });
    request.once('end', resolve);
    request.once('error', () => reject(new QueueError('Передача запроса прервана.', 400)));
  });
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new QueueError('Некорректный JSON.', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key))) throw new QueueError('Неподдерживаемые поля запроса.', 400);
  return data;
}

export async function createAgentServer({ root = ROOT, dataDir = path.join(root, '.skai-agent'), dbFile = path.join(dataDir, 'tasks.json'),
  workDbFile = path.join(dataDir, 'work', 'tasks.json'), port = 0, executionEnabled = true, command, prefixArgs = [],
  timeoutMs = 600_000, graceMs = 500, desktop = false, worker = createWorkerProfile({ desktop }) } = {}) {
  worker = createWorkerProfile(worker);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Порт должен быть целым числом от 0 до 65535.');
  const projects = await loadProjectCatalog({ root, dataDir, dbFile, workDbFile });
  const queues = new Map();
  const queueFor = project => {
    if (!queues.has(project.id)) queues.set(project.id, createQueueController({ root: project.root, dataDir: project.dataDir,
      dbFile: project.dbFile, command, prefixArgs, timeoutMs, graceMs, worker, project: project.context }));
    return queues.get(project.id);
  };
  const publicProject = project => ({ id: project.id, name: project.name, scope: project.scope, repository: project.repository });
  const selectedProject = request => {
    const id = request.headers['x-skai-project'] ?? 'agent';
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new ProjectError('Некорректный ID проекта.', 400);
    const project = projects.find(item => item.id === id);
    if (!project) throw new ProjectError('Проект не зарегистрирован.', 404);
    const scope = request.headers['x-skai-project-scope'];
    if ((scope !== undefined && scope !== project.scope) || (request.method === 'POST' && id !== 'agent' && scope !== project.scope)) {
      throw new ProjectError('Привязка проекта не подтверждена. Обновите список проектов.');
    }
    return project;
  };
  const checkStore = (db, project) => bindProjectStore(db, project.context, { bind: false });
  const requireFreeQueue = () => {
    if ([...queues.values()].some(queue => queue.active)) throw new QueueError('Уже выполняется очередь проекта. Дождитесь завершения или остановите её.');
  };
  const files = new Map(await Promise.all([...assets].map(async ([url, [name, type]]) =>
    [url, { content: await readFile(path.join(import.meta.dirname, 'public', name)), type }])));
  const queue = queueFor(projects[0]);
  let origin;
  let closing = false;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    const send = (status, data, type = 'application/json') => {
      response.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
      response.end(Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    try {
      // Literal loopback host + origin + non-simple request header protect the
      // local operator UI from DNS rebinding and requests made by other sites.
      if (closing) return send(503, { error: 'Панель завершает работу.' });
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Запрос с другого сайта запрещён.' });
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) return send(400, { error: 'Некорректный адрес.' });
      const url = new URL(request.url, origin);
      const asset = files.get(url.pathname);
      if (asset && request.method === 'GET') return send(200, asset.content, asset.type);
      if (!url.pathname.startsWith('/api/') || request.headers['x-skai-client'] !== 'operator-ui') return send(403, { error: 'Разрешены запросы панели Agent.' });
      if (request.method === 'OPTIONS') return send(403, { error: 'Cross-origin запросы запрещены.' });
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        return send(200, { defaultProjectId: 'agent', projects: projects.map(publicProject) });
      }
      const project = selectedProject(request);
      if (project.context) await assertProjectContext(project.context, { workspace: false });
      const queue = queueFor(project);
      const { root, dataDir, dbFile, workDbFile } = project;
      if (url.pathname === '/api/memory' && request.method === 'GET') {
        if (project.context) await assertProjectContext(project.context);
        const [memory, db, plan] = await Promise.all([readProjectMemory(root), readTasks(dbFile), readTasks(workDbFile)]);
        checkStore(db, project); checkStore(plan, project);
        return send(200, { ...memory, outcomes: { queue: summarizeOutcomes(db.tasks), plan: summarizeOutcomes(plan.tasks) } });
      }
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const [db, work] = await Promise.all([readTasks(dbFile), readTasks(workDbFile)]);
        checkStore(db, project); checkStore(work, project);
        let workspaceError = null;
        if (project.context) {
          try { await assertProjectContext(project.context); }
          catch (error) { if (!(error instanceof ProjectError)) throw error; workspaceError = error.message; }
        }
        const busy = projects.find(item => item.id !== project.id && queues.get(item.id)?.active);
        const currentIds = work.controller?.taskIds ?? [];
        const batch = db.batch;
        const tasks = db.tasks.map(task => view(task, false, db.tasks, worker));
        return send(200, { project: project.name, projectId: project.id, projectScope: project.scope,
          executionEnabled: executionEnabled && !workspaceError, workspaceError, otherActiveProject: busy ? publicProject(busy) : null,
          ownedRun: queue.active, worker,
          controllerError: queue.error, tasks, runnableCount: tasks.filter(task => task.status === 'queued').length,
          batch: batch ? { status: batch.status, taskIds: batch.taskIds, completed: batch.completed,
            activeTaskId: batch.activeTaskId, startedAt: batch.startedAt, finishedAt: batch.finishedAt, waiting: batch.waiting ?? 0,
            error: batch.error ? safeStatus(batch.error) : null } : null,
          plan: { status: work.controller?.status ?? 'idle', reason: work.controller?.reason ? safeStatus(work.controller.reason) : null,
            tasks: work.tasks.filter(task => currentIds.includes(task.id)).map(task => view(task, false, work.tasks, worker)) } });
      }
      if (url.pathname === '/api/tasks' && request.method === 'POST') {
        if (project.context) await assertProjectContext(project.context, { workspace: false });
        const input = await body(request, ['goal', 'requestId', 'target', 'dependsOn']);
        if (typeof input.goal !== 'string' || !UUID.test(input.requestId ?? '')) throw new QueueError('Нужны текст задачи и идентификатор отправки.', 400);
        if (safeStatus(input.goal) !== input.goal) throw new QueueError('Текст похож на пароль или ключ. Уберите секрет перед сохранением.', 400);
        let task;
        try { task = newTask(input.goal, input); } catch (error) { throw new QueueError(error.message, 400); }
        const saved = await transaction(dbFile, db => {
          bindProjectStore(db, project.context);
          const previous = db.tasks.find(item => item.submissionId === input.requestId);
          if (previous) {
            if (previous.goal !== task.goal || JSON.stringify(taskRequirements(previous)) !== JSON.stringify(taskRequirements(task))) throw new QueueError('Этот идентификатор отправки уже использован для другой задачи или требований.');
            return view(previous, true, db.tasks, worker);
          }
          try { validateDependencies(task, db.tasks); } catch (error) { throw new QueueError(error.message, 400); }
          task.submissionId = input.requestId;
          db.tasks.push(task);
          reconcileWaitingTasks(db, worker);
          return view(task, true, db.tasks, worker);
        });
        return send(201, { task: saved });
      }
      const match = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(resume))?$/i.exec(url.pathname);
      if (match && UUID.test(match[1])) {
        if (request.method === 'GET' && !match[2]) {
          const source = url.searchParams.get('source') ?? 'queue';
          if (!['queue', 'plan'].includes(source)) throw new QueueError('Неизвестная очередь.', 400);
          const db = await readTasks(source === 'plan' ? workDbFile : dbFile);
          checkStore(db, project);
          const task = db.tasks.find(item => item.id === match[1]);
          if (!task) throw new QueueError('Задача не найдена.', 404);
          return send(200, { task: view(task, true, db.tasks, worker) });
        }
        if (request.method === 'POST' && match[2] === 'resume') {
          await body(request, []);
          if (!executionEnabled) throw new QueueError('Запуск исполнителя приостановлен для этой панели.');
          requireFreeQueue();
          const batch = await queue.start(match[1]);
          return send(202, { batch: { status: batch.status, taskIds: batch.taskIds } });
        }
      }
      if (request.method === 'POST' && ['/api/queue/start', '/api/queue/stop', '/api/queue/recover'].includes(url.pathname)) {
        await body(request, []);
        if (url.pathname.endsWith('/start')) {
          if (!executionEnabled) throw new QueueError('Запуск исполнителя приостановлен для этой панели.');
          requireFreeQueue();
          const batch = await queue.start();
          return send(202, { batch: { status: batch.status, taskIds: batch.taskIds } });
        }
        if (url.pathname.endsWith('/stop')) { queue.requestStop(); return send(202, { status: 'stopping' }); }
        await queue.recover();
        return send(200, { status: 'recovered' });
      }
      return send(404, { error: 'Адрес не найден.' });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof QueueError || error instanceof ProjectError ? error.status : error instanceof MemoryError ? 422 : 500;
      send(status, { error: status < 500 ? safeStatus(error.message) : 'Не удалось прочитать или сохранить состояние. Существующие данные сохранены.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, queue, projects: projects.map(publicProject), async close() {
    closing = true;
    for (const queue of queues.values()) queue.requestStop();
    const stopped = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await Promise.all([...queues.values()].map(queue => queue.stop()));
    server.closeAllConnections();
    await stopped;
  } };
}
