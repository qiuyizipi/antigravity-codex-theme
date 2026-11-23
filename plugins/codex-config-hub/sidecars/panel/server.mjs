import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectConfigOverview,
  getAppDataDir,
  getGeminiConfigDir,
  getHomeDir,
  inspectClientAsar,
  pingHttpEndpoint,
} from './collector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = getAppDataDir();
const CONFIG_DIR = getGeminiConfigDir();

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const candidates = [
      path.join(APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      path.join(getHomeDir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return import(pathToFileURL(candidate).href);
      }
    }
    throw new Error('Unable to locate sidecar_sdk runtime module');
  }
}

const { Response, SidecarApp } = await loadSidecarSdk();

function readAsset(filename) {
  const filePath = path.join(HERE, filename);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function isPathInside(targetPath, allowedRoot) {
  if (!targetPath || !allowedRoot) return false;
  const rel = path.relative(path.resolve(allowedRoot), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isAllowedToOpen(targetPath) {
  const roots = [CONFIG_DIR];
  const client = inspectClientAsar();
  if (client.resourcesDir) roots.push(client.resourcesDir);
  return roots.some((r) => isPathInside(targetPath, r));
}

function openLocalPath(targetPath) {
  if (!targetPath || !isAllowedToOpen(targetPath)) {
    throw new Error('仅允许打开 Antigravity 配置目录或资源目录内的路径');
  }
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`路径不存在: ${resolved}`);
  }
  if (process.platform === 'win32') {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const child = spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } else {
      const child = spawn('cmd.exe', ['/c', 'start', '', resolved], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [resolved], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  return resolved;
}

const EDITABLE_DOCS = {
  agents: path.join(CONFIG_DIR, 'AGENTS.md'),
  memory: path.join(CONFIG_DIR, 'MEMORY.md'),
};

const app = new SidecarApp();

app.page('/', () => new Response(readAsset('index.html'), { contentType: 'text/html; charset=utf-8' }));
app.page('/app.js', () => new Response(readAsset('app.js'), { contentType: 'application/javascript; charset=utf-8' }));
app.api('/styles.css', () => new Response(readAsset('styles.css'), { contentType: 'text/css; charset=utf-8' }), 'GET');

app.api('/api/overview', () => {
  return new Response(JSON.stringify(collectConfigOverview()), {
    contentType: 'application/json; charset=utf-8',
  });
}, 'GET');

app.api('/api/save-doc', (data) => {
  const key = String(data?.docKey || '');
  const target = EDITABLE_DOCS[key];
  if (!target) {
    return new Response(JSON.stringify({ ok: false, error: '不支持编辑该文档' }), {
      status: 400,
      contentType: 'application/json; charset=utf-8',
    });
  }
  const content = typeof data?.content === 'string' ? data.content : '';
  const prevBytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  const nextStat = fs.statSync(target);
  return new Response(
    JSON.stringify({
      ok: true,
      path: target,
      prevBytes,
      nextBytes: nextStat.size,
      deltaBytes: nextStat.size - prevBytes,
      mtimeMs: nextStat.mtimeMs,
    }),
    { contentType: 'application/json; charset=utf-8' }
  );
}, 'POST');

app.api('/api/open', (data) => {
  const opened = openLocalPath(String(data?.path || ''));
  return new Response(JSON.stringify({ ok: true, opened }), {
    contentType: 'application/json; charset=utf-8',
  });
}, 'POST');

app.api('/api/ping-mcp', async (data) => {
  const url = String(data?.url || '');
  const res = await pingHttpEndpoint(url);
  return new Response(JSON.stringify(res), {
    contentType: 'application/json; charset=utf-8',
  });
}, 'POST');

app.run();
