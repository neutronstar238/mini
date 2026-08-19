'use strict';
/**
 * 比赛（Contest）服务 —— 比赛生命周期、字母编号映射、每题全局统计
 * 比赛制：选手端先进入比赛列表，选择已发布比赛；未到开始时间不可进入。
 */
const db = require('../store/db');

/** 根据开始时间判定比赛当前状态（并在必要时落库） */
function contestStatus(contest, now = Date.now()) {
  const startMs = Number(contest.startTimeMs) || 0;
  let status;
  if (now < startMs) status = 'upcoming';
  else if (contest.status === 'ended') status = 'ended';
  else status = 'ongoing';
  return status;
}

/** 刷新比赛状态（到点自动转 ongoing），返回状态字符串 */
function refreshStatus(contest) {
  if (!contest) return null;
  const st = contestStatus(contest);
  if (st !== contest.status) {
    db.contests.update(contest.id, { status: st });
    contest.status = st;
  }
  return st;
}

/** 公开的比赛信息（选手端列表） */
function publicContest(c, withProblems = false) {
  const st = refreshStatus(c);
  const problems = db.problems.find((p) => p.contestId === c.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const result = {
    id: c.id,
    title: c.title,
    description: c.description || '',
    startTimeMs: c.startTimeMs,
    status: st,
    problemCount: problems.length,
    problemIds: c.problemIds || [],
    createdAt: c.createdAt
  };
  if (withProblems) {
    result.problems = problems.map((p, i) => ({
      id: p.id, letter: letterOf(i), title: p.title
    }));
  }
  return result;
}

/** 字母编号：0->A, 1->B, ... */
function letterOf(index) {
  return String.fromCharCode(65 + index);
}

/** 比赛内按 order 排序的题目列表 */
function problemsOf(contestId) {
  return db.problems.find((p) => p.contestId === contestId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** 每题全局统计：acPeople（多少人通过）/ submitPeople（多少人提交，含通过与不通过） */
function colStats(contestId) {
  const problems = problemsOf(contestId);
  const subs = db.submissions.find((s) => s.contestId === contestId);
  const stats = {};
  problems.forEach((p, i) => {
    const related = subs.filter((s) => s.problemId === p.id);
    const acPeople = new Set(related.filter((s) => s.status === 'AC').map((s) => s.userId)).size;
    const submitPeople = new Set(related.map((s) => s.userId)).size;
    stats[p.id] = { letter: letterOf(i), problemId: p.id, acPeople, submitPeople };
  });
  return stats;
}

/** 是否可以进入比赛（未开始抛错误消息） */
function canEnter(contest, now = Date.now()) {
  const st = refreshStatus(contest);
  if (st === 'upcoming') return { ok: false, error: '比赛还未开始' };
  if (st === 'ended') return { ok: true };
  return { ok: true };
}

module.exports = {
  contestStatus, refreshStatus, publicContest, letterOf, problemsOf, colStats, canEnter
};
