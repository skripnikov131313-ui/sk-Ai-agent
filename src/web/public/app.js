const $ = id => document.getElementById(id);
const labels = { queued: 'Ожидает', running: 'В работе', completed: 'Готово', failed: 'Ошибка', blocked: 'Блокер', interrupted: 'Прервано', skipped: 'Пропущено', idle: 'Нет запуска' };
const icons = { queued: '◷', running: '↗', completed: '✓', failed: '!', blocked: '!', interrupted: 'Ⅱ', skipped: '–' };
let snapshot = null;
let source = 'queue';
let filter = 'all';
let refreshing = false;
let listKey = '';
let detailId = null;
let detailUpdated = null;
let posting = false;
let lastAttemptGoal = null;
let submissionId;
try { submissionId = sessionStorage.getItem('skai-submission') || crypto.randomUUID(); $('goal').value = sessionStorage.getItem('skai-draft') || ''; lastAttemptGoal = sessionStorage.getItem('skai-attempt'); }
catch { submissionId = crypto.randomUUID(); }

function remember() {
  try {
    sessionStorage.setItem('skai-draft', $('goal').value); sessionStorage.setItem('skai-submission', submissionId);
    if (lastAttemptGoal === null) sessionStorage.removeItem('skai-attempt'); else sessionStorage.setItem('skai-attempt', lastAttemptGoal);
  } catch { /* Private mode can disable storage. */ }
  $('char-count').textContent = $('goal').value.length;
}
remember();

async function api(url, { method = 'GET', data } = {}) {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-SkAi-Client': 'operator-ui', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не выполнен.');
  return result;
}
function notice(message, error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
function date(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function selectedTasks() { return source === 'plan' ? snapshot?.plan.tasks ?? [] : snapshot?.tasks ?? []; }
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }

function render() {
  if (!snapshot) return;
  $('project-name').textContent = snapshot.project;
  $('queue-count').textContent = snapshot.tasks.length;
  $('plan-count').textContent = snapshot.plan.tasks.length;
  $('composer').hidden = source === 'plan';
  $('page-title').textContent = source === 'plan' ? 'План в движении.' : 'От задачи к результату.';
  $('page-description').textContent = source === 'plan' ? 'Этапы текущего плана, их результаты и причины остановки.' : 'Опишите, что нужно сделать. Прогресс и проверки будут здесь.';
  $('tasks-title').textContent = source === 'plan' ? 'Этапы плана' : 'Очередь';
  const tasks = selectedTasks();
  const attention = task => ['failed', 'blocked', 'interrupted'].includes(task.status);
  $('stat-running').textContent = tasks.filter(task => task.status === 'running').length;
  $('stat-queued').textContent = tasks.filter(task => task.status === 'queued').length;
  $('stat-attention').textContent = tasks.filter(attention).length;
  $('stat-completed').textContent = tasks.filter(task => task.status === 'completed').length;
  const hasRunning = snapshot.tasks.some(task => task.status === 'running');
  $('run').hidden = source === 'plan';
  $('run').disabled = !snapshot.executionEnabled || snapshot.ownedRun || hasRunning || !snapshot.tasks.some(task => task.status === 'queued');
  $('stop').hidden = source === 'plan' || !snapshot.ownedRun;
  $('recover').hidden = source === 'plan' || snapshot.ownedRun || !(hasRunning || snapshot.controllerError || ['running', 'stopping'].includes(snapshot.batch?.status));
  const batch = source === 'queue' ? snapshot.batch : null;
  $('execution-note').hidden = snapshot.executionEnabled || source !== 'queue';
  $('batch-panel').hidden = !batch && source !== 'plan';
  if (source === 'plan') {
    $('batch-label').textContent = labels[snapshot.plan.status] || snapshot.plan.status;
    $('batch-detail').textContent = snapshot.plan.reason || 'Здесь появятся этапы запущенного рабочего плана.';
    $('batch-progress').hidden = true;
  } else if (batch) {
    $('batch-label').textContent = labels[batch.status] || batch.status;
    $('batch-detail').textContent = batch.error || `${batch.completed} из ${batch.taskIds.length} задач завершено. Список этого запуска зафиксирован.`;
    $('batch-progress').hidden = false;
    $('batch-progress').max = Math.max(1, batch.taskIds.length);
    $('batch-progress').value = batch.completed;
  }
  const visible = [...tasks].reverse().filter(task => filter === 'all' || (filter === 'attention' ? attention(task) : task.status === filter));
  const key = JSON.stringify({ source, filter, tasks: visible });
  if (key !== listKey) {
    const focused = document.activeElement?.dataset.taskId;
    $('task-list').replaceChildren(...visible.map(task => {
      const card = node('button', 'task'); card.type = 'button'; card.dataset.taskId = task.id;
      card.setAttribute('aria-label', `${labels[task.status] || task.status}: ${task.goal}`);
      card.append(node('span', `task-icon ${task.status}`, icons[task.status] || '•'));
      const copy = node('span', 'task-copy'); copy.append(node('span', 'task-title', task.goal));
      const meta = node('span', 'task-meta'); meta.append(node('span', '', date(task.createdAt)), node('span', '', `Попыток: ${task.attempts}/3`));
      if (task.checksCount) meta.append(node('span', '', `Проверок: ${task.checksCount}`));
      if (task.hasVerifiedFile) meta.append(node('span', '', 'Файл проверен'));
      copy.append(meta); card.append(copy);
      const right = node('span', 'task-right'); right.append(node('span', `status ${task.status}`, labels[task.status] || task.status), node('span', 'task-chevron', '›')); card.append(right);
      card.addEventListener('click', () => openDetails(task.id));
      return card;
    }));
    if (focused) document.querySelector(`[data-task-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    listKey = key;
  }
  $('empty').hidden = visible.length > 0;
  if (!visible.length) {
    $('empty').querySelector('h3').textContent = tasks.length ? 'В этом разделе пока пусто' : source === 'plan' ? 'План ещё не запущен' : 'Здесь начинается работа';
    $('empty').querySelector('p').textContent = tasks.length ? 'Другие задачи доступны в соседних фильтрах.' : source === 'plan' ? 'Здесь появятся этапы текущего рабочего плана.' : 'Добавьте первую задачу. Она сохранится в очереди этой рабочей среды.';
  }
  if ($('details').open) {
    const task = tasks.find(task => task.id === detailId);
    if (task && task.updatedAt !== detailUpdated) openDetails(detailId, false);
  }
}

function fillList(id, entries, empty) { $(id).replaceChildren(...(entries?.length ? entries : [empty]).map(value => node('li', '', value))); }
async function openDetails(id, show = true) {
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}?source=${source}`);
    detailId = id; detailUpdated = task.updatedAt;
    $('detail-title').textContent = task.goal;
    $('detail-status').textContent = labels[task.status] || task.status; $('detail-status').className = `status ${task.status}`;
    $('detail-meta').textContent = `Создана ${date(task.createdAt)} · Попыток ${task.attempts}/3`;
    $('detail-error').hidden = !task.error; $('detail-error').textContent = task.error || '';
    $('detail-summary').textContent = task.report?.summary || (task.status === 'queued' ? 'Задача сохранена и ожидает запуска.' : task.status === 'running' ? 'Исполнитель работает. Состояние обновляется автоматически.' : 'Подтверждённый отчёт не получен.');
    $('file-acceptance').hidden = !task.acceptance;
    $('acceptance-result').textContent = task.acceptance?.verified ? 'Контрольный файл и его содержимое проверены Agent.' : 'Контрольный файл пока не прошёл приёмку.';
    $('acceptance-file').textContent = task.acceptance?.file || '';
    fillList('detail-checks', task.report?.checks, 'Результаты проверок пока не приложены.');
    fillList('detail-files', task.report?.filesChanged, 'Изменённые файлы не указаны.');
    fillList('detail-blockers', task.report?.blockers, '');
    $('blockers-section').hidden = !task.report?.blockers?.length;
    $('detail-source').textContent = source === 'plan' ? 'Этап рабочего плана · просмотр' : 'Задача личной очереди';
    $('resume').hidden = source !== 'queue' || !task.canResume;
    $('resume').disabled = !snapshot.executionEnabled || snapshot.ownedRun || snapshot.tasks.some(task => task.status === 'running');
    if (show && !$('details').open) $('details').showModal();
  } catch (error) { notice(error.message, true); }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await api('/api/state');
    $('connection-dot').className = 'online'; $('connection-label').textContent = 'Очередь на связи';
    $('updated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    render();
  } catch (error) { $('connection-dot').className = 'offline'; $('connection-label').textContent = 'Нет связи с очередью'; notice(error.message, true); }
  finally { refreshing = false; }
}

$('goal').addEventListener('input', () => {
  if (lastAttemptGoal !== null && $('goal').value.trim() !== lastAttemptGoal) { submissionId = crypto.randomUUID(); lastAttemptGoal = null; }
  remember();
});
$('goal').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('composer').requestSubmit(); } });
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); if (posting) return;
  posting = true; $('add-task').disabled = true; $('goal').disabled = true;
  lastAttemptGoal = $('goal').value.trim(); remember();
  try {
    await api('/api/tasks', { method: 'POST', data: { goal: lastAttemptGoal, requestId: submissionId } });
    $('goal').value = ''; submissionId = crypto.randomUUID(); lastAttemptGoal = null; remember();
    filter = 'all'; source = 'queue'; updateSelection();
    notice('Задача сохранена. Можно добавить следующую или выполнить очередь.'); await refresh();
  } catch (error) { notice(error.message, true); }
  finally { posting = false; $('add-task').disabled = false; $('goal').disabled = false; $('goal').focus(); }
});
function updateSelection() {
  for (const button of document.querySelectorAll('[data-source]')) button.classList.toggle('active', button.dataset.source === source);
  for (const button of document.querySelectorAll('[data-filter]')) button.classList.toggle('active', button.dataset.filter === filter);
  listKey = ''; render();
}
for (const button of document.querySelectorAll('[data-source]')) button.addEventListener('click', () => { source = button.dataset.source; filter = 'all'; $('details').close(); updateSelection(); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; updateSelection(); });
async function action(url, message) {
  try { await api(url, { method: 'POST', data: {} }); notice(message); await refresh(); }
  catch (error) { notice(error.message, true); }
}
$('run').addEventListener('click', () => action('/api/queue/start', 'Запуск очереди принят. Состояние обновляется автоматически.'));
$('stop').addEventListener('click', () => action('/api/queue/stop', 'Остановка запрошена. Дождитесь сохранения состояния.'));
$('recover').addEventListener('click', () => action('/api/queue/recover', 'Состояние остановленного исполнителя восстановлено.'));
$('resume').addEventListener('click', () => { $('details').close(); action(`/api/tasks/${encodeURIComponent(detailId)}/resume`, 'Продолжаем сохранённую задачу.'); });
$('close-details').addEventListener('click', () => $('details').close());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
async function poll() { await refresh(); setTimeout(poll, document.hidden ? 10_000 : 2000); }
poll();
