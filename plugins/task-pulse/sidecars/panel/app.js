const sidecar = window.sidecar;
const HOST_CONV_ID = new URLSearchParams(window.location.search).get('conversationId') || '';

const state = {
  autoFollow: true,
  selectedConvId: '',
  latestData: null,
  lastPollClientMs: Date.now(),
  lastStagesKey: '',
  lastFeedKey: '',
  showThoughts: true,
  polling: false,
};

const $ = (id) => document.getElementById(id);

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

function formatTimeOfDay(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

function renderConversations(conversations, activeId) {
  const sel = $('conv-select');
  if (!sel) return;
  const activeItem = conversations.find((c) => c.id === activeId);
  const autoLabel = HOST_CONV_ID
    ? (activeItem ? `当前 · ${activeItem.title}` : '锁定当前会话')
    : (activeItem ? `自动 · ${activeItem.title}` : '自动跟随活跃会话');
  const modeKey = state.autoFollow ? '__auto__' : activeId;
  const key = conversations.map((c) => `${c.id}:${c.title}`).join('|') + `|${modeKey}|${autoLabel}`;
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;

  const autoOption = `<option value="__auto__" ${state.autoFollow ? 'selected' : ''}>${escapeHtml(autoLabel)}</option>`;
  const options = conversations
    .map((c) => `<option value="${escapeHtml(c.id)}" ${!state.autoFollow && c.id === activeId ? 'selected' : ''}>${escapeHtml(c.title)}</option>`)
    .join('');
  sel.innerHTML = autoOption + options;
}

function renderLiveClocks() {
  const data = state.latestData;
  if (!data || !data.found) return;

  const extraMs = data.timing?.isRunning ? Math.max(0, Date.now() - state.lastPollClientMs) : 0;
  const turnElapsedMs = (data.timing?.turnElapsedMs || 0) + extraMs;
  const stageElapsedMs = (data.timing?.stageElapsedMs || 0) + extraMs;

  $('metric-elapsed').textContent = formatClock(turnElapsedMs);
  $('metric-stage-elapsed').textContent = data.timing?.isRunning
    ? `本阶段 ${formatClock(stageElapsedMs)}`
    : '本轮已结束';

  const silenceEl = $('metric-silence');
  if (!data.timing?.isRunning) {
    silenceEl.textContent = data.health?.level === 'waiting_user' ? '等你确认' : '已结束';
  } else {
    const liveSilenceSec = (data.health?.silenceSec || 0) + Math.floor(extraMs / 1000);
    silenceEl.textContent = liveSilenceSec <= 3 ? '刚刚活跃' : `${liveSilenceSec}秒前活跃`;
  }
}

function renderStages(data) {
  const listEl = $('stage-list');
  const noteEl = $('stage-count-note');
  const hasExplicit = Array.isArray(data.explicitPlan) && data.explicitPlan.length > 0;
  const items = hasExplicit
    ? data.explicitPlan.map((p) => ({ title: p.title, status: p.status, elapsedMs: p.estimatedMs || 0, isEstimate: true }))
    : (data.stageTimeline || []).map((s) => ({ title: s.label, status: s.status, elapsedMs: s.elapsedMs, isEstimate: false }));

  noteEl.textContent = hasExplicit ? '按任务拆解阶段' : '自动归纳阶段';

  const key = JSON.stringify(items);
  if (key === state.lastStagesKey) return;
  state.lastStagesKey = key;

  if (!items.length) {
    listEl.innerHTML = '<div class="empty-hint">暂无阶段记录</div>';
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      const icon = item.status === 'done' ? '✓' : item.status === 'active' ? '●' : '○';
      let durText = '';
      if (item.status === 'active') durText = '进行中';
      else if (item.elapsedMs > 0) durText = item.isEstimate ? `约${formatShortDuration(item.elapsedMs)}` : formatShortDuration(item.elapsedMs);
      else durText = item.status === 'done' ? '已完成' : '待开始';

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
    feedEl.innerHTML = '<div class="empty-hint">开始执行长任务后，这里会持续播报每一步在做什么、为什么做。</div>';
    return;
  }

  feedEl.innerHTML = items
    .map((item) => {
      const thoughtHtml =
        state.showThoughts && item.thought && item.thought !== item.headline
          ? `<div class="feed-thought">${escapeHtml(item.thought)}</div>`
          : '';
      return `
        <div class="feed-item">
          <div class="feed-meta">
            <span>${escapeHtml(item.stageLabel)}</span>
            <span class="mono">${escapeHtml(formatTimeOfDay(item.timestampMs))}</span>
          </div>
          <div class="feed-headline">${escapeHtml(item.headline)}</div>
          ${thoughtHtml}
        </div>
      `;
    })
    .join('');
}

function renderAll(data) {
  state.latestData = data;
  state.lastPollClientMs = Date.now();

  renderConversations(data.conversations || [], data.conversationId || '');
  $('task-title').textContent = data.taskTitle || '等待新任务…';

  const level = data.health?.level || 'completed';
  const dot = $('header-dot');
  dot.className = 'pulse-dot';
  if (data.timing?.isRunning) {
    dot.classList.add(level === 'stuck' || level === 'error' ? `is-${level}` : level === 'slow' ? 'is-slow' : 'is-running');
  } else if (level === 'error') {
    dot.classList.add('is-error');
  }

  const pill = $('health-pill');
  pill.className = `health-pill is-${level}`;
  pill.textContent = data.health?.label || '待命中';

  $('metric-eta').textContent = data.eta?.displayText || '—';
  $('metric-eta-basis').textContent = data.eta?.basisText || '';

  const shortMap = {
    healthy: '正常',
    slow: '偏慢',
    stuck: '疑似卡住',
    waiting_user: '等你确认',
    completed: '正常',
    error: '出错',
  };
  $('metric-health-short').textContent = shortMap[level] || '正常';

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

  $('current-stage-chip').textContent = data.currentStage?.label || '待命中';
  $('current-summary').textContent = data.currentStage?.summary || '等待你的下一条指令…';

  const pct = Number(data.eta?.progressPercent || 0);
  $('progress-fill').style.width = `${pct}%`;
  $('progress-pct').textContent = `${pct}%`;

  const cpCount = Number(data.contextUsage?.checkpointCount || 0);
  if (cpCount > 0 && data.taskTitle) {
    $('task-title').textContent = `${data.taskTitle}（已压缩 ${cpCount} 次）`;
  }

  if (data.settings) {
    state.showThoughts = data.settings.showThoughts !== false;
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
    const targetConvId = !state.autoFollow && state.selectedConvId
      ? state.selectedConvId
      : HOST_CONV_ID;
    const query = targetConvId ? `?conversationId=${encodeURIComponent(targetConvId)}` : '';
    const res = await apiFetch(`/api/status${query}`);
    if (!res.ok) return;
    const data = await res.json();
    renderAll(data);
    $('sync-note').textContent = '实时同步中';
  } catch {
    $('sync-note').textContent = '重连中…';
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
  $('conv-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === '__auto__' || !val) {
      state.autoFollow = true;
      state.selectedConvId = '';
    } else {
      state.autoFollow = false;
      state.selectedConvId = val;
    }
    state.lastStagesKey = '';
    state.lastFeedKey = '';
    pollStatus();
  });

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
    const targetConvId = state.latestData?.conversationId || state.selectedConvId || HOST_CONV_ID;
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
