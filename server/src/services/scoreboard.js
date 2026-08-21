'use strict';
/**
 * 内存排行榜（Scoreboard Runtime）—— 按比赛维度 ICPC 风格，关系库权威（Phase 5）
 *
 * 数据来源：
 *  - 唯一权威 = SQLite（oj_contests / oj_problems / oj_users / oj_submissions）
 *  - 内存 = derived cache，仅加速读取与 SSE 推送；任何时候可从 SQLite 重建。
 *
 * 计分（ICPC）：
 *   solved      = 通过题数
 *   penalty     = Σ( 该题 AC 时距比赛开始的分钟数 + 20 × 该题 AC 前的错误提交次数 )
 *   wrongAttempts = 该题 AC 前的错误提交次数
 *   acceptedAt  = 该题 AC 的服务器接受时刻（权威）
 *
 * 稳定排序：solved DESC → penalty ASC → lastAcceptedAt ASC → userId ASC
 *
 * 增量更新：
 *   Submission FINISHED → recomputeParticipant(contestId,userId)（从 SQLite 重算单选手，保证 Rejudge 正确）
 *   → dirtyParticipants.add(userId) → 10s batch → SSE scoreboard-delta（只推变化用户）
 *
 * Freeze（最小预留）：若 contest.freeze_at 存在且当前在封榜期，普通选手投影隐藏其后新结果；
 *   Admin 仍可见真实结果。数据库始终保存真实结果，只改 public projection。
 *   当前项目未启用封榜，仅预留字段/interface，不做复杂动画。
 *
 * 与文档模式旧 scoreboard 的区别：本模块读取关系库（oj_*），不复用 store/db。
 */
const config = require('../config');
const hub = require('../sse/hub');
const contestRepo = require('../store/repositories/contest-repository');
const problemRepo = require('../store/repositories/problem-repository');
const userRepo = require('../store/repositories/user-repository');
const submissionRepo = require('../store/repositories/submission-repository');

/** contestId -> Map<userId, userStat> */
/** userStat: { solved:Set, penaltyMs:number, lastAcceptedAtMs:number, problems:{problemId:{solved,attempts,firstSolvedAtMs,acceptedAtMs,lastVerdict}} } */
const scoreboardRuntime = new Map();

/** contestId -> version（每比赛独立 version，初始 0，首个 delta 从 1 开始） */
const scoreboardVersion = new Map();

/** contestId -> Set<userId>（待批量推送的变化用户） */
const dirtyParticipants = new Map();

/**
 * contestId -> { version, snapshot }：已构建的内存 Snapshot 缓存。
 * 关键：Full Snapshot / SSE 重复请求同一 version 时直接命中缓存，0 次 SQLite 查询。
 * 仅在 version 变化（bumpVersion）或 rebuild 时失效重建。
 */
const snapshotCache = new Map();

/* ================= 基础结构 ================= */
function contestOf(contestId) {
  if (!scoreboardRuntime.has(contestId)) scoreboardRuntime.set(contestId, new Map());
  return scoreboardRuntime.get(contestId);
}
function dirtyOf(contestId) {
  if (!dirtyParticipants.has(contestId)) dirtyParticipants.set(contestId, new Set());
  return dirtyParticipants.get(contestId);
}

/* ================= 纯内存计算（无副作用，供 recompute / rebuild 复用） ================= */
function newStat() {
  return { solved: new Set(), penaltyMs: 0, lastAcceptedAtMs: 0, problems: {} };
}

function applySubmissionInto(st, sub, contestStartMs) {
  if (!sub || !sub.verdict) return;
  const pr = st.problems[sub.problemId] || {
    solved: false, attempts: 0, firstSolvedAtMs: 0, acceptedAtMs: 0, lastVerdict: null
  };
  const t = new Date(sub.serverReceivedAt || sub.judgeStartedAt || sub.createdAt || Date.now()).getTime();
  pr.lastVerdict = sub.verdict;

  if (sub.verdict === 'AC') {
    if (!pr.solved) {
      pr.solved = true;
      pr.firstSolvedAtMs = t;
      pr.acceptedAtMs = t;
      // 按时间顺序，此前的非 AC 提交已累加在 pr.attempts
      st.solved.add(sub.problemId);
      const acMinutes = contestStartMs ? Math.max(0, Math.floor((t - contestStartMs) / 60000)) : 0;
      const wrongs = Math.max(0, pr.attempts);
      pr.attempts = wrongs + 1; // 计入本次 AC 提交，用于展示总提交数
      st.penaltyMs += acMinutes + 20 * wrongs;
      if (t > st.lastAcceptedAtMs) st.lastAcceptedAtMs = t;
    }
  } else {
    if (!pr.solved) pr.attempts += 1;
  }
  st.problems[sub.problemId] = pr;
}

/* ================= recompute / rebuild（SQLite 权威重算） ================= */

/** 关系行 → 业务对象 */
function toSubObj(r) {
  return {
    contestId: r.contest_id,
    userId: r.user_id,
    problemId: r.problem_id,
    status: r.status,
    verdict: r.verdict,
    serverReceivedAt: r.server_received_at,
    createdAt: r.server_received_at
  };
}

/**
 * 从 SQLite 重算单个选手在该比赛的榜单状态（Rejudge / 异常回滚用）。
 * 清空该用户内存态，重放其全部终态提交（按时间顺序）。
 * @returns {object|null} userStat；无终态提交返回 null 并从内存移除
 */
function recomputeParticipant(contestId, userId) {
  const contest = contestRepo.findById(contestId);
  const startMs = contest ? new Date(contest.start_at || 0).getTime() : 0;
  const rows = submissionRepo.listFinishedByUserAndContest(userId, contestId);
  const fresh = newStat();
  let has = false;
  const sorted = rows.slice().sort((a, b) => (a.server_received_at || '').localeCompare(b.server_received_at || ''));
  for (const r of sorted) {
    applySubmissionInto(fresh, toSubObj(r), startMs);
    has = true;
  }
  const cMap = scoreboardRuntime.get(contestId);
  if (!has) {
    if (cMap) cMap.delete(userId);
    return null;
  }
  contestOf(contestId).set(userId, fresh);
  dirtyOf(contestId).add(userId);
  return fresh;
}

/**
 * 从 SQLite 重建某比赛完整榜单（启动 / 版本异常自愈 / Freeze 变更）。
 */
function rebuildScoreboard(contestId) {
  const contest = contestRepo.findById(contestId);
  if (!contest) {
    scoreboardRuntime.delete(contestId);
    dirtyParticipants.delete(contestId);
    scoreboardVersion.delete(contestId);
    return null;
  }
  const startMs = new Date(contest.start_at || 0).getTime();
  const rows = submissionRepo.listFinishedByContest(contestId);
  const fresh = new Map();
  for (const r of rows) {
    const uid = r.user_id;
    if (!fresh.has(uid)) fresh.set(uid, newStat());
    applySubmissionInto(fresh.get(uid), toSubObj(r), startMs);
  }
  scoreboardRuntime.set(contestId, fresh);
  dirtyParticipants.delete(contestId);
  if (!scoreboardVersion.has(contestId)) scoreboardVersion.set(contestId, 0);
  invalidateCache(contestId);
  return fresh;
}

/** 启动时全量重建（关系库权威） */
function recomputeFromDb() {
  scoreboardRuntime.clear();
  dirtyParticipants.clear();
  scoreboardVersion.clear();
  snapshotCache.clear();
  // 关系库没有轻量「全部比赛」接口，从文档模式取比赛 id 列表（仅 id 维度，非榜单数据源）
  const docDb = require('../store/db');
  const contests = docDb.contests.all();
  let n = 0;
  for (const c of contests) {
    if (rebuildScoreboard(c.id)) n++;
  }
  console.log(`[scoreboard] 已从关系库重建 ${n} 个比赛榜单`);
  return n;
}

/* ================= 快照 / 排序 ================= */

function letterOf(index) { return String.fromCharCode(65 + index); }
function contestStartMs(contest) { return contest ? new Date(contest.start_at || 0).getTime() : 0; }

/** 该题 AC 分钟 */
function acMinutes(pr, startMs) {
  return pr.acceptedAtMs && startMs ? Math.max(0, Math.floor((pr.acceptedAtMs - startMs) / 60000)) : 0;
}
/** 该题罚时（AC 分钟 + 20 × 错误次数） */
function acPenalty(pr, startMs) {
  const wrongs = Math.max(0, (pr.attempts || 1) - 1);
  return acMinutes(pr, startMs) + 20 * wrongs;
}

/**
 * 生成有序 ICPC 榜单（relation-backed）。
 * @param {string} contestId
 * @param {object} opts { admin:boolean }
 */
/**
 * 生成有序 ICPC 榜单（relation-backed）。
 * 使用内存 Snapshot 缓存：同一 version 的重复请求命中缓存，0 次 SQLite 查询。
 * 仅在 version 变化（bumpVersion）或 rebuild 时失效。
 * @param {string} contestId
 * @param {object} opts { admin:boolean }（freeze 激活时 admin 看真实，其余相同）
 */
function buildSnapshot(contestId, opts = {}) {
  const v = scoreboardVersion.get(contestId) || 0;
  const freezeActive = isFrozen(contestId);
  // 无 freeze 激活（默认）：复用按 contestId 缓存；freeze 激活时按 admin 区分缓存
  const cacheKey = freezeActive ? `${contestId}::${opts.admin ? 'admin' : 'public'}` : `${contestId}::base`;
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.version === v) {
    return cached.snapshot;
  }

  const contest = contestRepo.findById(contestId);
  if (!contest) {
    snapshotCache.delete(cacheKey);
    return null;
  }
  const startMs = contestStartMs(contest);
  const problems = problemRepo.listByContest(contestId);
  const freezeAtMs = contest.freeze_at ? new Date(contest.freeze_at).getTime() : 0;
  const applyFreeze = freezeActive && !opts.admin;

  const cMap = scoreboardRuntime.get(contestId) || new Map();
  // 每题全局统计：acPeople / submitPeople（freeze 投影时仅计 freeze 前）
  const colStats = buildColStats(contestId, problems, applyFreeze ? freezeAtMs : 0);

  const rows = [];
  for (const [uid, st] of cMap) {
    const u = userRepo.findById(uid);
    if (!u) continue;
    const cells = {};
    let solvedCount = 0;
    let penalty = 0;
    let lastAcceptedAtMs = 0;
    problems.forEach((p, i) => {
      const pr = st.problems[p.id];
      const letter = letterOf(i);
      if (!pr) {
        cells[p.id] = { letter, status: 'none', attempts: 0 };
        return;
      }
      // Freeze 投影：普通选手只看 freeze 前结果
      if (applyFreeze && pr.acceptedAtMs && pr.acceptedAtMs >= freezeAtMs) {
        cells[p.id] = { letter, status: 'failed', attempts: freezeAttempts(contestId, uid, p.id, freezeAtMs), lastVerdict: 'FROZEN' };
        return;
      }
      if (pr.solved) {
        solvedCount++;
        penalty += acPenalty(pr, startMs);
        lastAcceptedAtMs = Math.max(lastAcceptedAtMs, pr.acceptedAtMs || 0);
        cells[p.id] = { letter, status: 'AC', minutes: acMinutes(pr, startMs), attempts: pr.attempts || 0 };
      } else {
        cells[p.id] = { letter, status: 'failed', attempts: pr.attempts || 0, lastVerdict: pr.lastVerdict };
      }
    });
    rows.push({
      userId: uid,
      username: u.username,
      nickname: u.nickname || '',
      solved: solvedCount,
      penalty,
      lastAcceptedAtMs,
      cells
    });
  }

  // 稳定排序：solved DESC → penalty ASC → lastAcceptedAt ASC → userId ASC
  rows.sort((a, b) =>
    b.solved - a.solved ||
    a.penalty - b.penalty ||
    (a.lastAcceptedAtMs - b.lastAcceptedAtMs) ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
  rows.forEach((r, i) => { r.rank = i + 1; });

  const snap = {
    version: v,
    contest: {
      id: contest.id,
      title: contest.title,
      startTimeMs: startMs,
      status: contest.status,
      freezeAtMs: freezeAtMs || 0
    },
    problems: problems.map((p, i) => ({ id: p.id, letter: letterOf(i), title: p.title })),
    rows,
    colStats
  };
  snapshotCache.set(cacheKey, { version: v, snapshot: snap });
  return snap;
}

/**
 * 封榜投影：某用户某题在 freezeAt 之前的错误提交次数。
 * 仅封榜激活时调用（低频），经关系库按 (user, problem, deadline) 精确统计。
 */
function freezeAttempts(contestId, userId, problemId, freezeAtMs) {
  const rows = submissionRepo.listFinishedByUserAndContest(userId, contestId);
  let n = 0;
  for (const r of rows) {
    if (r.problem_id !== problemId) continue;
    const t = new Date(r.server_received_at || 0).getTime();
    if (t >= freezeAtMs) continue;
    if (r.verdict && r.verdict !== 'AC') n++;
  }
  return n;
}

/** 每题列统计（acPeople / submitPeople），可选 freeze 截止 */
function buildColStats(contestId, problems, freezeAtMs) {
  const stats = {};
  const perProblem = {};
  for (const p of problems) perProblem[p.id] = { ac: new Set(), submit: new Set() };
  const rows = submissionRepo.listFinishedByContest(contestId);
  for (const r of rows) {
    const s = perProblem[r.problem_id];
    if (!s) continue;
    if (freezeAtMs && new Date(r.server_received_at || 0).getTime() >= freezeAtMs) continue;
    s.submit.add(r.user_id);
    if (r.verdict === 'AC') s.ac.add(r.user_id);
  }
  problems.forEach((p, i) => {
    const s = perProblem[p.id] || { ac: new Set(), submit: new Set() };
    stats[p.id] = { letter: letterOf(i), problemId: p.id, acPeople: s.ac.size, submitPeople: s.submit.size };
  });
  return stats;
}

/* ================= 对外 API ================= */

/**
 * Full Snapshot（首次加载 / 缓存未命中 / version gap full sync）。
 * 只返回榜单需要数据；不含 source / compile / hidden test / judge data。
 */
function fullSnapshot(contestId, opts = {}) {
  const snap = buildSnapshot(contestId, opts);
  if (!snap) return null;
  const now = Date.now();
  return {
    version: snap.version,
    serverTime: new Date(now).toISOString(),
    nextSyncAt: new Date(now + config.CONTESTANT_BATCH_INTERVAL * 2).toISOString(),
    contest: snap.contest,
    problems: snap.problems,
    participants: snap.rows,
    colStats: snap.colStats,
    frozen: isFrozen(contestId) && !opts.admin
  };
}

/** 取某用户单行（delta 推送用） */
function deltaRowFor(contestId, userId) {
  const snap = buildSnapshot(contestId, { admin: false });
  if (!snap) return null;
  return snap.rows.find((r) => r.userId === userId) || null;
}

/** 每比赛当前 version */
function getVersion(contestId) {
  return scoreboardVersion.get(contestId) || 0;
}

/** 标记某比赛某用户变化 */
function markDirty(contestId, userId) {
  dirtyOf(contestId).add(userId);
}

/** version++ 并返回新值（每比赛独立），同时失效快照缓存 */
function bumpVersion(contestId) {
  const v = (scoreboardVersion.get(contestId) || 0) + 1;
  scoreboardVersion.set(contestId, v);
  invalidateCache(contestId);
  return v;
}

/** 失效某比赛的所有快照缓存（version 变化 / rebuild） */
function invalidateCache(contestId) {
  for (const k of snapshotCache.keys()) {
    if (k === contestId || k.startsWith(`${contestId}::`)) snapshotCache.delete(k);
  }
}

/** 从 SQLite 重算单选手并返回（Submission FINISHED 主路径 / Rejudge） */
function onFinished(contestId, userId) {
  return recomputeParticipant(contestId, userId);
}

/** 是否处于封榜期：now >= freeze_at 且（若配置 end_at）now < end_at。供接口标记与投影判定。 */
function isFrozen(contestId, now = Date.now()) {
  const c = contestRepo.findById(contestId);
  if (!c || !c.freeze_at) return false;
  const f = new Date(c.freeze_at).getTime();
  if (now < f) return false;
  if (c.end_at) {
    const e = new Date(c.end_at).getTime();
    if (now >= e) return false; // 比赛结束，恢复公开
  }
  return true;
}

/* ================= 10s Batch Delta + SSE ================= */
if (config.entry === 'all' || config.entry === 'contest') {
  setInterval(() => {
    for (const [contestId, set] of dirtyParticipants) {
      if (set.size === 0) continue;
      const v = bumpVersion(contestId);
      const changes = [];
      for (const uid of set) {
        const row = deltaRowFor(contestId, uid);
        if (row) changes.push({ userId: row.userId, solved: row.solved, penalty: row.penalty, problems: row.cells });
      }
      set.clear();
      if (changes.length) {
        // 新协议：每比赛 channel，事件名 scoreboard-delta
        hub.emit(`contest:${contestId}`, 'scoreboard-delta', { version: v, changes });
        // 兼容旧 page 通道（文档模式旧前端 / 其他页面）
        hub.emit('page', 'scoreboard_delta', { version: v, contestId, changes });
      }
    }
  }, config.CONTESTANT_BATCH_INTERVAL);
}

/**
 * onVerdict：兼容旧调用（scheduler 文档模式路径）。
 * 关系库权威：仅当该 submission 在 oj_submissions 中存在（FINISHED）时才重算对应选手；
 * 文档模式提交不在关系库，忽略，避免污染关系榜单。
 */
function onVerdict(sub) {
  if (!sub || !sub.id) return;
  const rel = submissionRepo.findById(sub.id);
  if (!rel || rel.status !== 'FINISHED' || !rel.contest_id || !rel.user_id) return;
  recomputeParticipant(rel.contest_id, rel.user_id);
}

module.exports = {
  onVerdict,                           // 兼容旧调用（仅关系库提交生效）
  onFinished,                          // Submission FINISHED 主路径（recompute 单选手）
  markDirty,
  bumpVersion,
  recomputeFromDb,
  rebuildScoreboard,
  recomputeParticipant,
  fullSnapshot,
  deltaRowFor,
  getVersion,
  isFrozen,
  getRuntimeSize: () => scoreboardRuntime.size,
  getVersionMapSize: () => scoreboardVersion.size,
  getDirtySize: () => dirtyParticipants.size
};
