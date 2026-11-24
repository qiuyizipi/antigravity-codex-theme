/**
 * Lifecycle hook handler for Task Pulse.
 * Records lightweight execution heartbeats (SessionStart, PreInvocation,
 * PostToolUse, PostInvocation, Stop) without altering tool permissions.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function sanitizeId(rawId) {
  const value = String(rawId || 'default').trim();
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function getLiveFilePath(conversationId) {
  const appDataDir =
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || homedir(), '.gemini', 'antigravity');
  const liveDir = join(appDataDir, 'plugin_data', 'task-pulse', 'live');
  mkdirSync(liveDir, { recursive: true });
  return join(liveDir, `${sanitizeId(conversationId)}.json`);
}

function safeReadJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath, data) {
  const content = JSON.stringify(data);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch {
    try {
      writeFileSync(filePath, content, 'utf8');
    } catch {
      // Fail-open so hooks never stall the agent loop.
    }
  }
}

function summarizeTool(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return { name: '', summary: '' };
  const name = String(toolCall.name || '').trim();
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  let summary = '';
  if (args.toolSummary) {
    summary = String(args.toolSummary).trim();
  } else if (args.toolAction) {
    summary = String(args.toolAction).trim();
  } else if (args.Role) {
    summary = String(args.Role).trim();
  } else if (args.CommandLine) {
    summary = String(args.CommandLine).trim().replace(/\s+/g, ' ').slice(0, 60);
  } else if (args.query) {
    summary = String(args.query).trim().slice(0, 60);
  }
  return { name, summary };
}

function updateState(eventType, payload, nowIso) {
  const convId = payload.conversationId;
  if (!convId) return;

  const livePath = getLiveFilePath(convId);
  const prev = safeReadJson(livePath);

  const next = {
    conversationId: convId,
    modelName: payload.modelName || prev.modelName || '',
    lastEventType: eventType,
    lastEventAt: nowIso,
    activeTurnStartedAt: prev.activeTurnStartedAt || nowIso,
    isTurnActive: prev.isTurnActive ?? false,
    lastTool: prev.lastTool || null,
    recentTools: Array.isArray(prev.recentTools) ? prev.recentTools.slice(-7) : [],
    lastError: prev.lastError || '',
    lastStop: prev.lastStop || null,
  };

  if (eventType === 'SessionStart') {
    next.activeTurnStartedAt = nowIso;
    next.isTurnActive = false;
    next.recentTools = [];
    next.lastTool = null;
    next.lastError = '';
  } else if (eventType === 'PreInvocation') {
    if (!prev.isTurnActive) {
      next.activeTurnStartedAt = nowIso;
      next.recentTools = [];
      next.lastTool = null;
      next.lastError = '';
    }
    next.isTurnActive = true;
  } else if (eventType === 'PostToolUse') {
    const { name, summary } = summarizeTool(payload.toolCall);
    const err = payload.error ? String(payload.error).slice(0, 200) : '';
    const entry = {
      name,
      summary,
      stepIdx: payload.stepIdx ?? null,
      error: err,
      at: nowIso,
    };
    next.isTurnActive = true;
    next.lastTool = entry;
    next.recentTools = [...next.recentTools, entry].slice(-8);
    next.lastError = err;
  } else if (eventType === 'PostInvocation') {
    next.isTurnActive = true;
  } else if (eventType === 'Stop') {
    next.isTurnActive = false;
    next.lastStop = {
      at: nowIso,
      terminationReason: String(payload.terminationReason || 'COMPLETED'),
      error: payload.error ? String(payload.error).slice(0, 200) : '',
      fullyIdle: payload.fullyIdle !== false,
    };
    if (payload.error) {
      next.lastError = String(payload.error).slice(0, 200);
    }
  }

  atomicWriteJson(livePath, next);
}

function readStdinUtf8() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const eventType = process.argv[2] || 'Unknown';
  const raw = readStdinUtf8().trim();
  if (raw) {
    try {
      const payload = JSON.parse(raw);
      updateState(eventType, payload, new Date().toISOString());
    } catch {
      // Ignore malformed stdin and fail open.
    }
  }
  process.stdout.write('{}\n');
}

main();
