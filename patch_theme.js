#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const CSS_PATH = path.join(SCRIPT_DIR, 'codex_theme.css');
const CN_REPO_URL = 'https://github.com/Silas-02/antigravity-desktop-cn.git';
const CN_ZIP_URL = 'https://github.com/Silas-02/antigravity-desktop-cn/archive/refs/heads/main.zip';
const CN_CACHE_DIR = path.join(SCRIPT_DIR, '.cache', 'antigravity-desktop-cn');
const CN_SIBLING_DIRS = [
    path.join(SCRIPT_DIR, '..', 'antigravity-desktop-cn-main'),
    path.join(SCRIPT_DIR, '..', 'antigravity-desktop-cn'),
];

const SIG_START = '/* __ANTIGRAVITY_CODEX_THEME_START__ */';
const SIG_END = '/* __ANTIGRAVITY_CODEX_THEME_END__ */';

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // lightweight synchronous wait for Windows file lock release
    }
}

function parseArgs(argv) {
    const opts = {
        mode: 'install', // install | uninstall | check
        withCn: false,
        noKill: false,
        brandTitle: 'english',
        manualPath: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--uninstall' || a === '--restore') opts.mode = 'uninstall';
        else if (a === '--check' || a === '--status') opts.mode = 'check';
        else if (a === '--with-cn') opts.withCn = true;
        else if (a === '--no-kill') opts.noKill = true;
        else if (a === '--brand-title' && argv[i + 1]) opts.brandTitle = argv[++i];
        else if ((a === '--asar' || a === '--install-dir') && argv[i + 1]) opts.manualPath = argv[++i];
        else if (!a.startsWith('-') && !opts.manualPath) opts.manualPath = a; // support drag-and-drop onto .bat
    }
    return opts;
}

// ============================================================================
// Smart Cross-Platform Antigravity Path Detection
// ============================================================================
function resolveAsarFromDirOrFile(candidate) {
    if (!candidate) return null;
    const cleaned = String(candidate).trim().replace(/^"|"$/g, '');
    if (!cleaned || !fs.existsSync(cleaned)) return null;

    const resolved = path.resolve(cleaned);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch {
        return null;
    }

    if (stat.isFile()) {
        if (path.basename(resolved).toLowerCase() === 'app.asar') return resolved;
        const parent = path.dirname(resolved);
        const tryFromExe = [
            path.join(parent, 'resources', 'app.asar'),
            path.join(parent, 'app.asar'),
        ];
        for (const p of tryFromExe) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    const candidates = [
        path.join(resolved, 'resources', 'app.asar'),
        path.join(resolved, 'Contents', 'Resources', 'app.asar'),
        path.join(resolved, 'app.asar'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function detectAntigravityPaths(manualPath) {
    if (manualPath) {
        const asar = resolveAsarFromDirOrFile(manualPath);
        if (!asar) {
            throw new Error(`手动指定的路径下未找到 app.asar: ${manualPath}`);
        }
        return {
            asarPath: asar,
            resourcesDir: path.dirname(asar),
            installDir: path.basename(path.dirname(asar)).toLowerCase() === 'resources'
                ? path.dirname(path.dirname(asar))
                : path.dirname(asar),
        };
    }

    const candidates = [];
    const seen = new Set();
    const add = (p) => {
        if (!p) return;
        const norm = path.resolve(p);
        const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(norm);
        }
    };

    add(process.env.ANTIGRAVITY_INSTALL_DIR);
    add(process.env.ANTIGRAVITY_HOME);

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        add(path.join(localAppData, 'Programs', 'antigravity'));
        add(path.join(localAppData, 'antigravity'));

        // Query Windows Uninstall Registry for custom install locations
        const regRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        ];
        for (const root of regRoots) {
            try {
                const out = execSync(`reg query "${root}" /s /f Antigravity /d`, {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 5000,
                });
                for (const line of out.split(/\r?\n/)) {
                    const m = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!m) continue;
                    let val = m[2].trim().replace(/^"|"$/g, '').replace(/,\d+$/, '');
                    if (/Antigravity\.exe$/i.test(val)) val = path.dirname(val);
                    add(val);
                }
            } catch {
                // ignore missing registry entries
            }
        }

        add('C:\\Program Files\\Antigravity');
        add('C:\\Program Files (x86)\\Antigravity');
        for (const drive of ['C', 'D', 'E', 'F']) {
            add(`${drive}:\\Programs\\Antigravity`);
            add(`${drive}:\\Antigravity`);
        }
    } else if (process.platform === 'darwin') {
        add('/Applications/Antigravity.app');
        add(path.join(os.homedir(), 'Applications', 'Antigravity.app'));
    } else {
        add('/opt/Antigravity');
        add(path.join(os.homedir(), '.local', 'share', 'antigravity'));
        add('/usr/lib/antigravity');
    }

    for (const c of candidates) {
        const asar = resolveAsarFromDirOrFile(c);
        if (asar) {
            const resourcesDir = path.dirname(asar);
            const installDir = path.basename(resourcesDir).toLowerCase() === 'resources'
                ? path.dirname(resourcesDir)
                : resourcesDir;
            return { asarPath: asar, resourcesDir, installDir };
        }
    }

    throw new Error(
        '未自动探测到 Antigravity 安装目录。\n' +
        '解决办法：将 Antigravity 安装文件夹（或 Antigravity.exe）直接拖拽到本 .bat 脚本图标上运行，\n' +
        '或在命令行传入路径：node patch_theme.js --install-dir "你的Antigravity安装目录"'
    );
}

// ============================================================================
// Process Closing & Write Permission Check
// ============================================================================
function isWindowsAntigravityRunning() {
    if (process.platform !== 'win32') return false;
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        });
        return /Antigravity\.exe/i.test(out);
    } catch {
        return false;
    }
}

function ensureAntigravityClosed(noKill) {
    if (noKill) return;
    if (process.platform === 'win32') {
        if (!isWindowsAntigravityRunning()) return;
        console.log('[进程] 检测到 Antigravity 正在运行，正在关闭进程以释放 app.asar 文件锁...');
        try {
            execSync('taskkill /F /IM Antigravity.exe /T >nul 2>nul', { stdio: 'ignore', timeout: 8000 });
        } catch {
            // ignore if already closed
        }
        for (let i = 0; i < 8; i++) {
            sleepSync(500);
            if (!isWindowsAntigravityRunning()) {
                console.log('[进程] Antigravity 已关闭。');
                return;
            }
        }
        console.warn('[警告] Antigravity 可能仍有残留进程，若后续写入报占用，请右键系统托盘彻底退出后重试。');
    }
}

function ensureWritable(asarPath) {
    const dir = path.dirname(asarPath);
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        throw new Error(
            `没有权限写入 ${asarPath}。\n` +
            '如果 Antigravity 安装在 C:\\Program Files 等系统目录，请右键 .bat 脚本选择「以管理员身份运行」。'
        );
    }
}

// ============================================================================
// Pure Node.js In-Place Chromium Pickle ASAR Reader & Patcher
// Preserves ALL `unpacked: true` native binary flags (safe for v2.34.0+)
// ============================================================================
function readAsarHeader(asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const sizeBuf = Buffer.alloc(16);
        fs.readSync(fd, sizeBuf, 0, 16, 0);
        const headerDataSize = sizeBuf.readUInt32LE(4);
        const jsonStrLen = sizeBuf.readUInt32LE(12);
        const jsonBuf = Buffer.alloc(jsonStrLen);
        fs.readSync(fd, jsonBuf, 0, jsonStrLen, 16);
        const header = JSON.parse(jsonBuf.toString('utf8'));
        return { header, baseOffset: 8 + headerDataSize };
    } finally {
        fs.closeSync(fd);
    }
}

function readAsarFile(asarPath, relPath) {
    const { header, baseOffset } = readAsarHeader(asarPath);
    let cur = header.files;
    for (const part of relPath.split('/')) {
        if (!cur || !cur[part]) return null;
        cur = cur[part].files || cur[part];
    }
    if (cur.unpacked || cur.offset === undefined) return null;
    const fd = fs.openSync(asarPath, 'r');
    try {
        const buf = Buffer.alloc(cur.size);
        fs.readSync(fd, buf, 0, cur.size, baseOffset + parseInt(cur.offset, 10));
        return buf;
    } finally {
        fs.closeSync(fd);
    }
}

function copyWithRetry(src, dst, retries = 5) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            fs.copyFileSync(src, dst);
            return;
        } catch (err) {
            lastErr = err;
            if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
                sleepSync(600);
                continue;
            }
            throw err;
        }
    }
    if (lastErr && lastErr.code === 'EBUSY') {
        throw new Error(
            `写入失败（文件被占用 EBUSY）：${dst}\n` +
            '请确认已完全退出 Antigravity（包括右下角任务栏托盘图标），然后重新运行脚本。'
        );
    }
    throw lastErr;
}

function patchAsarInPlace(sourceAsar, targetAsar, filePatches) {
    const { header, baseOffset } = readAsarHeader(sourceAsar);
    const fileEntries = [];
    function walk(dir, prefix) {
        for (const [name, entry] of Object.entries(dir)) {
            const fullPath = prefix ? `${prefix}/${name}` : name;
            if (entry.files) walk(entry.files, fullPath);
            else fileEntries.push({ path: fullPath, entry });
        }
    }
    walk(header.files, '');

    const packedFiles = fileEntries.filter(f => !f.entry.unpacked && f.entry.offset !== undefined);
    const unpackedCount = fileEntries.filter(f => f.entry.unpacked).length;
    packedFiles.sort((a, b) => parseInt(a.entry.offset, 10) - parseInt(b.entry.offset, 10));

    let curOffset = 0;
    for (const item of packedFiles) {
        item.oldOffset = parseInt(item.entry.offset, 10);
        item.oldSize = item.entry.size;
        if (filePatches[item.path] !== undefined) {
            const patchBuf = Buffer.isBuffer(filePatches[item.path])
                ? filePatches[item.path]
                : Buffer.from(filePatches[item.path], 'utf8');
            item.patchBuffer = patchBuf;
            item.entry.size = patchBuf.length;
            delete item.entry.integrity;
        }
        item.entry.offset = String(curOffset);
        curOffset += item.entry.size;
    }

    const newJsonStr = JSON.stringify(header);
    const newJsonBuf = Buffer.from(newJsonStr, 'utf8');
    const padLen = (4 - (newJsonBuf.length % 4)) % 4;
    const paddedJsonLen = newJsonBuf.length + padLen;
    const headerBuf = Buffer.alloc(16 + paddedJsonLen);
    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(paddedJsonLen + 8, 4);
    headerBuf.writeUInt32LE(paddedJsonLen + 4, 8);
    headerBuf.writeUInt32LE(newJsonBuf.length, 12);
    newJsonBuf.copy(headerBuf, 16);

    const tmpOut = `${targetAsar}.tmp_codex_${process.pid}`;
    try {
        const srcFd = fs.openSync(sourceAsar, 'r');
        const destFd = fs.openSync(tmpOut, 'w');
        try {
            fs.writeSync(destFd, headerBuf, 0, headerBuf.length, 0);
            let writePos = headerBuf.length;
            const copyBuf = Buffer.alloc(256 * 1024);
            for (const item of packedFiles) {
                if (item.patchBuffer) {
                    fs.writeSync(destFd, item.patchBuffer, 0, item.patchBuffer.length, writePos);
                    writePos += item.patchBuffer.length;
                } else {
                    let remaining = item.oldSize;
                    let readPos = baseOffset + item.oldOffset;
                    while (remaining > 0) {
                        const n = Math.min(remaining, copyBuf.length);
                        fs.readSync(srcFd, copyBuf, 0, n, readPos);
                        fs.writeSync(destFd, copyBuf, 0, n, writePos);
                        readPos += n;
                        writePos += n;
                        remaining -= n;
                    }
                }
            }
        } finally {
            fs.closeSync(srcFd);
            fs.closeSync(destFd);
        }

        const testPreload = readAsarFile(tmpOut, 'dist/preload.js');
        if (!testPreload) {
            throw new Error('校验失败：生成的临时 ASAR 缺少 dist/preload.js');
        }
        new vm.Script(testPreload.toString('utf8'));

        copyWithRetry(tmpOut, targetAsar);
        return {
            unpackedCount,
            packedCount: packedFiles.length,
            finalSize: fs.statSync(targetAsar).size,
        };
    } finally {
        if (fs.existsSync(tmpOut)) {
            try { fs.unlinkSync(tmpOut); } catch {}
        }
    }
}

function stripCodexTheme(preloadCode) {
    if (!preloadCode.includes(SIG_START)) return preloadCode;
    const s = preloadCode.indexOf(SIG_START);
    const eIdx = preloadCode.indexOf(SIG_END);
    if (eIdx === -1) return preloadCode;
    return preloadCode.slice(0, s) + preloadCode.slice(eIdx + SIG_END.length);
}

function buildInjection(css) {
    const escapedCss = css
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
    return `\n${SIG_START}\n(() => {\n    const themeCss = \`${escapedCss}\`;\n    function detectCodexMode() {\n        const h = document.documentElement;\n        const b = document.body;\n        const hc = h && h.classList;\n        const bc = b && b.classList;\n        const dt = (h && (h.getAttribute('data-theme') || h.getAttribute('data-color-scheme'))) ||\n            (b && (b.getAttribute('data-theme') || b.getAttribute('data-color-scheme'))) || '';\n        if ((hc && (hc.contains('dark') || hc.contains('theme-dark') || hc.contains('vscode-dark'))) ||\n            (bc && (bc.contains('dark') || bc.contains('theme-dark') || bc.contains('vscode-dark'))) ||\n            /dark/i.test(dt)) return 'dark';\n        if ((hc && (hc.contains('light') || hc.contains('theme-light') || hc.contains('vscode-light'))) ||\n            (bc && (bc.contains('light') || bc.contains('theme-light') || bc.contains('vscode-light'))) ||\n            /light/i.test(dt)) return 'light';\n        try {\n            const cs = h ? getComputedStyle(h).colorScheme : '';\n            if (cs && cs.includes('dark') && !cs.includes('light')) return 'dark';\n            if (cs && cs.includes('light') && !cs.includes('dark')) return 'light';\n        } catch {}\n        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';\n    }\n    function syncCodexMode() {\n        const h = document.documentElement;\n        if (!h) return;\n        const mode = detectCodexMode();\n        if (h.getAttribute('data-codex-mode') !== mode) {\n            h.setAttribute('data-codex-mode', mode);\n        }\n    }\n    let observerStarted = false;\n    function startThemeObserver() {\n        if (observerStarted || typeof MutationObserver === 'undefined') return;\n        const h = document.documentElement;\n        if (!h) return;\n        observerStarted = true;\n        const obs = new MutationObserver(syncCodexMode);\n        obs.observe(h, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'] });\n        if (document.body) {\n            obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme'] });\n        }\n        try {\n            const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');\n            if (mq && mq.addEventListener) mq.addEventListener('change', syncCodexMode);\n        } catch {}\n    }\n    function injectCodexTheme() {\n        syncCodexMode();\n        startThemeObserver();\n        let style = document.getElementById('antigravity-codex-theme-patch');\n        if (!style) {\n            style = document.createElement('style');\n            style.id = 'antigravity-codex-theme-patch';\n            style.textContent = themeCss;\n            (document.head || document.documentElement).appendChild(style);\n        }\n    }\n    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', injectCodexTheme);\n    } else {\n        injectCodexTheme();\n    }\n    window.addEventListener('load', injectCodexTheme);\n})();\n${SIG_END}\n`;
}

function inspectAsar(asarPath) {
    if (!fs.existsSync(asarPath)) {
        throw new Error(`未找到 Antigravity 核心文件: ${asarPath}`);
    }
    const { header } = readAsarHeader(asarPath);
    let unpackedCount = 0;
    let packedCount = 0;
    function walk(dir) {
        for (const entry of Object.values(dir)) {
            if (entry.files) walk(entry.files);
            else if (entry.unpacked) unpackedCount++;
            else packedCount++;
        }
    }
    walk(header.files);

    const pkgBuf = readAsarFile(asarPath, 'package.json');
    const preloadBuf = readAsarFile(asarPath, 'dist/preload.js');
    const preloadStr = preloadBuf ? preloadBuf.toString('utf8') : '';
    let syntaxValid = false;
    if (preloadStr) {
        try {
            new vm.Script(preloadStr);
            syntaxValid = true;
        } catch {
            syntaxValid = false;
        }
    }
    return {
        asarPath,
        version: pkgBuf ? JSON.parse(pkgBuf.toString('utf8')).version : 'unknown',
        asarBytes: fs.statSync(asarPath).size,
        packedCount,
        unpackedCount,
        syntaxValid,
        hasCN: preloadStr.includes('__ANTIGRAVITY_CHINESE_LOCALIZATION_START__'),
        hasCodexTheme: preloadStr.includes(SIG_START),
    };
}

// ============================================================================
// Sync Silas-02/antigravity-desktop-cn (Git + Windows Proxy + No-Git ZIP fallback)
// ============================================================================
function getWindowsSystemProxyUrl() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(
            'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable && reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }
        );
        if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null;
        const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        if (!m) return null;
        const raw = m[1].trim();
        if (!raw) return null;
        if (/^https?:\/\//i.test(raw)) return raw;
        const httpEntry = raw.split(';').find(s => s.startsWith('http='));
        const hostPort = httpEntry ? httpEntry.slice(5) : raw.split(';')[0];
        return hostPort ? `http://${hostPort}` : null;
    } catch {
        return null;
    }
}

function hasCommand(cmd) {
    const res = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 4000 });
    return res.status === 0;
}

function downloadCnZipFallback() {
    const zipFile = path.join(SCRIPT_DIR, '.cache', 'antigravity-desktop-cn.zip');
    const extractDir = path.join(SCRIPT_DIR, '.cache', '_extract_cn');
    fs.mkdirSync(path.dirname(zipFile), { recursive: true });
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    console.log('[联动汉化] 正在通过 ZIP 压缩包下载最新版汉化仓库（自动兼容系统代理，无需 Git）...');
    let ok = false;
    if (process.platform === 'win32') {
        const psCmd = [
            '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;',
            `$ProgressPreference = 'SilentlyContinue';`,
            `Invoke-WebRequest -UseBasicParsing -TimeoutSec 45 -Uri '${CN_ZIP_URL}' -OutFile '${zipFile.replace(/'/g, "''")}';`,
            `Expand-Archive -Force -Path '${zipFile.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'`,
        ].join(' ');
        const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
            stdio: 'inherit',
            timeout: 90000,
        });
        ok = ps.status === 0 && fs.existsSync(extractDir);
    } else {
        const dl = spawnSync('curl', ['-fsSL', '--max-time', '45', '-o', zipFile, CN_ZIP_URL], { stdio: 'inherit' });
        if (dl.status === 0) {
            fs.mkdirSync(extractDir, { recursive: true });
            const uz = spawnSync('unzip', ['-q', '-o', zipFile, '-d', extractDir], { stdio: 'inherit' });
            ok = uz.status === 0;
        }
    }

    if (fs.existsSync(zipFile)) {
        try { fs.unlinkSync(zipFile); } catch {}
    }
    if (!ok) return null;

    const sub = fs.readdirSync(extractDir).find(n => fs.existsSync(path.join(extractDir, n, 'localization_engine.js')));
    if (!sub) return null;

    const extractedRoot = path.join(extractDir, sub);
    if (fs.existsSync(CN_CACHE_DIR)) fs.rmSync(CN_CACHE_DIR, { recursive: true, force: true });
    fs.renameSync(extractedRoot, CN_CACHE_DIR);
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    return CN_CACHE_DIR;
}

function resolveCnRepoDir() {
    console.log('[联动汉化] 正在同步最新 Silas-02/antigravity-desktop-cn 汉化仓库...');

    const env = { ...process.env };
    if (!env.HTTPS_PROXY && !env.https_proxy && !env.HTTP_PROXY && !env.http_proxy) {
        const sysProxy = getWindowsSystemProxyUrl();
        if (sysProxy) {
            env.HTTPS_PROXY = sysProxy;
            env.HTTP_PROXY = sysProxy;
        }
    }

    const gitAvailable = hasCommand('git');
    if (gitAvailable) {
        if (fs.existsSync(path.join(CN_CACHE_DIR, '.git'))) {
            const pull = spawnSync('git', ['-C', CN_CACHE_DIR, 'pull', '--ff-only'], {
                stdio: 'inherit',
                env,
                timeout: 45000,
            });
            if (pull.status === 0 && fs.existsSync(path.join(CN_CACHE_DIR, 'localization_engine.js'))) {
                return CN_CACHE_DIR;
            }
            console.warn('[提示] git pull 失败，尝试直接下载 ZIP 或使用本地缓存...');
        } else {
            fs.mkdirSync(path.dirname(CN_CACHE_DIR), { recursive: true });
            if (fs.existsSync(CN_CACHE_DIR)) {
                fs.rmSync(CN_CACHE_DIR, { recursive: true, force: true });
            }
            const clone = spawnSync('git', ['clone', '--depth', '1', CN_REPO_URL, CN_CACHE_DIR], {
                stdio: 'inherit',
                env,
                timeout: 45000,
            });
            if (clone.status === 0 && fs.existsSync(path.join(CN_CACHE_DIR, 'localization_engine.js'))) {
                return CN_CACHE_DIR;
            }
            console.warn('[提示] git clone 失败，自动切换为 ZIP 直连下载...');
        }
    } else {
        console.log('[提示] 当前电脑未安装 Git，自动使用 ZIP 模式拉取汉化包...');
    }

    // Fallback 1: ZIP download (works without Git and automatically respects Windows system proxy)
    const zipDir = downloadCnZipFallback();
    if (zipDir && fs.existsSync(path.join(zipDir, 'localization_engine.js'))) {
        return zipDir;
    }

    // Fallback 2: existing cache or sibling folder
    for (const candidate of [CN_CACHE_DIR, ...CN_SIBLING_DIRS]) {
        if (fs.existsSync(path.join(candidate, 'localization_engine.js'))) {
            console.warn(`[提示] 在线拉取失败，回退使用本地已有汉化目录: ${candidate}`);
            return candidate;
        }
    }

    throw new Error(
        '无法拉取 Silas-02/antigravity-desktop-cn 汉化仓库。\n' +
        '请检查当前电脑能否访问 GitHub（如开启科学上网/系统代理后重试），\n' +
        '或手动下载 https://github.com/Silas-02/antigravity-desktop-cn 解压为同级目录 antigravity-desktop-cn-main 后重试。'
    );
}

function syncAndRunCnLocalization(opts, detected) {
    const cnDir = resolveCnRepoDir();
    const enginePath = path.join(cnDir, 'localization_engine.js');

    // If theme was previously applied before CN (so app.asar.bak doesn't exist yet),
    // restore clean pre-theme backup first so CN creates a pure official app.asar.bak.
    const cnBak = path.join(detected.resourcesDir, 'app.asar.bak');
    const preThemeBak = `${detected.asarPath}.before_codex_patch.bak`;
    if (!fs.existsSync(cnBak) && fs.existsSync(preThemeBak)) {
        const curInfo = inspectAsar(detected.asarPath);
        if (curInfo.hasCodexTheme && !curInfo.hasCN) {
            console.log('[联动汉化] 检测到此前仅安装过主题，先还原官方原版再执行汉化，保持官方备份纯净...');
            copyWithRetry(preThemeBak, detected.asarPath);
        }
    }

    const args = [
        enginePath,
        '--install-dir', detected.installDir,
        '--brand-title', opts.brandTitle,
    ];
    if (opts.noKill) args.push('--no-kill');

    console.log('[联动汉化] 正在执行中文汉化注入...');
    const res = spawnSync(process.execPath, args, { cwd: cnDir, stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error(`中文汉化脚本退出异常（exit code ${res.status}）`);
    }
    console.log('[联动汉化] 中文汉化完成，准备叠加注入 Codex v4.1 主题...\n');
}

// ============================================================================
// Main Actions: Install / Uninstall / Check
// ============================================================================
function printBanner(opts) {
    console.log('========================================================');
    if (opts.mode === 'uninstall') {
        console.log('        Antigravity Codex 主题无损卸载与还原工具');
    } else if (opts.withCn) {
        console.log('   Antigravity 一键联动最新中文汉化 + Codex v4.1 主题');
        console.log('   说明：自动同步 Silas-02 最新汉化，再原地无损注入主题');
    } else {
        console.log('      Antigravity 1:1 Codex 桌面端美化补丁（原地无损）');
    }
    console.log('========================================================\n');
}

function runInstall(opts) {
    printBanner(opts);
    if (!fs.existsSync(CSS_PATH)) {
        throw new Error(`未找到主题样式表: ${CSS_PATH}`);
    }

    const detected = detectAntigravityPaths(opts.manualPath);
    console.log(`[探测] 已定位 Antigravity: ${detected.asarPath}`);

    ensureWritable(detected.asarPath);
    ensureAntigravityClosed(opts.noKill);

    if (opts.withCn) {
        syncAndRunCnLocalization(opts, detected);
    }

    const backupPath = `${detected.asarPath}.before_codex_patch.bak`;
    console.log('[1/3] 检查并维护安全备份...');
    if (!fs.existsSync(backupPath)) {
        copyWithRetry(detected.asarPath, backupPath);
        console.log(`      已创建备份: ${backupPath}`);
    } else if (opts.withCn) {
        copyWithRetry(detected.asarPath, backupPath);
        console.log(`      已更新汉化后备份: ${backupPath}`);
    } else {
        console.log('      已有备份文件存在，跳过覆盖。');
    }

    console.log('[2/3] 正在原地无损注入 Codex v4.1 主题（保留全部 unpacked 原生依赖）...');
    const preloadBuf = readAsarFile(detected.asarPath, 'dist/preload.js');
    if (!preloadBuf) {
        throw new Error('无法从 app.asar 读取 dist/preload.js');
    }
    const cleanPreload = stripCodexTheme(preloadBuf.toString('utf8'));
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const newPreload = cleanPreload + buildInjection(css);

    new vm.Script(newPreload);

    const stats = patchAsarInPlace(detected.asarPath, detected.asarPath, { 'dist/preload.js': newPreload });

    console.log('[3/3] 正在执行最终封包校验...');
    const info = inspectAsar(detected.asarPath);
    if (!info.syntaxValid || !info.hasCodexTheme) {
        throw new Error('最终校验未通过，请检查 app.asar 状态。');
    }

    console.log('\n========================================================');
    console.log('  [OK] 成功！Codex 视觉与排版主题已无损部署到 Antigravity');
    console.log(`       版本: v${info.version} | 体积: ${(stats.finalSize / 1024 / 1024).toFixed(2)} MB | 原生依赖保留: ${stats.unpackedCount} 项`);
    console.log(`       中文汉化: ${info.hasCN ? '已启用' : '未启用'} | Codex 主题: 已启用 | 语法校验: 通过`);
    console.log('  请重新打开 Antigravity 即可体验全新界面。');
    console.log('========================================================');
}

function runUninstall(opts) {
    printBanner(opts);
    const detected = detectAntigravityPaths(opts.manualPath);
    console.log(`[探测] 已定位 Antigravity: ${detected.asarPath}`);

    ensureWritable(detected.asarPath);
    ensureAntigravityClosed(opts.noKill);

    const backupPath = `${detected.asarPath}.before_codex_patch.bak`;
    if (fs.existsSync(backupPath)) {
        copyWithRetry(backupPath, detected.asarPath);
        console.log(`[OK] 已从备份无损恢复: ${backupPath}`);
        console.log('请重新打开 Antigravity。');
        return;
    }

    const preloadBuf = readAsarFile(detected.asarPath, 'dist/preload.js');
    if (!preloadBuf) {
        throw new Error('无法读取 dist/preload.js，且未找到备份文件。');
    }
    const original = preloadBuf.toString('utf8');
    if (!original.includes(SIG_START)) {
        console.log('[提示] 当前 app.asar 未检测到 Codex 主题补丁，无需还原。');
        return;
    }
    const stripped = stripCodexTheme(original);
    new vm.Script(stripped);
    patchAsarInPlace(detected.asarPath, detected.asarPath, { 'dist/preload.js': stripped });
    console.log('[OK] 已原地无损移除 Codex 主题补丁。请重新打开 Antigravity。');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    try {
        if (opts.mode === 'check') {
            const detected = detectAntigravityPaths(opts.manualPath);
            const info = inspectAsar(detected.asarPath);
            console.log(JSON.stringify(info, null, 2));
        } else if (opts.mode === 'uninstall') {
            runUninstall(opts);
        } else {
            runInstall(opts);
        }
    } catch (err) {
        console.error(`\n[错误] ${err.message}`);
        process.exit(1);
    }
}

main();
