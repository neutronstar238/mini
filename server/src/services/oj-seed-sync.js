'use strict';
/**
 * oj-seed-sync —— 从文档模式种子数据补齐关系型主链路库
 *
 * 并存过渡：既有 JSON-doc 模式（store/db.js）已有 users/contests/problems/samples 种子。
 * 本服务把这些数据幂等同步到关系库（oj_main_path），使 Phase 4 主链路
 * 无需依赖远程 Worker / 文档模式的提交路径。
 *
 * 幂等：findById 存在则跳过，绝不重复插入。
 */
const db = require('../store/db');
const userRepo = require('../store/repositories/user-repository');
const contestRepo = require('../store/repositories/contest-repository');
const problemRepo = require('../store/repositories/problem-repository');

let done = false;

function syncFromDocStore() {
  if (done) return;
  done = true;

  // 用户
  for (const u of db.users.all()) {
    userRepo.ensureUser(u);
  }

  // 比赛 + 题目 + 样例
  for (const c of db.contests.all()) {
    const rc = contestRepo.ensureContest(c);
    const problems = db.problems.find((p) => p.contestId === c.id);
    for (const p of problems) {
      problemRepo.ensureProblem(p);
    }
    // 若文档模式题目已关联 contest 但未同步 label，可在此补齐（ensureProblem 已处理 order→label）
  }

  console.log('[oj-sync] 关系型主链路库已从文档种子补齐（users/contests/problems/samples）');
}

module.exports = { syncFromDocStore };
