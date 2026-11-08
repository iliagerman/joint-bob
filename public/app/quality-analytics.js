import { api } from './api.js';
import { toast } from './shell.js';
import { isNodeAdmin } from './node-admin.js';

let page = 0;
let loading = false;
let mounted = false;
const root = () => document.getElementById('qualityAnalytics');
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const field = id => document.getElementById(id);
const percent = (count, total) => total ? `${(100 * count / total).toFixed(1)}%` : '—';
function button(text, id, handler) { const node = el('button', text, 'ghost'); node.type = 'button'; node.dataset.testid = id; node.addEventListener('click', handler); return node; }
function label(text, control) { const node = el('label', text); node.append(control); return node; }
function input(id, placeholder, type = 'text') { const node = el('input'); node.id = id; node.dataset.testid = id.replaceAll('qualityIssue', 'quality-issue-filter'); node.type = type; node.placeholder = placeholder; return node; }
function mount() {
  const target = root(); target.replaceChildren();
  const toggle = input('qualityEnabled', '', 'checkbox'); toggle.dataset.testid = 'quality-enabled';
  const status = el('p', 'Changes save automatically on this machine.', 'settings-hint');
  status.dataset.testid = 'quality-save-status'; status.setAttribute('role', 'status');
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    status.classList.remove('quality-error'); status.textContent = 'Saving collection settings…';
    try {
      await api('/api/quality-analytics/settings', { method: 'PUT', body: JSON.stringify({ enabled }) });
      status.textContent = 'Saved on this machine.';
      await loadQualityAnalytics();
    } catch (error) {
      toggle.checked = !enabled;
      status.classList.add('quality-error'); status.textContent = `Could not save: ${error.message}`;
    } finally { toggle.disabled = false; }
  });
  const collection = el('section', undefined, 'quality-collection');
  const toggleLabel = el('label', undefined, 'checkbox-row'); toggleLabel.append(toggle, document.createTextNode('Aggregate quality on this machine'));
  collection.append(toggleLabel, status, el('p', 'Only conversations already available on this machine are analyzed, including normal synced copies. Claude and Jev receive evidence; derived lessons, reasons and metrics stay here. Other machines are unchanged. Enabling scans history and may incur model usage. Disabling keeps results.', 'muted'));
  collection.append(button('Configure models and accounts in System AI', 'quality-system-ai-link', async () => {
    const { openSettings } = await import('./settings.js'); await openSettings('system-ai');
  }));
  target.append(el('h2', 'Reply quality'), collection);
  const filters = el('div', undefined, 'quality-filters');
  const project = el('select'); project.id = 'qualityProject'; project.setAttribute('aria-label', 'Project');
  const from = input('qualityFrom', '', 'date'), to = input('qualityTo', '', 'date');
  const model = input('qualityModel', 'Exact source model'), harness = input('qualityHarness', 'claude, pi, kiro…');
  const claudeEvaluator = input('qualityClaudeEvaluator', 'Exact Claude evaluator'), jevEvaluator = input('qualityJevEvaluator', 'Exact Jev evaluator');
  const issue = input('qualityIssue', 'Issue type'), version = input('qualityVersion', 'Evaluator version'); version.value = '1';
  filters.append(label('Project', project), label('From', from), label('To', to), label('Source model', model), label('Harness', harness), label('Issue', issue), label('Evaluator version', version), label('Claude evaluator', claudeEvaluator), label('Jev evaluator', jevEvaluator));
  for (const control of [project, from, to, model, harness, issue, version, claudeEvaluator, jevEvaluator]) control.addEventListener('change', () => { page = 0; });
  const filterSection = el('details', undefined, 'quality-filter-section');
  const filterToggle = el('summary', 'Filters'); filterToggle.dataset.testid = 'quality-filters-toggle';
  filterSection.append(filterToggle, filters); target.append(filterSection);
  const actions = el('div', undefined, 'quality-actions');
  actions.append(button('Refresh', 'quality-refresh', () => { page = 0; void loadQualityAnalytics(); }), button('Retry / scan local history', 'quality-retry', async () => {
    try { await api('/api/quality-analytics/retry', { method: 'POST', body: '{}' }); toast('Local history scan queued'); await loadQualityAnalytics(); }
    catch (error) { toast.error(error.message); }
  }));
  const mode = el('select'); mode.id = 'qualityView'; mode.dataset.testid = 'quality-view'; mode.setAttribute('aria-label', 'Quality view');
  for (const [value, text] of [['trends', 'Quality trend'], ['issues', 'Issue types'], ['lessons', 'Accepted lessons'], ['rows', 'Reasons and lessons']]) mode.append(new Option(text, value));
  mode.addEventListener('change', showView);
  actions.append(label('View', mode));
  target.append(actions);
  for (const id of ['summary', 'coverage', 'trends', 'issues', 'lessons', 'rows', 'pager']) { const node = el('div'); node.id = `quality-${id}`; node.dataset.testid = `quality-${id}`; target.append(node); }
  mounted = true;
}
function showView() {
  const view = field('qualityView').value;
  for (const id of ['trends', 'issues', 'lessons', 'rows']) field(`quality-${id}`).hidden = id !== view;
  field('quality-pager').hidden = view !== 'rows';
}
function table(title, headings, rows) {
  const section = el('section'); section.append(el('h3', title));
  if (!rows.length) { section.append(el('p', 'No matching observations yet.', 'muted')); return section; }
  const table = el('table'), head = el('tr'); headings.forEach(text => head.append(el('th', text))); table.append(head);
  const body = el('tbody'); table.append(body); section.append(table);
  let localPage = 0;
  const pager = el('div', undefined, 'quality-actions');
  const draw = () => {
    body.replaceChildren();
    for (const values of rows.slice(localPage * 8, (localPage + 1) * 8)) { const row = el('tr'); for (const value of values) { const cell = el('td'); value instanceof Node ? cell.append(value) : cell.textContent = String(value ?? '—'); row.append(cell); } body.append(row); }
    pager.replaceChildren();
    if (rows.length <= 8) return;
    const back = button('Previous', 'quality-table-previous', () => { localPage--; draw(); }); back.disabled = localPage === 0;
    const next = button('Next', 'quality-table-next', () => { localPage++; draw(); }); next.disabled = (localPage + 1) * 8 >= rows.length;
    pager.append(back, el('span', `Page ${localPage + 1} of ${Math.ceil(rows.length / 8)}`), next);
  };
  draw(); section.append(pager); return section;
}
function render(view) {
  field('qualityEnabled').checked = view.enabled;
  const project = field('qualityProject'), selected = project.value;
  project.replaceChildren(new Option('All accessible projects', ''), ...view.projects.map(item => new Option(item.name, item.id))); project.value = selected;
  field('quality-summary').textContent = `${view.totals.replies} evaluated replies · ${percent(view.totals.issues, view.totals.replies)} with issues · ${view.totals.good} supported good · ${view.totals.unknown} unknown outcomes`;
  const coverage = field('quality-coverage'); coverage.replaceChildren(el('p', `Collection ${view.enabled ? 'enabled' : 'off'} · ${view.jobs.map(job => `${job.count} ${job.state}`).join(' · ') || 'No history scanned'}. Missing evidence is not success. Refresh to see progress.`, 'muted'));
  const details = el('details', undefined, 'quality-collection-details');
  const detailsToggle = el('summary', 'Coverage and evaluator details'); detailsToggle.dataset.testid = 'quality-details-toggle';
  details.append(detailsToggle);
  if (view.coverage) details.append(el('p', `Known eligible replies across selected projects: ${view.coverage.eligibleReplies}. Unscanned or missing transcripts may contain additional replies that cannot yet be counted.`, 'muted'));
  if (view.collectionError) coverage.append(el('p', view.collectionError, 'quality-error'));
  for (const failure of view.failures.slice(0, 4)) coverage.append(el('p', `${failure.projectId} / ${failure.conversationId}: ${failure.error}`, 'quality-error'));
  details.append(el('p', `Conversation ratings (all-time for selected projects, separate from reply judgments): ${view.feedback.map(item => `${item.source} ${item.rating}: ${item.count}`).join(' · ') || 'none'}`, 'muted'));
  details.append(el('p', `Evaluator/model cohorts: ${view.versions.map(item => `v${item.version} · ${item.claudeModel} · ${item.jevModel}`).join('; ') || 'none'}. Use version and evaluator filters for comparable trends; mixed evaluator cohorts are not a single comparable quality score.`, 'muted'));
  coverage.append(details);
  field('quality-trends').replaceChildren(table('Quality over time — source dates, not backfill dates', ['Date / evaluator cohort', 'Evaluated', 'Issue rate', 'Unknown'], view.trends.map(row => [`${row.day} · ${row.claudeEvaluator} / ${row.jevEvaluator}`, row.replies, percent(row.issues, row.replies), row.unknown])));
  field('quality-issues').replaceChildren(table('Issue types — no recent occurrence does not prove resolution', ['Type / drill down', 'Replies', 'First observed', 'Last observed'], view.issues.map(row => [button(row.type, `quality-type-${row.type}`, () => { field('qualityIssue').value = row.type; field('qualityView').value = 'rows'; page = 0; void loadQualityAnalytics(); }), row.replies, row.firstSeen, row.lastSeen])));
  field('quality-lessons').replaceChildren(table('Accepted lessons — before / after association, not proof of cause', ['Issue / rule', 'Adopted', 'Before', 'After'], (view.lessons ?? []).map(row => [`${row.type} / ${row.ruleId}`, row.adoptedAt || 'Unknown', `${row.beforeIssues}/${row.beforeReplies}`, `${row.afterIssues}/${row.afterReplies}`])));
  const rows = field('quality-rows'); rows.replaceChildren(el('h3', 'Reasons and lessons'));
  for (const row of view.rows) {
    const card = el('article', undefined, 'quality-observation');
    card.append(el('strong', `${row.result.outcome} · ${row.at || 'Undated'} · ${row.harness} ${row.model}`), el('p', row.result.reason), el('small', `Source: ${row.projectId} / ${row.conversationId} / reply ${row.replyId} · inferred · confidence ${row.result.confidence}`));
    for (const issue of row.result.issues) card.append(el('p', `${issue.type}: ${issue.reason}`), el('p', `Lesson: ${issue.lesson || 'No reusable lesson identified'}`), el('small', issue.ruleId ? `Accepted rule ${issue.ruleId} · adopted ${issue.adoptedAt || 'date unknown'}` : 'Derived lesson — not automatically installed as a shared rule'));
    rows.append(card);
  }
  const pager = field('quality-pager'); pager.replaceChildren();
  const back = button('Previous', 'quality-previous', () => { page--; void loadQualityAnalytics(); }); back.disabled = page === 0;
  const next = button('Next', 'quality-next', () => { page++; void loadQualityAnalytics(); }); next.disabled = (page + 1) * view.pageSize >= view.total;
  pager.append(back, el('span', `Page ${page + 1} · ${view.total} replies`), next);
  showView();
}
export async function loadQualityAnalytics() {
  if (!isNodeAdmin() || loading) return;
  if (!mounted) mount();
  loading = true;
  try {
    const query = new URLSearchParams({ page: String(page), pageSize: '8' });
    for (const [key, id] of [['projectId', 'qualityProject'], ['from', 'qualityFrom'], ['to', 'qualityTo'], ['model', 'qualityModel'], ['harness', 'qualityHarness'], ['issue', 'qualityIssue'], ['version', 'qualityVersion'], ['claudeEvaluator', 'qualityClaudeEvaluator'], ['jevEvaluator', 'qualityJevEvaluator']]) if (field(id).value) query.set(key, field(id).value);
    render(await api(`/api/quality-analytics?${query}`));
  } catch (error) { field('quality-summary').textContent = 'Quality metrics could not be loaded.'; toast.error(error.message); }
  finally { loading = false; }
}
