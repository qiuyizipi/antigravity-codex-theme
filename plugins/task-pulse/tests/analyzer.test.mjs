import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeConversation, condenseThinking, extractExplicitPlan } from '../sidecars/panel/analyzer.mjs';

const HOOK_SCRIPT = join(import.meta.dirname, '..', 'scripts', 'hook.mjs');

function makeTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'task-pulse-test-'));
  const convId = 'conv-1111-2222-3333';
  const convDir = join(root, 'brain', convId);
  mkdirSync(join(convDir, '.system_generated', 'logs'), { recursive: true });
  mkdirSync(join(convDir, '.system_generated', 'tasks'), { recursive: true });
  mkdirSync(join(convDir, '.system_generated', 'subagents'), { recursive: true });
  return { root, convId, convDir };
}

function writeTranscript(convDir, steps) {
  const logPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
  writeFileSync(logPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
}

test('condenseThinking strips XML tags, code blocks, and raw file paths', () => {
  const raw =
    '<USER_REQUEST>ignore</USER_REQUEST>I am checking C:\\Users\\Admin\\project\\src\\auth.ts#L10-L40 and /Users/dev/app/main.py now. ```js\nconst a = 1;\n``` Next I will update the auth guard.';
  const out = condenseThinking(raw);
  assert.ok(!out.includes('C:\\Users'), 'Windows path should be stripped');
  assert.ok(!out.includes('/Users/dev'), 'Unix path should be stripped');
  assert.ok(!out.includes('const a = 1'), 'Code fence should be stripped');
  assert.ok(out.includes('auth guard'), 'Readable reasoning should remain');
});

test('hook.mjs handles lifecycle events and malformed stdin safely', () => {
  const { root, convId } = makeTempEnv();
  try {
    const env = { ...process.env, ANTIGRAVITY_APP_DATA_DIR: root };
    const out1 = execFileSync(process.execPath, [HOOK_SCRIPT, 'PreInvocation'], {
      input: JSON.stringify({ conversationId: convId, modelName: 'Gemini 3.8 Flash' }),
      encoding: 'utf8',
      env,
    });
    assert.equal(out1.trim(), '{}');

    const out2 = execFileSync(process.execPath, [HOOK_SCRIPT, 'PostToolUse'], {
      input: JSON.stringify({
        conversationId: convId,
        stepIdx: 3,
        toolCall: { name: 'run_command', args: { toolSummary: '跑冒烟测试' } },
      }),
      encoding: 'utf8',
      env,
    });
    assert.equal(out2.trim(), '{}');

    const livePath = join(root, 'plugin_data', 'task-pulse', 'live', `${convId}.json`);
    const live = JSON.parse(readFileSync(livePath, 'utf8'));
    assert.equal(live.isTurnActive, true);
    assert.equal(live.lastTool.name, 'run_command');
    assert.equal(live.lastTool.summary, '跑冒烟测试');

    const badOut = execFileSync(process.execPath, [HOOK_SCRIPT, 'PostToolUse'], {
      input: '{not-valid-json',
      encoding: 'utf8',
      env,
    });
    assert.equal(badOut.trim(), '{}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeConversation classifies stages, computes ETA from task.md, and detects smoke test', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-10T10:00:00Z');
    writeFileSync(
      join(convDir, 'task.md'),
      '- [x] 排查鉴权逻辑 (~1m)\n- [x] 修改代码 (~2m)\n- [/] 跑冒烟测试 (~2m)\n- [ ] 复查总结 (~1m)\n',
      'utf8'
    );
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>修复登录超时问题并验证</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 5000).toISOString(),
        thinking: '先排查鉴权与 token 刷新逻辑，定位超时根因。',
        tool_calls: [{ name: 'grep_search', args: { query: 'refreshToken' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 65000).toISOString(),
        thinking: '已定位超时位置，准备修改重试策略与缓存过期判断。',
        tool_calls: [{ name: 'replace_file_content', args: { TargetFile: 'auth.ts' } }],
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 145000).toISOString(),
        thinking: '代码修改完成，现在跑冒烟测试验证登录主流程。',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'npm run test:smoke', toolSummary: '跑冒烟测试' } },
        ],
      },
    ]);

    const res = analyzeConversation({
      conversationId: convId,
      appDataDir: root,
      warnThresholdSec: 45,
      stuckThresholdSec: 120,
      nowMs: baseMs + 160000,
    });

    assert.equal(res.found, true);
    assert.equal(res.currentStage.key, 'testing');
    assert.equal(res.currentStage.label, '跑冒烟测试');
    assert.equal(res.health.level, 'healthy');
    assert.equal(res.timing.isRunning, true);
    assert.equal(res.timing.turnElapsedMs, 160000);
    assert.equal(res.eta.status, 'estimated');
    assert.ok(res.eta.progressPercent >= 40 && res.eta.progressPercent <= 95);
    assert.ok(res.eta.displayText.includes('分钟') || res.eta.displayText.includes('秒'));
    assert.equal(res.explicitPlan.length, 4);
    assert.ok(res.thoughtFeed.length >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeConversation detects stuck state, loop state, and waiting_user accurately', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-10T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>运行全量构建</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 5000).toISOString(),
        thinking: '开始执行构建脚本检查产物。',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run build', toolSummary: '执行构建检查' } }],
      },
    ]);

    // Case 1: Silence >= 120s -> stuck
    const stuckRes = analyzeConversation({
      conversationId: convId,
      appDataDir: root,
      warnThresholdSec: 45,
      stuckThresholdSec: 120,
      nowMs: baseMs + 140000,
    });
    assert.equal(stuckRes.health.level, 'stuck');
    assert.ok(stuckRes.health.reason.includes('执行构建检查'));

    // Case 2: Silence between 45s and 120s -> slow
    const slowRes = analyzeConversation({
      conversationId: convId,
      appDataDir: root,
      warnThresholdSec: 45,
      stuckThresholdSec: 120,
      nowMs: baseMs + 65000,
    });
    assert.equal(slowRes.health.level, 'slow');

    // Case 3: Repeated identical tool calls -> stuck (loop)
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>修复测试</USER_REQUEST>',
      },
      ...[1, 2, 3, 4].map((idx) => ({
        step_index: idx,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + idx * 5000).toISOString(),
        thinking: '再试一次跑测试',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      })),
    ]);
    const loopRes = analyzeConversation({
      conversationId: convId,
      appDataDir: root,
      nowMs: baseMs + 25000,
    });
    assert.equal(loopRes.health.level, 'stuck');
    assert.ok(loopRes.health.label.includes('重复打转'));

    // Case 4: Final PLANNER_RESPONSE without tools -> completed
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>复查完成了吗</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 30000).toISOString(),
        thinking: '已复查完毕。',
        content: '已经复查完毕，所有检查通过。',
      },
    ]);
    const doneRes = analyzeConversation({
      conversationId: convId,
      appDataDir: root,
      nowMs: baseMs + 200000,
    });
    assert.equal(doneRes.timing.isRunning, false);
    assert.equal(doneRes.health.level, 'completed');
    assert.equal(doneRes.eta.status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractExplicitPlan parses inline stage plan lines', () => {
  const plan = extractExplicitPlan([
    {
      type: 'PLANNER_RESPONSE',
      content: '阶段计划：1. 定位原因(~1m) → 2. 修改代码(~3m) → 3. 跑冒烟测试(~2m)',
    },
  ]);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].title, '定位原因');
  assert.equal(plan[0].estimatedMs, 60000);
  assert.equal(plan[2].title, '跑冒烟测试');
  assert.equal(plan[2].estimatedMs, 120000);
});

test('analyzeConversation treats ask_question as waiting_user and respects live background task logs', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const now = Date.now();
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(now - 200000).toISOString(),
        content: '<USER_REQUEST>跑个大构建任务</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(now - 190000).toISOString(),
        thinking: '正在运行全量构建任务。',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run build' } }],
      },
    ]);
    // Fresh active background log file prevents false stuck alarm.
    writeFileSync(join(convDir, '.system_generated', 'tasks', 'task-1.log'), 'Building bundle...\n', 'utf8');
    const activeBg = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: now });
    assert.equal(activeBg.health.level, 'healthy');

    // ask_question -> waiting_user, not stuck
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(now - 300000).toISOString(),
        content: '<USER_REQUEST>帮我决定方案</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(now - 290000).toISOString(),
        thinking: '需要用户确认方案偏好。',
        tool_calls: [{ name: 'ask_question', args: { questions: [] } }],
      },
    ]);
    const waitRes = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: now });
    assert.equal(waitRes.health.level, 'waiting_user');
    assert.equal(waitRes.timing.isRunning, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel read_file calls on different Paths and Test-Path commands do not misclassify', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-10T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>继续排查日志并检查五个文件</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 3000).toISOString(),
        content: '先并行读取核心配置与源码进行核对。',
        tool_calls: [
          { name: 'read_file', args: { Path: 'a.mjs', StartLine: 1, EndLine: 50 } },
          { name: 'read_file', args: { Path: 'b.mjs', StartLine: 1, EndLine: 50 } },
          { name: 'read_file', args: { Path: 'c.mjs', StartLine: 1, EndLine: 50 } },
          { name: 'read_file', args: { Path: 'd.mjs', StartLine: 1, EndLine: 50 } },
          { name: 'read_file', args: { Path: 'e.mjs', StartLine: 1, EndLine: 50 } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 8000).toISOString(),
        tool_calls: [
          {
            name: 'run_command',
            args: {
              toolSummary: 'Check node paths and Antigravity logs',
              CommandLine: 'if (Test-Path "$env:USERPROFILE\\.gemini") { Get-Content sidecar.log }',
            },
          },
        ],
      },
    ]);

    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 15000 });
    assert.equal(res.health.level, 'healthy', 'Reading different files must not trigger loop stuck');
    assert.equal(res.currentStage.key, 'research', 'Diagnostic Test-Path command should stay in research');
    assert.ok(!res.currentStage.summary.includes('跑测试'), 'Should not claim testing for Test-Path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canceled background tasks and prior-turn hook errors do not poison active turn', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-10T10:00:00Z');
    const liveDir = join(root, 'plugin_data', 'task-pulse', 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      join(liveDir, `${convId}.json`),
      JSON.stringify({
        conversationId: convId,
        isTurnActive: false,
        lastEventType: 'Stop',
        lastEventAt: new Date(baseMs + 10000).toISOString(),
        lastStop: { at: new Date(baseMs - 5000).toISOString(), fullyIdle: true },
        recentTools: [
          { name: 'run_command', error: 'e1', at: new Date(baseMs - 30000).toISOString() },
          { name: 'run_command', error: 'e2', at: new Date(baseMs - 20000).toISOString() },
          { name: 'run_command', error: 'e3', at: new Date(baseMs - 10000).toISOString() },
        ],
      }),
      'utf8'
    );
    writeFileSync(join(convDir, '.system_generated', 'tasks', 'task-299.log'), 'Scanning...\n', 'utf8');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>整理最后结果</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: new Date(baseMs + 2000).toISOString(),
        content: '<SYSTEM_MESSAGE>[Message] sender=conv/task-299 content=Task id "conv/task-299" was canceled</SYSTEM_MESSAGE>',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 9000).toISOString(),
        thinking: 'Checking final wording for the user.',
        content: '已经检查并完成全部修正，功能正常。',
      },
    ]);

    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 20000 });
    assert.equal(res.timing.isRunning, false);
    assert.equal(res.health.level, 'completed');
    assert.ok(res.thoughtFeed[0].thought.includes('已经检查并完成'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('condenseThinking truncates cleanly on word boundary without mid-word clipping', () => {
  const raw = 'This positive outcome strongly suggests the core mechanism works reliably without clipping any English identifier or long technical word at the end.';
  const out = condenseThinking(raw, 78);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('mec…'));
});

test('analyzeConversation computes contextUsage with compaction count and token estimates', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-10T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '# Resuming from compaction\nOld content...',
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs + 1000).toISOString(),
        content: '继续执行多轮大型分析任务',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 2000).toISOString(),
        thinking: '正在计算上下文消耗与执行计划。',
        content: '正在处理中...',
      },
    ]);

    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 5000 });
    assert.ok(res.contextUsage, 'contextUsage must be present');
    assert.equal(res.contextUsage.checkpointCount, 1);
    assert.ok(res.contextUsage.estimatedTokens > 0);
    assert.ok(res.contextUsage.label.includes('tokens'));
    assert.ok(res.contextUsage.label.includes('已压缩 1 次'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2.0: native update_steps/update_focus and agy-fast MCP tools classify accurately', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-24T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>升级任务脉搏并验证</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 5000).toISOString(),
        thinking: 'Let me edit the file in English internal reasoning.',
        content: '',
        tool_calls: [
          {
            name: 'update_steps',
            args: {
              steps: [
                { title: '审计代码', status: 'done' },
                { title: '修复核心逻辑', status: 'in_progress' },
                { title: '跑回归测试', status: 'pending' },
              ],
            },
          },
          { name: 'update_focus', args: { focus: '正在修复核心分析器逻辑' } },
          { name: 'mcp_agy-fast_fast_apply_edits', args: { toolSummary: '批量修改核心文件' } },
        ],
      },
    ]);
    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 15000 });
    assert.equal(res.currentStage.key, 'coding');
    assert.equal(res.currentStage.summary, '正在修复核心分析器逻辑');
    assert.equal(res.explicitPlan.length, 3);
    assert.equal(res.explicitPlan[0].status, 'done');
    assert.equal(res.explicitPlan[1].status, 'active');
    assert.equal(res.thoughtFeed[0].thought, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2.0: idle SUBAGENT_STATE_ALIVE after finished reply never triggers fake stuck alert', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-24T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>继续</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 10000).toISOString(),
        content: '全部核查完成，结果已归档到 [报告](file:///C:/tmp/a.md)。',
      },
    ]);
    const subId = 'sub-idle-1';
    const subDir = join(convDir, '.system_generated', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `${subId}.json`), JSON.stringify({ conversationId: subId, state: 'SUBAGENT_STATE_ALIVE' }));
    const subConvDir = join(root, 'brain', subId);
    mkdirSync(join(subConvDir, '.system_generated', 'logs'), { recursive: true });
    writeTranscript(subConvDir, [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(baseMs + 5000).toISOString(),
        content: '子代理检查完成。',
      },
    ]);
    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 1800000 });
    assert.equal(res.timing.isRunning, false);
    assert.equal(res.health.level, 'completed');
    assert.ok(!res.thoughtFeed[0].thought.includes('[]()'));
    assert.ok(res.thoughtFeed[0].thought.includes('报告'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2.0: image-only latest USER_INPUT falls back to previous readable user title', () => {
  const { root, convId, convDir } = makeTempEnv();
  try {
    const baseMs = Date.parse('2026-11-24T10:00:00Z');
    writeTranscript(convDir, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs).toISOString(),
        content: '<USER_REQUEST>帮我优化主题字重</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(baseMs + 5000).toISOString(),
        content: '<ADDITIONAL_METADATA>image only</ADDITIONAL_METADATA>',
      },
    ]);
    const res = analyzeConversation({ conversationId: convId, appDataDir: root, nowMs: baseMs + 6000 });
    assert.equal(res.taskTitle, '帮我优化主题字重');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
