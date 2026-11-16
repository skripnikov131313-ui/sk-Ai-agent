const $ = id => document.getElementById(id);
const labels = { queued: 'В очереди', waiting: 'Ожидает условий', running: 'В работе', completed: 'Готово', failed: 'Ошибка', blocked: 'Блокер', interrupted: 'Прервано', skipped: 'Пропущено', idle: 'Нет запуска' };
const icons = { queued: '◷', waiting: '◷', running: '↗', completed: '✓', failed: '!', blocked: '!', interrupted: 'Ⅱ', skipped: '–' };
const targets = { current: 'Текущая среда', windows: 'Windows', 'windows-gui': 'Windows с рабочим столом', invalid: 'Некорректные требования' };
let snapshot = null;
let source = 'queue';
let filter = 'all';
let refreshing = false;
let listKey = '';
let detailId = null;
let detailUpdated = null;
let posting = false;
let memorySnapshot = null;
let memoryError = null;
let memoryKey = '';
let lastAttemptPayload = null;
let dependency = '';
let submissionId = crypto.randomUUID();
let projectId = null;
let projectScope = null;
let projectChoices = [];
let projectReady = false;
let draftScope = null;
let viewEpoch = 0;
let refreshRequested = false;
try {
  const cachedId = sessionStorage.getItem('skai-project-id');
  projectId = new URL(location.href).searchParams.get('project') || cachedId;
  if (projectId === cachedId) projectScope = sessionStorage.getItem('skai-project-scope');
} catch { /* Storage is optional. */ }

function storageKey(key) { return `skai-project:${projectScope}:${key}`; }
function restoreDraft() {
  $('goal').value = ''; $('target').value = 'current'; dependency = ''; lastAttemptPayload = null; submissionId = crypto.randomUUID();
  try {
    if (projectId === 'agent' && !sessionStorage.getItem('skai-project-drafts-migrated')) {
      for (const key of ['draft', 'target', 'dependency', 'submission', 'attempt-v2', 'attempt']) {
        const value = sessionStorage.getItem(`skai-${key}`);
        if (value !== null && sessionStorage.getItem(storageKey(key)) === null) sessionStorage.setItem(storageKey(key), value);
      }
      sessionStorage.setItem('skai-project-drafts-migrated', '1');
    }
    submissionId = sessionStorage.getItem(storageKey('submission')) || submissionId;
    $('goal').value = sessionStorage.getItem(storageKey('draft')) || '';
    $('target').value = sessionStorage.getItem(storageKey('target')) || 'current';
    if (!targets[$('target').value]) $('target').value = 'current';
    dependency = sessionStorage.getItem(storageKey('dependency')) || '';
    lastAttemptPayload = sessionStorage.getItem(storageKey('attempt-v2'));
    const legacy = sessionStorage.getItem(storageKey('attempt'));
    if (lastAttemptPayload === null && legacy !== null) lastAttemptPayload = JSON.stringify({ goal: legacy, target: 'current', dependsOn: [] });
  } catch { /* Storage is optional. */ }
  draftScope = projectScope;
  remember();
}

function composeEnabled(enabled) {
  for (const id of ['goal', 'target', 'dependency', 'add-task']) $(id).disabled = !enabled;
}
composeEnabled(false);

function taskInput() { return { goal: $('goal').value.trim(), target: $('target').value, dependsOn: dependency ? [dependency] : [] }; }
function remember() {
  try {
    if (!projectReady || !projectScope || draftScope !== projectScope) return;
    sessionStorage.setItem(storageKey('draft'), $('goal').value); sessionStorage.setItem(storageKey('submission'), submissionId);
    sessionStorage.setItem(storageKey('target'), $('target').value); sessionStorage.setItem(storageKey('dependency'), dependency);
    sessionStorage.removeItem(storageKey('attempt'));
    if (lastAttemptPayload === null) sessionStorage.removeItem(storageKey('attempt-v2')); else sessionStorage.setItem(storageKey('attempt-v2'), lastAttemptPayload);
    sessionStorage.setItem('skai-project-id', projectId); sessionStorage.setItem('skai-project-scope', projectScope);
  } catch { /* Private mode can disable storage. */ }
  $('char-count').textContent = $('goal').value.length;
}

async function api(url, { method = 'GET', data, project = { id: projectId, scope: projectScope } } = {}) {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-SkAi-Client': 'operator-ui', ...(project ? { 'X-SkAi-Project': project.id, 'X-SkAi-Project-Scope': project.scope } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не выполнен.');
  return result;
}
function notice(message, error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
function date(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function selectedTasks() { return source === 'plan' ? snapshot?.plan.tasks ?? [] : snapshot?.tasks ?? []; }
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function detailVersion(task) { return JSON.stringify([task.updatedAt, task.status, task.route, task.canResume]); }

function renderProjects() {
  const key = JSON.stringify([projectChoices, projectReady, projectId]);
  if ($('project-select').dataset.choices !== key) {
    const options = projectChoices.map(project => { const option = node('option', '', project.name); option.value = project.id; return option; });
    if (!projectReady) { const placeholder = node('option', '', 'Выберите проект'); placeholder.value = ''; placeholder.disabled = true; options.unshift(placeholder); }
    $('project-select').replaceChildren(...options); $('project-select').value = projectReady ? projectId : ''; $('project-select').dataset.choices = key;
  }
  $('project-select').disabled = posting || !projectChoices.length;
}

function resetProjectView() {
  snapshot = null; memorySnapshot = null; memoryError = null; memoryKey = ''; listKey = ''; detailId = null; detailUpdated = null;
  source = 'queue'; filter = 'all'; $('details').close(); $('task-list').replaceChildren();
  for (const id of ['stat-running', 'stat-queued', 'stat-attention', 'stat-completed', 'queue-count', 'plan-count']) $(id).textContent = '0';
  $('memory-count').textContent = '—'; $('run').disabled = true; $('stop').hidden = true; $('recover').hidden = true;
  $('project-name').textContent = projectChoices.find(project => project.id === projectId)?.name || 'Выберите проект';
  $('page-title').textContent = 'От задачи к результату.';
  $('page-description').textContent = 'Опишите, что нужно сделать. Прогресс и проверки будут здесь.';
  $('worker-note').textContent = ''; $('execution-note').hidden = true;
  $('batch-panel').hidden = true; $('project-busy').hidden = true; $('workspace-note').hidden = true;
  $('memory-panel').hidden = true; $('task-stats').hidden = false; document.querySelector('.tasks-section').hidden = false;
  $('composer').hidden = false; $('empty').hidden = false;
  $('empty').querySelector('h3').textContent = 'Загрузка проекта…';
  $('empty').querySelector('p').textContent = 'Очередь и черновик принадлежат выбранному проекту.';
  $('dependency').replaceChildren(node('option', '', 'Без зависимости')); delete $('dependency').dataset.choices;
  $('dependency').firstElementChild.value = '';
  for (const button of document.querySelectorAll('[data-source]')) button.classList.toggle('active', button.dataset.source === source);
  for (const button of document.querySelectorAll('[data-filter]')) button.classList.toggle('active', button.dataset.filter === filter);
}

function chooseProject(id) {
  if (posting) return;
  const project = projectChoices.find(item => item.id === id);
  if (!project) return;
  remember(); viewEpoch++; projectId = project.id; projectScope = project.scope; projectReady = true;
  resetProjectView(); restoreDraft(); composeEnabled(true); renderProjects(); notice('');
  const url = new URL(location.href); url.searchParams.set('project', projectId); history.replaceState(null, '', url);
  refresh();
}

function renderMemory() {
  const key = JSON.stringify([projectScope, memorySnapshot, memoryError]);
  if (key === memoryKey) return;
  memoryKey = key;
  $('memory-error').hidden = !memoryError; $('memory-error').textContent = memoryError || '';
  if (!memorySnapshot) {
    $('memory-summary').textContent = memoryError ? 'Память недоступна' : 'Загрузка…';
    $('memory-count').textContent = '—'; $('memory-empty').hidden = true;
    for (const id of ['memory-metrics', 'memory-preferences', 'memory-lessons']) $(id).replaceChildren();
    return;
  }
  $('memory-count').textContent = memorySnapshot.lessons.length;
  $('memory-summary').textContent = `${memorySnapshot.lessons.length} приёмов · контекст следующей задачи`;
  $('memory-empty').hidden = memorySnapshot.available;
  const { queue, plan } = memorySnapshot.outcomes;
  const metrics = [
    ['Задач в истории', queue.total + plan.total],
    ['Завершено без блокеров', queue.byStatus.completed + plan.byStatus.completed - queue.contradictoryReports - plan.contradictoryReports],
    ['Дополнительных попыток', queue.extraAttempts + plan.extraAttempts],
    ['Файл проверен Agent', queue.verifiedFiles + plan.verifiedFiles],
  ];
  $('memory-metrics').replaceChildren(...metrics.map(([label, value]) => {
    const card = node('div'); card.append(node('span', '', label), node('strong', '', value)); return card;
  }));
  $('memory-preferences').replaceChildren(...memorySnapshot.preferences.map(item => {
    const li = node('li'); li.append(node('p', '', item.rule), node('small', 'muted', item.source)); return li;
  }));
  if (!memorySnapshot.preferences.length) $('memory-preferences').append(node('li', 'muted', 'Предпочтения пока не записаны.'));
  $('memory-lessons').replaceChildren(...memorySnapshot.lessons.map(lesson => {
    const card = node('article', 'memory-lesson');
    card.append(node('h3', '', lesson.title), node('p', 'muted', lesson.problem), node('p', '', lesson.approach));
    const checks = node('div', 'memory-checks'); checks.append(node('span', '', 'Проверки:'));
    for (const check of lesson.checks) checks.append(node('code', '', check));
    card.append(checks); return card;
  }));
}

function render() {
  if (!snapshot) return;
  const memoryView = source === 'memory';
  $('memory-panel').hidden = !memoryView;
  $('notice').hidden = memoryView || !$('notice').textContent;
  $('storage-note').textContent = memoryView ? 'Память хранится вместе с проектом' : 'Очередь сохраняется автоматически';
  $('task-stats').hidden = memoryView;
  document.querySelector('.tasks-section').hidden = memoryView;
  $('worker-note').hidden = memoryView;
  $('project-name').textContent = snapshot.project;
  $('workspace-note').hidden = !snapshot.workspaceError; $('workspace-note').textContent = snapshot.workspaceError || '';
  $('project-busy').hidden = !snapshot.otherActiveProject;
  $('project-busy-label').textContent = snapshot.otherActiveProject ? `Сейчас выполняется очередь «${snapshot.otherActiveProject.name}».` : '';
  const platform = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[snapshot.worker.platform] || snapshot.worker.platform;
  $('worker-note').textContent = `Исполнитель этой очереди: ${platform}.${snapshot.worker.desktop ? ' Доступ к рабочему столу заявлен при запуске.' : ' Задачи для рабочего стола ожидают отдельного разрешения на Windows.'}`;
  const choices = [node('option', '', 'Без зависимости'), ...snapshot.tasks.map(task => {
    const option = node('option', '', task.goal.length > 70 ? `${task.goal.slice(0, 70)}…` : task.goal); option.value = task.id; return option;
  })];
  choices[0].value = '';
  if (dependency && !snapshot.tasks.some(task => task.id === dependency)) {
    const option = node('option', '', 'Сохранённая зависимость недоступна'); option.value = dependency; choices.push(option);
  }
  // Polling must not replace an open select while the user chooses a parent.
  const choiceKey = JSON.stringify([projectScope, snapshot.tasks.map(task => [task.id, task.goal])]);
  if ($('dependency').dataset.choices !== choiceKey) {
    $('dependency').replaceChildren(...choices); $('dependency').value = dependency; $('dependency').dataset.choices = choiceKey;
  }
  $('queue-count').textContent = snapshot.tasks.length;
  $('plan-count').textContent = snapshot.plan.tasks.length;
  $('composer').hidden = source !== 'queue';
  $('page-title').textContent = memoryView ? 'Опыт остаётся с проектом.' : source === 'plan' ? 'План в движении.' : 'От задачи к результату.';
  $('page-description').textContent = memoryView ? 'Ваши предпочтения, проверенные приёмы и результаты предыдущей работы.' : source === 'plan' ? 'Этапы текущего плана, их результаты и причины остановки.' : 'Опишите, что нужно сделать. Прогресс и проверки будут здесь.';
  $('tasks-title').textContent = source === 'plan' ? 'Этапы плана' : 'Очередь';
  const tasks = selectedTasks();
  const attention = task => ['failed', 'blocked', 'interrupted'].includes(task.status);
  $('stat-running').textContent = tasks.filter(task => task.status === 'running').length;
  $('stat-queued').textContent = tasks.filter(task => ['queued', 'waiting'].includes(task.status)).length;
  $('stat-attention').textContent = tasks.filter(attention).length;
  $('stat-completed').textContent = tasks.filter(task => task.status === 'completed').length;
  const hasRunning = snapshot.tasks.some(task => task.status === 'running');
  $('run').hidden = source === 'plan';
  $('run').disabled = !snapshot.executionEnabled || snapshot.ownedRun || snapshot.otherActiveProject || hasRunning || snapshot.runnableCount === 0;
  $('stop').hidden = source === 'plan' || !snapshot.ownedRun;
  $('recover').hidden = source === 'plan' || snapshot.ownedRun || !(hasRunning || snapshot.controllerError || ['running', 'stopping'].includes(snapshot.batch?.status));
  const batch = source === 'queue' ? snapshot.batch : null;
  $('execution-note').hidden = snapshot.executionEnabled || source !== 'queue';
  $('batch-panel').hidden = memoryView || (!batch && source !== 'plan');
  if (memoryView) { renderMemory(); return; }
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
  const visible = [...tasks].reverse().filter(task => filter === 'all' || (filter === 'attention' ? attention(task) : filter === 'queued' ? ['queued', 'waiting'].includes(task.status) : task.status === filter));
  const key = JSON.stringify({ projectScope, source, filter, tasks: visible });
  if (key !== listKey) {
    const focused = document.activeElement?.dataset.taskId;
    $('task-list').replaceChildren(...visible.map(task => {
      const card = node('button', 'task'); card.type = 'button'; card.dataset.taskId = task.id;
      card.setAttribute('aria-label', `${labels[task.status] || task.status}: ${task.goal}`);
      card.append(node('span', `task-icon ${task.status}`, icons[task.status] || '•'));
      const copy = node('span', 'task-copy'); copy.append(node('span', 'task-title', task.goal));
      const meta = node('span', 'task-meta'); meta.append(node('span', '', date(task.createdAt)), node('span', '', `Попыток: ${task.attempts}/3`));
      if (task.target !== 'current') meta.append(node('span', '', targets[task.target] || task.target));
      if (task.dependsOn.length) meta.append(node('span', '', `Зависимостей: ${task.dependsOn.length}`));
      if (task.checksCount) meta.append(node('span', '', `Проверок: ${task.checksCount}`));
      if (task.hasVerifiedFile) meta.append(node('span', '', 'Файл проверен'));
      copy.append(meta);
      if (task.status === 'waiting') copy.append(node('span', 'task-waiting', task.route.message));
      card.append(copy);
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
    if (task && detailVersion(task) !== detailUpdated) openDetails(detailId, false);
  }
}

function fillList(id, entries, empty) { $(id).replaceChildren(...(entries?.length ? entries : [empty]).map(value => node('li', '', value))); }
async function openDetails(id, show = true) {
  const epoch = viewEpoch;
  const selectedSource = source;
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}?source=${selectedSource}`);
    if (epoch !== viewEpoch || selectedSource !== source) return;
    detailId = id; detailUpdated = detailVersion(task);
    $('detail-title').textContent = task.goal;
    $('detail-status').textContent = labels[task.status] || task.status; $('detail-status').className = `status ${task.status}`;
    $('detail-meta').textContent = `Создана ${date(task.createdAt)} · Попыток ${task.attempts}/3`;
    $('detail-requirements').textContent = `Где выполнять: ${targets[task.target] || task.target}`;
    const reason = task.error || (task.status !== 'completed' && !task.route.eligible ? task.route.message : '');
    $('detail-error').hidden = !reason; $('detail-error').textContent = reason;
    $('dependencies-section').hidden = task.dependsOn.length === 0;
    fillList('detail-dependencies', task.dependsOn.map(id => selectedTasks().find(parent => parent.id === id)?.goal || id), '');
    $('detail-summary').textContent = task.report?.summary || (task.status === 'waiting' ? 'Задача сохранена. Для запуска нужны подходящая среда и завершённые зависимости. Попытки пока не расходуются.' : task.status === 'queued' ? 'Задача сохранена и ожидает запуска.' : task.status === 'running' ? 'Исполнитель работает. Состояние обновляется автоматически.' : 'Подтверждённый отчёт не получен.');
    $('file-acceptance').hidden = !task.acceptance;
    $('acceptance-result').textContent = task.acceptance?.verified ? 'Контрольный файл и его содержимое проверены Agent.' : 'Контрольный файл пока не прошёл приёмку.';
    $('acceptance-file').textContent = task.acceptance?.file || '';
    fillList('detail-checks', task.report?.checks, 'Результаты проверок пока не приложены.');
    fillList('detail-files', task.report?.filesChanged, 'Изменённые файлы не указаны.');
    fillList('detail-blockers', task.report?.blockers, '');
    $('blockers-section').hidden = !task.report?.blockers?.length;
    $('detail-source').textContent = source === 'plan' ? 'Этап рабочего плана · просмотр' : 'Задача личной очереди';
    $('resume').hidden = source !== 'queue' || !task.canResume;
    $('resume').disabled = !snapshot.executionEnabled || snapshot.ownedRun || snapshot.otherActiveProject || snapshot.tasks.some(task => task.status === 'running');
    if (show && !$('details').open) $('details').showModal();
  } catch (error) { if (epoch === viewEpoch) notice(error.message, true); }
}

async function refresh() {
  if (refreshing) { refreshRequested = true; return; }
  refreshing = true;
  let epoch = viewEpoch;
  try {
    const roster = await api('/api/projects', { project: null });
    if (epoch !== viewEpoch) { refreshRequested = true; return; }
    projectChoices = roster.projects;
    projectId ||= roster.defaultProjectId;
    const selected = projectChoices.find(item => item.id === projectId);
    if (!selected || (projectScope && projectScope !== selected.scope)) {
      if (projectReady) { remember(); viewEpoch++; epoch = viewEpoch; resetProjectView(); }
      projectReady = false; composeEnabled(false); renderProjects();
      $('connection-dot').className = 'online'; $('connection-label').textContent = 'Выберите проект';
      notice('Сохранённый проект недоступен или его привязка изменилась. Выберите проект из списка перед отправкой задачи.', true);
      return;
    }
    if (!projectReady) {
      projectScope = selected.scope; projectReady = true;
      resetProjectView(); restoreDraft(); composeEnabled(!posting);
    }
    renderProjects();
    const project = { id: projectId, scope: projectScope };
    const state = await api('/api/state', { project });
    if (epoch !== viewEpoch) { refreshRequested = true; return; }
    if (state.projectId !== project.id || state.projectScope !== project.scope) throw new Error('Ответ очереди относится к другому проекту. Обновите панель.');
    snapshot = state;
    if (source === 'memory') {
      try {
        const memory = await api('/api/memory', { project });
        if (epoch !== viewEpoch) { refreshRequested = true; return; }
        memorySnapshot = memory; memoryError = null;
      } catch (error) {
        if (epoch !== viewEpoch) { refreshRequested = true; return; }
        memorySnapshot = null; memoryError = error.message;
      }
    }
    $('connection-dot').className = 'online'; $('connection-label').textContent = 'Очередь на связи';
    $('updated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    render();
  } catch (error) {
    if (epoch === viewEpoch) { $('connection-dot').className = 'offline'; $('connection-label').textContent = 'Нет связи с очередью'; notice(error.message, true); }
  } finally {
    refreshing = false;
    if (refreshRequested) { refreshRequested = false; queueMicrotask(refresh); }
  }
}

function draftChanged() {
  if (lastAttemptPayload !== null && JSON.stringify(taskInput()) !== lastAttemptPayload) { submissionId = crypto.randomUUID(); lastAttemptPayload = null; }
  remember();
}
$('goal').addEventListener('input', draftChanged);
$('target').addEventListener('change', draftChanged);
$('dependency').addEventListener('change', () => { dependency = $('dependency').value; draftChanged(); });
$('goal').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('composer').requestSubmit(); } });
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); if (posting || !projectReady) return;
  posting = true; composeEnabled(false); renderProjects();
  const input = taskInput(); lastAttemptPayload = JSON.stringify(input); remember();
  try {
    await api('/api/tasks', { method: 'POST', data: { ...input, requestId: submissionId } });
    $('goal').value = ''; dependency = ''; $('dependency').value = ''; submissionId = crypto.randomUUID(); lastAttemptPayload = null; remember();
    filter = 'all'; source = 'queue'; updateSelection();
    notice('Задача сохранена. Можно добавить следующую или выполнить очередь.'); await refresh();
  } catch (error) { notice(error.message, true); }
  finally { posting = false; composeEnabled(projectReady); renderProjects(); if (projectReady) $('goal').focus(); }
});
function updateSelection() {
  for (const button of document.querySelectorAll('[data-source]')) button.classList.toggle('active', button.dataset.source === source);
  for (const button of document.querySelectorAll('[data-filter]')) button.classList.toggle('active', button.dataset.filter === filter);
  listKey = ''; render();
}
for (const button of document.querySelectorAll('[data-source]')) button.addEventListener('click', () => { source = button.dataset.source; filter = 'all'; $('details').close(); updateSelection(); if (source === 'memory') refresh(); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; updateSelection(); });
async function action(url, message) {
  if (!projectReady) return;
  const epoch = viewEpoch;
  try { await api(url, { method: 'POST', data: {} }); if (epoch === viewEpoch) notice(message); await refresh(); }
  catch (error) { if (epoch === viewEpoch) notice(error.message, true); }
}
$('project-select').addEventListener('change', () => chooseProject($('project-select').value));
$('show-active-project').addEventListener('click', () => { if (snapshot?.otherActiveProject) chooseProject(snapshot.otherActiveProject.id); });
$('run').addEventListener('click', () => action('/api/queue/start', 'Запуск очереди принят. Состояние обновляется автоматически.'));
$('stop').addEventListener('click', () => action('/api/queue/stop', 'Остановка запрошена. Дождитесь сохранения состояния.'));
$('recover').addEventListener('click', () => action('/api/queue/recover', 'Состояние остановленного исполнителя восстановлено.'));
$('resume').addEventListener('click', () => { $('details').close(); action(`/api/tasks/${encodeURIComponent(detailId)}/resume`, 'Продолжаем сохранённую задачу.'); });
$('close-details').addEventListener('click', () => $('details').close());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
async function poll() { await refresh(); setTimeout(poll, document.hidden ? 10_000 : 2000); }
poll();
