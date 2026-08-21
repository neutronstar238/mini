'use strict';
/**
 * Submission 正式状态机（Phase 4 主链路唯一正式定义）
 *
 * status:  QUEUED → JUDGING → FINISHED
 * verdict: null → AC | WA | TLE | MLE | RE | CE | SYSTEM_ERROR（仅在 FINISHED 时非空）
 *
 * 与旧远程 Worker 路径的 state-machine.js（SUBMITTED/PENDING/LEASED/...）并存：
 * 本模块仅用于 Contestant 正式提交主链路 + 服务器端 JudgeAdapter 评测。
 */
const SUB_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  JUDGING: 'JUDGING',
  FINISHED: 'FINISHED'
});

const VERDICT = Object.freeze({
  AC: 'AC',
  WA: 'WA',
  TLE: 'TLE',
  MLE: 'MLE',
  RE: 'RE',
  CE: 'CE',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
});

const TERMINAL = Object.freeze([VERDICT.AC, VERDICT.WA, VERDICT.TLE, VERDICT.MLE, VERDICT.RE, VERDICT.CE, VERDICT.SYSTEM_ERROR]);

const TRANSITIONS = Object.freeze({
  [SUB_STATUS.QUEUED]: [SUB_STATUS.JUDGING, SUB_STATUS.FINISHED, SUB_STATUS.QUEUED],
  [SUB_STATUS.JUDGING]: [SUB_STATUS.FINISHED, SUB_STATUS.JUDGING],
  [SUB_STATUS.FINISHED]: []
});

function canTransition(from, to) {
  return !!TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}

/** 校验状态推进；返回 {ok} 或 {ok:false, error} */
function validateTransition(sub, nextStatus) {
  if (!sub) return { ok: false, error: '提交不存在' };
  if (sub.status === SUB_STATUS.FINISHED) return { ok: false, error: `提交已终态 ${sub.verdict || 'FINISHED'}，不可再流转` };
  if (!canTransition(sub.status, nextStatus)) {
    return { ok: false, error: `非法状态流转 ${sub.status} → ${nextStatus}` };
  }
  return { ok: true };
}

function isTerminalVerdict(v) {
  return TERMINAL.includes(v);
}

function isFinished(sub) {
  return sub && sub.status === SUB_STATUS.FINISHED;
}

module.exports = {
  SUB_STATUS, VERDICT, TERMINAL, TRANSITIONS, canTransition, validateTransition, isTerminalVerdict, isFinished
};
