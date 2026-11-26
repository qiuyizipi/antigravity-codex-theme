import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const telemetry = require('../codex_telemetry_rail.js');

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const LIVE_ASAR = 'C:\\Users\\刘辉\\AppData\\Local\\Programs\\Antigravity\\resources\\app.asar';

test('formatCompactNum formats large and small token counts cleanly', () => {
    assert.equal(telemetry.formatCompactNum(null), '—');
    assert.equal(telemetry.formatCompactNum(950), '950');
    assert.equal(telemetry.formatCompactNum(84230), '84.2k');
    assert.equal(telemetry.formatCompactNum(1_250_000), '1.25M');
});

test('formatResetCountdown supports ISO timestamps and protobuf Duration objects', () => {
    const now = Date.parse('2026-11-25T08:00:00Z');
    assert.equal(telemetry.formatResetCountdown(null, now), '—');
    assert.equal(telemetry.formatResetCountdown('2026-11-25T08:00:30Z', now), '即将刷新');
    assert.equal(telemetry.formatResetCountdown('2026-11-25T08:45:00Z', now), '45分钟后');
    assert.equal(telemetry.formatResetCountdown('2026-11-25T11:20:00Z', now), '3小时20分后');
    const twoDaysSec = Math.floor(Date.parse('2026-11-27T12:00:00Z') / 1000);
    assert.equal(telemetry.formatResetCountdown({ seconds: twoDaysSec, nanos: 0 }, now), '2天4小时后');
});

test('normalizeQuotaSnapshot deduplicates model variants, matches active model, and parses credits', () => {
    const userStatusRes = {
        userStatus: {
            planStatus: {
                planInfo: { planName: 'Google AI Pro' },
                usedPromptCredits: 120,
                availablePromptCredits: 880,
                usedFlexCredits: 50,
                availableFlexCredits: 450,
            },
            cascadeModelConfigData: {
                clientModelConfigs: [
                    {
                        label: 'Gemini 4 Neon (High)',
                        modelId: 'MODEL_GEMINI_4_NEON_HIGH',
                        quotaInfo: { remainingFraction: 0.78, resetTime: '2026-11-25T12:00:00Z' },
                    },
                    {
                        label: 'Gemini 4 Neon (XHigh)',
                        modelId: 'MODEL_GEMINI_4_NEON_XHIGH',
                        quotaInfo: { remainingFraction: 0.78, resetTime: '2026-11-25T12:00:00Z' },
                    },
                    {
                        label: 'Gemini 4 Hydrogen',
                        modelId: 'MODEL_GEMINI_4_HYDROGEN',
                        quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-25T10:00:00Z' },
                    },
                ],
            },
        },
    };
    const quotaSummaryRes = {
        summary: {
            groups: [
                {
                    displayName: 'Gemini 4',
                    buckets: [
                        {
                            description: 'Gemini 4 Neon',
                            refreshWindowLabel: '5小时窗',
                            remainingFraction: 0.78,
                            resetTime: '2026-11-25T12:00:00Z',
                        },
                        {
                            description: 'Claude / 第三方池',
                            refreshWindowLabel: '每周限额',
                            remainingFraction: 0.4,
                            resetTime: '2026-11-28T00:00:00Z',
                        },
                    ],
                },
            ],
        },
    };

    const snap = telemetry.normalizeQuotaSnapshot(userStatusRes, quotaSummaryRes, 'Gemini 4 Neon (High)');
    assert.equal(snap.ok, true);
    assert.equal(snap.planName, 'Google AI Pro');
    assert.equal(snap.activeQuota.label, 'Gemini 4 Neon');
    assert.equal(snap.activeQuota.remainingPct, 78);
    assert.equal(snap.activeQuota.usedPct, 22);
    // Legacy Windsurf Prompt/Flow fields are ignored; only positive AI Flex credits remain
    assert.equal(snap.credits.length, 1);
    assert.equal(snap.credits[0].available, 450);
    // Official summary buckets take strict priority: should NOT append Gemini 4 Hydrogen as extra model bucket
    assert.equal(snap.buckets.length, 2);
    assert.ok(snap.buckets.some((b) => b.label === 'Claude / 第三方池' && b.usedPct === 60));
});

test('normalizeQuotaSnapshot merges shared model pools and drops 0/0 legacy credits when summary is empty', () => {
    const userStatusRes = {
        userStatus: {
            planStatus: {
                planInfo: { planName: 'Google AI Pro' },
                usedPromptCredits: 0,
                availablePromptCredits: 0,
                usedFlexCredits: 20,
                availableFlexCredits: 480,
            },
            cascadeModelConfigData: {
                clientModelConfigs: [
                    { label: 'Gemini 4 Neon (High)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T15:00:00Z' } },
                    { label: 'Gemini 4 Neon (XHigh)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T15:00:00Z' } },
                    { label: 'Gemini 4 Carbon (High)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T15:00:12Z' } },
                    { label: 'Gemini 4 Hydrogen (High)', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T15:00:05Z' } },
                    { label: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-25T18:00:00Z' } },
                    { label: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-27T00:00:00Z' } },
                    { label: 'Claude Opus 4.6', quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-27T00:00:10Z' } },
                ],
            },
        },
    };

    const snap = telemetry.normalizeQuotaSnapshot(userStatusRes, {}, 'Gemini 4 Hydrogen (High)');
    assert.equal(snap.ok, true);
    assert.equal(snap.buckets.length, 3);
    assert.deepEqual(snap.buckets.map((b) => b.label), ['Gemini 4 共享池', 'Gemini 4 Argon', 'Claude 共享池']);
    assert.equal(snap.activeQuota.label, 'Gemini 4 共享池');
    assert.equal(snap.activeQuota.remainingPct, 80);
    assert.deepEqual(snap.activeQuota.members, ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Hydrogen']);
    // 0/0 Prompt credits filtered out, only non-zero Flex credits retained
    assert.equal(snap.credits.length, 1);
    assert.equal(snap.credits[0].available, 480);
});

test('normalizeQuotaSnapshot handles proto3 omitted 0%, distinct sub-pools, and 2s reset jitter', () => {
    // 1) Proto3 omitted remainingFraction=0 when resetTime exists -> exhausted (0% remaining / 100% used)
    const exhaustedSnap = telemetry.normalizeQuotaSnapshot({
        userStatus: {
            cascadeModelConfigData: {
                clientModelConfigs: [
                    { label: 'Gemini 4 Neon', quotaInfo: { resetTime: '2026-11-25T12:00:00Z' } },
                ],
            },
        },
    }, {}, 'Gemini 4 Neon');
    assert.equal(exhaustedSnap.activeQuota.remainingPct, 0);
    assert.equal(exhaustedSnap.activeQuota.usedPct, 100);

    const exhaustedSummary = telemetry.normalizeQuotaSnapshot({}, {
        summary: {
            groups: [
                {
                    displayName: 'Gemini 4',
                    buckets: [{ displayName: 'Gemini 4', resetTime: '2026-11-25T12:00:00Z' }],
                },
            ],
        },
    }, 'Gemini 4 Neon');
    assert.equal(exhaustedSummary.activeQuota.remainingPct, 0);
    assert.equal(exhaustedSummary.activeQuota.usedPct, 100);

    // 2) Two distinct Gemini sub-pools (Gemini 4 vs Gemini 3) must both be kept
    const multiPoolSnap = telemetry.normalizeQuotaSnapshot({
        userStatus: {
            cascadeModelConfigData: {
                clientModelConfigs: [
                    { label: 'Gemini 4 Neon', quotaInfo: { remainingFraction: 0.7, resetTime: '2026-11-25T12:00:00Z' } },
                    { label: 'Gemini 4 Carbon', quotaInfo: { remainingFraction: 0.7, resetTime: '2026-11-25T12:00:00Z' } },
                    { label: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-25T15:00:00Z' } },
                    { label: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-25T15:00:00Z' } },
                ],
            },
        },
    }, {}, 'Gemini 4 Neon');
    assert.equal(multiPoolSnap.buckets.length, 2);
    assert.deepEqual(multiPoolSnap.buckets.map((b) => b.label), ['Gemini 4 共享池', 'Gemini 3 共享池']);

    // 3) 2-second jitter across :30 boundary still merges into one pool
    const jitterSnap = telemetry.normalizeQuotaSnapshot({
        userStatus: {
            cascadeModelConfigData: {
                clientModelConfigs: [
                    { label: 'Gemini 4 Neon', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T12:00:29Z' } },
                    { label: 'Gemini 4 Hydrogen', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-25T12:00:31Z' } },
                ],
            },
        },
    }, {}, 'Gemini 4 Neon');
    assert.equal(jitterSnap.buckets.length, 1);
    assert.equal(jitterSnap.buckets[0].label, 'Gemini 4 共享池');
});

test('normalizeQuotaSnapshot handles empty or disabled payloads gracefully', () => {
    const snap = telemetry.normalizeQuotaSnapshot({}, {}, '');
    assert.equal(snap.ok, true);
    assert.equal(snap.activeQuota, null);
    assert.deepEqual(snap.buckets, []);
    assert.deepEqual(snap.credits, []);
});

test('generated main & preload telemetry scripts pass vm.Script syntax validation', () => {
    const mainNoWatch = telemetry.buildMainTelemetryInjection(null);
    const mainWatch = telemetry.buildMainTelemetryInjection('D:\\APP\\test\\codex_theme.css');
    const preloadScript = telemetry.buildPreloadTelemetryInjection();

    assert.doesNotThrow(() => new vm.Script(mainNoWatch));
    assert.doesNotThrow(() => new vm.Script(mainWatch));
    assert.doesNotThrow(() => new vm.Script(preloadScript));
    assert.ok(!mainNoWatch.includes('codex:read-hot-css'));
    assert.ok(mainWatch.includes('codex:read-hot-css'));
    assert.ok(mainNoWatch.includes('codex:quota-snapshot'));
    assert.ok(mainNoWatch.includes('codex:metrics-fallback'));
    assert.ok(preloadScript.includes('codex-telemetry-rail-host'));
    assert.ok(preloadScript.includes('codex.telemetryRail.pos'));
    assert.ok(preloadScript.includes('setPointerCapture'));
    assert.ok(preloadScript.includes('btn-reset-pos'));
    assert.ok(preloadScript.includes('ctx-ring-arc'));
    assert.ok(preloadScript.includes('docListenersBound'));
    assert.ok(preloadScript.includes('quota-active-windows'));
    assert.ok(preloadScript.includes('查看其他配额'));
    assert.ok(preloadScript.includes('visibilitychange'));
    assert.ok(preloadScript.includes('lastRequestCount'));
    assert.ok(preloadScript.includes('刚刚更新'));
    assert.ok(mainNoWatch.includes('forceRefresh: true'));
    assert.ok(mainNoWatch.includes('10000'));
});

test('normalizeQuotaSnapshot unwraps RetrieveUserQuotaSummary.response with both 5h and weekly windows', () => {
    const rpcWrapped = {
        response: {
            groups: [
                {
                    displayName: 'Gemini 4',
                    buckets: [
                        {
                            bucketId: 'g4_weekly',
                            displayName: 'Weekly limit',
                            refreshWindowLabel: 'Weekly',
                            remainingFraction: 0.62,
                            resetTime: '2026-11-30T00:00:00Z',
                        },
                        {
                            bucketId: 'g4_5h',
                            displayName: '5-hour limit',
                            refreshWindowLabel: '5 hours',
                            remainingFraction: 0.9,
                            resetTime: '2026-11-25T16:00:00Z',
                        },
                    ],
                },
                {
                    displayName: 'Claude',
                    buckets: [
                        {
                            bucketId: 'claude_5h',
                            refreshWindowLabel: '5-hour',
                            remainingFraction: 1,
                            resetTime: '2026-11-25T16:00:00Z',
                        },
                        {
                            bucketId: 'claude_weekly',
                            refreshWindowLabel: '7d',
                            remainingFraction: 0.85,
                            resetTime: '2026-11-30T00:00:00Z',
                        },
                    ],
                },
            ],
        },
    };
    const snap = telemetry.normalizeQuotaSnapshot({}, rpcWrapped, 'Gemini 4 Neon');
    assert.equal(snap.ok, true);
    assert.equal(snap.activeQuota.label, 'Gemini 4');
    assert.equal(snap.activeWindows.length, 2);
    assert.deepEqual(snap.activeWindows.map((w) => w.windowLabel), ['5小时', '周额度']);
    assert.equal(snap.activeWindows[0].remainingPct, 90);
    assert.equal(snap.activeWindows[1].remainingPct, 62);
    assert.equal(snap.buckets.length, 4);

    // Flat response.buckets[] with window suffixes in displayName
    const flatResp = {
        response: {
            buckets: [
                { displayName: 'Gemini Weekly limit', remainingFraction: 0.55, resetTime: '2026-11-30T00:00:00Z' },
                { displayName: 'Gemini 5-hour limit', remainingFraction: 0.95, resetTime: '2026-11-25T16:00:00Z' },
            ],
        },
    };
    const flatSnap = telemetry.normalizeQuotaSnapshot({}, flatResp, 'Gemini 4 Neon');
    assert.equal(flatSnap.activeQuota.label, 'Gemini');
    assert.deepEqual(flatSnap.activeWindows.map((w) => w.windowLabel), ['5小时', '周额度']);
});

test('normalizeQuotaSnapshot normalizes "Five Hour/Weekly Limit Remaining" buckets, drops legacy Prompt/Flow credits, and orders 5h before weekly', () => {
    const userStatusRes = {
        userStatus: {
            planStatus: {
                planInfo: { planName: 'Google AI Ultra' },
                usedPromptCredits: 10,
                availablePromptCredits: 990,
                usedFlowCredits: 0,
                availableFlowCredits: 100,
                usedFlexCredits: 0,
                availableFlexCredits: 0,
            },
        },
    };
    const quotaSummaryRes = {
        response: {
            groups: [
                {
                    displayName: 'Gemini',
                    buckets: [
                        {
                            bucketId: 'gemini_weekly',
                            displayName: 'Weekly Limit Remaining',
                            remainingFraction: 0.92,
                            resetTime: '2026-11-30T00:00:00Z',
                        },
                        {
                            bucketId: 'gemini_5h',
                            displayName: 'Five Hour Limit Remaining',
                            remainingFraction: 1,
                            resetTime: '2026-11-26T20:00:00Z',
                        },
                    ],
                },
                {
                    displayName: 'Claude',
                    buckets: [
                        {
                            bucketId: 'claude_weekly',
                            displayName: 'Weekly Limit Remaining',
                            remainingFraction: 1,
                            resetTime: '2026-11-30T00:00:00Z',
                        },
                        {
                            bucketId: 'claude_5h',
                            displayName: 'Five Hour Limit Remaining',
                            remainingFraction: 1,
                            resetTime: '2026-11-26T20:00:00Z',
                        },
                    ],
                },
            ],
        },
    };

    const snap = telemetry.normalizeQuotaSnapshot(userStatusRes, quotaSummaryRes, 'Gemini 3.1 Pro');
    assert.equal(snap.ok, true);
    assert.deepEqual(snap.credits, []);
    assert.equal(snap.activeQuota.label, 'Gemini');
    assert.deepEqual(snap.activeWindows.map((w) => [w.label, w.windowLabel]), [
        ['Gemini', '5小时'],
        ['Gemini', '周额度'],
    ]);
    assert.deepEqual(snap.buckets.map((b) => [b.label, b.windowLabel]), [
        ['Gemini', '5小时'],
        ['Gemini', '周额度'],
        ['Claude', '5小时'],
        ['Claude', '周额度'],
    ]);
});

test('non-destructive temp ASAR patch and strip round-trip preserves syntax and unpacked count', { skip: !fs.existsSync(LIVE_ASAR) }, () => {
    const patchSource = fs.readFileSync(path.join(ROOT_DIR, 'patch_theme.js'), 'utf8');
    // Extract pure ASAR helpers by requiring/evaluating non-CLI path in temp script is overkill; inspect patch_theme.js syntax + verify CSS
    assert.doesNotThrow(() => new vm.Script(patchSource));

    // Read current app.asar header & test patching dist/main.js and dist/preload.js on a temp copy
    const tmpAsar = path.join(os.tmpdir(), `codex_test_${process.pid}_${Date.now()}.asar`);
    fs.copyFileSync(LIVE_ASAR, tmpAsar);
    try {
        // Use patchAsarInPlace logic dynamically via vm? Better: require after patching patch_theme exports or run node helper
        const { readAsarHeader, readAsarFile, patchAsarInPlace, buildInjection, buildMainHotCssInjection, stripCodexTheme, stripMainHotCss, inspectAsar } = require('../patch_theme.js');
        if (typeof patchAsarInPlace === 'function') {
            const css = fs.readFileSync(path.join(ROOT_DIR, 'codex_theme.css'), 'utf8');
            const origPreload = stripCodexTheme(readAsarFile(tmpAsar, 'dist/preload.js').toString('utf8'));
            const origMain = stripMainHotCss(readAsarFile(tmpAsar, 'dist/main.js').toString('utf8'));

            const nextPreload = origPreload + buildInjection(css, null);
            const nextMain = origMain + buildMainHotCssInjection(null);
            new vm.Script(nextPreload);
            new vm.Script(nextMain);

            const beforeInfo = inspectAsar(tmpAsar);
            patchAsarInPlace(tmpAsar, tmpAsar, {
                'dist/preload.js': nextPreload,
                'dist/main.js': nextMain,
            });
            const afterInfo = inspectAsar(tmpAsar);
            assert.equal(afterInfo.syntaxValid, true);
            assert.equal(afterInfo.hasCodexTheme, true);
            assert.equal(afterInfo.hasTelemetryRail, true);
            assert.equal(afterInfo.unpackedCount, beforeInfo.unpackedCount);

            // Strip round-trip
            const strippedPreload = stripCodexTheme(readAsarFile(tmpAsar, 'dist/preload.js').toString('utf8'));
            const strippedMain = stripMainHotCss(readAsarFile(tmpAsar, 'dist/main.js').toString('utf8'));
            patchAsarInPlace(tmpAsar, tmpAsar, {
                'dist/preload.js': strippedPreload,
                'dist/main.js': strippedMain,
            });
            const cleanInfo = inspectAsar(tmpAsar);
            assert.equal(cleanInfo.syntaxValid, true);
            assert.equal(cleanInfo.hasCodexTheme, false);
            assert.equal(cleanInfo.hasTelemetryRail, false);
        }
    } finally {
        if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar);
    }
});
