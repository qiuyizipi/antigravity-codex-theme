import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

export function getGeminiConfigDir() {
  return path.join(getHomeDir(), '.gemini', 'config');
}

export function getAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) return process.env.ANTIGRAVITY_APP_DATA_DIR;
  return path.join(getHomeDir(), '.gemini', 'antigravity');
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, exists: false, data: null, error: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, exists: true, data: JSON.parse(raw), error: null, size: Buffer.byteLength(raw, 'utf8'), mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch (err) {
    return { ok: false, exists: true, data: null, error: err.message };
  }
}

function detectAppAsarPath() {
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(getHomeDir(), 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      path.join(progFiles, 'Antigravity', 'resources', 'app.asar'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(getHomeDir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
    );
  } else {
    candidates.push(
      '/usr/share/antigravity/resources/app.asar',
      '/opt/Antigravity/resources/app.asar',
      path.join(getHomeDir(), '.local', 'share', 'antigravity', 'resources', 'app.asar'),
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readAsarEntry(asarPath, relPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerDataSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    let cur = header.files;
    for (const part of relPath.split('/')) {
      if (!cur || !cur[part]) return null;
      cur = cur[part].files || cur[part];
    }
    if (cur.unpacked || cur.offset === undefined) return null;
    const out = Buffer.alloc(cur.size);
    fs.readSync(fd, out, 0, cur.size, 8 + headerDataSize + parseInt(cur.offset, 10));
    return out.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectClientAsar() {
  const asarPath = detectAppAsarPath();
  if (!asarPath) return { found: false };
  try {
    const pkgStr = readAsarEntry(asarPath, 'package.json');
    const preloadStr = readAsarEntry(asarPath, 'dist/preload.js') || '';
    const mainStr = readAsarEntry(asarPath, 'dist/main.js') || '';
    const version = pkgStr ? JSON.parse(pkgStr).version : 'unknown';
    const themeVerMatch = preloadStr.match(/Antigravity 1:1 Codex Mirror Aesthetic Theme \(([^)]+)\)/);
    return {
      found: true,
      asarPath,
      resourcesDir: path.dirname(asarPath),
      version,
      hasCN: preloadStr.includes('__ANTIGRAVITY_CHINESE_LOCALIZATION_START__'),
      hasCtxMonitor: mainStr.includes('__AG_CTX_MONITOR_START__') || preloadStr.includes('__AG_CTX_BRIDGE_START__'),
      hasCodexTheme: preloadStr.includes('__ANTIGRAVITY_CODEX_THEME_START__'),
      codexThemeEdition: themeVerMatch ? themeVerMatch[1] : null,
      hasHotCssIpc: mainStr.includes('__ANTIGRAVITY_CODEX_HOT_CSS_START__'),
    };
  } catch (err) {
    return { found: true, asarPath, error: err.message };
  }
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { valid: false, name: '', description: '' };
  const body = m[1];
  const nameM = body.match(/^\s*name:\s*["']?(.+?)["']?\s*$/m);
  let desc = '';
  const descM = body.match(/^\s*description:\s*(.+)$/m);
  if (descM) {
    const raw = descM[1].trim();
    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const idx = body.indexOf(descM[0]) + descM[0].length;
      const lines = body.slice(idx).split(/\r?\n/);
      const collected = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        if (/^\s+/.test(l)) collected.push(l.trim());
        else break;
      }
      desc = collected.join(' ');
    } else {
      desc = raw.replace(/^["']|["']$/g, '');
    }
  }
  return {
    valid: Boolean(nameM && nameM[1]),
    name: nameM ? nameM[1].trim() : '',
    description: desc.slice(0, 240),
  };
}

function scanSkills(configDir) {
  const dir = path.join(configDir, 'skills');
  if (!fs.existsSync(dir)) return { dir, count: 0, invalidCount: 0, items: [] };
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const items = [];
  for (const e of entries) {
    const skillDir = path.join(dir, e.name);
    const mdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(mdPath)) {
      items.push({ folder: e.name, name: e.name, description: '缺少 SKILL.md', valid: false, dirPath: skillDir, mdPath });
      continue;
    }
    try {
      const content = fs.readFileSync(mdPath, 'utf8');
      const fm = parseFrontmatter(content);
      const stat = fs.statSync(mdPath);
      items.push({
        folder: e.name,
        name: fm.name || e.name,
        description: fm.description || '（未填写描述）',
        valid: fm.valid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dirPath: skillDir,
        mdPath,
      });
    } catch (err) {
      items.push({ folder: e.name, name: e.name, description: `读取失败: ${err.message}`, valid: false, dirPath: skillDir, mdPath });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return {
    dir,
    count: items.length,
    invalidCount: items.filter((x) => !x.valid).length,
    items,
  };
}

function sanitizeMcpEntry(name, def, source, sourcePath) {
  const isHttp = Boolean(def.url || def.serverUrl);
  const url = def.url || def.serverUrl || null;
  const command = def.command || null;
  const args = Array.isArray(def.args) ? def.args : [];
  const envKeys = def.env && typeof def.env === 'object' ? Object.keys(def.env) : [];
  const headerKeys = def.headers && typeof def.headers === 'object' ? Object.keys(def.headers) : [];
  let localTargetExists = null;
  if (!isHttp && args.length > 0) {
    const scriptArg = args.find((a) => /\.(m?js|cjs|py|exe)$/i.test(String(a)));
    if (scriptArg && path.isAbsolute(scriptArg)) {
      localTargetExists = fs.existsSync(scriptArg);
    }
  }
  return {
    name,
    source,
    sourcePath,
    transport: isHttp ? 'http' : 'stdio',
    url,
    command: command ? [command, ...args].join(' ').slice(0, 140) : null,
    envKeys,
    headerKeys,
    disabled: Boolean(def.disabled),
    localTargetExists,
  };
}

function scanPluginsAndMcp(configDir, configJson) {
  const pluginsDir = path.join(configDir, 'plugins');
  const mcpPath = path.join(configDir, 'mcp_config.json');
  const mcpRes = readJsonSafe(mcpPath);
  const mcpItems = [];
  if (mcpRes.ok && mcpRes.data && mcpRes.data.mcpServers) {
    for (const [name, def] of Object.entries(mcpRes.data.mcpServers)) {
      mcpItems.push(sanitizeMcpEntry(name, def || {}, 'global', mcpPath));
    }
  }

  const plugins = [];
  if (fs.existsSync(pluginsDir)) {
    const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    for (const d of dirs) {
      const pDir = path.join(pluginsDir, d.name);
      const manifestPath = path.join(pDir, 'plugin.json');
      const manifest = readJsonSafe(manifestPath);
      const mData = manifest.ok ? manifest.data : {};
      const hasRules = fs.existsSync(path.join(pDir, 'rules'));
      const hasHooks = fs.existsSync(path.join(pDir, 'hooks.json'));
      const hasSidecar = fs.existsSync(path.join(pDir, 'sidecars')) || fs.existsSync(path.join(pDir, 'sidecars.json'));
      const hasSkills = fs.existsSync(path.join(pDir, 'skills'));
      const pluginMcpPath = path.join(pDir, 'mcp_config.json');
      const pluginMcp = readJsonSafe(pluginMcpPath);
      const hasMcp = Boolean(pluginMcp.ok && pluginMcp.data && pluginMcp.data.mcpServers && Object.keys(pluginMcp.data.mcpServers).length > 0);
      if (hasMcp) {
        for (const [mName, mDef] of Object.entries(pluginMcp.data.mcpServers)) {
          mcpItems.push(sanitizeMcpEntry(`${d.name}/${mName}`, mDef || {}, `plugin:${d.name}`, pluginMcpPath));
        }
      }
      const cfgEntry = configJson?.plugins?.[d.name];
      plugins.push({
        id: d.name,
        displayName: mData.displayName || mData.name || d.name,
        version: mData.version || cfgEntry?.installedFrom?.version || 'local',
        description: mData.description || '',
        origin: cfgEntry?.installedFrom?.marketplace ? 'marketplace' : 'local',
        dirPath: pDir,
        capabilities: {
          sidecar: hasSidecar,
          mcp: hasMcp,
          rules: hasRules,
          hooks: hasHooks,
          skills: hasSkills,
        },
      });
    }
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return {
    pluginsDir,
    plugins,
    mcpPath,
    mcpParseError: mcpRes.error,
    mcpItems,
  };
}

function readDocMeta(filePath, title) {
  if (!fs.existsSync(filePath)) {
    return { title, path: filePath, exists: false, size: 0, lines: 0, mtimeMs: 0, content: '' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  return {
    title,
    path: filePath,
    exists: true,
    size: stat.size,
    lines: content.split(/\r?\n/).length,
    mtimeMs: stat.mtimeMs,
    content,
  };
}

export function collectConfigOverview() {
  const configDir = getGeminiConfigDir();
  const configPath = path.join(configDir, 'config.json');
  const cfgRes = readJsonSafe(configPath);
  const userSettings = cfgRes.ok && cfgRes.data?.userSettings ? cfgRes.data.userSettings : {};
  const docs = {
    agents: readDocMeta(path.join(configDir, 'AGENTS.md'), '全局规则 (AGENTS.md)'),
    memory: readDocMeta(path.join(configDir, 'MEMORY.md'), '长期记忆 (MEMORY.md)'),
  };
  const skills = scanSkills(configDir);
  const { pluginsDir, plugins, mcpPath, mcpParseError, mcpItems } = scanPluginsAndMcp(configDir, cfgRes.data);
  const client = inspectClientAsar();

  const summarySettings = {
    themeMode: userSettings.themeMode || 'default',
    fontSize: userSettings.fontSize ?? null,
    autoExecutionPolicy: userSettings.autoExecutionPolicy || 'default',
    artifactReviewMode: userSettings.artifactReviewMode || 'default',
    nonWorkspaceFileAccessPolicy: userSettings.nonWorkspaceFileAccessPolicy || 'default',
    enableTerminalSandbox: userSettings.enableTerminalSandbox ?? null,
    allowRuleCount: Array.isArray(userSettings.globalPermissionGrants?.allow)
      ? userSettings.globalPermissionGrants.allow.length
      : 0,
  };

  return {
    generatedAt: Date.now(),
    platform: process.platform,
    configDir,
    configPath,
    configParseError: cfgRes.error,
    mcpPath,
    mcpParseError,
    pluginsDir,
    skillsDir: skills.dir,
    client,
    settings: summarySettings,
    docs,
    skills,
    mcp: mcpItems,
    plugins,
  };
}

export function pingHttpEndpoint(targetUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        resolve({ ok: false, error: '仅支持 http/https 检测' });
        return;
      }
    } catch {
      resolve({ ok: false, error: 'URL 格式无效' });
      return;
    }
    const start = Date.now();
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      { method: 'HEAD', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode, latencyMs: Date.now() - start });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '连接超时', latencyMs: Date.now() - start });
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: err.code || err.message, latencyMs: Date.now() - start });
    });
    req.end();
  });
}
