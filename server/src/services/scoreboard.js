'use strict';
/**
 * 内存排行榜（Scoreboard Runtime）—— 指导文档 §13/§14
 * - Judge Result 到达：持久化后更新 scoreboardRuntime + dirtyParticipants
 * - 每 10 秒：scoreboardVersion++，生成 delta，SSE 广播，清 dirty
 * - 禁止每次广播完整榜单；首次加载才允许 full snapshot
 * - 只按"正式提交（env.trusted=true 或 formal 模式）"计入
 */
const config = require('../config');
const hub = require('../sse/hub');

/** userStats: userId -> { solved:Set, penaltyMs, problems:{problemId:{solved,solvedAtMs}} } */
const scoreboardRuntime = new Map();
let scoreboardVersion = 0;
const dirtyParticipants = new Set();
const participantsSnapshot = []; // 有序排名快照

function recomputeFromDb() {
  const db = require('../store/db');
  const subs = db.submissions.all();
  scoreboardRuntime.clear();
  for (const s of subs) {
    if (s.status !== 'AC') continue;
    if (!s.env?.trusted && s.judgedAt && !s.verdictIsTrusted) continue;
    onVerdict(s, true);
  }
}

/** 依据一条 AC 提交更新内存榜单 */
function onVerdict(submission, fromRecompute = false) {
  if (!submission || submission.status !== 'AC') return;
  // 正式榜单仅采信可信 Worker 结果
  const trusted = !!submission.env?.trusted;
  const st = scoreboardRuntime.get(submission.userId) || { solved: new Set(), penaltyMs: 0, problems: {} };
  if (!st.solved.has(submission.problemId)) {
    st.solved.add(submission.problemId);
    st.penaltyMs += new Date(submission.serverReceivedAt || submission.createdAt).getTime();
    st.problems[submission.problemId] = { solved: true, trusted };
    scoreboardRuntime.set(submission.userId, st);
  }
  if (!fromRecompute) dirtyParticipants.add(submission.userId);
}

/** 生成有序快照（按 AC 数降序、罚时升序） */
function buildSnapshot() {
  const db = require('../store/db');
  const rows = [];
  for (const [uid, st] of scoreboardRuntime) {
    const u = db.users.byId(uid);
    rows.push({
      userId: uid,
      username: u ? u.username : uid,
      nickname: u ? u.nickname : '',
      solvedCount: st.solved.size,
      penaltyMs: st.penaltyMs
    });
  }
  rows.sort((a, b) => b.solvedCount - a.solvedCount || a.penaltyMs - b.penaltyMs);
  return rows;
}

/** 完整快照（仅首次加载 / bootstrap 使用） */
function fullSnapshot() {
  const rows = buildSnapshot();
  return { version: scoreboardVersion, rows };
}

/** 取某用户排名行的 delta 变化 */
function deltaFor(uid) {
  const rows = buildSnapshot();
  const row = rows.find((r) => r.userId === uid);
  return row || null;
}

/** 周期 batch：dirty → version++ → delta → SSE 广播（10 秒） */
if (config.entry === 'all' || config.entry === 'contest') {
  setInterval(() => {
    if (dirtyParticipants.size === 0) return;
    scoreboardVersion++;
    const changes = [];
    for (const uid of dirtyParticipants) {
      const row = deltaFor(uid);
      if (row) changes.push(row);
    }
    dirtyParticipants.clear();
    hub.emit('page', 'scoreboard_delta', {
      version: scoreboardVersion,
      changes
    });
  }, config.CONTESTANT_BATCH_INTERVAL);
}

module.exports = { onVerdict, fullSnapshot, recomputeFromDb, getVersion: () => scoreboardVersion };
