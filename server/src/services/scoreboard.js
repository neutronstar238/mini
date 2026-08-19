'use strict';
/**
 * 内存排行榜（Scoreboard Runtime）—— 按比赛维度 ICPC 风格
 * - 每个比赛独立榜单（contestId -> userId -> userStat）
 * - ICPC 计分：Solved（通过题数）、Penalty（罚时）
 *    罚时 = Σ( 该题 AC 时距比赛开始的分钟数 + 20 × 该题 AC 前的错误提交次数 )
 * - 每题状态格（每队每题）：
 *    AC：显示解出所用分钟数（绿色）；未解：显示 -错误次数（红色/灰）
 * - 每题列头全局统计：acPeople（多少人通过）/ submitPeople（多少人提交）
 * - Judge Result 到达 → 更新 runtime + dirty；10s batch → SSE 广播 delta
 */
const config = require('../config');
const db = require('../store/db');
const hub = require('../sse/hub');
const contestService = require('./contestService');

/** contestId -> userId -> userStat */
/** userStat: { solved:Set, penaltyMs:number, problems:{problemId:{solved,firstSolvedAtMs,attempts,lastVerdict}} } */
const scoreboardRuntime = new Map();
let scoreboardVersion = 0;
const dirtyParticipants = new Map(); // contestId -> Set<userId>

function contestOf(contestId) {
  if (!scoreboardRuntime.has(contestId)) scoreboardRuntime.set(contestId, new Map());
  return scoreboardRuntime.get(contestId);
}

function dirtyOf(contestId) {
  if (!dirtyParticipants.has(contestId)) dirtyParticipants.set(contestId, new Set());
  return dirtyParticipants.get(contestId);
}

/** 从 DB 重建（启动时） */
function recomputeFromDb() {
  const dbx = require('../store/db');
  scoreboardRuntime.clear();
  const subs = dbx.submissions.all();
  for (const s of subs) onVerdict(s, true);
}

/**
 * 依据一条提交更新内存榜单（AC 计入 solved/penalty；非 AC 记录错误次数）
 */
function onVerdict(submission, fromRecompute = false) {
  if (!submission || !submission.contestId) return;
  // 非 AC：记录该题的错误尝试（计入该队该题 attempts 与罚时）
  const cMap = contestOf(submission.contestId);
  const st = cMap.get(submission.userId) || { solved: new Set(), penaltyMs: 0, problems: {} };
  const pr = st.problems[submission.problemId] || { solved: false, firstSolvedAtMs: 0, attempts: 0, lastVerdict: submission.status };
  pr.lastVerdict = submission.status;

  if (submission.status === 'AC') {
    if (!pr.solved) {
      pr.solved = true;
      pr.firstSolvedAtMs = new Date(submission.serverReceivedAt || submission.createdAt).getTime();
      pr.attempts += 1; // 成功的这次也算一次提交（用于罚时计算错误次数时排除）
      st.solved.add(submission.problemId);
      // 罚时 = 每题 AC 分钟 + 20 × 错误次数
      const contest = db.contests.byId(submission.contestId);
      const startMs = contest ? Number(contest.startTimeMs) || 0 : 0;
      const acMinutes = startMs ? Math.max(0, Math.floor((pr.firstSolvedAtMs - startMs) / 60000)) : 0;
      const wrongAttempts = Math.max(0, (pr.attempts || 1) - 1);
      const penalty = acMinutes + 20 * wrongAttempts;
      st.penaltyMs += penalty; // 统一以"分钟"为罚时单位
      st.problems[submission.problemId] = pr;
    }
  } else {
    // 未通过：累计错误次数（仅终态错误计数，且发生在该队已提交但未 AC）
    if (!pr.solved) {
      pr.attempts += 1;
      st.problems[submission.problemId] = pr;
    }
  }
  cMap.set(submission.userId, st);
  if (!fromRecompute) dirtyOf(submission.contestId).add(submission.userId);
}

/**
 * 生成某比赛的有序 ICPC 榜单快照
 * @param {string} contestId
 * @returns {{version, contest, problems:Array, rows:Array, colStats:Object}}
 */
function buildSnapshot(contestId) {
  const dbx = require('../store/db');
  const contest = dbx.contests.byId(contestId);
  if (!contest) return { version: scoreboardVersion, contest: null, problems: [], rows: [], colStats: {} };

  const problems = contestService.problemsOf(contestId);
  const cMap = scoreboardRuntime.get(contestId) || new Map();
  const colStats = contestService.colStats(contestId);

  const rows = [];
  for (const [uid, st] of cMap) {
    const u = dbx.users.byId(uid);
    if (!u) continue;
    const cells = {};
    let solvedCount = 0;
    problems.forEach((p, i) => {
      const pr = st.problems[p.id];
      const letter = contestService.letterOf(i);
      if (pr && pr.solved) {
        solvedCount++;
        cells[p.id] = { letter, status: 'AC', minutes: Math.round(pr.firstSolvedAtMs && contest ? (pr.firstSolvedAtMs - (Number(contest.startTimeMs) || 0)) / 60000 : 0), attempts: pr.attempts || 0 };
      } else if (pr && pr.lastVerdict && !['SUBMITTED', 'PENDING', 'LEASED', 'COMPILING', 'RUNNING', 'VERIFYING'].includes(pr.lastVerdict)) {
        cells[p.id] = { letter, status: 'failed', attempts: pr.attempts || 0, lastVerdict: pr.lastVerdict };
      } else {
        cells[p.id] = { letter, status: 'none', attempts: 0 };
      }
    });
    rows.push({
      userId: uid,
      username: u.username,
      nickname: u.nickname || '',
      solved: solvedCount,
      penalty: st.penaltyMs || 0,
      cells
    });
  }
  // ICPC 排序：Solved 降序，Penalty 升序
  rows.sort((a, b) => b.solved - a.solved || a.penalty - b.penalty);
  // 附加 rank
  rows.forEach((r, i) => { r.rank = i + 1; });

  return { version: scoreboardVersion, contest: publicContestBrief(contest), problems: problems.map((p, i) => ({ id: p.id, letter: contestService.letterOf(i), title: p.title })), rows, colStats };
}

function publicContestBrief(c) {
  return { id: c.id, title: c.title, startTimeMs: c.startTimeMs, status: contestService.contestStatus(c) };
}

/** 完整快照（首次加载 / bootstrap / SSE 首推） */
function fullSnapshot(contestId) {
  return buildSnapshot(contestId);
}

/** 取某用户排名行的 delta 变化 */
function deltaFor(contestId, uid) {
  const snap = buildSnapshot(contestId);
  const row = snap.rows.find((r) => r.userId === uid);
  return row || null;
}

/** 周期 batch：dirty → version++ → delta → SSE 广播（10 秒） */
if (config.entry === 'all' || config.entry === 'contest') {
  setInterval(() => {
    let any = false;
    for (const [contestId, set] of dirtyParticipants) {
      if (set.size === 0) continue;
      any = true;
      scoreboardVersion++;
      const changes = [];
      for (const uid of set) {
        const row = deltaFor(contestId, uid);
        if (row) changes.push({ contestId, row });
      }
      set.clear();
      hub.emit('page', 'scoreboard_delta', {
        version: scoreboardVersion,
        contestId,
        changes
      });
    }
    if (any) dirtyParticipants.clear();
  }, config.CONTESTANT_BATCH_INTERVAL);
}

module.exports = { onVerdict, fullSnapshot, recomputeFromDb, getVersion: () => scoreboardVersion };
