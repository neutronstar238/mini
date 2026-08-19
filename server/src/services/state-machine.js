'use strict';
/**
 * 提交状态机（正式定义，见 plan.md §5）
 * SUBMITTED → PENDING → LEASED → COMPILING → RUNNING → VERIFYING → AC|WA|TLE|MLE|RE|CE|SE
 * - attempt：重试次数（lease 过期/验签失败/抽查不符时 +1，达 maxAttempt 判 SE）
 * - 由中心控制面唯一推进，Worker 只能提交签名结果，无权改库
 */
const config = require('../config');

// 合法状态流转
const TRANSITIONS = {
  SUBMITTED: ['PENDING', 'SE'],
  PENDING: ['LEASED', 'SE'],
  LEASED: ['COMPILING', 'RUNNING', 'VERIFYING', 'PENDING', 'SE'], // PENDING=租约超时回退
  COMPILING: ['RUNNING', 'VERIFYING', 'CE', 'PENDING', 'SE'],
  RUNNING: ['VERIFYING', 'PENDING', 'SE'],
  VERIFYING: ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE', 'PENDING'], // PENDING=抽查不符需重判
  AC: [], WA: [], TLE: [], MLE: [], RE: [], CE: [], SE: []
};

// 终态
const FINAL = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE'];

function isFinal(status) {
  return FINAL.includes(status);
}

function canTransition(from, to) {
  if (!TRANSITIONS[from]) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * 校验并推进状态
 * @param {object} sub 当前提交对象
 * @param {string} next 目标状态
 * @returns {{ok:boolean, error?:string}}
 */
function validate(sub, next) {
  if (!sub) return { ok: false, error: '提交不存在' };
  if (isFinal(sub.status)) return { ok: false, error: `提交已终态 ${sub.status}，不可再流转` };
  if (!canTransition(sub.status, next)) {
    return { ok: false, error: `非法状态流转 ${sub.status} → ${next}` };
  }
  return { ok: true };
}

/** 租约是否有效 */
function leaseValid(sub, now = Date.now()) {
  if (!sub.lease) return false;
  return now < sub.lease.expires_at;
}

/** 是否达到重试上限（应判 SE） */
function attemptExhausted(sub) {
  return (sub.attempt || 0) >= config.maxAttempt;
}

module.exports = {
  TRANSITIONS, FINAL, isFinal, canTransition, validate, leaseValid, attemptExhausted
};
