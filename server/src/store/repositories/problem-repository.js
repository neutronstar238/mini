'use strict';
/**
 * ProblemRepository —— 关系型 problems + problem_samples 表（Phase 4 主链路）
 * - testcases（隐藏测试）存于 oj_problems.testcases JSON 列，仅服务器可读
 * - samples（公开样例）存于 oj_problem_samples 表，可发给浏览器
 * 严禁 API 返回 testcases / Judge 数据路径。
 */
const crypto = require('crypto');
const { getOjDb } = require('../../db/sqlite');
const metrics = require('../db-metrics');

function findById(id) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  return getOjDb().prepare('SELECT * FROM oj_problems WHERE id = ?').get(id) || null;
}

function listByContest(contestId) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  return getOjDb().prepare('SELECT * FROM oj_problems WHERE contest_id = ? ORDER BY label, created_at')
    .all(contestId);
}

/** 解析隐藏测试 JSON（仅服务端 Judge 使用，绝不外发） */
function getTestcases(problem) {
  if (!problem) return [];
  try { return JSON.parse(problem.testcases || '[]'); } catch (_) { return []; }
}

function listSamples(problemId) {
  return getOjDb().prepare(
    'SELECT id, problem_id, sample_index, input, expected_output FROM oj_problem_samples WHERE problem_id = ? ORDER BY sample_index'
  ).all(problemId);
}

function replaceSamples(problemId, samples) {
  const db = getOjDb();
  const del = db.prepare('DELETE FROM oj_problem_samples WHERE problem_id = ?');
  const ins = db.prepare(
    'INSERT INTO oj_problem_samples (id, problem_id, sample_index, input, expected_output) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction((pid, list) => {
    del.run(pid);
    (list || []).forEach((s, i) => {
      ins.run(crypto.randomUUID(), pid, i, s.input || '', s.output || s.expected_output || '');
    });
  });
  tx(problemId, samples);
}

function insert({ id, contestId, label = '', title, statement = '', timeLimitMs = 1000, memoryLimitMb = 256, testcases = [], samples = [] }) {
  const rid = id || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const db = getOjDb();
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO oj_problems (id, contest_id, label, title, statement, time_limit_ms, memory_limit_mb, testcases, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(rid, contestId, label, title, statement, timeLimitMs, memoryLimitMb, JSON.stringify(testcases), createdAt);
    replaceSamples(rid, samples);
  });
  tx();
  return findById(rid);
}

/** 用文档模式题目补齐关系库（并存过渡） */
function ensureProblem(docProblem) {
  if (!docProblem) return null;
  let p = findById(docProblem.id);
  if (p) return p;
  return insert({
    id: docProblem.id,
    contestId: docProblem.contestId,
    label: String.fromCharCode(65 + ((docProblem.order || 1) - 1)),
    title: docProblem.title,
    statement: docProblem.description || docProblem.statement || '',
    timeLimitMs: docProblem.timeLimitMs || 1000,
    memoryLimitMb: docProblem.memoryLimitMb || 256,
    testcases: docProblem.testcases || [],
    samples: docProblem.samples || []
  });
}

/** 公开问题元数据（给 API，不泄露 testcases） */
function publicProblem(problem) {
  if (!problem) return null;
  const samples = listSamples(problem.id).map((s) => ({
    index: s.sample_index, input: s.input, output: s.expected_output, expected_output: s.expected_output
  }));
  return {
    id: problem.id,
    label: problem.label,
    title: problem.title,
    statement: problem.statement,
    description: problem.statement, // 前端兼容别名
    timeLimitMs: problem.time_limit_ms,
    memoryLimitMb: problem.memory_limit_mb,
    order: problem.label ? problem.label.charCodeAt(0) - 64 : 0, // A→1, B→2...
    testcaseCount: 0, // 隐藏测试数量不暴露给浏览器
    samples
  };
}

module.exports = { findById, listByContest, getTestcases, listSamples, replaceSamples, insert, ensureProblem, publicProblem };
