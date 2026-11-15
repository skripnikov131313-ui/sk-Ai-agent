export const TASK_TARGETS = Object.freeze(['current', 'windows', 'windows-gui']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createWorkerProfile({ platform = process.platform, desktop = false } = {}) {
  if (typeof platform !== 'string' || !platform || typeof desktop !== 'boolean') throw new Error('Некорректные возможности исполнителя.');
  if (desktop && platform !== 'win32') throw new Error('Доступ к Windows GUI можно заявить только на Windows.');
  return { platform, desktop };
}

export function taskRequirements({ target = 'current', dependsOn = [] } = {}) {
  if (!TASK_TARGETS.includes(target)) throw new Error('Цель задачи: current, windows или windows-gui.');
  if (!Array.isArray(dependsOn) || dependsOn.length > 32 || dependsOn.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Зависимости: до 32 UUID существующих задач.');
  return { target, dependsOn: [...new Set(dependsOn.map(id => id.toLowerCase()))].sort() };
}

// Dependencies are immutable and can only point to already existing tasks.
// New tasks therefore cannot introduce a cycle through the supported API.
export function validateDependencies(task, tasks) {
  for (const id of task.dependsOn ?? []) {
    if (id === task.id || !tasks.some(item => item.id === id)) throw new Error('Зависимая задача не найдена. Сначала создайте её в этой очереди.');
  }
}

export function evaluateTaskRoute(task, tasks, worker = createWorkerProfile()) {
  let requirements;
  try { requirements = taskRequirements(task); }
  catch { return { eligible: false, code: 'invalid-requirements', message: 'Требования задачи повреждены; запуск остановлен.' }; }
  if (requirements.target !== 'current' && worker.platform !== 'win32') {
    const name = { linux: 'Linux', darwin: 'macOS' }[worker.platform] ?? worker.platform;
    return { eligible: false, code: 'windows', message: `Задаче нужен Windows. Текущий исполнитель: ${name}.` };
  }
  if (requirements.target === 'windows-gui' && !worker.desktop) return {
    eligible: false, code: 'desktop', message: 'Нужен Windows-исполнитель с явно разрешённым доступом к рабочему столу.',
  };
  const parents = requirements.dependsOn.map(id => tasks.find(item => item.id === id));
  if (parents.some(parent => !parent)) return { eligible: false, code: 'missing-dependency', message: 'Предыдущая задача отсутствует в очереди. Требуется проверить зависимость.' };
  if (parents.some(parent => ['failed', 'blocked', 'interrupted'].includes(parent.status))) return {
    eligible: false, code: 'blocked-dependency', message: 'Предыдущая задача не завершена: сначала устраните её ошибку или блокер.',
  };
  if (parents.some(parent => parent.status !== 'completed')) return { eligible: false, code: 'dependency', message: 'Ожидает завершения предыдущих задач.' };
  return { eligible: true, code: null, message: null };
}

export function reconcileWaitingTasks(db, worker = createWorkerProfile()) {
  for (const task of db.tasks) {
    if (!['queued', 'waiting'].includes(task.status)) continue;
    const route = evaluateTaskRoute(task, db.tasks, worker);
    const status = route.eligible ? 'queued' : 'waiting';
    const reason = route.eligible ? null : { code: route.code, message: route.message };
    if (task.status !== status || JSON.stringify(task.waitingReason ?? null) !== JSON.stringify(reason)) {
      Object.assign(task, { status, waitingReason: reason, updatedAt: new Date().toISOString() });
    }
  }
}
