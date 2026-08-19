'use strict';
/**
 * 种子数据：管理员/选手账号、示例题目、Worker 演示注册码
 * 仅当对应集合为空时插入，可重复启动
 */
const bcrypt = require('bcryptjs');

module.exports = function seed(db) {
  console.log('[seed] 检查并初始化种子数据...');
  let added = [];

  if (db.users.all().length === 0) {
    db.users.insert({ username: 'admin', nickname: '管理员', passwordHash: bcrypt.hashSync('admin123', 10), role: 'admin', banned: false });
    db.users.insert({ username: 'user1', nickname: '选手一号', passwordHash: bcrypt.hashSync('user123', 10), role: 'user', banned: false });
    added.push('admin/user1');
  }

  if (db.problems.all().length === 0) {
    db.problems.insert({
      title: 'A + B Problem',
      description: '输入两个整数 $a$ 和 $b$，输出它们的和。\n\n这是一道用于熟悉评测流程的入门题。',
      difficulty: '简单', timeLimitMs: 1000, memoryLimitMb: 256,
      samples: [{ input: '1 2', output: '3' }, { input: '100 200', output: '300' }],
      testcases: [
        { id: 1, input: '1 2', answer: '3' }, { id: 2, input: '100 200', answer: '300' },
        { id: 3, input: '-5 8', answer: '3' }, { id: 4, input: '1000000000 1000000000', answer: '2000000000' }
      ],
      tags: ['入门', '模拟'], order: 1, version: 1
    });
    db.problems.insert({
      title: '循环求和',
      description: '输入 $n$，计算 $1+2+\\dots+n$ 的值（$1 \\le n \\le 10^9$）。\n\n注意：暴力循环可能超时，思考公式。',
      difficulty: '中等', timeLimitMs: 1000, memoryLimitMb: 256,
      samples: [{ input: '100', output: '5050' }],
      testcases: [
        { id: 1, input: '100', answer: '5050' }, { id: 2, input: '1', answer: '1' },
        { id: 3, input: '1000000000', answer: '500000000500000000' }
      ],
      tags: ['数学'], order: 2, version: 1
    });
    db.problems.insert({
      title: '输出问候',
      description: '读入一个名字（不含空格），输出 `Hello, <名字>!`。',
      difficulty: '简单', timeLimitMs: 1000, memoryLimitMb: 256,
      samples: [{ input: 'World', output: 'Hello, World!' }, { input: 'OJ', output: 'Hello, OJ!' }],
      testcases: [
        { id: 1, input: 'World', answer: 'Hello, World!' }, { id: 2, input: 'OJ', answer: 'Hello, OJ!' }
      ],
      tags: ['入门'], order: 3, version: 1
    });
    added.push('3 道题目');
  }

  if (db.registerCodes.all().length === 0) {
    db.registerCodes.insert({ code: 'OJ-DEMO-WORKER-2024', used: false, note: '演示 Worker 注册码' });
    added.push('Worker 注册码 OJ-DEMO-WORKER-2024');
  }

  console.log('[seed] 完成：' + (added.length ? added.join(', ') : '数据已存在，跳过'));
};
