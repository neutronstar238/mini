'use strict';
/**
 * 种子数据：管理员/选手账号、默认比赛与示例题目、Worker 演示注册码
 * 比赛制模式：数据不再兼容旧库，启动时若存在旧题目/提交数据则清空重建。
 */
const bcrypt = require('bcryptjs');

module.exports = function seed(db) {
  console.log('[seed] 检查并初始化种子数据...');
  let added = [];

  // 账号
  if (db.users.all().length === 0) {
    db.users.insert({ username: 'admin', nickname: '教练', passwordHash: bcrypt.hashSync('admin123', 10), role: 'admin', banned: false });
    db.users.insert({ username: 'user1', nickname: '选手一号', passwordHash: bcrypt.hashSync('user123', 10), role: 'user', banned: false });
    added.push('admin/user1');
  }

  // 比赛制：首次初始化（无任何比赛）时，清空旧测试数据并创建默认比赛与题目
  if (db.contests.all().length === 0) {
    db.problems.all().forEach((p) => db.problems.remove(p.id));
    db.submissions.all().forEach((s) => db.submissions.remove(s.id));
    db.judgeAttempts.all().forEach((a) => db.judgeAttempts.remove(a.id));
    added.push('已清空旧题目/提交数据');
    const contest = db.contests.insert({
      title: '示例比赛 · 入门热身赛',
      description: '一场用于演示比赛制功能的示例比赛，包含若干入门题。',
      startTimeMs: Date.now() - 3600 * 1000, // 已开始 1 小时
      status: 'ongoing',
      problemIds: [],
      createdAt: new Date().toISOString()
    });
    added.push('默认比赛');

    // 示例题目（带手动测试点，不依赖 g++ 生成）
    const defs = [
      {
        title: 'A + B Problem',
        description: '输入两个整数 $a$ 和 $b$，输出它们的和。\n\n这是用于熟悉评测流程的入门题。',
        samples: [{ input: '1 2', output: '3' }, { input: '100 200', output: '300' }],
        testcases: [
          { input: '1 2', answer: '3' }, { input: '100 200', answer: '300' },
          { input: '-5 8', answer: '3' }, { input: '1000000000 1000000000', answer: '2000000000' }
        ]
      },
      {
        title: '循环求和',
        description: '输入 $n$，计算 $1+2+\\dots+n$ 的值（$1 \\le n \\le 10^9$）。\n\n注意：暴力循环可能超时，思考公式。',
        samples: [{ input: '100', output: '5050' }],
        testcases: [
          { input: '100', answer: '5050' }, { input: '1', answer: '1' },
          { input: '1000000000', answer: '500000000500000000' }
        ]
      },
      {
        title: '输出问候',
        description: '读入一个名字（不含空格），输出 `Hello, <名字>!`。',
        samples: [{ input: 'World', output: 'Hello, World!' }, { input: 'OJ', output: 'Hello, OJ!' }],
        testcases: [
          { input: 'World', answer: 'Hello, World!' }, { input: 'OJ', answer: 'Hello, OJ!' }
        ]
      }
    ];

    const problemIds = [];
    defs.forEach((d, i) => {
      const problem = db.problems.insert({
        contestId: contest.id,
        title: d.title,
        description: d.description,
        timeLimitMs: 1000,
        memoryLimitMb: 256,
        samples: d.samples,
        testcases: d.testcases,
        genCode: '', solutionCode: '',
        order: i + 1,
        version: 1
      });
      problemIds.push(problem.id);
    });
    db.contests.update(contest.id, { problemIds });
    added.push(problemIds.length + ' 道题目');
  }

  if (db.registerCodes.all().length === 0) {
    db.registerCodes.insert({ code: 'OJ-DEMO-WORKER-2024', used: false, note: '演示 Worker 注册码' });
    added.push('Worker 注册码 OJ-DEMO-WORKER-2024');
  }

  console.log('[seed] 完成：' + (added.length ? added.join(', ') : '数据已存在，跳过'));
};
