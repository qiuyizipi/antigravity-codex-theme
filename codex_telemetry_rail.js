'use strict';

/**
 * Codex 右侧常驻监测面板与主进程只读遥测桥接模块（零外部依赖）。
 * - 复用 antigravity-desktop-cn 的 `ag-ctx:metrics`（若未安装则走 `codex:metrics-fallback`）
 * - 新增 `codex:quota-snapshot`：直连本地 Language Server 查询 GetUserStatus / RetrieveUserQuotaSummary
 * - 渲染器注入右侧留白常驻卡（宽屏停靠，窄屏/打开侧栏自动避让收起为紧凑胶囊）
 */

const SIG_MAIN_START = '/* __ANTIGRAVITY_CODEX_HOT_CSS_START__ */';
const SIG_MAIN_END = '/* __ANTIGRAVITY_CODEX_HOT_CSS_END__ */';

function formatCompactNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
}

function formatResetCountdown(resetTime, nowMs = Date.now()) {
    if (resetTime === null || resetTime === undefined || resetTime === '') return '—';
    let targetMs = null;
    if (typeof resetTime === 'number') {
        if (!Number.isFinite(resetTime) || resetTime <= 0) return '—';
        targetMs = resetTime > 1e12 ? resetTime : resetTime * 1000;
    } else if (typeof resetTime === 'string') {
        const t = Date.parse(resetTime.trim());
        if (!Number.isFinite(t)) return '—';
        targetMs = t;
    } else if (typeof resetTime === 'object') {
        const secs = Number(resetTime.seconds ?? 0);
        const nanos = Number(resetTime.nanos ?? 0);
        if (!Number.isFinite(secs) || secs <= 0) return '—';
        targetMs = secs * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
    }
    if (targetMs === null || !Number.isFinite(targetMs)) return '—';

    const diffMs = targetMs - nowMs;
    if (diffMs <= 60 * 1000) return '即将刷新';

    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / (24 * 60));
    const hours = Math.floor((totalMin % (24 * 60)) / 60);
    const mins = totalMin % 60;

    if (days > 0) return hours > 0 ? `${days}天${hours}小时后` : `${days}天后`;
    if (hours > 0) return mins > 0 ? `${hours}小时${mins}分后` : `${hours}小时后`;
    return `${mins}分钟后`;
}

function normalizeQuotaSnapshot(userStatusRes, quotaSummaryRes, currentModelLabel) {
    const cleanText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
    const toFinite = (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        }
        return null;
    };
    const clampFrac = (v) => {
        const n = toFinite(v);
        if (n === null) return null;
        return Math.max(0, Math.min(1, n));
    };
    const toPctPair = (frac) => {
        if (frac === null) return { remainingPct: null, usedPct: null };
        const remainingPct = Math.round(frac * 100);
        return { remainingPct, usedPct: 100 - remainingPct };
    };
    const stripEffortSuffix = (label) => {
        return cleanText(label)
            .replace(/\s*\((?:low|medium|high|xhigh|thinking)\)\s*$/i, '')
            .replace(/\s+(?:low|medium|high|xhigh|thinking)$/i, '')
            .trim();
    };
    const toResetMs = (rt) => {
        if (rt === null || rt === undefined || rt === '') return null;
        let ms = null;
        if (typeof rt === 'number') {
            if (Number.isFinite(rt) && rt > 0) ms = rt > 1e12 ? rt : rt * 1000;
        } else if (typeof rt === 'string') {
            const parsed = Date.parse(rt.trim());
            if (Number.isFinite(parsed)) ms = parsed;
        } else if (typeof rt === 'object') {
            const secs = Number(rt.seconds ?? 0);
            const nanos = Number(rt.nanos ?? 0);
            if (Number.isFinite(secs) && secs > 0) {
                ms = secs * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1e6) : 0);
            }
        }
        return ms !== null && Number.isFinite(ms) ? ms : null;
    };
    const readQuotaFraction = (obj, checkAmount) => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.remainingFraction !== undefined && obj.remainingFraction !== null && obj.remainingFraction !== '') {
            return clampFrac(obj.remainingFraction);
        }
        // Proto3 JSON 默认省略数值为 0 的字段；若存在 resetTime 且未单列剩余数量，说明该池已用尽 (0%)
        if (obj.resetTime && (!checkAmount || obj.remainingAmount === undefined || obj.remainingAmount === null || obj.remainingAmount === '')) {
            return 0;
        }
        return null;
    };
    const detectProviderBucket = (label) => {
        if (/\bargon\b/i.test(label)) return 'Argon';
        if (/\bgemini\b/i.test(label)) return 'Gemini';
        if (/\bclaude\b/i.test(label)) return 'Claude';
        if (/\b(?:gpt|openai|o1|o3|o4)\b/i.test(label)) return 'GPT';
        return '其他';
    };
    const normalizeWindowLabel = (rawWin, rawName, rawDesc, rawBucketId) => {
        const joined = [rawWin, rawName, rawDesc, rawBucketId].map(cleanText).filter(Boolean).join(' ');
        if (/(?:5\s*-?\s*h(?:our)?s?\b|five[\s_-]*hour|5小时)/i.test(joined)) return '5小时';
        if (/(?:\b7\s*-?\s*d(?:ays?)?\b|\b1\s*-?\s*w(?:eek)?\b|\bweek(?:ly)?\b|周额度|每周)/i.test(joined)) return '周额度';
        if (/(?:\b24\s*-?\s*h(?:ours?)?\b|\bdaily\b|日额度|每日)/i.test(joined)) return '日额度';
        if (/(?:\b30\s*-?\s*d(?:ays?)?\b|\bmonth(?:ly)?\b|月额度|每月)/i.test(joined)) return '月额度';
        return cleanText(rawWin) || null;
    };
    const isWindowOnlyName = (name) => {
        const t = cleanText(name);
        if (!t) return true;
        return /^(?:5\s*-?\s*h(?:our)?s?(?:\s+limit|\s+quota|\s+window)?|five[\s_-]*hour(?:\s+limit)?|\b7\s*-?\s*d(?:ays?)?|1\s*-?\s*w(?:eek)?|week(?:ly)?(?:\s+limit|\s+quota|\s+window)?|daily(?:\s+limit)?|monthly(?:\s+limit)?|5小时(?:额度|配额|限制|窗口)?|周额度|每周(?:额度|配额|限制)?|日额度|月额度)$/i.test(t);
    };
    const stripWindowSuffix = (name) => {
        return cleanText(name)
            .replace(/\s*[·|\-–—(（\[]*\s*(?:5\s*-?\s*h(?:our)?s?(?:\s+limit|\s+quota|\s+window)?|five[\s_-]*hour(?:\s+limit)?|week(?:ly)?(?:\s+limit|\s+quota|\s+window)?|7\s*-?\s*d(?:ays?)?|1\s*-?\s*w(?:eek)?|daily(?:\s+limit)?|monthly(?:\s+limit)?|5小时(?:额度|配额|限制|窗口)?|周额度|每周(?:额度|配额|限制)?|日额度|月额度)\s*[)）\]]*\s*$/i, '')
            .trim();
    };
    const windowRank = (winLabel) => {
        if (winLabel === '5小时') return 1;
        if (winLabel === '日额度') return 2;
        if (winLabel === '周额度') return 3;
        if (winLabel === '月额度') return 4;
        return 5;
    };

    const us = (userStatusRes && userStatusRes.userStatus && typeof userStatusRes.userStatus === 'object')
        ? userStatusRes.userStatus
        : (userStatusRes && typeof userStatusRes === 'object' ? userStatusRes : {});

    // 真实客户端 RPC 包装在 .response 下，兼容 .summary 与顶层直接返回
    const qs = (quotaSummaryRes && quotaSummaryRes.response && typeof quotaSummaryRes.response === 'object')
        ? quotaSummaryRes.response
        : ((quotaSummaryRes && quotaSummaryRes.summary && typeof quotaSummaryRes.summary === 'object')
            ? quotaSummaryRes.summary
            : (quotaSummaryRes && typeof quotaSummaryRes === 'object' ? quotaSummaryRes : {}));

    const planStatus = (us.planStatus && typeof us.planStatus === 'object') ? us.planStatus : null;
    const planName = cleanText(
        (planStatus && planStatus.planInfo && planStatus.planInfo.planName)
        || (us.userTier && us.userTier.name)
        || ''
    ) || null;

    // 1. 解析套餐点数 / AI Credits（过滤全 0 历史空字段）
    const credits = [];
    if (planStatus) {
        const creditSpecs = [
            ['Prompt 额度', planStatus.usedPromptCredits, planStatus.availablePromptCredits],
            ['Flow 额度', planStatus.usedFlowCredits, planStatus.availableFlowCredits],
            ['弹性额度 (AI Credits)', planStatus.usedFlexCredits, planStatus.availableFlexCredits],
        ];
        for (const [label, rawUsed, rawAvail] of creditSpecs) {
            const used = toFinite(rawUsed);
            const available = toFinite(rawAvail);
            if (!((used !== null && used > 0) || (available !== null && available > 0))) continue;
            const total = used !== null && available !== null ? used + available : null;
            credits.push({
                label,
                used,
                available,
                total,
            });
        }
    }

    // 2. 解析模型列表里的单模型配额
    const configs = (us.cascadeModelConfigData && Array.isArray(us.cascadeModelConfigData.clientModelConfigs))
        ? us.cascadeModelConfigData.clientModelConfigs
        : (Array.isArray(us.clientModelConfigs) ? us.clientModelConfigs : []);

    const rawModels = [];
    for (const cfg of configs) {
        if (!cfg || typeof cfg !== 'object') continue;
        const label = cleanText(cfg.label);
        if (!label) continue;
        const qi = (cfg.quotaInfo && typeof cfg.quotaInfo === 'object') ? cfg.quotaInfo : null;
        const frac = readQuotaFraction(qi, false);
        const resetTime = qi ? (qi.resetTime ?? null) : null;
        const { remainingPct, usedPct } = toPctPair(frac);
        const refs = [
            label,
            cleanText(cfg.modelId),
            cleanText(cfg.modelOrAlias && cfg.modelOrAlias.model),
            cleanText(cfg.modelOrAlias && cfg.modelOrAlias.alias),
        ].filter(Boolean);
        rawModels.push({
            label,
            family: stripEffortSuffix(label) || label,
            refs,
            remainingFraction: frac,
            remainingPct,
            usedPct,
            resetTime,
            disabled: Boolean(cfg.disabled),
        });
    }

    // 3. 解析 QuotaSummary 官方分组/配额池（有官方桶时严格只展示桶，不再叠加单模型列表）
    const buckets = [];
    const seenBucketKeys = new Set();
    const pushBucket = (item) => {
        if (!item || !item.label) return;
        const key = item.bucketId
            ? `id:${item.bucketId}`
            : `${item.label.toLowerCase()}|${item.windowLabel || ''}`;
        if (seenBucketKeys.has(key)) return;
        seenBucketKeys.add(key);
        buckets.push(item);
    };

    const nowMs = Date.now();
    const groups = Array.isArray(qs.groups) ? qs.groups : [];
    for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const groupName = cleanText(g.displayName || g.description);
        const subBuckets = Array.isArray(g.buckets) ? g.buckets : [];
        if (subBuckets.length > 0) {
            const parsedGroupBuckets = [];
            for (const b of subBuckets) {
                if (!b || typeof b !== 'object') continue;
                const frac = readQuotaFraction(b, true);
                const { remainingPct, usedPct } = toPctPair(frac);
                const rawBName = cleanText(b.displayName || b.description);
                let winLabel = normalizeWindowLabel(b.refreshWindowLabel || b.window, b.displayName, b.description, b.bucketId);
                const strippedBName = stripWindowSuffix(rawBName);
                const label = (groupName && (!rawBName || isWindowOnlyName(rawBName)))
                    ? groupName
                    : (strippedBName || rawBName || groupName || '模型配额池');
                parsedGroupBuckets.push({
                    label,
                    groupKey: (groupName || label).toLowerCase(),
                    bucketId: cleanText(b.bucketId) || null,
                    groupName: groupName || null,
                    windowLabel: winLabel || null,
                    remainingFraction: frac,
                    remainingPct,
                    usedPct,
                    remainingAmount: toFinite(b.remainingAmount),
                    resetTime: b.resetTime ?? null,
                    disabled: Boolean(b.disabled),
                    members: null,
                    refs: [],
                    source: 'summary',
                });
            }
            if (parsedGroupBuckets.length >= 2) {
                for (const item of parsedGroupBuckets) {
                    if (item.windowLabel) continue;
                    const rMs = toResetMs(item.resetTime);
                    if (rMs !== null) {
                        item.windowLabel = (rMs - nowMs) > 18 * 3600 * 1000 ? '周额度' : '5小时';
                    }
                }
            }
            for (const item of parsedGroupBuckets) pushBucket(item);
        } else if (groupName) {
            const frac = readQuotaFraction(g, true);
            const { remainingPct, usedPct } = toPctPair(frac);
            const winLabel = normalizeWindowLabel(g.refreshWindowLabel || g.window, g.displayName, g.description, g.bucketId);
            const cleanGName = stripWindowSuffix(groupName) || groupName;
            pushBucket({
                label: cleanGName,
                groupKey: cleanGName.toLowerCase(),
                bucketId: cleanText(g.bucketId) || null,
                groupName: cleanGName,
                windowLabel: winLabel || null,
                remainingFraction: frac,
                remainingPct,
                usedPct,
                remainingAmount: toFinite(g.remainingAmount),
                resetTime: g.resetTime ?? null,
                disabled: Boolean(g.disabled),
                members: null,
                refs: [],
                source: 'summary',
            });
        }
    }

    const topBuckets = Array.isArray(qs.buckets) ? qs.buckets : [];
    for (const b of topBuckets) {
        if (!b || typeof b !== 'object') continue;
        const rawName = cleanText(b.displayName || b.description || b.refreshWindowLabel || b.window);
        if (!rawName) continue;
        const winLabel = normalizeWindowLabel(b.refreshWindowLabel || b.window, b.displayName, b.description, b.bucketId);
        const label = stripWindowSuffix(rawName) || rawName;
        const frac = readQuotaFraction(b, true);
        const { remainingPct, usedPct } = toPctPair(frac);
        pushBucket({
            label,
            groupKey: label.toLowerCase(),
            bucketId: cleanText(b.bucketId) || null,
            groupName: null,
            windowLabel: winLabel || null,
            remainingFraction: frac,
            remainingPct,
            usedPct,
            remainingAmount: toFinite(b.remainingAmount),
            resetTime: b.resetTime ?? null,
            disabled: Boolean(b.disabled),
            members: null,
            refs: [],
            source: 'summary',
        });
    }

    // 4. 模型家族去重；仅在官方 summary 未返回桶时，按共享配额特征自动合并成配额池
    const dedupedModels = [];
    const familySeen = new Map();
    for (const m of rawModels) {
        if (m.remainingFraction === null && !m.disabled) continue;
        const fKey = m.family.toLowerCase();
        if (!familySeen.has(fKey)) {
            familySeen.set(fKey, m);
            dedupedModels.push(m);
        } else if (currentModelLabel && m.label.toLowerCase() === cleanText(currentModelLabel).toLowerCase()) {
            const idx = dedupedModels.indexOf(familySeen.get(fKey));
            if (idx !== -1) dedupedModels[idx] = m;
            familySeen.set(fKey, m);
        }
    }

    if (buckets.length === 0 && dedupedModels.length > 0) {
        const pools = [];
        for (const m of dedupedModels) {
            const fracKey = m.remainingFraction === null ? 'none' : m.remainingFraction.toFixed(4);
            const resetMs = toResetMs(m.resetTime);
            const provider = detectProviderBucket(m.family || m.label);
            let pool = pools.find((p) => {
                if (p.provider !== provider || p.fracKey !== fracKey) return false;
                if (resetMs === null && p.resetMs === null) return true;
                if (resetMs !== null && p.resetMs !== null && Math.abs(resetMs - p.resetMs) <= 120000) return true;
                return false;
            });
            if (!pool) {
                pool = {
                    provider,
                    fracKey,
                    resetMs,
                    members: [],
                    refs: [],
                    remainingFraction: m.remainingFraction,
                    remainingPct: m.remainingPct,
                    usedPct: m.usedPct,
                    resetTime: m.resetTime,
                    disabled: m.disabled,
                };
                pools.push(pool);
            }
            const fam = m.family || m.label;
            if (!pool.members.includes(fam)) pool.members.push(fam);
            for (const r of m.refs) {
                const rl = r.toLowerCase();
                if (!pool.refs.includes(rl)) pool.refs.push(rl);
            }
            if (!m.disabled) pool.disabled = false;
            if (!pool.resetTime && m.resetTime) pool.resetTime = m.resetTime;
        }

        const providerPoolLabel = {
            Gemini: 'Gemini 共享池',
            Claude: 'Claude 共享池',
            GPT: 'GPT 共享池',
        };
        const usedLabelCounts = new Map();
        for (let idx = 0; idx < pools.length; idx++) {
            const pool = pools[idx];
            let baseLabel;
            if (pool.members.length === 1) {
                baseLabel = pool.members[0];
            } else {
                const gens = pool.members.map((mem) => {
                    const gm = mem.match(/^Gemini\s+(\d+(?:\.\d+)?)\b/i);
                    return gm ? gm[1] : null;
                });
                if (pool.provider === 'Gemini' && gens[0] && gens.every((g) => g === gens[0])) {
                    baseLabel = `Gemini ${gens[0]} 共享池`;
                } else {
                    baseLabel = providerPoolLabel[pool.provider] || '共享配额池';
                }
            }
            const prevCount = usedLabelCounts.get(baseLabel) || 0;
            usedLabelCounts.set(baseLabel, prevCount + 1);
            const label = prevCount > 0 ? `${baseLabel} (${prevCount + 1})` : baseLabel;
            pushBucket({
                label,
                groupKey: label.toLowerCase(),
                bucketId: `merged:${idx}`,
                groupName: null,
                windowLabel: null,
                remainingFraction: pool.remainingFraction,
                remainingPct: pool.remainingPct,
                usedPct: pool.usedPct,
                remainingAmount: null,
                resetTime: pool.resetTime,
                disabled: pool.disabled,
                members: pool.members,
                refs: pool.refs,
                source: 'merged',
            });
        }
    }

    // 5. 匹配当前对话所用模型对应的配额池，并聚合同一组下的 5小时 + 周额度 双窗口
    const toQuotaEntry = (src, matchedBy) => ({
        label: src.label,
        groupKey: src.groupKey || String(src.label || '').toLowerCase(),
        bucketId: src.bucketId || null,
        members: src.members || null,
        windowLabel: src.windowLabel || null,
        remainingFraction: src.remainingFraction,
        remainingPct: src.remainingPct,
        usedPct: src.usedPct,
        resetTime: src.resetTime || null,
        disabled: Boolean(src.disabled),
        matchedBy,
    });

    let activeQuota = null;
    const target = cleanText(currentModelLabel).toLowerCase();
    const targetFamily = stripEffortSuffix(currentModelLabel).toLowerCase();

    if (target) {
        const matchedMergedPool = buckets.find((b) =>
            b.remainingFraction !== null
            && Array.isArray(b.refs)
            && b.refs.length > 0
            && (b.refs.includes(target) || (targetFamily && b.refs.includes(targetFamily)))
        ) || buckets.find((b) =>
            b.remainingFraction !== null
            && Array.isArray(b.members)
            && targetFamily
            && b.members.some((mem) => mem.toLowerCase() === targetFamily)
        );
        if (matchedMergedPool) {
            activeQuota = toQuotaEntry(matchedMergedPool, 'pool');
        }

        if (!activeQuota && targetFamily) {
            const familyWords = targetFamily.split(/\s+/).filter((w) => w.length >= 3);
            const matchedBucket = buckets.find((b) => {
                if (b.remainingFraction === null) return false;
                const bl = (b.groupKey || b.label || '').toLowerCase();
                return bl.includes(targetFamily) || targetFamily.includes(bl)
                    || (familyWords.length > 0 && familyWords.every((w) => bl.includes(w)));
            }) || buckets.find((b) => {
                if (b.remainingFraction === null) return false;
                const bl = (b.groupKey || b.label || '').toLowerCase();
                return familyWords.some((w) => bl.includes(w));
            });
            if (matchedBucket) {
                activeQuota = toQuotaEntry(matchedBucket, 'bucket');
            }
        }

        if (!activeQuota) {
            const exactModel = rawModels.find((m) =>
                m.remainingFraction !== null && m.refs.some((r) => r.toLowerCase() === target)
            ) || rawModels.find((m) =>
                m.remainingFraction !== null && m.family.toLowerCase() === targetFamily
            );
            if (exactModel) {
                activeQuota = toQuotaEntry(exactModel, 'model');
            }
        }
    }

    if (!activeQuota) {
        const firstValid = buckets.find((b) => b.remainingFraction !== null)
            || rawModels.find((m) => m.remainingFraction !== null);
        if (firstValid) {
            activeQuota = toQuotaEntry(firstValid, 'fallback');
        }
    }

    let activeWindows = [];
    if (activeQuota) {
        const matchGroupKey = activeQuota.groupKey;
        const siblingBuckets = buckets.filter((b) =>
            b.remainingFraction !== null
            && ((matchGroupKey && (b.groupKey || b.label.toLowerCase()) === matchGroupKey)
                || (activeQuota.bucketId && b.bucketId === activeQuota.bucketId))
        );
        if (siblingBuckets.length > 0) {
            siblingBuckets.sort((a, b) => windowRank(a.windowLabel) - windowRank(b.windowLabel));
            activeWindows = siblingBuckets.map((b) => toQuotaEntry(b, activeQuota.matchedBy));
            const primary = activeWindows[0];
            activeQuota = Object.assign({}, primary, {
                members: activeQuota.members || primary.members || null,
                windows: activeWindows,
            });
        } else {
            activeWindows = [Object.assign({}, activeQuota)];
            activeQuota.windows = activeWindows;
        }
    }

    return {
        ok: true,
        fetchedAt: Date.now(),
        planName,
        activeQuota,
        activeWindows,
        buckets: buckets.slice(0, 12),
        credits,
    };
}

/**
 * 构造注入 dist/main.js 的主进程代码（使用 SIG_MAIN_START / SIG_MAIN_END 包裹，兼容无损卸载）
 * @param {string | null} hotCssPath 可选的 --watch-css 热重载路径
 */
function buildMainTelemetryInjection(hotCssPath) {
    const hotCssBlock = hotCssPath
        ? (() => {
            const hotPathLiteral = JSON.stringify(hotCssPath);
            return `
        const _hotPath = ${hotPathLiteral};
        if (_hotPath && _el && _el.ipcMain && typeof _el.ipcMain.handle === 'function') {
            let _lastMt = 0;
            let _lastCss = '';
            try { _el.ipcMain.removeHandler('codex:read-hot-css'); } catch {}
            _el.ipcMain.handle('codex:read-hot-css', () => {
                try {
                    if (!_fs.existsSync(_hotPath)) return null;
                    const mt = _fs.statSync(_hotPath).mtimeMs;
                    if (mt !== _lastMt || !_lastCss) {
                        _lastMt = mt;
                        _lastCss = _fs.readFileSync(_hotPath, 'utf8');
                    }
                    return { mt, css: _lastCss };
                } catch { return null; }
            });
        }`;
        })()
        : '';
    const helpersSrc = normalizeQuotaSnapshot.toString();

    return `\n${SIG_MAIN_START}\n(() => {
    try {
        const _el = require('electron');
        const _fs = require('fs');
        const _http = require('http');
        const _https = require('https');

        ${helpersSrc}
        ${hotCssBlock}

        if (!_el || !_el.ipcMain || typeof _el.ipcMain.handle !== 'function') return;

        const LOCAL_ORIGIN_RE = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?(?:\\/|$)/i;
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const RPC_SERVICE = '/exa.language_server_pb.LanguageServerService/';
        const MAX_RPC_BYTES = 2 * 1024 * 1024;
        const protocolCache = new Map();

        let lsMod = null;
        try { lsMod = require('./languageServer'); } catch {}

        function getEndpoint() {
            if (!lsMod) return null;
            let port = typeof lsMod.getLsPort === 'function' ? Number(lsMod.getLsPort()) : 0;
            const proc = typeof lsMod.getLsProcess === 'function' ? lsMod.getLsProcess() : null;
            if ((!Number.isInteger(port) || port <= 0 || port > 65535) && typeof lsMod.getLsBaseUrl === 'function') {
                try {
                    const base = String(lsMod.getLsBaseUrl() || '').trim();
                    if (base) port = Number(new URL(base).port) || 0;
                } catch {}
            }
            let csrf = typeof lsMod.getLsCsrfToken === 'function' ? String(lsMod.getLsCsrfToken() || '').trim() : '';
            if (!csrf && Array.isArray(proc && proc.spawnargs)) {
                const args = proc.spawnargs;
                for (let i = 0; i < args.length; i++) {
                    const a = String(args[i] || '');
                    if (a === '--csrf_token' && i + 1 < args.length) { csrf = String(args[i + 1] || ''); break; }
                    if (a.startsWith('--csrf_token=')) { csrf = a.slice('--csrf_token='.length); break; }
                }
            }
            if (!Number.isInteger(port) || port <= 0 || port > 65535 || !csrf) return null;
            return { port, csrf, key: port + ':' + csrf };
        }

        function sendRpcOnce(proto, port, csrf, method, bodyText) {
            return new Promise((resolve, reject) => {
                const mod = proto === 'https' ? _https : _http;
                const req = mod.request({
                    hostname: '127.0.0.1',
                    port,
                    path: RPC_SERVICE + method,
                    method: 'POST',
                    rejectUnauthorized: false,
                    timeout: 4500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Connect-Protocol-Version': '1',
                        'X-Codeium-Csrf-Token': csrf,
                        'Content-Length': Buffer.byteLength(bodyText, 'utf8'),
                    },
                }, (res) => {
                    const chunks = [];
                    let total = 0;
                    res.on('data', (chunk) => {
                        total += chunk.length;
                        if (total > MAX_RPC_BYTES) {
                            res.destroy();
                            reject(new Error('response_too_large'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('end', () => {
                        const raw = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error('http_' + res.statusCode));
                            return;
                        }
                        try {
                            resolve(raw ? JSON.parse(raw) : {});
                        } catch {
                            reject(new Error('invalid_json'));
                        }
                    });
                });
                req.on('timeout', () => { req.destroy(new Error('timeout')); });
                req.on('error', reject);
                req.write(bodyText);
                req.end();
            });
        }

        async function callLsRpc(ep, method, bodyObj) {
            const payload = JSON.stringify(bodyObj || {});
            const cachedProto = protocolCache.get(ep.key);
            const order = cachedProto ? [cachedProto, cachedProto === 'https' ? 'http' : 'https'] : ['https', 'http'];
            let lastErr = null;
            for (const proto of order) {
                try {
                    const res = await sendRpcOnce(proto, ep.port, ep.csrf, method, payload);
                    protocolCache.set(ep.key, proto);
                    return res;
                } catch (err) {
                    lastErr = err;
                }
            }
            throw lastErr || new Error('rpc_failed');
        }

        // --- codex:quota-snapshot ---
        let rawQuotaCache = { key: '', fetchedAt: 0, userStatus: null, quotaSummary: null };
        let quotaInflight = null;

        try { _el.ipcMain.removeHandler('codex:quota-snapshot'); } catch {}
        _el.ipcMain.handle('codex:quota-snapshot', async (event, currentModelLabel, force) => {
            try {
                const senderUrl = event && event.senderFrame ? String(event.senderFrame.url || '') : '';
                if (!LOCAL_ORIGIN_RE.test(senderUrl)) return { ok: false, reason: 'forbidden' };
                const ep = getEndpoint();
                if (!ep) return { ok: false, reason: 'offline' };

                const now = Date.now();
                const needFetch = Boolean(force)
                    || rawQuotaCache.key !== ep.key
                    || (!rawQuotaCache.userStatus && !rawQuotaCache.quotaSummary)
                    || (now - rawQuotaCache.fetchedAt > 10000);

                if (needFetch) {
                    if (!quotaInflight || force) {
                        quotaInflight = Promise.allSettled([
                            callLsRpc(ep, 'GetUserStatus', {}),
                            callLsRpc(ep, 'RetrieveUserQuotaSummary', { request: {}, forceRefresh: true }),
                        ]).then(([rUser, rSummary]) => {
                            const userStatus = rUser.status === 'fulfilled' ? rUser.value : null;
                            const quotaSummary = rSummary.status === 'fulfilled' ? rSummary.value : null;
                            if (userStatus || quotaSummary) {
                                rawQuotaCache = { key: ep.key, fetchedAt: Date.now(), userStatus, quotaSummary };
                            }
                            return { userStatus, quotaSummary };
                        }).finally(() => { quotaInflight = null; });
                    }
                    await quotaInflight;
                }

                if (!rawQuotaCache.userStatus && !rawQuotaCache.quotaSummary) {
                    return { ok: false, reason: 'unavailable' };
                }
                const snap = normalizeQuotaSnapshot(
                    rawQuotaCache.userStatus,
                    rawQuotaCache.quotaSummary,
                    typeof currentModelLabel === 'string' ? currentModelLabel : ''
                );
                snap.fetchedAt = rawQuotaCache.fetchedAt || snap.fetchedAt;
                return snap;
            } catch (err) {
                return { ok: false, reason: (err && err.message) || 'error' };
            }
        });

        // --- codex:metrics-fallback（仅在用户未装汉化包、缺少 ag-ctx:metrics 时兜底） ---
        const fallbackCache = new Map();
        try { _el.ipcMain.removeHandler('codex:metrics-fallback'); } catch {}
        _el.ipcMain.handle('codex:metrics-fallback', async (event, rawId, force) => {
            try {
                const senderUrl = event && event.senderFrame ? String(event.senderFrame.url || '') : '';
                if (!LOCAL_ORIGIN_RE.test(senderUrl)) return { status: 'offline', running: false };
                if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return { status: 'new', running: false, conversationId: null };
                const id = rawId.toLowerCase();
                const ep = getEndpoint();
                if (!ep) return { status: 'offline', running: false, conversationId: id };

                const hit = fallbackCache.get(id);
                if (hit && !force && hit.key === ep.key && (Date.now() - hit.at) < (hit.payload.running ? 1400 : 6000)) {
                    return hit.payload;
                }

                const sumRes = await callLsRpc(ep, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false });
                const summary = sumRes && sumRes.trajectorySummaries && sumRes.trajectorySummaries[id];
                if (!summary) return { status: 'new', running: false, conversationId: id };
                const running = /RUNNING|BUSY|IN_PROGRESS/i.test(String(summary.status || ''));

                const [userRes, metaRes] = await Promise.allSettled([
                    callLsRpc(ep, 'GetUserStatus', {}),
                    callLsRpc(ep, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, startIndex: 0 }),
                ]);

                const modelMap = new Map();
                if (userRes.status === 'fulfilled' && userRes.value) {
                    const cfgs = (userRes.value.userStatus && userRes.value.userStatus.cascadeModelConfigData && userRes.value.userStatus.cascadeModelConfigData.clientModelConfigs) || [];
                    for (const c of cfgs) {
                        if (!c || !c.label) continue;
                        [c.modelId, c.modelOrAlias && c.modelOrAlias.model, c.modelOrAlias && c.modelOrAlias.alias].filter(Boolean).forEach((k) => {
                            modelMap.set(String(k).toLowerCase(), c.label);
                        });
                    }
                }

                const gens = metaRes.status === 'fulfilled' && metaRes.value
                    ? (metaRes.value.generatorMetadata || metaRes.value.generatorMetadatas || [])
                    : [];

                let lastChat = null;
                let totalRead = 0, totalWrite = 0, totalInput = 0, reqCount = 0, lastCache = null;
                let sumTok = 0, sumSec = 0, lastSpeed = null, lastTtft = null;

                const parseDur = (v) => {
                    if (typeof v === 'number' && Number.isFinite(v)) return v;
                    if (typeof v === 'string' && /^\\d+(?:\\.\\d+)?s$/.test(v)) return Number(v.slice(0, -1));
                    if (v && typeof v === 'object') return Number(v.seconds ?? 0) + Number(v.nanos ?? 0) / 1e9;
                    return null;
                };

                for (const g of gens) {
                    const chat = g && g.chatModel;
                    if (!chat || typeof chat !== 'object') continue;
                    lastChat = chat;
                    const u = chat.usage || {};
                    const inp = Number(u.inputTokens);
                    const rd = Number(u.cacheReadTokens ?? 0);
                    const wr = Number(u.cacheWriteTokens ?? 0);
                    if (Number.isFinite(inp) && inp >= 0) {
                        const tot = inp + (Number.isFinite(rd) ? rd : 0) + (Number.isFinite(wr) ? wr : 0);
                        totalRead += Number.isFinite(rd) ? rd : 0;
                        totalWrite += Number.isFinite(wr) ? wr : 0;
                        totalInput += tot;
                        reqCount++;
                        lastCache = { readTokens: rd, writeTokens: wr, totalTokens: tot, hitRate: tot > 0 ? rd / tot : null };
                    }
                    const ttft = parseDur(chat.timeToFirstToken);
                    if (ttft !== null) lastTtft = ttft;
                    const dur = parseDur(chat.streamingDuration);
                    const vis = u.responseOutputTokens !== undefined ? Number(u.responseOutputTokens) : Number(u.outputTokens);
                    if (Number.isFinite(vis) && vis > 0 && dur !== null && dur >= 0.3) {
                        sumTok += vis;
                        sumSec += dur;
                        lastSpeed = { tps: vis / dur, responseTokens: vis, duration: dur };
                    }
                }

                let context = null;
                if (lastChat) {
                    const cm = lastChat.chatStartMetadata && lastChat.chatStartMetadata.contextWindowMetadata;
                    const used = cm ? Number(cm.estimatedTokensUsed) : NaN;
                    const max = cm ? Number(cm.maxContextTokens) : NaN;
                    const rawModel = String(lastChat.modelDisplayName || lastChat.responseModel || lastChat.model || '');
                    const modelLabel = (rawModel && !/^MODEL_/i.test(rawModel)) ? rawModel : (modelMap.get(rawModel.toLowerCase()) || rawModel || null);
                    if (Number.isFinite(used)) {
                        context = {
                            usedTokens: used,
                            maxTokens: Number.isFinite(max) && max > 0 ? max : null,
                            usedFraction: Number.isFinite(max) && max > 0 ? used / max : null,
                            model: modelLabel,
                        };
                    }
                }

                const payload = {
                    status: context ? 'ready' : 'waiting',
                    running,
                    conversationId: id,
                    context,
                    cache: reqCount > 0 ? {
                        latest: lastCache,
                        session: { readTokens: totalRead, writeTokens: totalWrite, totalTokens: totalInput, hitRate: totalInput > 0 ? totalRead / totalInput : null, requests: reqCount },
                    } : null,
                    speed: (lastSpeed || sumSec > 0 || lastTtft !== null) ? {
                        latestTps: lastSpeed ? lastSpeed.tps : null,
                        sessionTps: sumSec > 0 ? sumTok / sumSec : null,
                        ttftSeconds: lastTtft,
                    } : null,
                };
                fallbackCache.set(id, { key: ep.key, at: Date.now(), payload });
                if (fallbackCache.size > 24) fallbackCache.delete(fallbackCache.keys().next().value);
                return payload;
            } catch {
                return { status: 'error', running: false };
            }
        });
    } catch {}
})();\n${SIG_MAIN_END}\n`;
}

/**
 * 构造注入 dist/preload.js 末尾的右侧常驻遥测看板脚本（自包含，无外部依赖）
 */
function buildPreloadTelemetryInjection() {
    function rendererTelemetryBootstrap() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (window.__codexTelemetryRailLoaded) return;
        window.__codexTelemetryRailLoaded = true;

        const HOST_ID = 'codex-telemetry-rail-host';
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const COLLAPSE_STORAGE_KEY = 'codex.telemetryRail.collapsed';
        const POS_STORAGE_KEY = 'codex.telemetryRail.pos';
        const RING_R = 11.5;
        const RING_C = 2 * Math.PI * RING_R;

        let userCollapsed = false;
        try { userCollapsed = localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'; } catch {}

        function loadSavedPos() {
            try {
                const raw = localStorage.getItem(POS_STORAGE_KEY);
                if (!raw) return null;
                const p = JSON.parse(raw);
                if (p && typeof p.left === 'number' && typeof p.top === 'number' && Number.isFinite(p.left) && Number.isFinite(p.top)) {
                    return {
                        left: p.left,
                        top: p.top,
                        anchorRight: Boolean(p.anchorRight),
                        rightGap: typeof p.rightGap === 'number' && Number.isFinite(p.rightGap) ? p.rightGap : 24,
                    };
                }
            } catch {}
            return null;
        }

        let customPos = loadSavedPos();
        function savePos(pos) {
            customPos = pos;
            try {
                if (pos) localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
                else localStorage.removeItem(POS_STORAGE_KEY);
            } catch {}
        }

        let popoverOpen = false;
        let showAllBuckets = false;
        let isDocked = false;
        let isDragging = false;
        let suppressPillClick = false;
        let activeConvId = null;
        let lastMetrics = null;
        let lastQuota = null;
        let lastQuotaAt = 0;
        let lastQuotaModelHint = '';
        let lastMetricsAt = 0;
        let lastRequestCount = 0;
        let quotaFetching = false;
        let reqRefreshTimer = null;
        let turnEndTimer = null;
        let lastCountdownTickAt = 0;
        let wasRunning = false;
        let metricsIpcChannel = 'ag-ctx:metrics';
        let currentTheme = 'light';
        let layoutTimer = null;
        let lastLayoutSig = '';
        let docListenersBound = false;
        let hostEl = null;
        let shadowRoot = null;
        let els = null;

        function invokeIpc(channel, ...args) {
            try {
                if (typeof electron_1 !== 'undefined' && electron_1 && electron_1.ipcRenderer && typeof electron_1.ipcRenderer.invoke === 'function') {
                    return electron_1.ipcRenderer.invoke(channel, ...args);
                }
            } catch {}
            return Promise.reject(new Error('ipc_unavailable'));
        }

        function clampNum(v, min, max) {
            return Math.min(Math.max(v, min), Math.max(min, max));
        }

        function fmtCompact(n) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
            const a = Math.abs(n);
            if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
            if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
            if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
            return String(Math.round(n));
        }

        function fmtPct(frac) {
            if (typeof frac !== 'number' || !Number.isFinite(frac)) return '—';
            const p = frac * 100;
            return (p >= 99.95 || p === 0 ? Math.round(p) : p.toFixed(1).replace(/\.0$/, '')) + '%';
        }

        function fmtTpsValue(tps) {
            if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0) return '—';
            return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1).replace(/\.0$/, '');
        }

        function fmtDuration(sec) {
            if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
            if (sec < 1) return Math.round(sec * 1000) + 'ms';
            return sec.toFixed(1).replace(/\.0$/, '') + 's';
        }

        function fmtCountdown(resetTime) {
            if (!resetTime) return '—';
            let ms = null;
            if (typeof resetTime === 'number') ms = resetTime > 1e12 ? resetTime : resetTime * 1000;
            else if (typeof resetTime === 'string') {
                const t = Date.parse(resetTime.trim());
                if (Number.isFinite(t)) ms = t;
            } else if (typeof resetTime === 'object') {
                const s = Number(resetTime.seconds ?? 0);
                const na = Number(resetTime.nanos ?? 0);
                if (Number.isFinite(s) && s > 0) ms = s * 1000 + Math.floor(na / 1e6);
            }
            if (!ms || !Number.isFinite(ms)) return '—';
            const diff = ms - Date.now();
            if (diff <= 60000) return '即将刷新';
            const min = Math.floor(diff / 60000);
            const d = Math.floor(min / 1440);
            const h = Math.floor((min % 1440) / 60);
            const m = min % 60;
            if (d > 0) return h > 0 ? d + '天' + h + '小时后' : d + '天后';
            if (h > 0) return m > 0 ? h + '小时' + m + '分后' : h + '小时后';
            return m + '分钟后';
        }

        function isVisible(el) {
            return Boolean(el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
        }

        function detectDark() {
            const h = document.documentElement;
            const b = document.body;
            if (h && h.getAttribute('data-codex-mode') === 'dark') return true;
            if (h && h.getAttribute('data-codex-mode') === 'light') return false;
            if ((h && h.classList.contains('dark')) || (b && b.classList.contains('dark'))) return true;
            if ((h && h.classList.contains('light')) || (b && b.classList.contains('light'))) return false;
            return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        }

        function findActiveViewAndId() {
            const views = Array.from(document.querySelectorAll('[data-testid="conversation-view"]')).filter(isVisible);
            let bestView = null;
            let bestArea = 0;
            for (const v of views) {
                const r = v.getBoundingClientRect();
                const area = r.width * r.height;
                if (area > bestArea) { bestArea = area; bestView = v; }
            }
            if (!bestView) return { view: null, convId: null, uiModel: '' };

            let convId = null;
            const readId = (el) => {
                const val = el && el.getAttribute && el.getAttribute('data-cascade-id');
                return UUID_RE.test(val || '') ? val.toLowerCase() : null;
            };
            convId = readId(bestView);
            if (!convId) {
                for (let el = bestView.parentElement, hops = 0; el && el !== document.body && hops < 12; el = el.parentElement, hops++) {
                    convId = readId(el);
                    if (convId) break;
                }
            }
            if (!convId) {
                const sub = bestView.querySelector('[data-cascade-id]');
                convId = readId(sub);
            }
            if (!convId) {
                const urlMatch = (window.location.href || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (urlMatch) convId = urlMatch[0].toLowerCase();
            }

            let uiModel = '';
            const modelTrigger = bestView.querySelector('[data-testid="model-selector-trigger"]');
            if (modelTrigger) {
                uiModel = (modelTrigger.textContent || '').replace(/\s+/g, ' ').trim();
            }
            return { view: bestView, convId, uiModel };
        }

        function buildDom() {
            if (hostEl && hostEl.isConnected && shadowRoot && els) return;
            const old = document.getElementById(HOST_ID);
            if (old) old.remove();

            hostEl = document.createElement('div');
            hostEl.id = HOST_ID;
            hostEl.setAttribute('data-ag-localization-skip', 'true');
            hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;';

            shadowRoot = hostEl.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = `
                :host {
                    --surface: rgba(255, 255, 255, 0.92);
                    --surface-soft: rgba(244, 246, 250, 0.85);
                    --border: rgba(15, 23, 42, 0.085);
                    --divider: rgba(15, 23, 42, 0.065);
                    --ink: #1B1F24;
                    --ink-strong: #0B0F17;
                    --muted: #57606A;
                    --faint: #818A96;
                    --hover: rgba(15, 23, 42, 0.055);
                    --track: rgba(15, 23, 42, 0.085);
                    --ok: #10B981;
                    --ok-fg: #047857;
                    --ok-bg: rgba(16, 185, 129, 0.11);
                    --warn: #F59E0B;
                    --warn-fg: #B45309;
                    --warn-bg: rgba(245, 158, 11, 0.12);
                    --danger: #EF4444;
                    --danger-fg: #B91C1C;
                    --danger-bg: rgba(239, 68, 68, 0.11);
                    --accent: #3B82F6;
                    --tag-bg: rgba(59, 130, 246, 0.09);
                    --tag-fg: #2563EB;
                    --shadow: 0 10px 30px rgba(15, 23, 42, 0.075), 0 1px 3px rgba(15, 23, 42, 0.04);
                    --shadow-drag: 0 18px 42px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08);
                    font-family: "CodexYaHei", "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
                    color: var(--ink);
                }
                :host([data-theme="dark"]) {
                    --surface: rgba(24, 25, 28, 0.90);
                    --surface-soft: rgba(255, 255, 255, 0.045);
                    --border: rgba(255, 255, 255, 0.095);
                    --divider: rgba(255, 255, 255, 0.07);
                    --ink: #E5E7EB;
                    --ink-strong: #F9FAFB;
                    --muted: #9CA3AF;
                    --faint: #6B7280;
                    --hover: rgba(255, 255, 255, 0.08);
                    --track: rgba(255, 255, 255, 0.10);
                    --ok: #34D399;
                    --ok-fg: #6EE7B7;
                    --ok-bg: rgba(16, 185, 129, 0.14);
                    --warn: #FBBF24;
                    --warn-fg: #FCD34D;
                    --warn-bg: rgba(245, 158, 11, 0.15);
                    --danger: #F87171;
                    --danger-fg: #FCA5A5;
                    --danger-bg: rgba(239, 68, 68, 0.16);
                    --accent: #60A5FA;
                    --tag-bg: rgba(96, 165, 250, 0.14);
                    --tag-fg: #93C5FD;
                    --shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.28);
                    --shadow-drag: 0 20px 48px rgba(0, 0, 0, 0.65);
                }
                * { box-sizing: border-box; }
                .hidden { display: none !important; }

                .rail-card {
                    position: fixed;
                    pointer-events: auto;
                    background: var(--surface);
                    backdrop-filter: blur(18px) saturate(160%);
                    -webkit-backdrop-filter: blur(18px) saturate(160%);
                    border: 1px solid var(--border);
                    border-radius: 16px;
                    box-shadow: var(--shadow);
                    padding: 12px 14px 13px;
                    overflow-y: auto;
                    overflow-x: hidden;
                    scrollbar-width: thin;
                    transition: box-shadow 0.18s ease, border-color 0.18s ease;
                    user-select: none;
                }
                .rail-card.dragging {
                    box-shadow: var(--shadow-drag);
                    border-color: var(--accent);
                    transition: none;
                }

                .head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    margin: -4px -6px 10px;
                    padding: 4px 6px 8px;
                    border-bottom: 1px solid var(--divider);
                    cursor: grab;
                    touch-action: none;
                }
                .rail-card.dragging .head { cursor: grabbing; }
                .head-left {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-width: 0;
                }
                .grip {
                    width: 10px;
                    height: 14px;
                    color: var(--faint);
                    opacity: 0.55;
                    flex: none;
                    transition: opacity 0.15s ease, color 0.15s ease;
                }
                .head:hover .grip { opacity: 1; color: var(--muted); }
                .dot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: var(--faint);
                    opacity: 0.65;
                    flex: none;
                    transition: background-color 0.2s ease, box-shadow 0.2s ease;
                }
                .dot.running {
                    background: var(--ok);
                    opacity: 1;
                    box-shadow: 0 0 0 3px var(--ok-bg);
                    animation: pulse 1.3s ease-in-out infinite;
                }
                @keyframes pulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(0.84); opacity: 0.55; }
                }
                .title {
                    font-size: 12.5px;
                    font-weight: 600;
                    color: var(--ink-strong);
                    letter-spacing: 0.1px;
                }
                .plan-tag {
                    font-size: 10px;
                    font-weight: 600;
                    color: var(--tag-fg);
                    background: var(--tag-bg);
                    border-radius: 999px;
                    padding: 1.5px 7px;
                    max-width: 72px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .head-btns {
                    display: flex;
                    align-items: center;
                    gap: 2px;
                    flex: none;
                }
                .icon-btn {
                    appearance: none;
                    border: none;
                    background: transparent;
                    color: var(--muted);
                    width: 24px;
                    height: 24px;
                    border-radius: 7px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    padding: 0;
                    transition: background-color 0.14s ease, color 0.14s ease;
                }
                .icon-btn svg { width: 13.5px; height: 13.5px; display: block; }
                .icon-btn:hover { background: var(--hover); color: var(--ink-strong); }
                .icon-btn.spinning svg { animation: spin 0.7s linear infinite; }
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                .model-chip {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    background: var(--surface-soft);
                    border-radius: 10px;
                    padding: 6px 10px;
                    margin-bottom: 11px;
                }
                .chip-k {
                    font-size: 11px;
                    color: var(--muted);
                    white-space: nowrap;
                    flex: none;
                }
                .chip-v {
                    font-size: 11.5px;
                    font-weight: 600;
                    color: var(--ink-strong);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    text-align: right;
                }

                .hero-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                    padding-bottom: 11px;
                    margin-bottom: 10px;
                    border-bottom: 1px solid var(--divider);
                }
                .hero-cell {
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    justify-content: space-between;
                }
                .hero-cell + .hero-cell {
                    padding-left: 10px;
                    border-left: 1px solid var(--divider);
                }
                .kicker {
                    font-size: 10.5px;
                    font-weight: 500;
                    color: var(--muted);
                    letter-spacing: 0.2px;
                }
                .speed-main {
                    display: flex;
                    align-items: baseline;
                    gap: 3px;
                    margin-top: 4px;
                }
                .hero-num {
                    font-size: 18.5px;
                    font-weight: 700;
                    color: var(--ink-strong);
                    font-variant-numeric: tabular-nums;
                    letter-spacing: -0.03em;
                    line-height: 1.15;
                }
                .hero-unit {
                    font-size: 10.5px;
                    font-weight: 500;
                    color: var(--faint);
                }
                .ctx-main {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    margin-top: 3px;
                }
                .ctx-ring {
                    width: 28px;
                    height: 28px;
                    flex: none;
                    transform: rotate(-90deg);
                }
                .ctx-ring-bg {
                    fill: none;
                    stroke: var(--track);
                    stroke-width: 2.8;
                }
                .ctx-ring-arc {
                    fill: none;
                    stroke: var(--ok);
                    stroke-width: 2.8;
                    stroke-linecap: round;
                    transition: stroke-dashoffset 0.3s ease, stroke 0.2s ease;
                }
                .ctx-ring-arc.warn { stroke: var(--warn); }
                .ctx-ring-arc.danger { stroke: var(--danger); }
                .ctx-num {
                    font-size: 15.5px;
                    font-weight: 700;
                    color: var(--ink-strong);
                    font-variant-numeric: tabular-nums;
                    letter-spacing: -0.02em;
                    line-height: 1.15;
                }
                .hero-sub {
                    font-size: 10px;
                    color: var(--faint);
                    margin-top: 4px;
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .sec {
                    padding-bottom: 10px;
                    margin-bottom: 10px;
                    border-bottom: 1px solid var(--divider);
                }
                .sec:last-child {
                    padding-bottom: 0;
                    margin-bottom: 0;
                    border-bottom: none;
                }
                .sec-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 6px;
                }
                .cache-item + .cache-item { margin-top: 7px; }
                .cache-top {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                }
                .cache-name {
                    font-size: 11px;
                    color: var(--muted);
                }
                .cache-right {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-variant-numeric: tabular-nums;
                }
                .rate-pill {
                    font-size: 10.5px;
                    font-weight: 600;
                    padding: 1px 6px;
                    border-radius: 999px;
                    background: var(--surface-soft);
                    color: var(--muted);
                }
                .rate-pill.ok { background: var(--ok-bg); color: var(--ok-fg); }
                .rate-pill.warn { background: var(--warn-bg); color: var(--warn-fg); }
                .tok-num {
                    font-size: 11.5px;
                    font-weight: 600;
                    color: var(--ink-strong);
                }
                .sub-detail {
                    font-size: 10px;
                    color: var(--faint);
                    text-align: right;
                    margin-top: 2px;
                    font-variant-numeric: tabular-nums;
                }

                .quota-hero {
                    background: var(--ok-bg);
                    border-radius: 11px;
                    padding: 8px 10px;
                    margin-bottom: 0;
                    transition: background-color 0.2s ease;
                }
                .quota-hero.warn { background: var(--warn-bg); }
                .quota-hero.danger { background: var(--danger-bg); }
                .quota-hero-top {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 6px;
                }
                .quota-name {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--ink-strong);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    min-width: 0;
                }
                .quota-rem {
                    font-size: 12px;
                    font-weight: 700;
                    font-variant-numeric: tabular-nums;
                    color: var(--ok-fg);
                    white-space: nowrap;
                }
                .quota-hero.warn .quota-rem { color: var(--warn-fg); }
                .quota-hero.danger .quota-rem { color: var(--danger-fg); }
                .quota-win-list {
                    display: grid;
                    gap: 7px;
                    margin-top: 6px;
                }
                .quota-win-row + .quota-win-row {
                    padding-top: 6px;
                    border-top: 1px dashed rgba(128, 128, 128, 0.20);
                }
                .quota-win-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    font-size: 10.5px;
                }
                .win-tag {
                    font-size: 10px;
                    font-weight: 600;
                    padding: 1px 6px;
                    border-radius: 5px;
                    background: rgba(128, 128, 128, 0.14);
                    color: var(--ink-strong);
                }
                .win-pct {
                    font-size: 10.5px;
                    font-weight: 650;
                    font-variant-numeric: tabular-nums;
                    color: var(--ink-strong);
                }
                .win-reset {
                    font-size: 10px;
                    color: var(--muted);
                    margin-top: 3px;
                    text-align: right;
                    font-variant-numeric: tabular-nums;
                }
                .bar-track {
                    height: 5px;
                    border-radius: 999px;
                    background: rgba(128, 128, 128, 0.16);
                    overflow: hidden;
                    margin-top: 5px;
                }
                .bar-fill {
                    height: 100%;
                    width: 0%;
                    border-radius: 999px;
                    background: var(--ok);
                    transition: width 0.28s ease, background-color 0.2s ease;
                }
                .bar-fill.warn { background: var(--warn); }
                .bar-fill.danger { background: var(--danger); }
                .quota-meta {
                    display: flex;
                    justify-content: space-between;
                    font-size: 10px;
                    color: var(--muted);
                    margin-top: 5px;
                    font-variant-numeric: tabular-nums;
                }

                .bucket-list {
                    display: grid;
                    gap: 6px;
                    margin-top: 8px;
                }
                .bucket-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    font-size: 11px;
                }
                .bucket-name {
                    color: var(--muted);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    min-width: 0;
                    flex: 1;
                }
                .bucket-right {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    flex: none;
                }
                .mini-bar {
                    width: 38px;
                    height: 4px;
                    border-radius: 999px;
                    background: var(--track);
                    overflow: hidden;
                }
                .mini-bar > i {
                    display: block;
                    height: 100%;
                    border-radius: 999px;
                    background: var(--ok);
                }
                .mini-bar > i.warn { background: var(--warn); }
                .mini-bar > i.danger { background: var(--danger); }
                .bucket-stat {
                    color: var(--ink);
                    font-size: 10.5px;
                    font-weight: 550;
                    font-variant-numeric: tabular-nums;
                    min-width: 34px;
                    text-align: right;
                }
                .credit-stat {
                    color: var(--muted);
                    font-size: 10.5px;
                    font-variant-numeric: tabular-nums;
                }
                .more-btn {
                    appearance: none;
                    border: none;
                    width: 100%;
                    background: transparent;
                    color: var(--muted);
                    font-family: inherit;
                    font-size: 10.5px;
                    padding: 5px 4px 1px;
                    margin-top: 4px;
                    border-radius: 6px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    cursor: pointer;
                    transition: background-color 0.14s ease, color 0.14s ease;
                }
                .more-btn:hover { background: var(--hover); color: var(--ink-strong); }
                .more-btn svg { width: 11px; height: 11px; transition: transform 0.18s ease; }
                .more-btn[aria-expanded="true"] svg { transform: rotate(180deg); }

                .compact-pill {
                    position: fixed;
                    pointer-events: auto;
                    appearance: none;
                    background: var(--surface);
                    backdrop-filter: blur(14px) saturate(150%);
                    -webkit-backdrop-filter: blur(14px) saturate(150%);
                    border: 1px solid var(--border);
                    border-radius: 999px;
                    box-shadow: var(--shadow);
                    height: 28px;
                    padding: 0 11px;
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    font-family: inherit;
                    font-size: 11px;
                    font-weight: 550;
                    font-variant-numeric: tabular-nums;
                    color: var(--ink-strong);
                    cursor: grab;
                    touch-action: none;
                    user-select: none;
                    transition: border-color 0.15s ease, box-shadow 0.15s ease;
                }
                .compact-pill:hover { border-color: var(--muted); }
                .compact-pill.dragging { cursor: grabbing; box-shadow: var(--shadow-drag); transition: none; }
            `;

            const html = document.createElement('div');
            html.innerHTML = `
                <button class="compact-pill hidden" id="pill" type="button" title="点击展开 · 按住拖动位置">
                    <span class="dot" id="pill-dot"></span>
                    <span id="pill-text">监测 · —</span>
                </button>
                <aside class="rail-card hidden" id="card" aria-label="实时运行监测">
                    <div class="head" id="card-head" title="按住拖动 · 双击恢复右侧自动停靠">
                        <div class="head-left">
                            <svg class="grip" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
                                <circle cx="2.5" cy="2.5" r="1.1"/><circle cx="7.5" cy="2.5" r="1.1"/>
                                <circle cx="2.5" cy="7" r="1.1"/><circle cx="7.5" cy="7" r="1.1"/>
                                <circle cx="2.5" cy="11.5" r="1.1"/><circle cx="7.5" cy="11.5" r="1.1"/>
                            </svg>
                            <span class="dot" id="card-dot"></span>
                            <span class="title">实时监测</span>
                            <span class="plan-tag hidden" id="plan-tag"></span>
                        </div>
                        <div class="head-btns">
                            <button class="icon-btn hidden" id="btn-reset-pos" type="button" title="归位到右侧默认停靠">
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.4-3.7L2.5 5.8"/><path d="M2.5 2.5v3.3h3.3"/></svg>
                            </button>
                            <button class="icon-btn" id="btn-refresh" type="button" title="立即刷新配额与上下文">
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9"/><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9"/><path d="M12.3 1.9v2.8H9.5"/><path d="M3.7 14.1v-2.8h2.8"/></svg>
                            </button>
                            <button class="icon-btn" id="btn-collapse" type="button" title="收起为胶囊">
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 8h9"/></svg>
                            </button>
                        </div>
                    </div>

                    <div class="model-chip">
                        <span class="chip-k">所用模型</span>
                        <span class="chip-v" id="val-model" title="">—</span>
                    </div>

                    <div class="hero-grid">
                        <div class="hero-cell">
                            <div class="kicker">生成速度</div>
                            <div class="speed-main">
                                <span class="hero-num" id="val-tps">—</span>
                                <span class="hero-unit" id="unit-tps">t/s</span>
                            </div>
                            <div class="hero-sub" id="sub-tps">等待响应</div>
                        </div>
                        <div class="hero-cell">
                            <div class="kicker">上下文窗口</div>
                            <div class="ctx-main">
                                <svg class="ctx-ring" viewBox="0 0 28 28" aria-hidden="true">
                                    <circle class="ctx-ring-bg" cx="14" cy="14" r="11.5"/>
                                    <circle class="ctx-ring-arc" id="ctx-ring-arc" cx="14" cy="14" r="11.5" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/>
                                </svg>
                                <span class="ctx-num" id="val-ctx-pct">—</span>
                            </div>
                            <div class="hero-sub" id="sub-ctx-tok">—</div>
                        </div>
                    </div>

                    <div class="sec">
                        <div class="sec-head">
                            <span class="kicker">缓存命中</span>
                        </div>
                        <div class="cache-item">
                            <div class="cache-top">
                                <span class="cache-name">本次缓存</span>
                                <span class="cache-right">
                                    <span class="rate-pill" id="pill-cache-last">—</span>
                                    <span class="tok-num" id="val-cache-last">—</span>
                                </span>
                            </div>
                            <div class="sub-detail" id="sub-cache-last"></div>
                        </div>
                        <div class="cache-item">
                            <div class="cache-top">
                                <span class="cache-name">累计缓存</span>
                                <span class="cache-right">
                                    <span class="rate-pill" id="pill-cache-total">—</span>
                                    <span class="tok-num" id="val-cache-total">—</span>
                                </span>
                            </div>
                            <div class="sub-detail" id="sub-cache-total"></div>
                        </div>
                    </div>

                    <div class="sec">
                        <div class="sec-head">
                            <span class="kicker">模型额度</span>
                            <span class="sub-detail" id="quota-updated">实时同步</span>
                        </div>
                        <div class="quota-hero" id="quota-hero">
                            <div class="quota-hero-top">
                                <span class="quota-name" id="quota-active-name">—</span>
                                <span class="quota-rem" id="quota-active-pct">—</span>
                            </div>
                            <div id="quota-single-wrap">
                                <div class="bar-track"><div class="bar-fill" id="bar-quota"></div></div>
                                <div class="quota-meta">
                                    <span id="quota-active-used">已用 —</span>
                                    <span id="quota-active-reset">刷新 —</span>
                                </div>
                            </div>
                            <div class="quota-win-list hidden" id="quota-active-windows"></div>
                        </div>
                        <div class="bucket-list hidden" id="bucket-list"></div>
                        <button class="more-btn hidden" id="btn-more-buckets" type="button" aria-expanded="false">
                            <span id="more-buckets-text">展开其余模型</span>
                            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>
                        </button>
                    </div>
                </aside>
            `;

            shadowRoot.appendChild(style);
            while (html.firstChild) shadowRoot.appendChild(html.firstChild);

            const q = (id) => shadowRoot.getElementById(id);
            els = {
                pill: q('pill'),
                pillDot: q('pill-dot'),
                pillText: q('pill-text'),
                card: q('card'),
                head: q('card-head'),
                cardDot: q('card-dot'),
                planTag: q('plan-tag'),
                btnResetPos: q('btn-reset-pos'),
                btnRefresh: q('btn-refresh'),
                btnCollapse: q('btn-collapse'),
                valModel: q('val-model'),
                valTps: q('val-tps'),
                unitTps: q('unit-tps'),
                subTps: q('sub-tps'),
                ctxRingArc: q('ctx-ring-arc'),
                valCtxPct: q('val-ctx-pct'),
                subCtxTok: q('sub-ctx-tok'),
                pillCacheLast: q('pill-cache-last'),
                valCacheLast: q('val-cache-last'),
                subCacheLast: q('sub-cache-last'),
                pillCacheTotal: q('pill-cache-total'),
                valCacheTotal: q('val-cache-total'),
                subCacheTotal: q('sub-cache-total'),
                quotaUpdated: q('quota-updated'),
                quotaHero: q('quota-hero'),
                quotaActiveName: q('quota-active-name'),
                quotaActivePct: q('quota-active-pct'),
                quotaSingleWrap: q('quota-single-wrap'),
                barQuota: q('bar-quota'),
                quotaActiveUsed: q('quota-active-used'),
                quotaActiveReset: q('quota-active-reset'),
                quotaActiveWindows: q('quota-active-windows'),
                bucketList: q('bucket-list'),
                btnMoreBuckets: q('btn-more-buckets'),
                moreBucketsText: q('more-buckets-text'),
            };

            // 卡片顶部栏拖动 + 双击归位
            els.head.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('button'))) return;
                e.preventDefault();
                e.stopPropagation();

                const rect = els.card.getBoundingClientRect();
                const cardW = rect.width || 248;
                const startX = e.clientX;
                const startY = e.clientY;
                let curLeft = rect.left;
                let curTop = rect.top;
                let moved = false;

                isDragging = true;
                els.card.classList.add('dragging');
                try { els.head.setPointerCapture(e.pointerId); } catch {}

                const onMove = (ev) => {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
                    curLeft = Math.round(clampNum(rect.left + dx, 8, window.innerWidth - cardW - 8));
                    curTop = Math.round(clampNum(rect.top + dy, 44, Math.max(44, window.innerHeight - 160)));
                    els.card.style.left = curLeft + 'px';
                    els.card.style.right = 'auto';
                    els.card.style.top = curTop + 'px';
                    els.card.style.maxHeight = Math.max(120, window.innerHeight - curTop - 12) + 'px';
                };

                const onEnd = (ev) => {
                    isDragging = false;
                    els.card.classList.remove('dragging');
                    els.head.removeEventListener('pointermove', onMove);
                    els.head.removeEventListener('pointerup', onEnd);
                    els.head.removeEventListener('pointercancel', onEnd);
                    try { els.head.releasePointerCapture(ev.pointerId); } catch {}
                    if (moved) {
                        const anchorRight = (curLeft + cardW / 2) > (window.innerWidth / 2);
                        const rightGap = Math.max(8, Math.round(window.innerWidth - (curLeft + cardW)));
                        savePos({ left: curLeft, top: curTop, anchorRight, rightGap });
                        scheduleLayout(true);
                    }
                };

                els.head.addEventListener('pointermove', onMove);
                els.head.addEventListener('pointerup', onEnd);
                els.head.addEventListener('pointercancel', onEnd);
            });

            els.head.addEventListener('dblclick', (e) => {
                if (e.target && e.target.closest && e.target.closest('button')) return;
                e.stopPropagation();
                savePos(null);
                scheduleLayout(true);
            });

            // 胶囊拖动（超过 4px 视为拖动，否则视为点击展开）
            els.pill.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();

                const rect = els.pill.getBoundingClientRect();
                const pillW = rect.width || 130;
                const startX = e.clientX;
                const startY = e.clientY;
                let curLeft = rect.left;
                let curTop = rect.top;
                let dragged = false;

                try { els.pill.setPointerCapture(e.pointerId); } catch {}

                const onMove = (ev) => {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (!dragged && Math.hypot(dx, dy) > 4) {
                        dragged = true;
                        isDragging = true;
                        els.pill.classList.add('dragging');
                    }
                    if (!dragged) return;
                    curLeft = Math.round(clampNum(rect.left + dx, 8, window.innerWidth - pillW - 8));
                    curTop = Math.round(clampNum(rect.top + dy, 44, window.innerHeight - 36));
                    els.pill.style.left = curLeft + 'px';
                    els.pill.style.right = 'auto';
                    els.pill.style.top = curTop + 'px';
                };

                const onEnd = (ev) => {
                    els.pill.removeEventListener('pointermove', onMove);
                    els.pill.removeEventListener('pointerup', onEnd);
                    els.pill.removeEventListener('pointercancel', onEnd);
                    try { els.pill.releasePointerCapture(ev.pointerId); } catch {}
                    if (dragged) {
                        isDragging = false;
                        els.pill.classList.remove('dragging');
                        suppressPillClick = true;
                        setTimeout(() => { suppressPillClick = false; }, 120);
                        const anchorRight = (curLeft + pillW / 2) > (window.innerWidth / 2);
                        const rightGap = Math.max(8, Math.round(window.innerWidth - (curLeft + pillW)));
                        const cardLeft = anchorRight ? Math.max(8, window.innerWidth - rightGap - 248) : Math.min(curLeft, window.innerWidth - 256);
                        savePos({ left: cardLeft, top: curTop, anchorRight, rightGap });
                        scheduleLayout(true);
                    }
                };

                els.pill.addEventListener('pointermove', onMove);
                els.pill.addEventListener('pointerup', onEnd);
                els.pill.addEventListener('pointercancel', onEnd);
            });

            els.pill.addEventListener('click', (e) => {
                e.stopPropagation();
                if (suppressPillClick) return;
                if (userCollapsed) {
                    userCollapsed = false;
                    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, '0'); } catch {}
                    popoverOpen = !isDocked;
                } else {
                    popoverOpen = !popoverOpen;
                }
                scheduleLayout(true);
            });

            els.btnResetPos.addEventListener('click', (e) => {
                e.stopPropagation();
                savePos(null);
                scheduleLayout(true);
            });

            els.btnCollapse.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isDocked || customPos) {
                    userCollapsed = true;
                    popoverOpen = false;
                    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, '1'); } catch {}
                } else {
                    popoverOpen = false;
                }
                scheduleLayout(true);
            });

            els.btnRefresh.addEventListener('click', (e) => {
                e.stopPropagation();
                els.btnRefresh.classList.add('spinning');
                void Promise.all([fetchMetrics(true), fetchQuota(true)]).finally(() => {
                    setTimeout(() => els && els.btnRefresh.classList.remove('spinning'), 350);
                });
            });

            els.btnMoreBuckets.addEventListener('click', (e) => {
                e.stopPropagation();
                showAllBuckets = !showAllBuckets;
                renderData();
            });

            shadowRoot.addEventListener('pointerdown', (e) => e.stopPropagation());
            if (!docListenersBound) {
                docListenersBound = true;
                document.addEventListener('pointerdown', () => {
                    if (!isDocked && !customPos && popoverOpen) {
                        popoverOpen = false;
                        scheduleLayout(true);
                    }
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !isDocked && !customPos && popoverOpen) {
                        popoverOpen = false;
                        scheduleLayout(true);
                    }
                });
                const onWindowWake = () => {
                    if (document.hidden) return;
                    if (Date.now() - lastQuotaAt >= 10000) {
                        void fetchMetrics(false);
                        void fetchQuota(true);
                    }
                };
                document.addEventListener('visibilitychange', onWindowWake);
                window.addEventListener('focus', onWindowWake);
            }
        }

        function updateQuotaFreshnessLabel() {
            if (!els || !els.quotaUpdated) return;
            if (quotaFetching) {
                els.quotaUpdated.textContent = '更新中…';
                return;
            }
            if (lastQuota && lastQuota.ok && lastQuota.fetchedAt) {
                const ageSec = Math.max(0, Math.floor((Date.now() - lastQuota.fetchedAt) / 1000));
                if (ageSec < 5) els.quotaUpdated.textContent = '刚刚更新';
                else if (ageSec < 60) els.quotaUpdated.textContent = ageSec + '秒前';
                else els.quotaUpdated.textContent = Math.floor(ageSec / 60) + '分钟前';
                return;
            }
            if (lastQuota && lastQuota.reason === 'offline') {
                els.quotaUpdated.textContent = '等待服务';
                return;
            }
            els.quotaUpdated.textContent = '实时同步';
        }

        function ensureMounted() {
            const parent = document.body || document.documentElement;
            if (!parent) return;
            buildDom();
            if (hostEl.parentElement !== parent) parent.appendChild(hostEl);
            const nextTheme = detectDark() ? 'dark' : 'light';
            if (nextTheme !== currentTheme) {
                currentTheme = nextTheme;
                hostEl.setAttribute('data-theme', currentTheme);
            }
        }

        function setToneClass(el, usedFrac) {
            el.classList.remove('warn', 'danger');
            if (typeof usedFrac !== 'number' || !Number.isFinite(usedFrac)) return;
            if (usedFrac >= 0.85) el.classList.add('danger');
            else if (usedFrac >= 0.65) el.classList.add('warn');
        }

        function setRatePillTone(el, hitRate) {
            el.classList.remove('ok', 'warn');
            if (typeof hitRate !== 'number' || !Number.isFinite(hitRate)) return;
            if (hitRate >= 0.7) el.classList.add('ok');
            else if (hitRate >= 0.3) el.classList.add('warn');
        }

        function renderData() {
            if (!els) return;
            const running = Boolean(lastMetrics && lastMetrics.running);
            els.cardDot.classList.toggle('running', running);
            els.pillDot.classList.toggle('running', running);

            const ctx = lastMetrics && lastMetrics.context;
            const speed = lastMetrics && lastMetrics.speed;
            const cache = lastMetrics && lastMetrics.cache;

            const { uiModel } = findActiveViewAndId();
            const modelName = (ctx && ctx.model) || uiModel || '—';
            els.valModel.textContent = modelName;
            els.valModel.title = modelName;

            const primaryTps = speed && typeof speed.latestTps === 'number'
                ? speed.latestTps
                : (speed && typeof speed.sessionTps === 'number' ? speed.sessionTps : null);
            if (primaryTps !== null) {
                els.valTps.textContent = fmtTpsValue(primaryTps);
                els.unitTps.classList.remove('hidden');
            } else {
                els.valTps.textContent = running ? '生成中' : '—';
                els.unitTps.classList.add('hidden');
            }
            const speedParts = [];
            if (speed && typeof speed.sessionTps === 'number') speedParts.push('均 ' + Math.round(speed.sessionTps));
            if (speed && typeof speed.ttftSeconds === 'number') speedParts.push('首字 ' + fmtDuration(speed.ttftSeconds));
            els.subTps.textContent = speedParts.length ? speedParts.join(' · ') : (running ? '采样中' : '等待响应');

            if (ctx && typeof ctx.usedFraction === 'number') {
                const clamped = clampNum(ctx.usedFraction, 0, 1);
                els.valCtxPct.textContent = fmtPct(clamped);
                els.subCtxTok.textContent = fmtCompact(ctx.usedTokens) + ' / ' + fmtCompact(ctx.maxTokens);
                els.ctxRingArc.style.strokeDashoffset = (RING_C * (1 - clamped)).toFixed(2);
                setToneClass(els.ctxRingArc, clamped);
            } else if (ctx && typeof ctx.usedTokens === 'number') {
                els.valCtxPct.textContent = fmtCompact(ctx.usedTokens);
                els.subCtxTok.textContent = '已用 Token';
                els.ctxRingArc.style.strokeDashoffset = RING_C.toFixed(2);
                setToneClass(els.ctxRingArc, 0);
            } else {
                els.valCtxPct.textContent = '—';
                els.subCtxTok.textContent = activeConvId ? '暂无采样' : '新对话';
                els.ctxRingArc.style.strokeDashoffset = RING_C.toFixed(2);
                setToneClass(els.ctxRingArc, 0);
            }

            if (cache && cache.latest) {
                const l = cache.latest;
                els.pillCacheLast.textContent = l.hitRate !== null ? fmtPct(l.hitRate) : '—';
                setRatePillTone(els.pillCacheLast, l.hitRate);
                els.valCacheLast.textContent = fmtCompact(l.readTokens);
                els.subCacheLast.textContent = '命中 ' + fmtCompact(l.readTokens) + ' / 输入 ' + fmtCompact(l.totalTokens);
            } else {
                els.pillCacheLast.textContent = '—';
                setRatePillTone(els.pillCacheLast, null);
                els.valCacheLast.textContent = '—';
                els.subCacheLast.textContent = '';
            }

            if (cache && cache.session) {
                const s = cache.session;
                els.pillCacheTotal.textContent = s.hitRate !== null ? fmtPct(s.hitRate) : '—';
                setRatePillTone(els.pillCacheTotal, s.hitRate);
                els.valCacheTotal.textContent = fmtCompact(s.readTokens);
                els.subCacheTotal.textContent = s.requests + ' 次请求 · 总输入 ' + fmtCompact(s.totalTokens);
            } else {
                els.pillCacheTotal.textContent = '—';
                setRatePillTone(els.pillCacheTotal, null);
                els.valCacheTotal.textContent = '—';
                els.subCacheTotal.textContent = '';
            }

            if (lastQuota && lastQuota.ok) {
                if (lastQuota.planName) {
                    els.planTag.textContent = lastQuota.planName;
                    els.planTag.classList.remove('hidden');
                } else {
                    els.planTag.classList.add('hidden');
                }
                const aq = lastQuota.activeQuota;
                const activeWindows = (aq && Array.isArray(aq.windows) && aq.windows.length > 0)
                    ? aq.windows
                    : (Array.isArray(lastQuota.activeWindows) && lastQuota.activeWindows.length > 0
                        ? lastQuota.activeWindows
                        : (aq ? [aq] : []));

                if (aq) {
                    els.quotaActiveName.textContent = aq.label;
                    els.quotaActiveName.title = (Array.isArray(aq.members) && aq.members.length > 1)
                        ? `${aq.label}（含 ${aq.members.join('、')}）`
                        : aq.label;

                    if (activeWindows.length >= 2) {
                        els.quotaActivePct.classList.add('hidden');
                        els.quotaSingleWrap.classList.add('hidden');
                        els.quotaActiveWindows.classList.remove('hidden');
                        els.quotaActiveWindows.innerHTML = '';
                        let maxUsedFrac = 0;
                        for (const w of activeWindows) {
                            const wUsedFrac = w.usedPct !== null ? w.usedPct / 100 : 0;
                            if (wUsedFrac > maxUsedFrac) maxUsedFrac = wUsedFrac;
                            const rowEl = document.createElement('div');
                            rowEl.className = 'quota-win-row';
                            const headEl = document.createElement('div');
                            headEl.className = 'quota-win-head';
                            const tagEl = document.createElement('span');
                            tagEl.className = 'win-tag';
                            tagEl.textContent = w.windowLabel || '窗口';
                            const pctEl = document.createElement('span');
                            pctEl.className = 'win-pct';
                            pctEl.textContent = w.remainingPct !== null ? `已用 ${w.usedPct}% · 剩 ${w.remainingPct}%` : (w.disabled ? '不可用' : '—');
                            headEl.appendChild(tagEl);
                            headEl.appendChild(pctEl);

                            const trackEl = document.createElement('div');
                            trackEl.className = 'bar-track';
                            const fillEl = document.createElement('div');
                            fillEl.className = 'bar-fill';
                            fillEl.style.width = w.remainingPct !== null ? clampNum(w.remainingPct, 0, 100) + '%' : '0%';
                            setToneClass(fillEl, wUsedFrac);
                            trackEl.appendChild(fillEl);

                            const resetEl = document.createElement('div');
                            resetEl.className = 'win-reset';
                            resetEl.textContent = '刷新 ' + fmtCountdown(w.resetTime);

                            rowEl.appendChild(headEl);
                            rowEl.appendChild(trackEl);
                            rowEl.appendChild(resetEl);
                            els.quotaActiveWindows.appendChild(rowEl);
                        }
                        setToneClass(els.quotaHero, maxUsedFrac);
                    } else {
                        const usedFrac = aq.usedPct !== null ? aq.usedPct / 100 : null;
                        els.quotaActivePct.classList.remove('hidden');
                        els.quotaSingleWrap.classList.remove('hidden');
                        els.quotaActiveWindows.classList.add('hidden');
                        els.quotaActivePct.textContent = aq.remainingPct !== null ? ('剩 ' + aq.remainingPct + '%') : (aq.disabled ? '不可用' : '—');
                        els.quotaActiveUsed.textContent = (aq.windowLabel ? aq.windowLabel + ' · ' : '') + (aq.usedPct !== null ? ('已用 ' + aq.usedPct + '%') : '已用 —');
                        els.quotaActiveReset.textContent = '刷新 ' + fmtCountdown(aq.resetTime);
                        els.barQuota.style.width = aq.remainingPct !== null ? clampNum(aq.remainingPct, 0, 100) + '%' : '0%';
                        setToneClass(els.quotaHero, usedFrac);
                        setToneClass(els.barQuota, usedFrac);
                    }
                } else {
                    els.quotaActivePct.classList.remove('hidden');
                    els.quotaSingleWrap.classList.remove('hidden');
                    els.quotaActiveWindows.classList.add('hidden');
                    els.quotaActiveName.textContent = '暂未匹配';
                    els.quotaActivePct.textContent = '—';
                    els.quotaActiveUsed.textContent = '已用 —';
                    els.quotaActiveReset.textContent = '刷新 —';
                    els.barQuota.style.width = '0%';
                    setToneClass(els.quotaHero, 0);
                    setToneClass(els.barQuota, 0);
                }

                const extraRows = [];
                const buckets = Array.isArray(lastQuota.buckets) ? lastQuota.buckets : [];
                for (const b of buckets) {
                    const bGroup = (b.groupKey || b.label || '').toLowerCase();
                    const inActiveWindows = activeWindows.some((aw) =>
                        (aw.bucketId && b.bucketId && aw.bucketId === b.bucketId)
                        || (bGroup && (aw.groupKey || aw.label || '').toLowerCase() === bGroup && (aw.windowLabel || '') === (b.windowLabel || ''))
                        || (Array.isArray(aw.members) && Array.isArray(b.members) && aw.members.length === b.members.length && aw.members[0] === b.members[0])
                    );
                    if (inActiveWindows) continue;
                    const tipParts = [];
                    if (Array.isArray(b.members) && b.members.length > 1) tipParts.push('共享：' + b.members.join('、'));
                    if (b.remainingPct !== null) tipParts.push(`已用 ${b.usedPct}% · 剩 ${b.remainingPct}%`);
                    if (b.resetTime) tipParts.push('刷新 ' + fmtCountdown(b.resetTime));
                    extraRows.push({
                        kind: 'bucket',
                        name: b.windowLabel ? `${b.label} · ${b.windowLabel}` : b.label,
                        remainingPct: b.remainingPct,
                        usedPct: b.usedPct,
                        disabled: b.disabled,
                        title: tipParts.join(' · '),
                    });
                }
                const creds = Array.isArray(lastQuota.credits) ? lastQuota.credits : [];
                for (const c of creds) {
                    const statParts = [];
                    if (typeof c.used === 'number') statParts.push('已用 ' + fmtCompact(c.used));
                    if (typeof c.available === 'number') statParts.push('剩 ' + fmtCompact(c.available));
                    if (statParts.length) {
                        extraRows.push({ kind: 'credit', name: c.label, stat: statParts.join(' · '), title: '' });
                    }
                }

                els.bucketList.innerHTML = '';
                const defaultCap = 0;
                const limit = showAllBuckets ? extraRows.length : defaultCap;
                const shown = extraRows.slice(0, limit);
                if (shown.length > 0) {
                    els.bucketList.classList.remove('hidden');
                    for (const row of shown) {
                        const div = document.createElement('div');
                        div.className = 'bucket-item';
                        if (row.title) div.title = row.title;
                        const n = document.createElement('span');
                        n.className = 'bucket-name';
                        n.textContent = row.name;
                        div.appendChild(n);

                        if (row.kind === 'bucket') {
                            const right = document.createElement('span');
                            right.className = 'bucket-right';
                            const bar = document.createElement('span');
                            bar.className = 'mini-bar';
                            const fill = document.createElement('i');
                            const pct = row.remainingPct !== null ? clampNum(row.remainingPct, 0, 100) : 0;
                            fill.style.width = pct + '%';
                            if (row.usedPct !== null) {
                                if (row.usedPct >= 85) fill.classList.add('danger');
                                else if (row.usedPct >= 65) fill.classList.add('warn');
                            }
                            bar.appendChild(fill);
                            const st = document.createElement('span');
                            st.className = 'bucket-stat';
                            st.textContent = row.remainingPct !== null ? (row.remainingPct + '%') : (row.disabled ? '禁用' : '—');
                            right.appendChild(bar);
                            right.appendChild(st);
                            div.appendChild(right);
                        } else {
                            const st = document.createElement('span');
                            st.className = 'credit-stat';
                            st.textContent = row.stat;
                            div.appendChild(st);
                        }
                        els.bucketList.appendChild(div);
                    }
                } else {
                    els.bucketList.classList.add('hidden');
                }
                if (extraRows.length > defaultCap) {
                    els.btnMoreBuckets.classList.remove('hidden');
                    els.btnMoreBuckets.setAttribute('aria-expanded', showAllBuckets ? 'true' : 'false');
                    els.moreBucketsText.textContent = showAllBuckets ? '收起其他配额' : `查看其他配额 (${extraRows.length})`;
                } else {
                    els.btnMoreBuckets.classList.add('hidden');
                }
            } else {
                els.planTag.classList.add('hidden');
                els.quotaActivePct.classList.remove('hidden');
                els.quotaSingleWrap.classList.remove('hidden');
                els.quotaActiveWindows.classList.add('hidden');
                els.quotaActiveName.textContent = lastQuota && lastQuota.reason === 'offline' ? '等待本地服务' : '正在同步额度…';
                els.quotaActivePct.textContent = '—';
                els.quotaActiveUsed.textContent = '已用 —';
                els.quotaActiveReset.textContent = '刷新 —';
                els.barQuota.style.width = '0%';
                els.bucketList.classList.add('hidden');
                els.btnMoreBuckets.classList.add('hidden');
            }

            const pillParts = [];
            if (ctx && typeof ctx.usedFraction === 'number') pillParts.push('上下文 ' + fmtPct(ctx.usedFraction));
            if (primaryTps !== null) pillParts.push(fmtTpsValue(primaryTps) + ' t/s');
            if (lastQuota && lastQuota.activeQuota) {
                const wins = Array.isArray(lastQuota.activeQuota.windows) && lastQuota.activeQuota.windows.length > 0
                    ? lastQuota.activeQuota.windows
                    : [lastQuota.activeQuota];
                const w5 = wins.find((w) => w.windowLabel === '5小时');
                const wW = wins.find((w) => w.windowLabel === '周额度');
                if (w5 && wW && w5.remainingPct !== null && wW.remainingPct !== null) {
                    pillParts.push(`5h ${w5.remainingPct}% · 周 ${wW.remainingPct}%`);
                } else if (lastQuota.activeQuota.remainingPct !== null) {
                    pillParts.push('额剩 ' + lastQuota.activeQuota.remainingPct + '%');
                }
            }
            els.pillText.textContent = pillParts.length ? pillParts.join(' · ') : '实时监测';
            updateQuotaFreshnessLabel();
        }

        function updateLayout(force) {
            if (isDragging) return;
            ensureMounted();
            if (!els) return;

            const { view, convId } = findActiveViewAndId();
            if (convId !== activeConvId) {
                activeConvId = convId;
                lastMetrics = null;
                lastMetricsAt = 0;
                lastRequestCount = 0;
                lastQuotaModelHint = '';
                wasRunning = false;
                if (reqRefreshTimer) { clearTimeout(reqRefreshTimer); reqRefreshTimer = null; }
                if (turnEndTimer) { clearTimeout(turnEndTimer); turnEndTimer = null; }
                renderData();
                void fetchMetrics(true);
                void fetchQuota(false);
            }

            if (!view) {
                if (!els.card.classList.contains('hidden') || !els.pill.classList.contains('hidden')) {
                    els.card.classList.add('hidden');
                    els.pill.classList.add('hidden');
                    lastLayoutSig = 'none';
                }
                return;
            }

            els.btnResetPos.classList.toggle('hidden', !customPos);

            if (customPos) {
                const cardW = 248;
                isDocked = !userCollapsed;
                const sig = [
                    'M',
                    userCollapsed ? 'C' : 'O',
                    Math.round(customPos.left),
                    Math.round(customPos.top),
                    Math.round(customPos.rightGap || 0),
                    window.innerWidth,
                    window.innerHeight,
                ].join(':');
                if (!force && sig === lastLayoutSig) return;
                lastLayoutSig = sig;

                const resolvedLeft = customPos.anchorRight
                    ? clampNum(window.innerWidth - customPos.rightGap - cardW, 8, window.innerWidth - cardW - 8)
                    : clampNum(customPos.left, 8, window.innerWidth - cardW - 8);
                const resolvedTop = clampNum(customPos.top, 44, Math.max(44, window.innerHeight - 160));

                if (userCollapsed) {
                    els.card.classList.add('hidden');
                    els.pill.classList.remove('hidden');
                    els.pill.style.top = clampNum(resolvedTop, 44, window.innerHeight - 36) + 'px';
                    if (customPos.anchorRight) {
                        els.pill.style.left = 'auto';
                        els.pill.style.right = clampNum(customPos.rightGap, 8, window.innerWidth - 120) + 'px';
                    } else {
                        els.pill.style.right = 'auto';
                        els.pill.style.left = clampNum(resolvedLeft, 8, window.innerWidth - 140) + 'px';
                    }
                } else {
                    els.pill.classList.add('hidden');
                    els.card.classList.remove('hidden');
                    els.card.style.left = Math.round(resolvedLeft) + 'px';
                    els.card.style.right = 'auto';
                    els.card.style.top = Math.round(resolvedTop) + 'px';
                    els.card.style.width = cardW + 'px';
                    els.card.style.maxHeight = Math.max(120, window.innerHeight - Math.round(resolvedTop) - 12) + 'px';
                    els.btnCollapse.title = '收起为胶囊';
                }
                return;
            }

            const vr = view.getBoundingClientRect();
            const boxEl = view.querySelector('#antigravity\\.agentSidePanelInputBox, [data-testid="agent-input-box"] .surface-composer, [data-testid="agent-input-box"]');
            let contentRight = vr.left + Math.floor((vr.width + Math.min(vr.width, 768)) / 2);
            if (boxEl && isVisible(boxEl)) {
                const br = boxEl.getBoundingClientRect();
                if (br.width > 120 && br.width < vr.width - 80) {
                    contentRight = br.right;
                }
            }
            contentRight = Math.min(vr.right, contentRight);
            const freeRight = Math.floor(vr.right - contentRight);
            const canDock = !userCollapsed && freeRight >= 236 && vr.height >= 260;
            isDocked = canDock;

            const sig = [
                canDock ? 'D' : (popoverOpen ? 'P' : 'C'),
                Math.round(vr.top),
                Math.round(vr.right),
                Math.round(vr.bottom),
                freeRight,
            ].join(':');
            if (!force && sig === lastLayoutSig) return;
            lastLayoutSig = sig;

            if (canDock) {
                const cardW = Math.min(256, Math.max(220, freeRight - 36));
                const rightClear = Math.max(16, Math.min(28, Math.floor((freeRight - cardW) * 0.55)));
                const cardLeft = Math.round(Math.max(contentRight + 12, vr.right - rightClear - cardW));
                const cardTop = Math.max(Math.round(vr.top + 16), 54);
                const maxH = Math.max(200, Math.floor(vr.bottom - cardTop - 16));

                els.pill.classList.add('hidden');
                els.card.classList.remove('hidden');
                els.card.style.left = cardLeft + 'px';
                els.card.style.right = 'auto';
                els.card.style.top = cardTop + 'px';
                els.card.style.width = cardW + 'px';
                els.card.style.maxHeight = maxH + 'px';
                els.btnCollapse.title = '收起为胶囊';
            } else {
                const pillTop = Math.max(Math.round(vr.top + 10), 48);
                const rightGap = Math.max(16, Math.round(window.innerWidth - vr.right + 16));

                els.pill.classList.remove('hidden');
                els.pill.style.left = 'auto';
                els.pill.style.top = pillTop + 'px';
                els.pill.style.right = rightGap + 'px';

                if (popoverOpen) {
                    const popTop = pillTop + 34;
                    const maxH = Math.max(200, Math.floor(vr.bottom - popTop - 14));
                    els.card.classList.remove('hidden');
                    els.card.style.left = 'auto';
                    els.card.style.right = rightGap + 'px';
                    els.card.style.top = popTop + 'px';
                    els.card.style.width = '248px';
                    els.card.style.maxHeight = maxH + 'px';
                    els.btnCollapse.title = '收起弹窗';
                } else {
                    els.card.classList.add('hidden');
                }
            }
        }

        function scheduleLayout(force) {
            if (isDragging) return;
            if (force) {
                updateLayout(true);
                return;
            }
            if (layoutTimer) return;
            layoutTimer = requestAnimationFrame(() => {
                layoutTimer = null;
                updateLayout(false);
            });
        }

        async function fetchMetrics(force) {
            const targetId = activeConvId;
            if (!targetId) {
                lastMetrics = null;
                renderData();
                return;
            }
            lastMetricsAt = Date.now();
            try {
                let res;
                try {
                    res = await invokeIpc(metricsIpcChannel, targetId, Boolean(force));
                } catch {
                    if (metricsIpcChannel !== 'codex:metrics-fallback') {
                        metricsIpcChannel = 'codex:metrics-fallback';
                        res = await invokeIpc(metricsIpcChannel, targetId, Boolean(force));
                    }
                }
                if (targetId !== activeConvId) return;
                if (res) {
                    lastMetrics = res;
                    const nowRunning = Boolean(res.running);
                    const nextModelHint = (res.context && res.context.model) || '';
                    const nextReqCount = (res.cache && res.cache.session && typeof res.cache.session.requests === 'number')
                        ? res.cache.session.requests
                        : 0;

                    if (nextModelHint && nextModelHint !== lastQuotaModelHint) {
                        void fetchQuota(false);
                    }
                    if (wasRunning && !nowRunning) {
                        if (reqRefreshTimer) { clearTimeout(reqRefreshTimer); reqRefreshTimer = null; }
                        if (turnEndTimer) clearTimeout(turnEndTimer);
                        turnEndTimer = setTimeout(() => {
                            turnEndTimer = null;
                            void fetchQuota(true);
                        }, 1100);
                    } else if (lastRequestCount > 0 && nextReqCount > lastRequestCount && (Date.now() - lastQuotaAt >= 8000)) {
                        if (!reqRefreshTimer) {
                            reqRefreshTimer = setTimeout(() => {
                                reqRefreshTimer = null;
                                void fetchQuota(true);
                            }, 1200);
                        }
                    }

                    lastRequestCount = nextReqCount;
                    wasRunning = nowRunning;
                    renderData();
                }
            } catch {}
        }

        async function fetchQuota(force) {
            lastQuotaAt = Date.now();
            quotaFetching = true;
            updateQuotaFreshnessLabel();
            try {
                const { uiModel } = findActiveViewAndId();
                const modelHint = (lastMetrics && lastMetrics.context && lastMetrics.context.model) || uiModel || '';
                lastQuotaModelHint = modelHint;
                const res = await invokeIpc('codex:quota-snapshot', modelHint, Boolean(force));
                if (res) {
                    lastQuota = res;
                    lastCountdownTickAt = Date.now();
                    renderData();
                }
            } catch {} finally {
                quotaFetching = false;
                updateQuotaFreshnessLabel();
            }
        }

        function boot() {
            ensureMounted();
            updateLayout(true);
            void fetchMetrics(true);
            void fetchQuota(true);

            const obs = new MutationObserver(() => scheduleLayout(false));
            if (document.documentElement) {
                obs.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'data-codex-mode', 'data-cascade-id'],
                });
            }
            window.addEventListener('resize', () => scheduleLayout(true));
            setInterval(() => {
                if (document.hidden) return;
                updateLayout(false);
                updateQuotaFreshnessLabel();
                const now = Date.now();
                const mInterval = wasRunning ? 1200 : 2500;
                const qInterval = wasRunning ? 12000 : 20000;
                if (now - lastMetricsAt >= mInterval) void fetchMetrics(false);
                if (now - lastQuotaAt >= qInterval) void fetchQuota(false);
                if (now - lastCountdownTickAt >= 15000 && lastQuota && lastQuota.ok) {
                    lastCountdownTickAt = now;
                    renderData();
                }
            }, 1000);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
            boot();
        }
    }

    return `\n;(${rendererTelemetryBootstrap.toString()})();\n`;
}

module.exports = {
    SIG_MAIN_START,
    SIG_MAIN_END,
    formatCompactNum,
    formatResetCountdown,
    normalizeQuotaSnapshot,
    buildMainTelemetryInjection,
    buildPreloadTelemetryInjection,
};
