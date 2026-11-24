/**
 * Sidecar HTTP server for Task Pulse v2.0.
 * Serves the Auxiliary Pane web UI and exposes local status/settings endpoints.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeConversation, getDefaultAppDataDir } from './analyzer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = getDefaultAppDataDir();
const SERVER_STARTED_AT = Date.now();

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const candidates = [
      join(APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      join(process.env.USERPROFILE || process.env.HOME || homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return import(pathToFileURL(candidate).href);
      }
    }
    throw new Error('Unable to locate sidecar_sdk runtime module');
  }
}

const { Response, SidecarApp } = await loadSidecarSdk();
const SETTINGS_PATH = join(APP_DATA_DIR, 'plugin_data', 'task-pulse', 'settings.json');

const DEFAULT_SETTINGS = {
  warnThresholdSec: 45,
  stuckThresholdSec: 120,
  showThoughts: true,
  enableNotifications: true,
  enableSound: true,
};

function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const current = readSettings();
  const warnThresholdSec = Number(patch.warnThresholdSec);
  const stuckThresholdSec = Number(patch.stuckThresholdSec);
  const next = {
    warnThresholdSec: Number.isFinite(warnThresholdSec) && warnThresholdSec >= 15 ? warnThresholdSec : current.warnThresholdSec,
    stuckThresholdSec: Number.isFinite(stuckThresholdSec) && stuckThresholdSec >= 30 ? stuckThresholdSec : current.stuckThresholdSec,
    showThoughts: typeof patch.showThoughts === 'boolean' ? patch.showThoughts : current.showThoughts,
    enableNotifications: typeof patch.enableNotifications === 'boolean' ? patch.enableNotifications : current.enableNotifications,
    enableSound: typeof patch.enableSound === 'boolean' ? patch.enableSound : current.enableSound,
  };
  if (next.warnThresholdSec >= next.stuckThresholdSec) {
    next.warnThresholdSec = Math.max(15, Math.floor(next.stuckThresholdSec * 0.4));
  }
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const notifiedEvents = new Set();

function notifyDesktop({ title, message, sound = true }) {
  const safeTitle = String(title || '任务脉搏').replace(/["`$\\]/g, ' ').slice(0, 60);
  const safeMsg = String(message || '').replace(/["`$\\]/g, ' ').slice(0, 140);
  try {
    if (process.platform === 'win32') {
      const soundCmd = sound ? '[System.Media.SystemSounds]::Asterisk.Play();' : '';
      const script = `
        ${soundCmd}
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.Visible = $true
        $n.ShowBalloonTip(3500, "${safeTitle}", "${safeMsg}", [System.Windows.Forms.ToolTipIcon]::Info)
        Start-Sleep -Seconds 4
        $n.Dispose()
      `;
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const soundPart = sound ? ' sound name "Glass"' : '';
      const child = spawn('osascript', ['-e', `display notification "${safeMsg}" with title "${safeTitle}"${soundPart}`], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch {
    // Fail-open on unsupported desktop environments.
  }
}

function maybeNotify(analysis, settings) {
  if (!settings.enableNotifications && !settings.enableSound) return;
  const convId = analysis.conversationId;
  const turnStart = analysis.timing?.turnStartMs || 0;
  if (!convId || !turnStart) return;
  // Never spam desktop notifications for historical turns from before sidecar startup.
  if (turnStart < SERVER_STARTED_AT - 15000 && !analysis.timing?.isRunning) return;

  if (analysis.health?.level === 'completed' && (analysis.timing?.turnElapsedMs || 0) >= 25000) {
    const key = `${convId}:${turnStart}:completed`;
    if (!notifiedEvents.has(key)) {
      notifiedEvents.add(key);
      notifyDesktop({
        title: '任务脉搏 · 任务已完成',
        message: `「${String(analysis.taskTitle || '当前任务').slice(0, 30)}」已执行完毕（耗时 ${Math.round(analysis.timing.turnElapsedMs / 1000)} 秒）。`,
        sound: settings.enableSound !== false,
      });
    }
  }

  if (analysis.health?.level === 'stuck' && analysis.timing?.isRunning) {
    const key = `${convId}:${turnStart}:stuck`;
    if (!notifiedEvents.has(key)) {
      notifiedEvents.add(key);
      notifyDesktop({
        title: '任务脉搏 · 疑似卡住',
        message: analysis.health.reason || '当前步骤已静默较长时间，请确认是否需要介入。',
        sound: settings.enableSound !== false,
      });
    }
  }
}

function readAsset(filename) {
  const filePath = join(HERE, filename);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

const app = new SidecarApp();

app.page('/', () => new Response(readAsset('index.html'), { contentType: 'text/html; charset=utf-8' }));
app.page('/app.js', () => new Response(readAsset('app.js'), { contentType: 'application/javascript; charset=utf-8' }));
app.api('/styles.css', () => new Response(readAsset('styles.css'), { contentType: 'text/css; charset=utf-8' }), 'GET');

app.api('/api/status', (query) => {
  const settings = readSettings();
  const convId = String(query?.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  const analysis = analyzeConversation({
    conversationId: convId || undefined,
    appDataDir: APP_DATA_DIR,
    warnThresholdSec: settings.warnThresholdSec,
    stuckThresholdSec: settings.stuckThresholdSec,
  });
  try {
    maybeNotify(analysis, settings);
  } catch {
    // Non-blocking notification
  }
  return new Response(JSON.stringify({ ...analysis, settings }), {
    contentType: 'application/json; charset=utf-8',
  });
}, 'GET');

app.api('/api/settings', (data) => {
  return new Response(JSON.stringify({ ok: true, settings: saveSettings(data || {}) }), {
    contentType: 'application/json; charset=utf-8',
  });
}, 'POST');

app.run();
