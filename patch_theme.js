#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const CSS_PATH = path.join(SCRIPT_DIR, 'codex_theme.css');
const CONFIG_HUB_SRC = path.join(SCRIPT_DIR, 'plugins', 'codex-config-hub');
const SELF_RAW_BASE = (process.env.CODEX_THEME_RAW_BASE || 'https://raw.githubusercontent.com/qiuyizipi/antigravity-codex-theme/main').replace(/\/+$/, '');
const CN_REPO_URL = 'https://github.com/Silas-02/antigravity-desktop-cn.git';
const CN_ZIP_URL = 'https://github.com/Silas-02/antigravity-desktop-cn/archive/refs/heads/main.zip';
const CN_CACHE_DIR = path.join(SCRIPT_DIR, '.cache', 'antigravity-desktop-cn');
const CN_SIBLING_DIRS = [
    path.join(SCRIPT_DIR, '..', 'antigravity-desktop-cn-main'),
    path.join(SCRIPT_DIR, '..', 'antigravity-desktop-cn'),
];

const SIG_START = '/* __ANTIGRAVITY_CODEX_THEME_START__ */';
const SIG_END = '/* __ANTIGRAVITY_CODEX_THEME_END__ */';
const SIG_MAIN_START = '/* __ANTIGRAVITY_CODEX_HOT_CSS_START__ */';
const SIG_MAIN_END = '/* __ANTIGRAVITY_CODEX_HOT_CSS_END__ */';

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // lightweight synchronous wait for Windows file lock release
    }
}

function parseArgs(argv) {
    const opts = {
        mode: 'install', // install | uninstall | check | doctor | install-hub
        withCn: false,
        noKill: false,
        noUpdate: false,
        noHub: false,
        removeHub: false,
        selfUpdated: false,
        watchCss: false,
        brandTitle: 'english',
        manualPath: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--uninstall' || a === '--restore') opts.mode = 'uninstall';
        else if (a === '--check' || a === '--status') opts.mode = 'check';
        else if (a === '--doctor') opts.mode = 'doctor';
        else if (a === '--install-hub') opts.mode = 'install-hub';
        else if (a === '--with-cn') opts.withCn = true;
        else if (a === '--no-kill') opts.noKill = true;
        else if (a === '--no-update') opts.noUpdate = true;
        else if (a === '--no-hub') opts.noHub = true;
        else if (a === '--remove-hub') opts.removeHub = true;
        else if (a === '--self-updated') opts.selfUpdated = true;
        else if (a === '--watch-css') opts.watchCss = true;
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
        // 0. If Antigravity is currently running, read its exact executable path first (works for ANY custom folder!)
        try {
            const runningExe = execSync(
                'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process Antigravity -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }
            ).trim();
            if (runningExe) add(path.dirname(runningExe));
        } catch {
            // ignore
        }

        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        add(path.join(localAppData, 'Programs', 'antigravity'));
        add(path.join(localAppData, 'antigravity'));

        // Query Windows Uninstall Registry in UTF-8 mode (avoids GBK mojibake on Chinese paths)
        const regRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        ];
        for (const root of regRoots) {
            try {
                const out = execSync(`chcp 65001 >nul && reg query "${root}" /s /f Antigravity /d`, {
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
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
        try {
            const chk = spawnSync('pgrep', ['-fi', 'Antigravity'], { stdio: 'ignore', timeout: 3000 });
            if (chk.status === 0) {
                console.warn('[提示] 检测到 Antigravity 可能正在运行，建议先完全退出客户端，补丁完成后再重新启动。');
            }
        } catch {
            // ignore
        }
    }
}

function resignMacAppIfNeeded(asarPath) {
    if (process.platform !== 'darwin') return;
    const match = asarPath.match(/^(.*\.app)\/Contents\/Resources\/app\.asar$/i);
    if (!match) return;
    const appBundle = match[1];
    console.log('[macOS] 正在执行 ad-hoc 重签名以防止 Apple Silicon 报“应用已损坏”...');
    const res = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 30000,
    });
    if (res.status !== 0) {
        console.warn(`[警告] macOS 重签名未成功（可手动执行: codesign --force --deep --sign - "${appBundle}"）`);
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

function stripMainHotCss(mainCode) {
    if (!mainCode.includes(SIG_MAIN_START)) return mainCode;
    const s = mainCode.indexOf(SIG_MAIN_START);
    const eIdx = mainCode.indexOf(SIG_MAIN_END);
    if (eIdx === -1) return mainCode;
    return mainCode.slice(0, s) + mainCode.slice(eIdx + SIG_MAIN_END.length);
}

function buildMainHotCssInjection(hotCssPath) {
    const pLiteral = JSON.stringify(hotCssPath);
    return `\n${SIG_MAIN_START}\n(() => {\n    try {\n        const _el = require('electron');\n        const _fs = require('fs');\n        const _p = ${pLiteral};\n        let _lastMt = 0;\n        let _lastCss = '';\n        if (_el && _el.ipcMain && typeof _el.ipcMain.handle === 'function') {\n            try { _el.ipcMain.removeHandler('codex:read-hot-css'); } catch {}\n            _el.ipcMain.handle('codex:read-hot-css', () => {\n                try {\n                    if (!_fs.existsSync(_p)) return null;\n                    const mt = _fs.statSync(_p).mtimeMs;\n                    if (mt !== _lastMt || !_lastCss) {\n                        _lastMt = mt;\n                        _lastCss = _fs.readFileSync(_p, 'utf8');\n                    }\n                    return { mt, css: _lastCss };\n                } catch { return null; }\n            });\n        }\n    } catch {}\n})();\n${SIG_MAIN_END}\n`;
}

function buildInjection(css, hotCssPath) {
    const escapedCss = css
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
    const hotPathLiteral = hotCssPath ? JSON.stringify(hotCssPath) : 'null';
    return `\n${SIG_START}\n(() => {\n    let themeCss = \`${escapedCss}\`;\n    const HOT_CSS_PATH = ${hotPathLiteral};\n    let lastHotMtime = 0;\n    const STYLE_ID = 'antigravity-codex-theme-patch';\n    let lastOverlayMode = '';\n    let overlaySyncTimer = null;\n    function applyThemeCssText(nextCss) {\n        if (!nextCss || nextCss === themeCss) return;\n        themeCss = nextCss;\n        const s = document.getElementById(STYLE_ID);\n        if (s && s.textContent !== themeCss) s.textContent = themeCss;\n    }\n    function reloadHotCssIfChanged() {\n        if (!HOT_CSS_PATH) return;\n        try {\n            if (typeof electron_1 !== 'undefined' && electron_1 && electron_1.ipcRenderer) {\n                void Promise.resolve(electron_1.ipcRenderer.invoke('codex:read-hot-css')).then((res) => {\n                    if (!res || !res.css) return;\n                    if (res.mt !== lastHotMtime || res.css !== themeCss) {\n                        lastHotMtime = res.mt || Date.now();\n                        applyThemeCssText(res.css);\n                    }\n                }).catch(() => undefined);\n                return;\n            }\n        } catch {}\n        try {\n            const _fs = require('fs');\n            if (!_fs.existsSync(HOT_CSS_PATH)) return;\n            const mt = _fs.statSync(HOT_CSS_PATH).mtimeMs;\n            if (mt !== lastHotMtime) {\n                lastHotMtime = mt;\n                applyThemeCssText(_fs.readFileSync(HOT_CSS_PATH, 'utf8'));\n            }\n        } catch {}\n    }\n    function parseHexLum(val) {\n        const m = String(val || '').trim().match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);\n        if (!m) return null;\n        const hex = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];\n        const r = parseInt(hex.slice(0, 2), 16);\n        const g = parseInt(hex.slice(2, 4), 16);\n        const b = parseInt(hex.slice(4, 6), 16);\n        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;\n    }\n    function detectCodexMode() {\n        const h = document.documentElement;\n        const b = document.body;\n        const r = document.getElementById('root') || (b && b.firstElementChild);\n        const nodes = [h, b, r].filter(Boolean);\n        for (const el of nodes) {\n            const cl = el.classList;\n            const dt = el.getAttribute('data-theme') || el.getAttribute('data-color-scheme') || '';\n            if ((cl && (cl.contains('dark') || cl.contains('theme-dark') || cl.contains('vscode-dark'))) || /dark/i.test(dt)) return 'dark';\n            if ((cl && (cl.contains('light') || cl.contains('theme-light') || cl.contains('vscode-light'))) || /light/i.test(dt)) return 'light';\n        }\n        try {\n            if (h) {\n                const st = getComputedStyle(h);\n                const cs = st.colorScheme || '';\n                if (cs.includes('dark') && !cs.includes('light')) return 'dark';\n                if (cs.includes('light') && !cs.includes('dark')) return 'light';\n                const nativeBg = st.getPropertyValue('--background');\n                const lum = parseHexLum(nativeBg);\n                if (lum !== null) return lum < 0.5 ? 'dark' : 'light';\n            }\n        } catch {}\n        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';\n    }\n    function syncTitleBarOverlay(mode, force) {\n        if (!force && mode === lastOverlayMode) return;\n        lastOverlayMode = mode;\n        if (overlaySyncTimer) clearTimeout(overlaySyncTimer);\n        const pushOverlay = () => {\n            try {\n                if (typeof electron_1 !== 'undefined' && electron_1 && electron_1.ipcRenderer) {\n                    const opts = mode === 'dark'\n                        ? { color: '#181818', symbolColor: '#ECECEC' }\n                        : { color: '#F8F9FC', symbolColor: '#1F2328' };\n                    void Promise.resolve(electron_1.ipcRenderer.invoke('window:set-title-bar-overlay', opts)).catch(() => undefined);\n                }\n            } catch {}\n        };\n        pushOverlay();\n        overlaySyncTimer = setTimeout(pushOverlay, 350);\n        setTimeout(pushOverlay, 1200);\n    }\n    let pinning = false;\n    function ensureStylePinned() {\n        if (pinning) return;\n        const target = document.head || document.documentElement;\n        if (!target) return;\n        pinning = true;\n        try {\n            let style = document.getElementById(STYLE_ID);\n            if (!style) {\n                style = document.createElement('style');\n                style.id = STYLE_ID;\n                style.textContent = themeCss;\n                target.appendChild(style);\n            } else if (style.parentNode !== target || target.lastElementChild !== style) {\n                target.appendChild(style);\n            }\n        } finally {\n            pinning = false;\n        }\n    }\n    function syncCodexMode(forceOverlay) {\n        const h = document.documentElement;\n        if (!h) return;\n        const mode = detectCodexMode();\n        if (h.getAttribute('data-codex-mode') !== mode) {\n            h.setAttribute('data-codex-mode', mode);\n            syncTitleBarOverlay(mode, true);\n        } else if (forceOverlay) {\n            syncTitleBarOverlay(mode, true);\n        }\n    }\n    let htmlObserved = false;\n    let headObserved = false;\n    let bodyObserved = false;\n    let mqBound = false;\n    let watchdogStarted = false;\n    let attrObs = null;\n    let headObs = null;\n    function startThemeObserver() {\n        if (typeof MutationObserver !== 'undefined') {\n            if (!attrObs) attrObs = new MutationObserver(() => { syncCodexMode(false); ensureStylePinned(); });\n            if (!htmlObserved && document.documentElement) {\n                htmlObserved = true;\n                attrObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'] });\n            }\n            if (!bodyObserved && document.body) {\n                bodyObserved = true;\n                attrObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme'] });\n            }\n            if (!headObserved && document.head) {\n                headObserved = true;\n                headObs = new MutationObserver(() => ensureStylePinned());\n                headObs.observe(document.head, { childList: true });\n            }\n        }\n        if (!mqBound) {\n            mqBound = true;\n            try {\n                const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');\n                if (mq && mq.addEventListener) mq.addEventListener('change', () => syncCodexMode(true));\n            } catch {}\n        }\n        if (!watchdogStarted) {\n            watchdogStarted = true;\n            setInterval(() => {\n                reloadHotCssIfChanged();\n                startThemeObserver();\n                ensureStylePinned();\n                syncCodexMode(false);\n            }, 800);\n        }\n    }\n    function injectCodexTheme() {\n        ensureStylePinned();\n        reloadHotCssIfChanged();\n        syncCodexMode(true);\n        startThemeObserver();\n    }\n    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', injectCodexTheme);\n    } else {\n        injectCodexTheme();\n    }\n    window.addEventListener('load', injectCodexTheme);\n    window.addEventListener('hashchange', () => setTimeout(injectCodexTheme, 120));\n    window.addEventListener('popstate', () => setTimeout(injectCodexTheme, 120));\n})();\n${SIG_END}\n`;
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
    const mainBuf = readAsarFile(asarPath, 'dist/main.js');
    const preloadStr = preloadBuf ? preloadBuf.toString('utf8') : '';
    const mainStr = mainBuf ? mainBuf.toString('utf8') : '';
    let syntaxValid = false;
    if (preloadStr) {
        try {
            new vm.Script(preloadStr);
            if (mainStr) new vm.Script(mainStr);
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
        hasHotCssIpc: mainStr.includes(SIG_MAIN_START),
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

// ============================================================================
// Self-Update Engine (Git fast-forward OR single-shot proxy-aware HTTP for ZIP)
// Fail-open: never blocks installation when offline or GitHub is unreachable
// ============================================================================
function downloadPairWithProxy(urlCss, urlJs, timeoutSec = 8) {
    const tag = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const tmpCss = path.join(os.tmpdir(), `codex_css_${tag}.tmp`);
    const tmpJs = path.join(os.tmpdir(), `codex_js_${tag}.tmp`);
    try {
        if (process.platform === 'win32') {
            const esc = (s) => s.replace(/'/g, "''");
            // Single PowerShell invocation: if first download fails (offline/blocked), immediately abort instead of waiting twice
            const psCmd = [
                '$ErrorActionPreference = "Stop";',
                '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;',
                '$ProgressPreference = "SilentlyContinue";',
                `Invoke-WebRequest -UseBasicParsing -TimeoutSec ${timeoutSec} -Uri '${esc(urlCss)}' -OutFile '${esc(tmpCss)}';`,
                `Invoke-WebRequest -UseBasicParsing -TimeoutSec ${timeoutSec} -Uri '${esc(urlJs)}' -OutFile '${esc(tmpJs)}'`,
            ].join(' ');
            spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
                stdio: 'ignore',
                timeout: (timeoutSec * 2 + 6) * 1000,
            });
        } else {
            const r1 = spawnSync('curl', ['-fsSL', '--max-time', String(timeoutSec), '-o', tmpCss, urlCss], {
                stdio: 'ignore',
                timeout: (timeoutSec + 4) * 1000,
            });
            if (r1.status === 0) {
                spawnSync('curl', ['-fsSL', '--max-time', String(timeoutSec), '-o', tmpJs, urlJs], {
                    stdio: 'ignore',
                    timeout: (timeoutSec + 4) * 1000,
                });
            }
        }
        return {
            remoteCss: fs.existsSync(tmpCss) ? fs.readFileSync(tmpCss, 'utf8') : null,
            remoteJs: fs.existsSync(tmpJs) ? fs.readFileSync(tmpJs, 'utf8') : null,
        };
    } catch {
        return { remoteCss: null, remoteJs: null };
    } finally {
        for (const f of [tmpCss, tmpJs]) {
            if (fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch {}
            }
        }
    }
}

function normalizeLf(s) {
    return String(s).replace(/\r\n/g, '\n');
}

function isValidThemeCss(text) {
    if (!text || text.length < 1000) return false;
    if (/^\s*<(!doctype|html)/i.test(text)) return false;
    return text.includes('--codex-bg') && text.includes('[data-testid="conversation-view"]');
}

function isValidPatchScript(text) {
    if (!text || text.length < 3000) return false;
    if (/^\s*<(!doctype|html)/i.test(text)) return false;
    if (!text.includes('patchAsarInPlace') || !text.includes('buildInjection')) return false;
    try {
        new vm.Script(text);
        return true;
    } catch {
        return false;
    }
}

function reexecUpdatedSelf() {
    const childArgs = [__filename, '--self-updated', ...process.argv.slice(2).filter(a => a !== '--self-updated')];
    const res = spawnSync(process.execPath, childArgs, { stdio: 'inherit' });
    process.exit(res.status === null ? 1 : res.status);
}

function trySelfUpdate(opts) {
    if (opts.noUpdate || opts.selfUpdated) return;
    console.log('[自更新] 正在检查 Codex 主题与安装脚本是否有新版本...');

    // Case 1: Git clone with clean working tree -> fast-forward pull
    const isGitRepo = fs.existsSync(path.join(SCRIPT_DIR, '.git'));
    if (isGitRepo && hasCommand('git')) {
        const st = spawnSync('git', ['-C', SCRIPT_DIR, 'status', '--porcelain'], {
            encoding: 'utf8',
            timeout: 5000,
        });
        if (st.status === 0 && st.stdout.trim().length > 0) {
            console.log('[自更新] 检测到本地有未提交改动，跳过自动拉取（保留本地修改）。');
            return;
        }
        const beforeJs = normalizeLf(fs.readFileSync(__filename, 'utf8'));
        const beforeCss = fs.existsSync(CSS_PATH) ? normalizeLf(fs.readFileSync(CSS_PATH, 'utf8')) : '';
        const env = { ...process.env };
        if (!env.HTTPS_PROXY && !env.https_proxy && !env.HTTP_PROXY && !env.http_proxy) {
            const sysProxy = getWindowsSystemProxyUrl();
            if (sysProxy) {
                env.HTTPS_PROXY = sysProxy;
                env.HTTP_PROXY = sysProxy;
            }
        }
        const pull = spawnSync('git', ['-C', SCRIPT_DIR, 'pull', '--ff-only'], {
            stdio: 'pipe',
            encoding: 'utf8',
            env,
            timeout: 18000,
        });
        if (pull.status === 0) {
            const afterJs = normalizeLf(fs.readFileSync(__filename, 'utf8'));
            const afterCss = fs.existsSync(CSS_PATH) ? normalizeLf(fs.readFileSync(CSS_PATH, 'utf8')) : '';
            if (afterJs !== beforeJs && isValidPatchScript(afterJs)) {
                console.log('[自更新] 已通过 Git 同步最新版安装引擎，正在无缝切换至新版执行...\n');
                reexecUpdatedSelf();
            } else if (afterCss !== beforeCss) {
                console.log('[自更新] 已通过 Git 同步最新版 codex_theme.css。');
            } else {
                console.log('[自更新] 当前主题与脚本已是最新版本。');
            }
            return;
        }
        console.log('[自更新] Git 拉取未成功，继续尝试使用本地版本（不影响安装）。');
        return;
    }

    // Case 2: ZIP download (no .git) -> single-shot proxy-aware raw HTTP sync with strict validation
    const cacheBust = `?t=${Date.now()}`;
    const { remoteCss, remoteJs } = downloadPairWithProxy(
        `${SELF_RAW_BASE}/codex_theme.css${cacheBust}`,
        `${SELF_RAW_BASE}/patch_theme.js${cacheBust}`,
        8
    );

    if (!remoteCss && !remoteJs) {
        console.log('[自更新] 无法连接 GitHub（或网络超时），继续使用本地版本完成安装。');
        return;
    }

    let cssUpdated = false;
    let jsUpdated = false;

    if (remoteCss && isValidThemeCss(remoteCss)) {
        const localCss = fs.existsSync(CSS_PATH) ? normalizeLf(fs.readFileSync(CSS_PATH, 'utf8')) : '';
        if (normalizeLf(remoteCss) !== localCss) {
            fs.writeFileSync(CSS_PATH, remoteCss, 'utf8');
            cssUpdated = true;
        }
    }

    if (remoteJs && isValidPatchScript(remoteJs)) {
        const localJs = normalizeLf(fs.readFileSync(__filename, 'utf8'));
        if (normalizeLf(remoteJs) !== localJs) {
            fs.writeFileSync(__filename, remoteJs, 'utf8');
            jsUpdated = true;
        }
    }

    if (jsUpdated) {
        console.log(`[自更新] 已自动更新安装引擎${cssUpdated ? '与主题样式' : ''}（通过语法校验），正在无缝切换至最新版执行...\n`);
        reexecUpdatedSelf();
    } else if (cssUpdated) {
        console.log('[自更新] 已自动更新最新版 codex_theme.css。');
    } else {
        console.log('[自更新] 当前主题与脚本已是最新版本。');
    }
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
    console.log('[联动汉化] 中文汉化完成，准备叠加注入 Codex v4.6 主题...\n');
}

// ============================================================================
// Main Actions: Install / Uninstall / Check
// ============================================================================
function printBanner(opts) {
    console.log('========================================================');
    if (opts.mode === 'uninstall') {
        console.log('        Antigravity Codex 主题无损卸载与还原工具');
    } else if (opts.withCn) {
        console.log('   Antigravity 一键联动最新中文汉化 + Codex v4.6 主题');
        console.log('   说明：自动同步 Silas-02 最新汉化，再原地无损注入主题');
    } else {
        console.log('      Antigravity 1:1 Codex 桌面端美化补丁（原地无损）');
    }
    console.log('========================================================\n');
}

function runInstall(opts) {
    if (!opts.selfUpdated) printBanner(opts);
    trySelfUpdate(opts);
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
    const preInfo = inspectAsar(detected.asarPath);
    let needRefreshBackup = !fs.existsSync(backupPath) || opts.withCn;
    if (!needRefreshBackup && fs.existsSync(backupPath)) {
        try {
            const bakInfo = inspectAsar(backupPath);
            // If Antigravity upgraded to a newer version, refresh stale backup instead of keeping an old version!
            if (bakInfo.version !== preInfo.version && !preInfo.hasCodexTheme) {
                console.log(`      检测到客户端已从 v${bakInfo.version} 升级至 v${preInfo.version}，自动刷新同版本安全备份...`);
                needRefreshBackup = true;
            }
        } catch {
            if (!preInfo.hasCodexTheme) needRefreshBackup = true;
        }
    }
    if (needRefreshBackup) {
        copyWithRetry(detected.asarPath, backupPath);
        console.log(`      已创建/更新备份: ${backupPath} (v${preInfo.version})`);
    } else {
        console.log(`      已有同版本备份 (v${preInfo.version})，跳过覆盖。`);
    }

    console.log('[2/3] 正在原地无损注入 Codex v4.6 主题（保留全部 unpacked 原生依赖）...');
    const preloadBuf = readAsarFile(detected.asarPath, 'dist/preload.js');
    if (!preloadBuf) {
        throw new Error('无法从 app.asar 读取 dist/preload.js');
    }
    const cleanPreload = stripCodexTheme(preloadBuf.toString('utf8'));
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const newPreload = cleanPreload + buildInjection(css, opts.watchCss ? CSS_PATH : null);

    new vm.Script(newPreload);

    const filePatches = { 'dist/preload.js': newPreload };
    const mainBuf = readAsarFile(detected.asarPath, 'dist/main.js');
    if (mainBuf) {
        const rawMain = mainBuf.toString('utf8');
        const cleanMain = stripMainHotCss(rawMain);
        if (opts.watchCss) {
            const newMain = cleanMain + buildMainHotCssInjection(CSS_PATH);
            new vm.Script(newMain);
            filePatches['dist/main.js'] = newMain;
        } else if (cleanMain !== rawMain) {
            new vm.Script(cleanMain);
            filePatches['dist/main.js'] = cleanMain;
        }
    }

    const stats = patchAsarInPlace(detected.asarPath, detected.asarPath, filePatches);
    resignMacAppIfNeeded(detected.asarPath);

    console.log('[3/3] 正在执行最终封包校验...');
    const info = inspectAsar(detected.asarPath);
    if (!info.syntaxValid || !info.hasCodexTheme) {
        throw new Error('最终校验未通过，请检查 app.asar 状态。');
    }

    let hubInstalled = false;
    if (!opts.noHub && fs.existsSync(CONFIG_HUB_SRC)) {
        const hubRes = installConfigHubPlugin();
        hubInstalled = hubRes.installed;
    }

    console.log('\n========================================================');
    console.log('  [OK] 成功！Codex 视觉与排版主题已无损部署到 Antigravity');
    console.log(`       版本: v${info.version} | 体积: ${(stats.finalSize / 1024 / 1024).toFixed(2)} MB | 原生依赖保留: ${stats.unpackedCount} 项`);
    console.log(`       中文汉化: ${info.hasCN ? '已启用' : '未启用'} | Codex 主题: 已启用 | 语法校验: 通过${info.hasHotCssIpc ? ' | IPC热重载: 已启用' : ''}`);
    if (hubInstalled) {
        console.log('       右侧栏「配置总览 (Config Hub)」插件: 已同步（重开后可在插件面板打开）');
    }
    console.log('  请重新打开 Antigravity 即可体验全新界面。');
    console.log('========================================================');
}

function getGeminiConfigDir() {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    return path.join(home, '.gemini', 'config');
}

function copyDirRecursive(srcDir, dstDir) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(dstDir, entry.name);
        if (entry.isDirectory()) copyDirRecursive(s, d);
        else fs.copyFileSync(s, d);
    }
}

function installConfigHubPlugin() {
    if (!fs.existsSync(CONFIG_HUB_SRC)) {
        return { installed: false, reason: '仓库内未找到 plugins/codex-config-hub 目录' };
    }
    const targetDir = path.join(getGeminiConfigDir(), 'plugins', 'codex-config-hub');
    copyDirRecursive(CONFIG_HUB_SRC, targetDir);

    const sidecarJsonPath = path.join(targetDir, 'sidecars', 'panel', 'sidecar.json');
    if (fs.existsSync(sidecarJsonPath)) {
        const sc = JSON.parse(fs.readFileSync(sidecarJsonPath, 'utf8'));
        sc.command = process.platform === 'win32' ? 'node.exe' : 'node';
        fs.writeFileSync(sidecarJsonPath, JSON.stringify(sc, null, 2) + '\n', 'utf8');
    }
    JSON.parse(fs.readFileSync(path.join(targetDir, 'plugin.json'), 'utf8'));
    return { installed: true, targetDir };
}

function runDoctor(opts) {
    const configDir = getGeminiConfigDir();
    const readJson = (p) => {
        if (!fs.existsSync(p)) return null;
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { __parseError: true }; }
    };

    console.log('========================================================');
    console.log('      Antigravity 全局配置与补丁生效状态体检 (--doctor)');
    console.log('========================================================\n');

    try {
        const detected = detectAntigravityPaths(opts.manualPath);
        const info = inspectAsar(detected.asarPath);
        console.log('[1] 客户端与底层补丁');
        console.log(`    安装文件   : ${info.asarPath}`);
        console.log(`    客户端版本 : v${info.version} (语法校验: ${info.syntaxValid ? '通过' : '异常'}, unpacked: ${info.unpackedCount})`);
        console.log(`    中文汉化   : ${info.hasCN ? '已启用' : '未安装'}`);
        console.log(`    Codex 主题 : ${info.hasCodexTheme ? '已启用' : '未安装'}${info.hasHotCssIpc ? ' (IPC热重载已开)' : ''}\n`);
    } catch (err) {
        console.log(`[1] 客户端探测失败: ${err.message}\n`);
    }

    const cfgPath = path.join(configDir, 'config.json');
    const cfg = readJson(cfgPath);
    const us = (cfg && cfg.userSettings) || {};
    console.log('[2] 核心用户设置');
    console.log(`    配置文件   : ${cfgPath}`);
    console.log(`    执行 / 审阅: ${us.autoExecutionPolicy || '默认'} / ${us.artifactReviewMode || '默认'}`);
    console.log(`    主题 / 字号: ${us.themeMode || '默认'} / ${us.fontSize ?? '默认'}px`);
    console.log(`    白名单规则 : ${Array.isArray(us.globalPermissionGrants && us.globalPermissionGrants.allow) ? us.globalPermissionGrants.allow.length : 0} 条\n`);

    console.log('[3] 全局规则与长期记忆');
    for (const name of ['AGENTS.md', 'MEMORY.md']) {
        const fp = path.join(configDir, name);
        if (fs.existsSync(fp)) {
            const st = fs.statSync(fp);
            const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).length;
            console.log(`    ${name.padEnd(10)} : 已配置 (${(st.size / 1024).toFixed(1)} KB, ${lines} 行) -> ${fp}`);
        } else {
            console.log(`    ${name.padEnd(10)} : 未创建 -> ${fp}`);
        }
    }
    console.log('');

    const skillsDir = path.join(configDir, 'skills');
    let skillFolders = [];
    let invalidSkills = [];
    if (fs.existsSync(skillsDir)) {
        skillFolders = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
        for (const s of skillFolders) {
            const md = path.join(skillsDir, s, 'SKILL.md');
            if (!fs.existsSync(md) || !/^---\r?\n[\s\S]*?\r?\n---/.test(fs.readFileSync(md, 'utf8'))) {
                invalidSkills.push(s);
            }
        }
    }
    console.log(`[4] 全局 Skills (${skillFolders.length} 个) -> ${skillsDir}`);
    console.log(`    正常: ${skillFolders.length - invalidSkills.length} | 异常: ${invalidSkills.length}${invalidSkills.length ? ` (${invalidSkills.join(', ')})` : ''}\n`);

    const mcpPath = path.join(configDir, 'mcp_config.json');
    const mcp = readJson(mcpPath);
    const mcpServers = (mcp && mcp.mcpServers) || {};
    console.log(`[5] 全局 MCP 服务 (${Object.keys(mcpServers).length} 个，密钥已脱敏) -> ${mcpPath}`);
    for (const [name, def] of Object.entries(mcpServers)) {
        const target = (def && (def.url || def.serverUrl)) || (def && def.command ? `${def.command} ${(def.args || []).join(' ')}` : 'unknown');
        console.log(`    - ${name}: ${target}`);
    }
    console.log('');

    const pluginsDir = path.join(configDir, 'plugins');
    const pluginDirs = fs.existsSync(pluginsDir)
        ? fs.readdirSync(pluginsDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
        : [];
    console.log(`[6] 已装原生插件 (${pluginDirs.length} 个) -> ${pluginsDir}`);
    for (const p of pluginDirs) {
        const pj = readJson(path.join(pluginsDir, p, 'plugin.json'));
        const ver = (pj && pj.version) || 'local';
        const tags = [];
        if (fs.existsSync(path.join(pluginsDir, p, 'sidecars')) || fs.existsSync(path.join(pluginsDir, p, 'sidecars.json'))) tags.push('侧栏UI');
        if (fs.existsSync(path.join(pluginsDir, p, 'mcp_config.json'))) tags.push('MCP');
        if (fs.existsSync(path.join(pluginsDir, p, 'rules'))) tags.push('规则');
        if (fs.existsSync(path.join(pluginsDir, p, 'hooks.json'))) tags.push('Hooks');
        if (fs.existsSync(path.join(pluginsDir, p, 'skills'))) tags.push('Skills');
        console.log(`    - ${p} (v${ver}) [${tags.join(', ') || '基础'}]`);
    }
    console.log('\n========================================================');
}

function runUninstall(opts) {
    printBanner(opts);
    const detected = detectAntigravityPaths(opts.manualPath);
    console.log(`[探测] 已定位 Antigravity: ${detected.asarPath}`);

    ensureWritable(detected.asarPath);
    ensureAntigravityClosed(opts.noKill);

    if (opts.removeHub) {
        const hubDir = path.join(getGeminiConfigDir(), 'plugins', 'codex-config-hub');
        if (fs.existsSync(hubDir)) {
            fs.rmSync(hubDir, { recursive: true, force: true });
            console.log(`[清理] 已移除右侧栏配置总览插件: ${hubDir}`);
        }
    }

    const backupPath = `${detected.asarPath}.before_codex_patch.bak`;
    const curInfo = inspectAsar(detected.asarPath);
    if (fs.existsSync(backupPath)) {
        let bakVersionMatches = false;
        try {
            const bakInfo = inspectAsar(backupPath);
            bakVersionMatches = bakInfo.version === curInfo.version;
            if (!bakVersionMatches) {
                console.warn(`[保护] 检测到备份版本 (v${bakInfo.version}) 与当前客户端版本 (v${curInfo.version}) 不一致，禁止跨版本覆盖，改用安全原地剥离！`);
            }
        } catch {
            bakVersionMatches = false;
        }
        if (bakVersionMatches) {
            copyWithRetry(backupPath, detected.asarPath);
            resignMacAppIfNeeded(detected.asarPath);
            console.log(`[OK] 已从同版本备份无损恢复: ${backupPath} (v${curInfo.version})`);
            console.log('请重新打开 Antigravity。');
            return;
        }
    }

    const preloadBuf = readAsarFile(detected.asarPath, 'dist/preload.js');
    if (!preloadBuf) {
        throw new Error('无法读取 dist/preload.js，且未找到匹配的备份文件。');
    }
    const original = preloadBuf.toString('utf8');
    const mainBuf = readAsarFile(detected.asarPath, 'dist/main.js');
    const originalMain = mainBuf ? mainBuf.toString('utf8') : '';
    const hasMainPatch = originalMain.includes(SIG_MAIN_START);
    if (!original.includes(SIG_START) && !hasMainPatch) {
        console.log('[提示] 当前 app.asar 未检测到 Codex 主题补丁，无需还原。');
        return;
    }
    const stripped = stripCodexTheme(original);
    new vm.Script(stripped);
    const uninstallPatches = { 'dist/preload.js': stripped };
    if (hasMainPatch) {
        const strippedMain = stripMainHotCss(originalMain);
        new vm.Script(strippedMain);
        uninstallPatches['dist/main.js'] = strippedMain;
    }
    patchAsarInPlace(detected.asarPath, detected.asarPath, uninstallPatches);
    resignMacAppIfNeeded(detected.asarPath);
    console.log('[OK] 已原地无损移除 Codex 主题补丁（保留当前客户端版本与汉化）。请重新打开 Antigravity。');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    try {
        if (opts.mode === 'check') {
            const detected = detectAntigravityPaths(opts.manualPath);
            const info = inspectAsar(detected.asarPath);
            console.log(JSON.stringify(info, null, 2));
        } else if (opts.mode === 'doctor') {
            runDoctor(opts);
        } else if (opts.mode === 'install-hub') {
            const res = installConfigHubPlugin();
            if (!res.installed) throw new Error(res.reason);
            console.log(`[OK] 已安装/更新原生右侧栏「配置总览 (Config Hub)」插件：${res.targetDir}`);
            console.log('     请重启 Antigravity 后在右侧边栏插件列表打开「配置总览」。');
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
