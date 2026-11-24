const sidecar = window.sidecar;

const state = {
  pushedConvId: '',
  activeConvId: '',
  latestData: null,
  lastPollClientMs: Date.now(),
  lastStagesKey: '',
  lastFeedKey: '',
  showThoughts: false,
  polling: false,
};

const $ = (id) => document.getElementById(id);

function getCurrentConvId() {
  return String(
    state.pushedConvId ||
      window.sidecar?.conversationId ||
      new URLSearchParams(window.location.search).get('conversationId') ||
      ''
  ).trim();
}

function resetForConversationSwitch(nextConvId) {
  state.activeConvId = nextConvId;
  state.latestData = null;
  state.lastStagesKey = '';
  state.lastFeedKey = '';
}

function applyThemeClass() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  let isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (bg) {
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (match) {
      isDark = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) < 128;
    } else if (bg.startsWith('#') && (bg.length === 7 || bg.length === 4)) {
      const hex = bg.length === 4 ? `#${bg[1]}${bg[1]}${bg[2]}${bg[2]}${bg[3]}${bg[3]}` : bg;
      const lum = 0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16);
      isDark = lum < 128;
    }
  }
  document.body.classList.toggle('theme-dark', isDark);
  document.body.classList.toggle('theme-light', !isDark);
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'theme-change') {
    setTimeout(applyThemeClass, 10);
  } else if (event.data?.type === 'conversation-change') {
    const nextId = String(event.data?.payload?.conversationId || '').trim();
    if (nextId !== state.pushedConvId) {
      state.pushedConvId = nextId;
      resetForConversationSwitch(nextId);
      pollStatus();
    }
  }
});

function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function formatShortDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${mins}分${remSec}秒` : `${mins}分钟`;
}

function formatShortTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function apiFetch(path, options = {}) {
  if (sidecar && typeof sidecar.fetch === 'function') {
    return sidecar.fetch(path, options);
  }
  return fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}

function renderConvBadge(convId) {
  const badge = $('conv-badge');
  if (!badge) return;
  if (convId) {
    badge.textContent = `#${convId.slice(0, 8)}`;
    badge.title = `当前仅追踪此对话：${convId}`;
  } else {
    badge.textContent = '未绑定';
    badge.title = '等待 Antigravity 传入当前对话 ID';
  }
}

function renderLiveClocks() {
  const data = state.latestData;
  if (!data || !data.found) {
    $('metric-elapsed').textContent = '00:00';
    $('metric-stage-elapsed').textContent = '待开始';
    $('metric-silence').textContent = '空闲';
    return;
  }

  const extraMs = data.timing?.isRunning ? Math.max(0, Date.now() - state.lastPollClientMs) : 0;
  const turnElapsedMs = (data.timing?.turnElapsedMs || 0) + extraMs;
  const stageElapsedMs = (data.timing?.stageElapsedMs || 0) + extraMs;

  $('metric-elapsed').textContent = formatClock(turnElapsedMs);
  $('metric-stage-elapsed').textContent = data.timing?.isRunning
    ? `阶段 ${formatClock(stageElapsedMs)}`
    : '已结束';

  const silenceEl = $('metric-silence');
  if (!data.timing?.isRunning) {
    silenceEl.textContent = data.health?.level === 'waiting_user' ? '待确认' : '已结束';
  } else {
    const liveSilenceSec = (data.health?.silenceSec || 0) + Math.floor(extraMs / 1000);
    silenceEl.textContent = liveSilenceSec <= 3 ? '刚刚' : `${liveSilenceSec}s前`;
  }
}

function renderStages(data) {
  const listEl = $('stage-list');
  const noteEl = $('stage-count-note');
  const hasExplicit = Array.isArray(data.explicitPlan) && data.explicitPlan.length > 0;
  const items = hasExplicit
    ? data.explicitPlan.map((p) => ({ title: p.title, status: p.status, elapsedMs: p.estimatedMs || 0, isEstimate: true }))
    : (data.stageTimeline || []).map((s) => ({ title: s.label, status: s.status, elapsedMs: s.elapsedMs, isEstimate: false }));

  const doneCount = items.filter((it) => it.status === 'done').length;
  noteEl.textContent = items.length ? `${doneCount}/${items.length}` : '';

  const key = JSON.stringify(items);
  if (key === state.lastStagesKey) return;
  state.lastStagesKey = key;

  if (!items.length) {
    listEl.innerHTML = '<div class="empty-hint">暂无阶段</div>';
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      const icon = item.status === 'done' ? '✓' : item.status === 'active' ? '●' : '○';
      let durText = '';
      if (item.status === 'active') durText = '进行中';
      else if (item.elapsedMs > 0) durText = item.isEstimate ? `约${formatShortDuration(item.elapsedMs)}` : formatShortDuration(item.elapsedMs);
      else durText = item.status === 'done' ? '完成' : '待开始';

      return `
        <div class="stage-row is-${escapeHtml(item.status)}">
          <div class="stage-left">
            <span class="stage-icon">${icon}</span>
            <span class="stage-name">${escapeHtml(item.title)}</span>
          </div>
          <span class="stage-dur mono">${escapeHtml(durText)}</span>
        </div>
      `;
    })
    .join('');
}

function renderThoughtFeed(data) {
  const feedEl = $('thought-feed');
  const items = data.thoughtFeed || [];
  const key = JSON.stringify(items) + `|${state.showThoughts}`;
  if (key === state.lastFeedKey) return;
  state.lastFeedKey = key;

  if (!items.length) {
    feedEl.innerHTML = '<div class="empty-hint">暂无动态</div>';
    return;
  }

  feedEl.innerHTML = items
    .map((item) => {
      const thoughtHtml =
        state.showThoughts && item.thought && item.thought !== item.headline
          ? `<div class="feed-thought" title="${escapeHtml(item.thought)}">${escapeHtml(item.thought)}</div>`
          : '';
      return `
        <div class="feed-item">
          <div class="feed-row">
            <span class="feed-headline" title="${escapeHtml(item.headline)}">${escapeHtml(item.headline)}</span>
            <span class="feed-time mono">${escapeHtml(formatShortTime(item.timestampMs))}</span>
          </div>
          ${thoughtHtml}
        </div>
      `;
    })
    .join('');
}

function renderAll(data) {
  state.latestData = data;
  state.lastPollClientMs = Date.now();

  renderConvBadge(data.conversationId || state.activeConvId);

  const titleEl = $('task-title');
  const cpCount = Number(data.contextUsage?.checkpointCount || 0);
  if (data.found && data.taskTitle) {
    titleEl.textContent = cpCount > 0 ? `${data.taskTitle}（压缩${cpCount}次）` : data.taskTitle;
    titleEl.classList.remove('hidden');
  } else {
    titleEl.textContent = '';
    titleEl.classList.add('hidden');
  }

  const level = data.health?.level || 'idle';
  const dot = $('header-dot');
  dot.className = 'pulse-dot';
  if (data.timing?.isRunning) {
    dot.classList.add(level === 'stuck' || level === 'error' ? `is-${level}` : level === 'slow' ? 'is-slow' : 'is-running');
  } else if (level === 'error') {
    dot.classList.add('is-error');
  }

  const pill = $('health-pill');
  pill.className = `health-pill is-${level}`;
  pill.textContent = data.health?.label || '待命';

  $('metric-eta').textContent = data.eta?.displayText || '—';
  $('metric-eta-basis').textContent = data.eta?.basisText || '待开始';

  const shortMap = {
    idle: '待命',
    healthy: '正常',
    slow: '偏慢',
    stuck: '卡住',
    waiting_user: '待确认',
    completed: '完成',
    error: '出错',
  };
  $('metric-health-short').textContent = shortMap[level] || '待命';

  const alertBanner = $('alert-banner');
  const nudgeBtn = $('btn-nudge');
  if (level === 'slow' || level === 'stuck' || level === 'error') {
    alertBanner.className = `alert-banner is-${level}`;
    $('alert-title').textContent = data.health?.label || '';
    $('alert-reason').textContent = data.health?.reason || '';
    nudgeBtn.classList.toggle('hidden', level !== 'stuck' && level !== 'error');
    nudgeBtn.disabled = false;
    nudgeBtn.textContent = '提醒检查';
  } else {
    alertBanner.className = 'alert-banner hidden';
  }

  $('current-stage-chip').textContent = data.currentStage?.label || '待命';
  $('current-summary').textContent = data.currentStage?.summary || '发送指令后自动追踪';

  const pct = data.found ? Number(data.eta?.progressPercent || 0) : 0;
  $('progress-fill').style.width = `${pct}%`;
  $('progress-pct').textContent = `${pct}%`;

  if (data.settings) {
    state.showThoughts = data.settings.showThoughts === true;
    $('toggle-thoughts').checked = state.showThoughts;
    if ($('toggle-notify')) $('toggle-notify').checked = data.settings.enableNotifications !== false;
    if ($('toggle-sound')) $('toggle-sound').checked = data.settings.enableSound !== false;
    document.querySelectorAll('.thresh-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.sec) === Number(data.settings.stuckThresholdSec));
    });
  }

  renderLiveClocks();
  renderStages(data);
  renderThoughtFeed(data);
}

async function pollStatus() {
  if (state.polling) return;
  state.polling = true;
  try {
    const convId = getCurrentConvId();
    if (convId !== state.activeConvId) {
      resetForConversationSwitch(convId);
    }
    const qs = new URLSearchParams({ strict: '1' });
    if (convId) qs.set('conversationId', convId);
    const res = await apiFetch(`/api/status?${qs.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (getCurrentConvId() !== convId) return;
    renderAll(data);
    $('sync-note').textContent = '';
  } catch {
    $('sync-note').textContent = '重连中';
  } finally {
    state.polling = false;
  }
}

async function updateSettings(patch) {
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await pollStatus();
  } catch {
    // Ignore transient settings errors.
  }
}

function bindEvents() {

  $('toggle-thoughts').addEventListener('change', (e) => {
    state.showThoughts = e.target.checked;
    state.lastFeedKey = '';
    updateSettings({ showThoughts: state.showThoughts });
  });

  if ($('toggle-notify')) {
    $('toggle-notify').addEventListener('change', (e) => {
      updateSettings({ enableNotifications: e.target.checked });
    });
  }

  if ($('toggle-sound')) {
    $('toggle-sound').addEventListener('change', (e) => {
      updateSettings({ enableSound: e.target.checked });
    });
  }

  $('threshold-group').addEventListener('click', (e) => {
    const btn = e.target.closest('.thresh-btn');
    if (!btn) return;
    const stuckThresholdSec = Number(btn.dataset.sec);
    if (!Number.isFinite(stuckThresholdSec)) return;
    updateSettings({
      stuckThresholdSec,
      warnThresholdSec: Math.max(15, Math.floor(stuckThresholdSec * 0.4)),
    });
  });

  $('btn-nudge').addEventListener('click', async () => {
    const btn = $('btn-nudge');
    const targetConvId = getCurrentConvId() || state.latestData?.conversationId;
    if (!sidecar?.agent || !targetConvId) return;
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      await sidecar.agent.sendMessage(
        '【任务脉搏提醒】当前步骤已静默较长时间，请检查后台命令或工具是否卡住；若已完成请继续推进，若阻塞请汇报卡点并安全恢复。',
        targetConvId
      );
      btn.textContent = '已提醒';
    } catch {
      btn.disabled = false;
      btn.textContent = '提醒检查';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  applyThemeClass();
  bindEvents();
  pollStatus();
  setInterval(pollStatus, 2000);
  setInterval(renderLiveClocks, 1000);
});
