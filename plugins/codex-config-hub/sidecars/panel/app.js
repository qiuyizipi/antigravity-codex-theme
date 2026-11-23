const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  activeTab: 'overview',
  activeDoc: 'agents',
  docOriginals: { agents: '', memory: '' },
  skillQuery: '',
  pingResults: {},
};

function applyThemeClass() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  let isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (bg) {
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) {
      isDark = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) < 128;
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
  if (event.data?.type === 'theme-change') setTimeout(applyThemeClass, 15);
});

async function apiFetch(path, options = {}) {
  if (sidecar && typeof sidecar.fetch === 'function') {
    return sidecar.fetch(path, options);
  }
  return fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ms) {
  if (!ms) return '未创建';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

let toastTimer = null;
function showToast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('is-err', isErr);
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

async function openPath(targetPath) {
  try {
    const res = await apiFetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || '打开失败');
    showToast(`已打开：${json.opened}`);
  } catch (err) {
    showToast(err.message || '打开路径失败', true);
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.panel').forEach((el) => {
    el.classList.toggle('is-active', el.id === `panel-${tab}`);
  });
}

function mapPolicyLabel(val) {
  const map = {
    CASCADE_COMMANDS_AUTO_EXECUTION_EAGER: '自动执行 (Eager)',
    ARTIFACT_REVIEW_MODE_TURBO: '极速免审 (Turbo)',
    AGENT_SETTING_POLICY_ALLOW: '允许 (Allow)',
    THEME_MODE_LIGHT: '浅色 (Light)',
    THEME_MODE_DARK: '深色 (Dark)',
    THEME_MODE_SYSTEM: '跟随系统',
  };
  return map[val] || String(val || '默认');
}

function renderOverview(data) {
  $('last-scan').textContent = `最近扫描：${fmtTime(data.generatedAt)}`;
  $('tab-skills-count').textContent = String(data.skills.count);
  $('tab-mcp-count').textContent = String(data.mcp.length);
  $('tab-plugins-count').textContent = String(data.plugins.length);

  $('stat-agents').textContent = data.docs.agents.exists ? fmtBytes(data.docs.agents.size) : '未配置';
  $('stat-agents-sub').textContent = data.docs.agents.exists ? `${data.docs.agents.lines} 行 · AGENTS.md` : '点击去创建 AGENTS.md';
  $('stat-skills').textContent = String(data.skills.count);
  $('stat-skills-sub').textContent = data.skills.invalidCount > 0 ? `有 ${data.skills.invalidCount} 项异常` : '全部格式正常';
  $('stat-mcp').textContent = String(data.mcp.length);
  $('stat-mcp-sub').textContent = data.mcpParseError ? 'JSON 格式异常' : '点击检查连通状态';
  $('stat-plugins').textContent = String(data.plugins.length);

  const c = data.client || {};
  $('client-version').textContent = c.found ? `v${c.version || '?'}` : '未探测到';
  $('client-version').className = `pill ${c.found ? 'is-ok' : 'is-warn'}`;

  const clientRows = [
    ['中文汉化', c.hasCN ? '<span class="pill is-ok">已生效</span>' : '<span class="pill is-warn">未安装</span>'],
    ['底栏上下文监控', c.hasCtxMonitor ? '<span class="pill is-ok">已生效</span>' : '<span class="pill">未开启</span>'],
    ['Codex 实墨主题', c.hasCodexTheme ? `<span class="pill is-ok">${escapeHtml(c.codexThemeEdition || '已生效')}</span>` : '<span class="pill is-warn">未安装</span>'],
    ['IPC 样式热重载', c.hasHotCssIpc ? '<span class="pill is-ok">已启用</span>' : '<span class="pill">标准固化模式</span>'],
  ];
  $('client-kv').innerHTML = clientRows
    .map(([k, v]) => `<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val">${v}</span></div>`)
    .join('');

  const s = data.settings || {};
  const settingRows = [
    ['命令自动执行', escapeHtml(mapPolicyLabel(s.autoExecutionPolicy))],
    ['工件审阅模式', escapeHtml(mapPolicyLabel(s.artifactReviewMode))],
    ['跨目录读写权限', escapeHtml(mapPolicyLabel(s.nonWorkspaceFileAccessPolicy))],
    ['界面主题 / 字号', `${escapeHtml(mapPolicyLabel(s.themeMode))} / ${s.fontSize ?? '默认'}px`],
    ['全局权限白名单', `${s.allowRuleCount} 条规则`],
  ];
  $('settings-kv').innerHTML = settingRows
    .map(([k, v]) => `<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val">${v}</span></div>`)
    .join('');

  const quick = [
    ['配置根目录', data.configDir],
    ['Skills 目录', data.skillsDir],
    ['插件目录', data.pluginsDir],
    ['AGENTS.md', data.docs.agents.path],
    ['mcp_config.json', data.mcpPath],
  ];
  $('quick-actions').innerHTML = quick
    .map(([label, p]) => `<button class="btn" data-open="${escapeHtml(p)}">${escapeHtml(label)}</button>`)
    .join('');
}

function renderDoc(forceReset = false) {
  const data = state.data;
  if (!data) return;
  const doc = data.docs[state.activeDoc];
  const editor = $('doc-editor');
  const prevOriginal = state.docOriginals[state.activeDoc];
  if (forceReset || editor.value === prevOriginal || editor.dataset.docKey !== state.activeDoc) {
    editor.value = doc.content || '';
    editor.dataset.docKey = state.activeDoc;
  }
  state.docOriginals[state.activeDoc] = doc.content || '';
  $('doc-meta').textContent = doc.exists
    ? `${doc.path} · ${fmtBytes(doc.size)} · ${doc.lines} 行 · 更新于 ${fmtTime(doc.mtimeMs)}`
    : `${doc.path}（文件尚未创建，输入内容点保存即可创建）`;
  updateDirtyState();
}

function updateDirtyState() {
  const editor = $('doc-editor');
  const dirty = editor.value !== (state.docOriginals[state.activeDoc] || '');
  $('doc-dirty').textContent = dirty ? '有未保存更改' : '已与本地磁盘同步';
  $('btn-save-doc').disabled = !dirty;
  $('btn-revert-doc').disabled = !dirty;
}

function renderSkills() {
  const data = state.data;
  if (!data) return;
  const q = state.skillQuery.trim().toLowerCase();
  const list = data.skills.items.filter((item) => {
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.folder.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
  });
  $('skills-summary').textContent = q
    ? `匹配 ${list.length} / ${data.skills.count} 个 Skill`
    : `共检测到 ${data.skills.count} 个全局 Skill（正常 ${data.skills.count - data.skills.invalidCount}，异常 ${data.skills.invalidCount}）`;

  if (!list.length) {
    $('skills-list').innerHTML = '<div class="item-card"><div class="item-desc">没有找到匹配的 Skill。</div></div>';
    return;
  }
  $('skills-list').innerHTML = list.map((s) => `
    <div class="item-card">
      <div class="item-head">
        <span class="item-title">${escapeHtml(s.name)}</span>
        <div class="item-actions">
          <span class="pill ${s.valid ? 'is-ok' : 'is-warn'}">${s.valid ? '正常' : '异常'}</span>
          <button class="btn-link" data-open="${escapeHtml(s.mdPath)}">查看</button>
          <button class="btn-link" data-open="${escapeHtml(s.dirPath)}">目录</button>
        </div>
      </div>
      <div class="item-desc">${escapeHtml(s.description)}</div>
    </div>
  `).join('');
}

function renderMcp() {
  const data = state.data;
  if (!data) return;
  if (!data.mcp.length) {
    $('mcp-list').innerHTML = '<div class="item-card"><div class="item-desc">尚未配置任何 MCP 服务。</div></div>';
    return;
  }
  $('mcp-list').innerHTML = data.mcp.map((m) => {
    const ping = state.pingResults[m.name];
    let statusBadge = '';
    if (m.disabled) {
      statusBadge = '<span class="pill is-warn">已禁用</span>';
    } else if (m.transport === 'http') {
      if (ping) {
        statusBadge = ping.ok
          ? `<span class="pill is-ok">在线 (${ping.status} · ${ping.latencyMs}ms)</span>`
          : `<span class="pill is-err">离线 (${escapeHtml(ping.error)})</span>`;
      } else {
        statusBadge = '<span class="pill">HTTP 端点</span>';
      }
    } else if (m.localTargetExists === false) {
      statusBadge = '<span class="pill is-err">脚本路径不存在</span>';
    } else {
      statusBadge = '<span class="pill is-ok">Stdio 已就绪</span>';
    }

    const keysInfo = [
      ...m.envKeys.map((k) => `env:${k}`),
      ...m.headerKeys.map((k) => `header:${k}`),
    ];

    return `
      <div class="item-card">
        <div class="item-head">
          <span class="item-title">${escapeHtml(m.name)}</span>
          <div class="item-actions">
            ${statusBadge}
            ${m.transport === 'http' && m.url ? `<button class="btn-link" data-ping-name="${escapeHtml(m.name)}" data-ping-url="${escapeHtml(m.url)}">测连通</button>` : ''}
            <button class="btn-link" data-open="${escapeHtml(m.sourcePath)}">打开配置</button>
          </div>
        </div>
        <div class="item-desc mono">${escapeHtml(m.transport === 'http' ? m.url : m.command)}</div>
        <div class="item-meta">
          <span class="pill">${m.source === 'global' ? '全局 MCP' : escapeHtml(m.source)}</span>
          ${keysInfo.map((k) => `<span class="pill">${escapeHtml(k)} (已脱敏)</span>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderPlugins() {
  const data = state.data;
  if (!data) return;
  if (!data.plugins.length) {
    $('plugins-list').innerHTML = '<div class="item-card"><div class="item-desc">尚未安装任何原生插件。</div></div>';
    return;
  }
  $('plugins-list').innerHTML = data.plugins.map((p) => {
    const caps = [];
    if (p.capabilities.sidecar) caps.push('侧栏 UI');
    if (p.capabilities.mcp) caps.push('MCP');
    if (p.capabilities.rules) caps.push('规则');
    if (p.capabilities.hooks) caps.push('Hooks');
    if (p.capabilities.skills) caps.push('Skills');
    return `
      <div class="item-card">
        <div class="item-head">
          <span class="item-title">${escapeHtml(p.displayName)}</span>
          <div class="item-actions">
            <span class="pill is-ok">v${escapeHtml(p.version)}</span>
            <button class="btn-link" data-open="${escapeHtml(p.dirPath)}">目录</button>
          </div>
        </div>
        <div class="item-desc">${escapeHtml(p.description || p.id)}</div>
        <div class="item-meta">
          <span class="pill">${p.origin === 'marketplace' ? '官方商店' : '本地插件'}</span>
          ${caps.map((c) => `<span class="pill">${c}</span>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

async function refreshAll(silent = false) {
  try {
    const res = await apiFetch('/api/overview');
    const data = await res.json();
    state.data = data;
    renderOverview(data);
    renderDoc(false);
    renderSkills();
    renderMcp();
    renderPlugins();
    if (!silent) showToast('已重新扫描全部配置，状态为最新');
  } catch (err) {
    showToast(`扫描失败：${err.message}`, true);
  }
}

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tab);
    return;
  }
  const jumpBtn = e.target.closest('[data-jump]');
  if (jumpBtn) {
    switchTab(jumpBtn.dataset.jump);
    return;
  }
  const segBtn = e.target.closest('.seg');
  if (segBtn) {
    state.activeDoc = segBtn.dataset.doc;
    document.querySelectorAll('.seg').forEach((s) => s.classList.toggle('is-active', s === segBtn));
    renderDoc(true);
    return;
  }
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) {
    await openPath(openBtn.dataset.open);
    return;
  }
  const pingBtn = e.target.closest('[data-ping-url]');
  if (pingBtn) {
    const name = pingBtn.dataset.pingName;
    const url = pingBtn.dataset.pingUrl;
    pingBtn.textContent = '检测中…';
    try {
      const res = await apiFetch('/api/ping-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      state.pingResults[name] = await res.json();
      renderMcp();
    } catch (err) {
      state.pingResults[name] = { ok: false, error: err.message };
      renderMcp();
    }
    return;
  }
});

$('btn-refresh').addEventListener('click', () => refreshAll(false));
$('btn-open-config-json').addEventListener('click', () => state.data && openPath(state.data.configPath));
$('btn-open-doc-file').addEventListener('click', () => state.data && openPath(state.data.docs[state.activeDoc].path));
$('btn-open-skills-dir').addEventListener('click', () => state.data && openPath(state.data.skillsDir));
$('btn-open-mcp-json').addEventListener('click', () => state.data && openPath(state.data.mcpPath));
$('btn-open-plugins-dir').addEventListener('click', () => state.data && openPath(state.data.pluginsDir));

$('skills-search').addEventListener('input', (e) => {
  state.skillQuery = e.target.value;
  renderSkills();
});

$('doc-editor').addEventListener('input', updateDirtyState);

$('btn-revert-doc').addEventListener('click', () => {
  renderDoc(true);
  showToast('已撤销未保存修改');
});

$('btn-save-doc').addEventListener('click', async () => {
  const editor = $('doc-editor');
  try {
    const res = await apiFetch('/api/save-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docKey: state.activeDoc, content: editor.value }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || '保存失败');
    const sign = json.deltaBytes >= 0 ? `+${json.deltaBytes}` : `${json.deltaBytes}`;
    showToast(`已保存到磁盘（${sign} B，共 ${fmtBytes(json.nextBytes)}），新会话或下一轮生效`);
    await refreshAll(true);
    renderDoc(true);
  } catch (err) {
    showToast(`保存失败：${err.message}`, true);
  }
});

applyThemeClass();
refreshAll(true);
