#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const CSS_PATH = path.join(SCRIPT_DIR, 'codex_theme.css');
const CN_REPO_URL = 'https://github.com/Silas-02/antigravity-desktop-cn.git';
const CN_CACHE_DIR = path.join(SCRIPT_DIR, '.cache', 'antigravity-desktop-cn');
const CN_SIBLING_DIR = path.join(SCRIPT_DIR, '..', 'antigravity-desktop-cn-main');

const SIG_START = '/* __ANTIGRAVITY_CODEX_THEME_START__ */';
const SIG_END = '/* __ANTIGRAVITY_CODEX_THEME_END__ */';

function parseArgs(argv) {
    const opts = {
        mode: 'install', // install | uninstall | check
        withCn: false,
        noKill: false,
        brandTitle: 'english',
        asarPath: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--uninstall' || a === '--restore') opts.mode = 'uninstall';
        else if (a === '--check' || a === '--status') opts.mode = 'check';
        else if (a === '--with-cn') opts.withCn = true;
        else if (a === '--no-kill') opts.noKill = true;
        else if (a === '--brand-title' && argv[i + 1]) opts.brandTitle = argv[++i];
        else if (a === '--asar' && argv[i + 1]) opts.asarPath = argv[++i];
    }
    return opts;
}

function detectAsarPath(customPath) {
    if (customPath) return path.resolve(customPath);
    const plat = process.platform;
    if (plat === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar');
    }
    if (plat === 'darwin') {
        return '/Applications/Antigravity.app/Contents/Resources/app.asar';
    }
    const linuxCandidates = [
        '/opt/Antigravity/resources/app.asar',
        path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app.asar'),
        '/usr/lib/antigravity/resources/app.asar',
    ];
    for (const c of linuxCandidates) {
        if (fs.existsSync(c)) return c;
    }
    return linuxCandidates[0];
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

    // Validate temp ASAR before replacing target
    const testPreload = readAsarFile(tmpOut, 'dist/preload.js');
    if (!testPreload) {
        fs.unlinkSync(tmpOut);
        throw new Error('校验失败：生成的临时 ASAR 缺少 dist/preload.js');
    }
    new vm.Script(testPreload.toString('utf8'));

    fs.copyFileSync(tmpOut, targetAsar);
    fs.unlinkSync(tmpOut);
    return {
        unpackedCount,
        packedCount: packedFiles.length,
        finalSize: fs.statSync(targetAsar).size,
    };
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
    return `\n${SIG_START}\n(() => {\n    const themeCss = \`${escapedCss}\`;\n    function injectCodexTheme() {\n        if (document.getElementById('antigravity-codex-theme-patch')) return;\n        const style = document.createElement('style');\n        style.id = 'antigravity-codex-theme-patch';\n        style.textContent = themeCss;\n        (document.head || document.documentElement).appendChild(style);\n    }\n    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', injectCodexTheme);\n    } else {\n        injectCodexTheme();\n    }\n    window.addEventListener('load', injectCodexTheme);\n})();\n${SIG_END}\n`;
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

function syncAndRunCnLocalization(opts) {
    console.log('[联动汉化] 正在同步最新 Silas-02/antigravity-desktop-cn 汉化仓库...');
    let cnDir = null;

    if (fs.existsSync(path.join(CN_CACHE_DIR, '.git'))) {
        const pull = spawnSync('git', ['-C', CN_CACHE_DIR, 'pull', '--ff-only'], { stdio: 'inherit' });
        if (pull.status === 0) {
            cnDir = CN_CACHE_DIR;
        } else {
            console.warn('[警告] git pull 失败，继续使用本地缓存的汉化仓库。');
            cnDir = CN_CACHE_DIR;
        }
    } else {
        fs.mkdirSync(path.dirname(CN_CACHE_DIR), { recursive: true });
        const clone = spawnSync('git', ['clone', '--depth', '1', CN_REPO_URL, CN_CACHE_DIR], { stdio: 'inherit' });
        if (clone.status === 0) {
            cnDir = CN_CACHE_DIR;
        } else if (fs.existsSync(path.join(CN_SIBLING_DIR, 'localization_engine.js'))) {
            console.warn(`[警告] 在线拉取失败，回退使用本地汉化目录: ${CN_SIBLING_DIR}`);
            cnDir = CN_SIBLING_DIR;
        } else {
            throw new Error('无法拉取 Silas-02/antigravity-desktop-cn，请检查网络或 git 环境。');
        }
    }

    const enginePath = path.join(cnDir, 'localization_engine.js');
    if (!fs.existsSync(enginePath)) {
        throw new Error(`汉化仓库缺少入口脚本: ${enginePath}`);
    }

    const args = [enginePath, '--brand-title', opts.brandTitle];
    if (opts.noKill) args.push('--no-kill');

    console.log('[联动汉化] 正在执行中文汉化注入...');
    const res = spawnSync(process.execPath, args, { cwd: cnDir, stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error(`中文汉化脚本退出异常（exit code ${res.status}）`);
    }
    console.log('[联动汉化] 中文汉化完成，准备叠加注入 Codex v4.0 主题...\n');
}

function runInstall(opts) {
    const asarPath = detectAsarPath(opts.asarPath);
    if (!fs.existsSync(asarPath)) {
        throw new Error(`未找到 Antigravity 核心文件: ${asarPath}`);
    }
    if (!fs.existsSync(CSS_PATH)) {
        throw new Error(`未找到主题样式表: ${CSS_PATH}`);
    }

    if (opts.withCn) {
        syncAndRunCnLocalization(opts);
    }

    const backupPath = `${asarPath}.before_codex_patch.bak`;
    console.log('[1/3] 检查并维护安全备份...');
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(asarPath, backupPath);
        console.log(`      已创建备份: ${backupPath}`);
    } else if (opts.withCn) {
        // Refresh pre-theme backup after fresh CN localization so uninstall restores cleanly
        fs.copyFileSync(asarPath, backupPath);
        console.log(`      已更新汉化后备份: ${backupPath}`);
    } else {
        console.log('      已有备份文件存在，跳过覆盖。');
    }

    console.log('[2/3] 正在原地无损注入 Codex v4.0 主题（保留全部 unpacked 原生依赖）...');
    const preloadBuf = readAsarFile(asarPath, 'dist/preload.js');
    if (!preloadBuf) {
        throw new Error('无法从 app.asar 读取 dist/preload.js');
    }
    const cleanPreload = stripCodexTheme(preloadBuf.toString('utf8'));
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const newPreload = cleanPreload + buildInjection(css);

    // Pre-write JS syntax check
    new vm.Script(newPreload);

    const stats = patchAsarInPlace(asarPath, asarPath, { 'dist/preload.js': newPreload });

    console.log('[3/3] 正在执行最终封包校验...');
    const info = inspectAsar(asarPath);
    if (!info.syntaxValid || !info.hasCodexTheme) {
        throw new Error('最终校验未通过，请检查 app.asar 状态。');
    }

    console.log('\n=======================================================');
    console.log('  [√] 成功！Codex 视觉与排版主题已无损部署到 Antigravity');
    console.log(`      版本: v${info.version} | 体积: ${(stats.finalSize / 1024 / 1024).toFixed(2)} MB | 原生依赖保留: ${stats.unpackedCount} 项`);
    console.log(`      中文汉化: ${info.hasCN ? '已启用' : '未启用'} | Codex 主题: 已启用 | 语法校验: 通过`);
    console.log('  请完全退出系统托盘并重启 Antigravity 生效。');
    console.log('=======================================================');
}

function runUninstall(opts) {
    const asarPath = detectAsarPath(opts.asarPath);
    if (!fs.existsSync(asarPath)) {
        throw new Error(`未找到 Antigravity 核心文件: ${asarPath}`);
    }
    const backupPath = `${asarPath}.before_codex_patch.bak`;
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, asarPath);
        console.log(`[√] 已从备份无损恢复: ${backupPath}`);
        console.log('请完全退出并重启 Antigravity。');
        return;
    }

    // Fallback: strip Codex theme in-place without disturbing CN localization or unpacked files
    const preloadBuf = readAsarFile(asarPath, 'dist/preload.js');
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
    patchAsarInPlace(asarPath, asarPath, { 'dist/preload.js': stripped });
    console.log('[√] 已原地无损移除 Codex 主题补丁。请重启 Antigravity。');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    try {
        if (opts.mode === 'check') {
            const info = inspectAsar(detectAsarPath(opts.asarPath));
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
