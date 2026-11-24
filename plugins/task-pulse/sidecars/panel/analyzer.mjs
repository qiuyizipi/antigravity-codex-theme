/**
 * Core analysis engine for Task Pulse v2.0.
 * High-performance incremental transcript reader + native update_steps/update_focus support +
 * false-positive-free subagent/background health checks + honest progress/ETA reporting.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STAGE_META = {
  planning: { key: 'planning', label: '方案构思与拆解', defaultDurationSec: 20, weight: 0.7 },
  research: { key: 'research', label: '排查问题与调研', defaultDurationSec: 28, weight: 1.0 },
  coding: { key: 'coding', label: '编写与修改代码', defaultDurationSec: 55, weight: 1.5 },
  testing: { key: 'testing', label: '跑测试与验证', defaultDurationSec: 35, weight: 1.2 },
  subagents: { key: 'subagents', label: '多代理协同处理', defaultDurationSec: 50, weight: 1.3 },
  review: { key: 'review', label: '复查与整理结论', defaultDurationSec: 18, weight: 0.6 },
};

const TOOL_STAGE_MAP = {
  write_file: 'coding',
  edit_file: 'coding',
  replace_file_content: 'coding',
  multi_replace_file_content: 'coding',
  write_to_file: 'coding',
  mcp_agy_fast_fast_apply_edits: 'coding',
  'mcp_agy-fast_fast_apply_edits': 'coding',
  run_command: 'testing',
  'mcp_agy-fast_fast_run_checks': 'testing',
  manage_task: 'testing',
  read_terminal: 'testing',
  command_status: 'testing',
  send_command_input: 'testing',
  invoke_subagent: 'subagents',
  manage_subagents: 'subagents',
  send_message: 'subagents',
  run_workflow: 'subagents',
  swarm: 'subagents',
  read_file: 'research',
  view_file: 'research',
  view_file_outline: 'research',
  view_code_item: 'research',
  grep_search: 'research',
  find_by_name: 'research',
  list_dir: 'research',
  search_web: 'research',
  search_marketplace: 'research',
  read_url_content: 'research',
  read_resource: 'research',
  list_resources: 'research',
  'mcp_agy-fast_fast_batch_search': 'research',
  'mcp_agy-fast_fast_quick_outline': 'research',
  'mcp_agy-fast_fast_read_slices': 'research',
  ask_question: 'planning',
  schedule: 'testing',
  update_steps: 'meta',
  update_focus: 'meta',
};

const DEFAULT_PIPELINE_ORDER = ['research', 'coding', 'testing', 'review'];
const transcriptCache = new Map();
const convMetaCache = new Map();
const MAX_COLD_READ_BYTES = 4 * 1024 * 1024;

export function getDefaultAppDataDir() {
  return (
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || homedir(), '.gemini', 'antigravity')
  );
}

const CONV_ID_RE = /^[a-zA-Z0-9._-]{4,128}$/;

export function isValidConversationId(rawId) {
  const id = String(rawId || '').trim();
  return Boolean(id) && !id.includes('..') && CONV_ID_RE.test(id);
}

export function sanitizeId(rawId) {
  return String(rawId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeReadJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readHeadUtf8(filePath, maxBytes = 4096) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readTailUtf8(filePath, maxBytes = 65536) {
  const stat = statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const len = stat.size - start;
  if (len <= 0) return '';
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function atomicWriteJson(filePath, data) {
  const payload = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, payload, 'utf8');
    renameSync(tmpPath, filePath);
  } catch {
    try {
      writeFileSync(filePath, payload, 'utf8');
    } catch {
      // Ignore write failures in read/telemetry sidecar.
    }
  }
}

function parseTimestampMs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function hasChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''));
}

function stripTagsAndPaths(raw) {
  if (!raw) return '';
  let text = String(raw);
  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  text = text.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
  text = text.replace(/<\/?USER_REQUEST>/gi, '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]+)`/g, (_, inner) => {
    if (/[\\/]/.test(inner) && inner.length > 18) return '';
    return inner;
  });
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/[A-Za-z]:\\[^\s"'`<>|]+/g, '');
  text = text.replace(/\/(?:Users|home|var|tmp|etc|opt)\/[^\s"'`<>|]+/g, '');
  text = text.replace(/file:\/\/[^\s)]+/gi, '');
  text = text.replace(/#L\d+(?:-L?\d+)?/g, '');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function truncateClean(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  let cut = text.slice(0, maxChars - 1);
  if (/[A-Za-z0-9]$/.test(cut) && /[A-Za-z0-9]/.test(text[maxChars - 1] || '')) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= Math.floor(maxChars * 0.55)) {
      cut = cut.slice(0, lastSpace);
    }
  }
  return `${cut.trimEnd()}…`;
}

export function condenseThinking(rawThinking, maxChars = 160) {
  const cleaned = stripTagsAndPaths(rawThinking);
  if (!cleaned) return '';
  const sentences = cleaned
    .split(/(?<=[。！？.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  const picked = (sentences.length > 0 ? sentences.slice(0, 2).join(' ') : cleaned).trim();
  return truncateClean(picked, maxChars);
}

export function extractCleanUserTitle(rawContent, maxChars = 48) {
  if (!rawContent) return '当前会话';
  const reqMatch = String(rawContent).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const base = reqMatch ? reqMatch[1] : rawContent;
  const cleaned = stripTagsAndPaths(base);
  if (!cleaned) return '当前会话';
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}

function unwrapArg(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getToolCalls(step) {
  return Array.isArray(step?.tool_calls) ? step.tool_calls : [];
}

function classifyRunCommand(tc) {
  const summary = String(unwrapArg(tc.args?.toolSummary) || '');
  const cmd = String(unwrapArg(tc.args?.CommandLine) || '');
  const sanitized = `${summary} ${cmd}`.replace(/\btest-path\b/gi, '').toLowerCase();

  if (/\b(?:smoke)\b|冒烟/.test(sanitized)) {
    return { stage: 'testing', label: '跑冒烟测试' };
  }
  if (/(?:--test\b|\b(?:pytest|vitest|jest|unittest|mocha)\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:go|cargo|node)\s+[^;\n]*\btest\b|单元测试|跑测试|测试与验证)/.test(sanitized)) {
    return { stage: 'testing', label: '跑测试与验证' };
  }
  if (/(?:\b(?:tsc|webpack|vite)\b|(?:npm|pnpm|yarn|bun|cargo|go)\s+[^;\n]*\b(?:build|compile)\b|编译|构建检查)/.test(sanitized)) {
    return { stage: 'testing', label: '编译构建检查' };
  }
  if (/(?:--check\b|\b(?:eslint|prettier|mypy|ruff|flake8|typecheck|lint)\b|语法检查|语法校验|静态检查)/.test(sanitized)) {
    return { stage: 'testing', label: '静态检查与校验' };
  }
  if (/\bgit\s+(?:add|commit|push|merge|rebase)\b|推送|提交/.test(sanitized)) {
    return { stage: 'review', label: '提交与同步仓库' };
  }
  if (/(?:diagnose|inspect|select-string|get-content|get-childitem|get-ciminstance|get-process|where\.exe|chcp\b|\bgit\s+(?:status|log|diff|show)\b|\bcheck\b.*(?:log|env|path|node|status|config)|排查|诊断|日志|查看|检查|核对|检索|调研|盘点|扫描|对比|测算)/.test(sanitized)) {
    return { stage: 'research', label: STAGE_META.research.label };
  }
  if (/\b(?:build|test|spec|check|verify)\b|验证/.test(sanitized)) {
    return { stage: 'testing', label: '运行命令验证' };
  }
  return { stage: 'research', label: '执行命令排查' };
}

function classifyToolCall(tc) {
  const name = tc?.name || '';
  if (name === 'run_command') return classifyRunCommand(tc).stage;
  if (name === 'call_mcp_tool') {
    const toolName = String(unwrapArg(tc.args?.ToolName) || '').toLowerCase();
    if (/(edit|write|create|update|push|merge|delete)/.test(toolName)) return 'coding';
    return 'research';
  }
  if (TOOL_STAGE_MAP[name]) return TOOL_STAGE_MAP[name];
  if (/(apply_edits|write|edit|create|update)/i.test(name)) return 'coding';
  if (/(run_checks|test|verify|check)/i.test(name)) return 'testing';
  return 'research';
}

function detectTestingSubLabel(toolCalls) {
  for (const tc of toolCalls) {
    if (tc.name === 'run_command') {
      const cat = classifyRunCommand(tc);
      if (cat.stage === 'testing') return cat.label;
    }
    if (tc.name === 'mcp_agy-fast_fast_run_checks') {
      const s = String(unwrapArg(tc.args?.toolSummary) || '');
      if (s && hasChinese(s)) return s.replace(/^正在/, '');
      return '并行校验与测试';
    }
  }
  const joined = toolCalls
    .map((tc) => `${unwrapArg(tc.args?.toolSummary) || ''} ${unwrapArg(tc.args?.CommandLine) || ''}`)
    .join(' ')
    .replace(/\btest-path\b/gi, '')
    .toLowerCase();
  if (/smoke|冒烟/.test(joined)) return '跑冒烟测试';
  if (/pytest|vitest|jest|unittest|--test/.test(joined)) return '跑测试与验证';
  if (/build|compile|tsc|webpack|vite|cargo/.test(joined)) return '编译构建检查';
  if (/lint|typecheck|--check|format/.test(joined)) return '静态检查与校验';
  return '运行命令验证';
}

function detectStageFromStep(step, prevStageKey) {
  const toolCalls = getToolCalls(step);
  const textBlob = `${step?.thinking || ''} ${step?.content || ''}`.toLowerCase();

  if (toolCalls.length === 0) {
    if (/(review|audit|check|verify|复查|核对|审查)/.test(textBlob) && prevStageKey && prevStageKey !== 'planning') {
      return { key: 'review', label: STAGE_META.review.label };
    }
    if (!prevStageKey) {
      return { key: 'planning', label: STAGE_META.planning.label };
    }
    return { key: 'review', label: STAGE_META.review.label };
  }

  const votes = new Map();
  for (const tc of toolCalls) {
    const mapped = classifyToolCall(tc);
    if (mapped === 'meta') continue;
    votes.set(mapped, (votes.get(mapped) || 0) + 1);
  }

  if (votes.size === 0) {
    const fallbackKey = prevStageKey || 'planning';
    return { key: fallbackKey, label: STAGE_META[fallbackKey]?.label || STAGE_META.planning.label };
  }

  let chosen = 'research';
  if (votes.has('testing')) chosen = 'testing';
  else if (votes.has('coding')) chosen = 'coding';
  else if (votes.has('subagents')) chosen = 'subagents';
  else if (votes.has('review')) chosen = 'review';
  else if (votes.has('planning')) chosen = 'planning';

  if (chosen === 'testing') {
    return { key: 'testing', label: detectTestingSubLabel(toolCalls) };
  }
  if (chosen === 'research' && /(复查|review|核对|审计|检查改动)/.test(textBlob) && prevStageKey === 'coding') {
    return { key: 'review', label: '复查代码改动' };
  }
  return { key: chosen, label: STAGE_META[chosen].label };
}

function buildChineseActionHeadline(stage, step) {
  const toolCalls = getToolCalls(step);
  if (toolCalls.length === 0) {
    if (step?.type === 'PLANNER_RESPONSE' && step?.content) {
      return stage.key === 'review' ? '正在复查与整理结论' : '正在整理回复内容';
    }
    return '正在思考下一步方案';
  }

  const focusCall = toolCalls.find((tc) => tc.name === 'update_focus');
  if (focusCall) {
    const focus = String(unwrapArg(focusCall.args?.focus) || '').trim();
    if (focus && hasChinese(focus)) return focus;
  }

  const zhSummaries = toolCalls
    .map((tc) => unwrapArg(tc.args?.toolSummary))
    .filter((s) => Boolean(s) && hasChinese(s));

  if (zhSummaries.length > 0) {
    return `正在${zhSummaries[0].replace(/^正在/, '')}`;
  }

  const readCount = toolCalls.filter((tc) => ['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'mcp_agy-fast_fast_quick_outline', 'mcp_agy-fast_fast_read_slices'].includes(tc.name)).length;
  const searchCount = toolCalls.filter((tc) => ['grep_search', 'find_by_name', 'list_dir', 'mcp_agy-fast_fast_batch_search'].includes(tc.name)).length;
  const editCount = toolCalls.filter((tc) => ['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file', 'mcp_agy-fast_fast_apply_edits'].includes(tc.name)).length;
  const runCmdCalls = toolCalls.filter((tc) => tc.name === 'run_command' || tc.name === 'mcp_agy-fast_fast_run_checks');

  if (toolCalls.some((tc) => tc.name === 'ask_question')) return '需要你确认关键信息后再继续';
  if (toolCalls.some((tc) => tc.name === 'search_web' || tc.name === 'read_url_content')) return '正在检索外部资料与相关文档';
  if (toolCalls.some((tc) => tc.name === 'invoke_subagent' || tc.name === 'manage_subagents' || tc.name === 'swarm' || tc.name === 'run_workflow')) return '正在调度子代理协同推进任务';
  if (toolCalls.some((tc) => tc.name === 'manage_task')) return '正在查看或管理后台任务状态';

  if (editCount > 0) {
    return editCount > 1 ? `正在修改 ${editCount} 处代码或配置` : '正在编写或修改核心代码与配置';
  }
  if (stage.key === 'testing') {
    return `正在${stage.label}，确认改动表现`;
  }
  if (runCmdCalls.length > 0 && stage.key === 'research') {
    return readCount > 0
      ? `正在排查命令状态并核对 ${readCount} 份文件`
      : '正在执行命令排查日志与运行状态';
  }
  if (readCount > 0) {
    return readCount > 1 ? `正在并行读取并分析 ${readCount} 份代码与配置` : '正在读取上下文代码与配置';
  }
  if (searchCount > 0) {
    return '正在检索代码库定位关键实现';
  }

  switch (stage.key) {
    case 'planning':
      return '正在梳理任务目标与实现方案';
    case 'research':
      return '正在排查上下文逻辑与代码现状';
    case 'coding':
      return '正在编写或修改核心代码与配置';
    case 'subagents':
      return '正在调度子代理协同推进任务';
    case 'review':
      return '正在复查修改细节并核对结果';
    default:
      return '正在推进当前任务';
  }
}

function readRangeUtf8(fd, offset, length) {
  if (length <= 0) return '';
  const buf = Buffer.allocUnsafe(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n).toString('utf8');
}

function readTranscriptLines(convBrainDir) {
  const compactPath = join(convBrainDir, '.system_generated', 'logs', 'transcript.jsonl');
  const fullPath = join(convBrainDir, '.system_generated', 'logs', 'transcript_full.jsonl');

  const targetPath = existsSync(compactPath) ? compactPath : (existsSync(fullPath) ? fullPath : '');
  if (!targetPath) return { steps: [], mtimeMs: 0 };

  const stat = statSync(targetPath);
  const cached = transcriptCache.get(targetPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { steps: cached.steps, mtimeMs: stat.mtimeMs };
  }

  // Incremental delta read ONLY when file genuinely grew in append-only fashion (verified via head+tail fingerprint).
  if (cached && stat.size > cached.size && cached.offset === cached.size && cached.offset > 0) {
    const fd = openSync(targetPath, 'r');
    try {
      const headNow = readRangeUtf8(fd, 0, Math.min(256, cached.offset));
      const tailStart = Math.max(0, cached.offset - 64);
      const tailNow = readRangeUtf8(fd, tailStart, cached.offset - tailStart);
      if (headNow === cached.headSig && tailNow === cached.tailSig) {
        const deltaLen = stat.size - cached.offset;
        const deltaText = readRangeUtf8(fd, cached.offset, deltaLen);
        const chunk = cached.partial + deltaText;
        const lines = chunk.split(/\r?\n/);
        const partial = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parsed = safeParseJson(trimmed);
          if (parsed) cached.steps.push(parsed);
        }
        const newOffset = stat.size;
        const newTailStart = Math.max(0, newOffset - 64);
        cached.size = stat.size;
        cached.offset = newOffset;
        cached.mtimeMs = stat.mtimeMs;
        cached.partial = partial;
        cached.tailSig = readRangeUtf8(fd, newTailStart, newOffset - newTailStart);
        return { steps: cached.steps, mtimeMs: stat.mtimeMs };
      }
    } finally {
      closeSync(fd);
    }
  }

  // Cold read (bounded to last 4 MB on huge archives so UI never stalls).
  const raw = stat.size > MAX_COLD_READ_BYTES
    ? readTailUtf8(targetPath, MAX_COLD_READ_BYTES)
    : readFileSync(targetPath, 'utf8');
  let headSig = '';
  let tailSig = '';
  if (stat.size > 0 && stat.size <= MAX_COLD_READ_BYTES) {
    const fd = openSync(targetPath, 'r');
    try {
      headSig = readRangeUtf8(fd, 0, Math.min(256, stat.size));
      const tStart = Math.max(0, stat.size - 64);
      tailSig = readRangeUtf8(fd, tStart, stat.size - tStart);
    } finally {
      closeSync(fd);
    }
  }
  const lines = raw.split(/\r?\n/);
  const endsWithNewline = raw.endsWith('\n');
  const partial = endsWithNewline ? '' : (lines.pop() || '');
  const steps = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed) steps.push(parsed);
  }
  let finalPartial = partial;
  if (partial.trim()) {
    const parsed = safeParseJson(partial.trim());
    if (parsed) {
      steps.push(parsed);
      finalPartial = '';
    }
  }
  const canAppend = stat.size <= MAX_COLD_READ_BYTES;
  transcriptCache.set(targetPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset: canAppend ? stat.size : 0,
    partial: finalPartial,
    headSig,
    tailSig,
    steps,
  });
  return { steps, mtimeMs: stat.mtimeMs };
}

function extractTitleFromTail(logPath, fallbackId) {
  for (const tailBytes of [65536, 262144]) {
    const raw = readTailUtf8(logPath, tailBytes);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const step = safeParseJson(lines[i]);
      if (step && (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT')) {
        const cleaned = extractCleanUserTitle(step.content, 36);
        if (cleaned && cleaned !== '当前会话') return cleaned;
      }
    }
  }
  return `会话 ${fallbackId.slice(0, 8)}`;
}

export function listConversations(appDataDir = getDefaultAppDataDir(), limit = 15) {
  const brainDir = join(appDataDir, 'brain');
  if (!existsSync(brainDir)) return [];

  const liveDir = join(appDataDir, 'plugin_data', 'task-pulse', 'live');
  const candidates = [];

  // Pass 1: stat-only scan (millisecond speed even with 100+ sessions / 200MB logs).
  for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const logPath = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(logPath)) continue;
    try {
      const stat = statSync(logPath);
      if (stat.size === 0) continue;
      let updatedAtMs = stat.mtimeMs;
      const hookFile = join(liveDir, `${sanitizeId(entry.name)}.json`);
      if (existsSync(hookFile)) {
        const hookStat = statSync(hookFile);
        if (hookStat.mtimeMs > updatedAtMs) updatedAtMs = hookStat.mtimeMs;
      }
      candidates.push({ id: entry.name, logPath, size: stat.size, mtimeMs: stat.mtimeMs, updatedAtMs });
    } catch {
      // Skip unreadable session directories.
    }
  }

  candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  // Pass 2: read only head (4KB) + tail (64KB) of the most recent candidates.
  const items = [];
  const maxInspect = Math.min(candidates.length, Math.max(limit * 2, 25));
  for (let idx = 0; idx < maxInspect && items.length < limit; idx++) {
    const c = candidates[idx];
    try {
      const cacheKey = `${c.mtimeMs}:${c.size}`;
      let cached = convMetaCache.get(c.logPath);
      if (!cached || cached.cacheKey !== cacheKey) {
        const head = readHeadUtf8(c.logPath, 4096);
        const firstLine = head.split(/\r?\n/).find((l) => l.trim());
        const firstObj = firstLine ? safeParseJson(firstLine) : null;
        if (!firstObj || firstObj.source === 'SYSTEM' || firstObj.type === 'SYSTEM_MESSAGE') {
          cached = { cacheKey, skip: true };
        } else {
          cached = { cacheKey, skip: false, title: extractTitleFromTail(c.logPath, c.id) };
        }
        convMetaCache.set(c.logPath, cached);
      }
      if (!cached.skip) {
        items.push({ id: c.id, title: cached.title, updatedAtMs: c.updatedAtMs });
      }
    } catch {
      // Skip unreadable candidate.
    }
  }

  return items;
}

function parseExplicitDurationMs(text) {
  const minMatch = text.match(/[~约]?\s*(\d+(?:\.\d+)?)\s*(?:m|min|mins|分钟|分)\b/i);
  if (minMatch) return Math.round(Number(minMatch[1]) * 60 * 1000);
  const secMatch = text.match(/[~约]?\s*(\d+)\s*(?:s|sec|secs|秒)\b/i);
  if (secMatch) return Math.round(Number(secMatch[1]) * 1000);
  return 0;
}

function inferStageWeightFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/测试|冒烟|验证|test|smoke|build|编译/.test(t)) return STAGE_META.testing.weight;
  if (/复查|审查|核对|总结|review|audit/.test(t)) return STAGE_META.review.weight;
  if (/写|改|实现|修复|开发|重构|code|edit|fix|impl/.test(t)) return STAGE_META.coding.weight;
  if (/调研|排查|定位|读|查|analy|research|debug/.test(t)) return STAGE_META.research.weight;
  return 1.0;
}

export function extractExplicitPlan(turnSteps, taskMdText = '') {
  // Priority 1: Native Antigravity update_steps structured checklist from current turn.
  for (let i = turnSteps.length - 1; i >= 0; i--) {
    const step = turnSteps[i];
    for (const tc of getToolCalls(step)) {
      if (tc.name === 'update_steps' && Array.isArray(tc.args?.steps) && tc.args.steps.length >= 2) {
        return tc.args.steps.slice(0, 8).map((s) => {
          const rawStatus = String(s.status || 'pending');
          const status = rawStatus === 'done' || rawStatus === 'skipped'
            ? 'done'
            : rawStatus === 'in_progress'
              ? 'active'
              : 'pending';
          const title = stripTagsAndPaths(s.title || '').slice(0, 36) || String(s.title || '');
          return {
            title,
            status,
            estimatedMs: 0,
            weight: inferStageWeightFromTitle(title),
          };
        });
      }
    }
  }

  // Priority 2: task.md checklist if present.
  const stages = [];
  if (taskMdText) {
    for (const line of taskMdText.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s*\[([ xX/])\]\s+(.+)$/);
      if (!m) continue;
      const mark = m[1];
      const title = stripTagsAndPaths(m[2]).slice(0, 36);
      if (!title) continue;
      stages.push({
        title,
        status: mark.toLowerCase() === 'x' ? 'done' : mark === '/' ? 'active' : 'pending',
        estimatedMs: parseExplicitDurationMs(m[2]),
        weight: inferStageWeightFromTitle(title),
      });
    }
    if (stages.length >= 2) return stages;
  }

  // Priority 3: Inline "阶段计划：..." line in current turn.
  for (let i = turnSteps.length - 1; i >= 0; i--) {
    const step = turnSteps[i];
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const text = `${step.content || ''}\n${step.thinking || ''}`;
    const planLineMatch = text.match(/(?:阶段计划|任务阶段|执行计划)[：:]\s*([^\n]+)/);
    if (planLineMatch) {
      const parts = planLineMatch[1]
        .split(/(?:→|->|；|;)/)
        .map((p) => p.replace(/^\s*\d+[.、)]\s*/, '').trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        return parts.slice(0, 6).map((part) => {
          const title = part.replace(/[（(][~约]?\s*\d+(?:\.\d+)?\s*(?:m|min|分钟|分|s|秒)[)）]/gi, '').trim();
          return {
            title: title || part,
            status: 'pending',
            estimatedMs: parseExplicitDurationMs(part),
            weight: inferStageWeightFromTitle(part),
          };
        });
      }
    }
  }
  return [];
}

function collectClosedTaskIds(steps) {
  const closed = new Set();
  for (const step of steps) {
    const content = String(step?.content || '');
    if (!content) continue;
    if (step?.type === 'SYSTEM_MESSAGE') {
      const senderMatch = content.match(/sender=[^\s/]+\/(task-\d+)/i);
      if (
        senderMatch &&
        /(finished with result:|was canceled|Timer fired|Task completed|cancelled)/i.test(content)
      ) {
        closed.add(senderMatch[1]);
      }
    }
    if (step?.type === 'GENERIC') {
      const cancelMatch = content.match(/Task\s+"[^"]*\/(task-\d+)"\s+cancelled/i);
      if (cancelMatch) closed.add(cancelMatch[1]);
    }
  }
  return closed;
}

function isSubagentTranscriptIdle(subLogPath) {
  try {
    const tail = readTailUtf8(subLogPath, 16384);
    const lines = tail.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;
      if (step.type === 'PLANNER_RESPONSE' && step.status === 'DONE' && getToolCalls(step).length === 0) {
        return true;
      }
      return false;
    }
  } catch {
    // ignore
  }
  return false;
}

function inspectBackgroundActivity(convBrainDir, nowMs, turnStartMs = 0, steps = []) {
  const tasksDir = join(convBrainDir, '.system_generated', 'tasks');
  const closedTaskIds = collectClosedTaskIds(steps);
  const runningStepTasks = new Set();
  for (const step of steps) {
    if (step?.type === 'GENERIC' && step?.status === 'RUNNING') {
      const m = String(step.content || '').match(/task id:\s*[^\s/]+\/(task-\d+)/i);
      if (m && !closedTaskIds.has(m[1])) runningStepTasks.add(m[1]);
    }
  }

  const activeTasks = [];
  let latestTaskActivityMs = 0;

  if (existsSync(tasksDir)) {
    for (const f of readdirSync(tasksDir)) {
      if (!f.endsWith('.log')) continue;
      const taskId = f.replace('.log', '');
      if (closedTaskIds.has(taskId)) continue;
      const p = join(tasksDir, f);
      try {
        const stat = statSync(p);
        if (turnStartMs > 0 && stat.mtimeMs < turnStartMs - 30000 && !runningStepTasks.has(taskId)) {
          continue;
        }
        const raw = readTailUtf8(p, 16384);
        const finished =
          raw.includes('Timer fired') ||
          raw.includes('finished with result:') ||
          raw.includes('exited with code') ||
          raw.includes('was canceled') ||
          raw.includes('cancelled') ||
          raw.includes('Task completed');
        if (!finished) {
          activeTasks.push({ id: taskId, mtimeMs: stat.mtimeMs });
          if (stat.mtimeMs > latestTaskActivityMs) latestTaskActivityMs = stat.mtimeMs;
        }
      } catch {
        // Skip unreadable log.
      }
    }
  }

  const subDir = join(convBrainDir, '.system_generated', 'subagents');
  const brainRoot = dirname(convBrainDir);
  const activeSubagents = [];
  let latestSubagentActivityMs = 0;

  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir)) {
      if (!f.endsWith('.json')) continue;
      const data = safeReadJsonFile(join(subDir, f));
      if (!data) continue;
      const st = String(data.state || '');
      if (/KILLED|DONE|COMPLETED|IDLE|STOPPED/i.test(st)) continue;

      const subId = data.conversationId || f.replace('.json', '');
      const subLog = join(brainRoot, subId, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs = 0;
      if (existsSync(subLog)) {
        try {
          mtimeMs = statSync(subLog).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
      }
      // Idle browser/worker subagents stay SUBAGENT_STATE_ALIVE forever: ignore if untouched in current turn or already finished.
      if (turnStartMs > 0 && mtimeMs > 0 && mtimeMs < turnStartMs - 10000) continue;
      if (mtimeMs > 0 && nowMs - mtimeMs > 150000) continue;
      if (mtimeMs > 0 && existsSync(subLog) && isSubagentTranscriptIdle(subLog)) continue;

      if (mtimeMs > latestSubagentActivityMs) latestSubagentActivityMs = mtimeMs;
      if (mtimeMs > 0 && nowMs - mtimeMs <= 150000) {
        activeSubagents.push({ id: subId, role: data.subagentDescriptor?.role || '子代理', mtimeMs });
      }
    }
  }

  return { activeTasks, latestTaskActivityMs, activeSubagents, latestSubagentActivityMs };
}

function buildToolCallSignature(tc) {
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const primary =
    unwrapArg(args.CommandLine) ||
    unwrapArg(args.Path) ||
    unwrapArg(args.TargetFile) ||
    unwrapArg(args.AbsolutePath) ||
    unwrapArg(args.Url) ||
    unwrapArg(args.query) ||
    unwrapArg(args.ToolName) ||
    unwrapArg(args.TaskId) ||
    unwrapArg(args.Role) ||
    unwrapArg(args.Action) ||
    '';
  const range = args.StartLine || args.EndLine ? `@${args.StartLine || ''}-${args.EndLine || ''}` : '';
  const target = primary ? `${primary}${range}` : JSON.stringify(args);
  return `${tc?.name || 'unknown'}:${String(target).slice(0, 120)}`;
}

function detectToolLoop(turnSteps, hookState, turnStartMs = 0) {
  const signatures = [];
  for (const step of turnSteps) {
    for (const tc of getToolCalls(step)) {
      if (tc.name === 'update_steps' || tc.name === 'update_focus') continue;
      signatures.push(buildToolCallSignature(tc));
    }
  }
  if (signatures.length >= 4) {
    const tail = signatures.slice(-4);
    if (tail.every((s) => s === tail[0])) return true;
  }

  const recentTools = (Array.isArray(hookState?.recentTools) ? hookState.recentTools : [])
    .filter((t) => !turnStartMs || parseTimestampMs(t.at) >= turnStartMs - 1000);
  if (recentTools.length >= 3) {
    const tailErrs = recentTools.slice(-3);
    if (tailErrs.every((t) => Boolean(t.error))) return true;
  }
  return false;
}

function formatDurationRangeZh(lowMs, highMs) {
  const fmtOne = (ms) => {
    const sec = Math.max(15, Math.round(ms / 1000));
    if (sec < 60) return `${sec}秒`;
    const mins = Math.round((sec / 60) * 10) / 10;
    return `${mins % 1 === 0 ? mins.toFixed(0) : mins}分钟`;
  };
  if (highMs < 60000) return '不足 1 分钟';
  const lowMin = Math.max(1, Math.floor(lowMs / 60000));
  const highMin = Math.max(lowMin + 1, Math.ceil(highMs / 60000));
  if (lowMin === highMin) return `约 ${lowMin} 分钟`;
  if (highMs <= 90000) return `约 ${fmtOne(lowMs)}~${fmtOne(highMs)}`;
  return `约 ${lowMin}~${highMin} 分钟`;
}

function loadHistoryStats(appDataDir) {
  const statsPath = join(appDataDir, 'plugin_data', 'task-pulse', 'history_stats.json');
  return {
    path: statsPath,
    data: safeReadJsonFile(statsPath, { stageDurationsMs: {}, recordedTurns: [] }),
  };
}

function recordTurnStatsIfCompleted(appDataDir, turnKey, stageTimeline, isCompleted) {
  if (!isCompleted || !turnKey || stageTimeline.length === 0) return;
  const { path: statsPath, data } = loadHistoryStats(appDataDir);
  const recorded = Array.isArray(data.recordedTurns) ? data.recordedTurns : [];
  if (recorded.includes(turnKey)) return;

  const stageDurationsMs = { ...(data.stageDurationsMs || {}) };
  for (const st of stageTimeline) {
    if (st.elapsedMs < 3000 || st.elapsedMs > 45 * 60 * 1000) continue;
    const prev = stageDurationsMs[st.key];
    stageDurationsMs[st.key] = prev ? Math.round(prev * 0.7 + st.elapsedMs * 0.3) : st.elapsedMs;
  }

  atomicWriteJson(statsPath, {
    stageDurationsMs,
    recordedTurns: [...recorded.slice(-49), turnKey],
  });
}

function estimateRemainingTime({
  isTurnActive,
  turnElapsedMs,
  stageTimeline,
  explicitPlan,
  historyStageMs,
  turnSteps,
}) {
  if (!isTurnActive) {
    return {
      status: 'done',
      displayText: '已完成',
      basisText: '当前轮次已结束',
      progressPercent: 100,
    };
  }

  if (explicitPlan.length >= 2) {
    let completedWeight = 0;
    let activeWeight = 0;
    let remainingWeight = 0;
    let remainingExplicitMs = 0;
    let completedCount = 0;
    let activeIdx = -1;

    for (let i = 0; i < explicitPlan.length; i++) {
      const item = explicitPlan[i];
      if (item.status === 'done') {
        completedWeight += item.weight;
        completedCount++;
      } else if (item.status === 'active') {
        if (activeIdx === -1) activeIdx = i;
        activeWeight += item.weight * 0.45;
        remainingWeight += item.weight * 0.55;
        if (item.estimatedMs > 0) remainingExplicitMs += item.estimatedMs * 0.55;
      } else {
        remainingWeight += item.weight;
        if (item.estimatedMs > 0) remainingExplicitMs += item.estimatedMs;
      }
    }

    const totalWeight = completedWeight + activeWeight + remainingWeight;
    const progressPercent = totalWeight > 0
      ? Math.min(95, Math.max(10, Math.round(((completedWeight + activeWeight) / totalWeight) * 100)))
      : 15;

    if (completedCount === 0 && remainingExplicitMs <= 0) {
      const stepNum = activeIdx >= 0 ? activeIdx + 1 : 1;
      return {
        status: 'estimating',
        displayText: `第 ${stepNum}/${explicitPlan.length} 阶段`,
        basisText: `已完成 ${completedCount}/${explicitPlan.length}，待首阶段完成后估算耗时`,
        progressPercent,
      };
    }

    let baseEtaMs;
    if (remainingExplicitMs > 0 && completedCount === 0) {
      baseEtaMs = remainingExplicitMs;
    } else {
      const priorMsPerWeight = 35000;
      const observedMsPerWeight = completedWeight > 0 ? turnElapsedMs / completedWeight : priorMsPerWeight;
      const clampedObserved = Math.min(240000, Math.max(12000, observedMsPerWeight));
      const blendedMsPerWeight = completedCount > 0 ? (clampedObserved * 0.6 + priorMsPerWeight * 0.4) : priorMsPerWeight;
      baseEtaMs = remainingExplicitMs > 0
        ? (remainingExplicitMs * 0.5 + remainingWeight * blendedMsPerWeight * 0.5)
        : remainingWeight * blendedMsPerWeight;
    }

    return {
      status: 'estimated',
      displayText: formatDurationRangeZh(baseEtaMs * 0.8, baseEtaMs * 1.3),
      basisText: `按阶段进度推算（已完成 ${completedCount}/${explicitPlan.length} 个阶段）`,
      progressPercent,
    };
  }

  if (turnSteps.length <= 2 || turnElapsedMs < 20000) {
    return {
      status: 'estimating',
      displayText: '执行中…',
      basisText: '短任务或刚启动，暂不盲猜剩余时长',
      progressPercent: turnSteps.length <= 1 ? 12 : 25,
    };
  }

  const baselineSec = (key) => {
    const histMs = historyStageMs?.[key];
    if (histMs && histMs >= 5000) return Math.min(180, histMs / 1000);
    return STAGE_META[key]?.defaultDurationSec || 30;
  };

  const currentStage = stageTimeline[stageTimeline.length - 1];
  const currentKey = currentStage?.key || 'research';
  const currentIdx = Math.max(0, DEFAULT_PIPELINE_ORDER.indexOf(currentKey));
  const currentElapsedMs = currentStage?.elapsedMs || 0;
  const expectedCurrentMs = baselineSec(currentKey) * 1000;
  const currentRemMs = Math.max(12000, expectedCurrentMs - currentElapsedMs);

  let tailRemMs = 0;
  for (let i = currentIdx + 1; i < DEFAULT_PIPELINE_ORDER.length; i++) {
    tailRemMs += baselineSec(DEFAULT_PIPELINE_ORDER[i]) * 1000;
  }

  const totalEstMs = currentRemMs + tailRemMs;
  const denom = turnElapsedMs + totalEstMs;
  const progressPercent = denom > 0 ? Math.min(92, Math.max(18, Math.round((turnElapsedMs / denom) * 100))) : 25;

  return {
    status: 'estimated',
    displayText: formatDurationRangeZh(totalEstMs * 0.75, totalEstMs * 1.35),
    basisText: '按当前阶段与历史同类任务节奏推算',
    progressPercent,
  };
}

function evaluateHealth({
  isTurnActive,
  waitingForUserInput,
  lastStepStatus,
  lastActivityMs,
  nowMs,
  warnThresholdSec,
  stuckThresholdSec,
  currentStage,
  activeToolLabel,
  activeTasksCount,
  activeSubagentsCount,
  loopDetected,
  lastError,
}) {
  if (waitingForUserInput) {
    return {
      level: 'waiting_user',
      label: '等待你的确认',
      silenceSec: 0,
      reason: '需要你回答问题或确认操作后继续',
    };
  }

  if (!isTurnActive) {
    if (lastStepStatus === 'ERROR' || lastError) {
      return {
        level: 'error',
        label: '执行遇到错误',
        silenceSec: 0,
        reason: lastError ? `上一轮执行异常：${lastError.slice(0, 80)}` : '上一轮执行出现错误中断',
      };
    }
    return {
      level: 'completed',
      label: '本轮已完成',
      silenceSec: 0,
      reason: '任务本轮已结束，等待你的下一条指令',
    };
  }

  const silenceSec = lastActivityMs > 0 ? Math.max(0, Math.round((nowMs - lastActivityMs) / 1000)) : 0;

  if (loopDetected) {
    return {
      level: 'stuck',
      label: '疑似卡住（重复打转）',
      silenceSec,
      reason: '检测到连续多次重复同一操作或连续报错，建议介入检查',
    };
  }

  if (silenceSec >= stuckThresholdSec) {
    const what = activeToolLabel
      ? `正在执行「${activeToolLabel}」`
      : activeTasksCount > 0
        ? '后台命令任务'
        : activeSubagentsCount > 0
          ? '子代理协同任务'
          : `阶段「${currentStage?.label || '推理响应'}」`;
    return {
      level: 'stuck',
      label: '疑似卡住',
      silenceSec,
      reason: `${what}已静默 ${silenceSec} 秒无新进展，可能等待交互或进程挂起`,
    };
  }

  if (silenceSec >= warnThresholdSec) {
    return {
      level: 'slow',
      label: '等待响应较久',
      silenceSec,
      reason: `正在等待当前步骤返回结果（已静默 ${silenceSec} 秒）`,
    };
  }

  return {
    level: 'healthy',
    label: '正常推进中',
    silenceSec,
    reason: activeSubagentsCount > 0
      ? `有 ${activeSubagentsCount} 个子代理正在协同执行`
      : activeTasksCount > 0
        ? '后台任务正在持续输出日志'
        : '思考与工具执行节奏正常',
  };
}

export function buildEmptyAnalysis(convId = '', conversations = [], reason = '') {
  const safeId = isValidConversationId(convId) ? String(convId).trim() : '';
  return {
    found: false,
    conversationId: safeId,
    conversations,
    taskTitle: safeId ? '当前对话暂无任务' : '等待进入对话',
    currentStage: {
      key: 'idle',
      label: '待命中',
      summary: safeId
        ? '在当前对话发送指令后，这里会独立追踪本对话的阶段与进展。'
        : '请在当前对话发送一条消息，任务脉搏将自动绑定本对话。',
    },
    health: {
      level: 'idle',
      label: '待命中',
      silenceSec: 0,
      reason: reason || '本对话暂无进行中的任务',
    },
    timing: { turnStartMs: 0, turnElapsedMs: 0, stageElapsedMs: 0, lastActivityAtMs: 0, isRunning: false },
    eta: { status: 'idle', displayText: '—', basisText: '等待本对话任务开始', progressPercent: 0 },
    explicitPlan: [],
    stageTimeline: [],
    thoughtFeed: [],
  };
}

export function analyzeConversation({
  conversationId,
  appDataDir = getDefaultAppDataDir(),
  warnThresholdSec = 45,
  stuckThresholdSec = 120,
  nowMs = Date.now(),
  strict = true,
  includeConversations = false,
} = {}) {
  const rawConvId = String(conversationId || '').trim();
  const validConvId = isValidConversationId(rawConvId) ? rawConvId : '';
  const conversations = includeConversations ? listConversations(appDataDir) : [];

  if (strict && !validConvId) {
    return buildEmptyAnalysis('', conversations, rawConvId ? '无效的会话标识' : '');
  }

  let targetId = validConvId;
  if (!targetId && !strict) {
    const fallbackList = includeConversations ? conversations : listConversations(appDataDir, 1);
    targetId = fallbackList[0]?.id || '';
  }

  if (!targetId) {
    return buildEmptyAnalysis('', conversations);
  }

  const convBrainDir = join(appDataDir, 'brain', targetId);
  const { steps, mtimeMs: transcriptMtimeMs } = readTranscriptLines(convBrainDir);
  const hookPath = join(appDataDir, 'plugin_data', 'task-pulse', 'live', `${sanitizeId(targetId)}.json`);
  const hookState = safeReadJsonFile(hookPath, {});

  if (steps.length === 0 && !hookState.isTurnActive) {
    return buildEmptyAnalysis(targetId, conversations);
  }

  let lastUserIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].source === 'USER_EXPLICIT' || steps[i].type === 'USER_INPUT') {
      lastUserIdx = i;
      break;
    }
  }

  const turnSteps = lastUserIdx >= 0 ? steps.slice(lastUserIdx) : steps;
  const userStep = lastUserIdx >= 0 ? steps[lastUserIdx] : null;

  // Walk backwards if latest user step is image-only/empty so title never degrades to generic fallback.
  let taskTitle = extractCleanUserTitle(userStep?.content || '', 56);
  if (steps.length === 0 && hookState.isTurnActive) {
    taskTitle = '正在启动新任务';
  } else if (taskTitle === '当前会话' && lastUserIdx > 0) {
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      if (steps[i].source === 'USER_EXPLICIT' || steps[i].type === 'USER_INPUT') {
        const candidate = extractCleanUserTitle(steps[i].content || '', 56);
        if (candidate && candidate !== '当前会话') {
          taskTitle = candidate;
          break;
        }
      }
    }
  }

  const turnStartMs =
    parseTimestampMs(userStep?.created_at) ||
    parseTimestampMs(hookState.activeTurnStartedAt) ||
    transcriptMtimeMs ||
    nowMs;

  const stageTimeline = [];
  const thoughtFeed = [];
  let prevStageKey = '';

  for (let i = 0; i < turnSteps.length; i++) {
    const step = turnSteps[i];
    if (step.type !== 'PLANNER_RESPONSE') continue;

    const stepMs = parseTimestampMs(step.created_at) || nowMs;
    const stage = detectStageFromStep(step, prevStageKey);
    const headline = buildChineseActionHeadline(stage, step);
    const contentSnippet = hasChinese(step.content) ? condenseThinking(step.content, 160) : '';
    const zhThinkingSnippet = hasChinese(step.thinking) ? condenseThinking(step.thinking, 155) : '';
    const thoughtSnippet = contentSnippet || zhThinkingSnippet;

    const lastStage = stageTimeline[stageTimeline.length - 1];
    if (lastStage && lastStage.key === stage.key) {
      lastStage.label = stage.label;
      lastStage.endedAtMs = stepMs;
      lastStage.stepCount += 1;
    } else {
      if (lastStage) {
        lastStage.endedAtMs = stepMs;
        lastStage.elapsedMs = Math.max(1000, lastStage.endedAtMs - lastStage.startedAtMs);
        lastStage.status = 'done';
      }
      stageTimeline.push({
        id: `stage-${stageTimeline.length + 1}`,
        key: stage.key,
        label: stage.label,
        status: 'active',
        startedAtMs: stepMs,
        endedAtMs: stepMs,
        elapsedMs: 0,
        stepCount: 1,
      });
    }
    prevStageKey = stage.key;

    if (headline || thoughtSnippet) {
      thoughtFeed.push({
        id: `thought-${step.step_index ?? i}`,
        stageLabel: stage.label,
        headline,
        thought: thoughtSnippet,
        timestampMs: stepMs,
      });
    }
  }

  const bg = inspectBackgroundActivity(convBrainDir, nowMs, turnStartMs, steps);
  const lastStep = turnSteps[turnSteps.length - 1] || null;
  const lastStepMs = parseTimestampMs(lastStep?.created_at);
  const lastHookMs = parseTimestampMs(hookState.lastEventAt);
  const lastStopMs = parseTimestampMs(hookState.lastStop?.at);

  const lastToolCalls = getToolCalls(lastStep);
  const askingQuestion = lastToolCalls.some((tc) => tc.name === 'ask_question');
  const hasPendingTools = lastStep?.type === 'PLANNER_RESPONSE' && lastToolCalls.length > 0;
  const waitingModelResponse =
    lastStep?.type === 'USER_INPUT' || lastStep?.type === 'GENERIC' || lastStep?.type === 'SYSTEM_MESSAGE';
  const hookSaysActive =
    Boolean(hookState.isTurnActive) &&
    lastHookMs >= turnStartMs &&
    lastHookMs > lastStopMs &&
    nowMs - lastHookMs < Math.max(stuckThresholdSec * 3, 600) * 1000;
  const hasErrorStep = lastStep?.status === 'ERROR' || lastStep?.type === 'ERROR_MESSAGE';
  const stopHookIdleAfterReply =
    lastStopMs >= turnStartMs &&
    lastStopMs >= lastStepMs &&
    hookState.lastEventType === 'Stop' &&
    hookState.lastStop?.fullyIdle !== false;

  const isFinalReply = lastStep?.type === 'PLANNER_RESPONSE' && !hasPendingTools && lastStep?.status === 'DONE';
  // Only genuine running background commands/tasks from THIS turn keep a final reply active; idle subagents never hijack finished turns.
  const hasWaitingBackground =
    (bg.activeTasks.length > 0 || (!isFinalReply && bg.activeSubagents.length > 0)) && !stopHookIdleAfterReply;

  const isTurnActive =
    !askingQuestion &&
    !hasErrorStep &&
    ((!isFinalReply && (waitingModelResponse || hasPendingTools || hookSaysActive)) || hasWaitingBackground);

  const turnEndMs = isTurnActive ? nowMs : Math.max(lastStepMs, lastStopMs, turnStartMs);
  const turnElapsedMs = Math.max(0, turnEndMs - turnStartMs);

  if (stageTimeline.length > 0) {
    const activeStage = stageTimeline[stageTimeline.length - 1];
    activeStage.status = isTurnActive ? 'active' : 'done';
    activeStage.endedAtMs = turnEndMs;
    for (const st of stageTimeline) {
      st.elapsedMs = Math.max(1000, st.endedAtMs - st.startedAtMs);
    }
  }

  const currentStageObj = stageTimeline[stageTimeline.length - 1] || {
    key: 'planning',
    label: isTurnActive ? '方案构思与启动' : '待命中',
    elapsedMs: turnElapsedMs,
  };

  const latestFeed = thoughtFeed[thoughtFeed.length - 1];
  const taskMdPath = join(convBrainDir, 'task.md');
  const taskMdText = existsSync(taskMdPath) ? readFileSync(taskMdPath, 'utf8') : '';
  const explicitPlan = extractExplicitPlan(turnSteps, taskMdText);

  if (explicitPlan.length > 0 && explicitPlan.every((p) => p.status === 'pending')) {
    const completedStages = stageTimeline.filter((s) => s.status === 'done').length;
    for (let idx = 0; idx < explicitPlan.length; idx++) {
      if (!isTurnActive) {
        explicitPlan[idx].status = 'done';
      } else if (idx < completedStages) {
        explicitPlan[idx].status = 'done';
      } else if (idx === completedStages) {
        explicitPlan[idx].status = 'active';
      }
    }
  } else if (explicitPlan.length > 0 && !isTurnActive) {
    for (const item of explicitPlan) {
      if (item.status === 'active') item.status = 'done';
    }
  }

  const lastActivityMs = Math.max(
    lastStepMs || transcriptMtimeMs,
    lastHookMs,
    bg.activeTasks.length > 0 ? bg.latestTaskActivityMs : 0,
    bg.activeSubagents.length > 0 ? bg.latestSubagentActivityMs : 0,
    turnStartMs
  );

  const activeToolLabel = hasPendingTools
    ? unwrapArg(lastToolCalls[lastToolCalls.length - 1]?.args?.toolSummary) ||
      lastToolCalls[lastToolCalls.length - 1]?.name ||
      ''
    : '';

  const loopDetected = detectToolLoop(turnSteps, hookState, turnStartMs);
  const effectiveHookError =
    hookState.lastError && lastHookMs >= turnStartMs && lastHookMs >= lastStepMs
      ? hookState.lastError
      : '';
  const health = evaluateHealth({
    isTurnActive,
    waitingForUserInput: askingQuestion,
    lastStepStatus: hasErrorStep ? 'ERROR' : lastStep?.status,
    lastActivityMs,
    nowMs,
    warnThresholdSec,
    stuckThresholdSec,
    currentStage: currentStageObj,
    activeToolLabel,
    activeTasksCount: bg.activeTasks.length,
    activeSubagentsCount: bg.activeSubagents.length,
    loopDetected,
    lastError: effectiveHookError,
  });

  const history = loadHistoryStats(appDataDir).data;
  const eta = estimateRemainingTime({
    isTurnActive,
    turnElapsedMs,
    stageTimeline,
    explicitPlan,
    historyStageMs: history.stageDurationsMs,
    turnSteps,
  });

  if (!isTurnActive && turnSteps.length >= 2) {
    recordTurnStatsIfCompleted(
      appDataDir,
      `${targetId}:${turnStartMs}`,
      stageTimeline,
      health.level === 'completed'
    );
  }

  // Track compaction count honestly (UI delegates real context % to native bottom monitor).
  let lastCheckpointIdx = -1;
  let checkpointCount = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'CHECKPOINT') {
      lastCheckpointIdx = i;
      checkpointCount++;
    }
  }
  const activeContextSteps = steps.slice(lastCheckpointIdx >= 0 ? lastCheckpointIdx : 0);
  let totalChars = 0;
  for (const st of activeContextSteps) {
    if (st.content) totalChars += String(st.content).length;
    if (Array.isArray(st.tool_calls)) {
      for (const tc of st.tool_calls) {
        totalChars += (tc.name || '').length + JSON.stringify(tc.args || {}).length;
      }
    }
  }
  const estimatedTokens = Math.max(500, Math.round(totalChars / 3.5));
  const maxContextTokens = 1000000;
  const percentUsed = Math.min(100, Math.max(1, Math.round((estimatedTokens / maxContextTokens) * 100)));
  const contextUsage = {
    estimatedTokens,
    percentUsed,
    level: percentUsed >= 85 ? 'danger' : percentUsed >= 65 ? 'warning' : 'healthy',
    statusText: checkpointCount > 0 ? `已压缩 ${checkpointCount} 次` : '充裕',
    label: checkpointCount > 0
      ? `约 ${Math.round(estimatedTokens / 1000)}k tokens · 已压缩 ${checkpointCount} 次`
      : `约 ${Math.round(estimatedTokens / 1000)}k tokens · 充裕`,
    checkpointCount,
  };

  return {
    found: true,
    conversationId: targetId,
    conversations,
    taskTitle,
    currentStage: {
      key: currentStageObj.key,
      label: currentStageObj.label,
      summary: latestFeed?.headline || (isTurnActive ? `正在执行「${currentStageObj.label}」` : '本轮任务已结束'),
    },
    health,
    timing: {
      turnStartMs,
      turnElapsedMs,
      stageElapsedMs: currentStageObj.elapsedMs || 0,
      lastActivityAtMs: lastActivityMs,
      isRunning: isTurnActive,
    },
    eta,
    contextUsage,
    explicitPlan,
    stageTimeline: stageTimeline.slice(-6),
    thoughtFeed: thoughtFeed.slice(-8).reverse(),
  };
}
