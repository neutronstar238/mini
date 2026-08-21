/* ============================================================
 * GCC11 Header Strict Check（Browser Local CE 预检）
 *
 * 目标：在 Browser 本地正式显示"编译成功"之前，增加一次轻量语义兼容检查，
 * 尽量消除"Browser libc++ 因传递 include 错误放行、但 GCC11 正式提交会 CE"
 * 的负向误放行。典型场景：漏写 `<algorithm>` 但用了 `std::sort`。
 *
 * 设计约束（严格）：
 *  - 不改 libc++、不从 libc++ 删声明、不补 shim 声明。
 *  - bits/stdc++.h 显式包含 → 直接豁免（用户主动选择完整 GNU ACM Header 环境）。
 *  - 只对"非 bits 显式头模式"做检查。
 *  - 只覆盖 P0 高频 ACM 标准实体（Ownership Table），不声称等价完整语义检查。
 *  - 基于 token 级扫描（跳过注释/字符串/预处理行），避免简单字符串替换误判。
 *  - 只对"libstdc++ 下必须显式 include 该头才可见"的实体硬性要求，
 *    避免因 libc++ 传递 include 而误放行；同时用"调用/实例化形式 + std:: 限定"
 *    降低用户自定义同名符号的误杀。
 *
 * 注意：本检查判定依据为「用户显式 include 集合」+「P0 高频实体的标准头归属」，
 * 而非 libc++ 的实际 include 图（libc++ 闭包更宽，不能代表 libstdc++）。
 * ============================================================ */
'use strict';

/* P0 高频 ACM 标准实体 → 标准头。
 * 三类判定强度：
 *  - TYPE_LIKE：类型/模板（vector<、std::vector、unique_ptr< 等）。`X<` 实例化或 `std::X` 均可靠。
 *  - FREE_FN：自由函数/算法（sort、lower_bound、accumulate…）。`std::f(` 或裸 `f(`（排除成员调用）。
 *  - STD_ONLY：易与成员方法冲突（find/count/begin/end/set/get/insert…）。仅 `std::X` 限定才判定。
 * 仅收录「libstdc++ 下需显式包含该头才可见、且 P0 高频」的实体。max/min/swap 等易冲突者不入表。 */
const OWNERSHIP = {
  // <algorithm> —— 自由函数
  sort: ['algorithm', 'FREE_FN'], stable_sort: ['algorithm', 'FREE_FN'],
  lower_bound: ['algorithm', 'FREE_FN'], upper_bound: ['algorithm', 'FREE_FN'],
  binary_search: ['algorithm', 'FREE_FN'], nth_element: ['algorithm', 'FREE_FN'],
  reverse: ['algorithm', 'FREE_FN'], unique: ['algorithm', 'FREE_FN'],
  next_permutation: ['algorithm', 'FREE_FN'], prev_permutation: ['algorithm', 'FREE_FN'],
  min_element: ['algorithm', 'FREE_FN'], max_element: ['algorithm', 'FREE_FN'],
  remove: ['algorithm', 'FREE_FN'], remove_if: ['algorithm', 'FREE_FN'],
  fill: ['algorithm', 'FREE_FN'], fill_n: ['algorithm', 'FREE_FN'],
  partial_sort: ['algorithm', 'FREE_FN'], is_sorted: ['algorithm', 'FREE_FN'],
  all_of: ['algorithm', 'FREE_FN'], any_of: ['algorithm', 'FREE_FN'],
  none_of: ['algorithm', 'FREE_FN'], equal: ['algorithm', 'FREE_FN'],
  copy: ['algorithm', 'FREE_FN'], copy_if: ['algorithm', 'FREE_FN'],
  transform: ['algorithm', 'FREE_FN'], merge: ['algorithm', 'FREE_FN'],
  for_each: ['algorithm', 'FREE_FN'], replace: ['algorithm', 'FREE_FN'],
  // find/count 与成员方法冲突，仅 std:: 限定
  find: ['algorithm', 'STD_ONLY'], find_if: ['algorithm', 'FREE_FN'],
  count: ['algorithm', 'STD_ONLY'], count_if: ['algorithm', 'FREE_FN'],
  // 容器类型（TYPE_LIKE，X< 或 std::X 可靠）
  vector: ['vector', 'TYPE_LIKE'], map: ['map', 'TYPE_LIKE'],
  multimap: ['map', 'TYPE_LIKE'], set: ['set', 'TYPE_LIKE'],
  multiset: ['set', 'TYPE_LIKE'], queue: ['queue', 'TYPE_LIKE'],
  priority_queue: ['queue', 'TYPE_LIKE'], deque: ['deque', 'TYPE_LIKE'],
  stack: ['stack', 'TYPE_LIKE'], list: ['list', 'TYPE_LIKE'], array: ['array', 'TYPE_LIKE'],
  unordered_map: ['unordered_map', 'TYPE_LIKE'], unordered_multimap: ['unordered_map', 'TYPE_LIKE'],
  unordered_set: ['unordered_set', 'TYPE_LIKE'], unordered_multiset: ['unordered_set', 'TYPE_LIKE'],
  pair: ['utility', 'TYPE_LIKE'], tuple: ['tuple', 'TYPE_LIKE'],
  bitset: ['bitset', 'TYPE_LIKE'], string: ['string', 'TYPE_LIKE'],
  stringstream: ['sstream', 'TYPE_LIKE'], istringstream: ['sstream', 'TYPE_LIKE'],
  ostringstream: ['sstream', 'TYPE_LIKE'],
  function: ['functional', 'TYPE_LIKE'], unique_ptr: ['memory', 'TYPE_LIKE'],
  shared_ptr: ['memory', 'TYPE_LIKE'], allocator: ['memory', 'TYPE_LIKE'],
  numeric_limits: ['limits', 'TYPE_LIKE'], regex: ['regex', 'TYPE_LIKE'],
  smatch: ['regex', 'TYPE_LIKE'], match_results: ['regex', 'TYPE_LIKE'],
  // <numeric> 自由函数
  accumulate: ['numeric', 'FREE_FN'], iota: ['numeric', 'FREE_FN'],
  inner_product: ['numeric', 'FREE_FN'], partial_sum: ['numeric', 'FREE_FN'],
  adjacent_difference: ['numeric', 'FREE_FN'], gcd: ['numeric', 'FREE_FN'],
  lcm: ['numeric', 'FREE_FN'],
  // <random> 类型
  mt19937: ['random', 'TYPE_LIKE'], mt19937_64: ['random', 'TYPE_LIKE'],
  default_random_engine: ['random', 'TYPE_LIKE'], random_device: ['random', 'TYPE_LIKE'],
  uniform_int_distribution: ['random', 'TYPE_LIKE'],
  uniform_real_distribution: ['random', 'TYPE_LIKE'],
  normal_distribution: ['random', 'TYPE_LIKE'], bernoulli_distribution: ['random', 'TYPE_LIKE'],
  // <string> 自由函数
  getline: ['string', 'FREE_FN'], stoi: ['string', 'FREE_FN'],
  stoll: ['string', 'FREE_FN'], stol: ['string', 'FREE_FN'],
  stod: ['string', 'FREE_FN'], stof: ['string', 'FREE_FN'],
  stoul: ['string', 'FREE_FN'], to_string: ['string', 'FREE_FN'],
  // <functional> 自由函数
  bind: ['functional', 'FREE_FN'], ref: ['functional', 'FREE_FN'], cref: ['functional', 'FREE_FN'],
  // <utility> / <memory> 自由函数
  make_pair: ['utility', 'FREE_FN'], move: ['utility', 'FREE_FN'], forward: ['utility', 'FREE_FN'],
  make_tuple: ['tuple', 'FREE_FN'], make_unique: ['memory', 'FREE_FN'],
  make_shared: ['memory', 'FREE_FN'],
  // <type_traits>
  is_same: ['type_traits', 'FREE_FN'], enable_if: ['type_traits', 'FREE_FN'],
  conditional: ['type_traits', 'FREE_FN'], is_integral: ['type_traits', 'FREE_FN'],
  is_floating_point: ['type_traits', 'FREE_FN'], is_pointer: ['type_traits', 'FREE_FN'],
  remove_reference: ['type_traits', 'FREE_FN'], decay: ['type_traits', 'FREE_FN'],
  is_base_of: ['type_traits', 'FREE_FN'],
  // <iterator> —— 仅 std:: 限定（begin/end 等裸形式常为成员方法）
  begin: ['iterator', 'STD_ONLY'], end: ['iterator', 'STD_ONLY'],
  next: ['iterator', 'STD_ONLY'], prev: ['iterator', 'STD_ONLY'],
  back_inserter: ['iterator', 'STD_ONLY'], front_inserter: ['iterator', 'STD_ONLY'],
  distance: ['iterator', 'STD_ONLY'], advance: ['iterator', 'STD_ONLY'],
  // <chrono> 类型
  chrono: ['chrono', 'TYPE_LIKE'], steady_clock: ['chrono', 'TYPE_LIKE'],
  system_clock: ['chrono', 'TYPE_LIKE'], high_resolution_clock: ['chrono', 'TYPE_LIKE'],
  duration: ['chrono', 'TYPE_LIKE'], time_point: ['chrono', 'TYPE_LIKE'],
  milliseconds: ['chrono', 'TYPE_LIKE'], microseconds: ['chrono', 'TYPE_LIKE'],
  seconds: ['chrono', 'TYPE_LIKE']
};

/* 由包含 header 传递提供的实体判定：header 已 include 且实体在传递集 → 豁免 */
function isTransitiveProvided(includes, name, header) {
  if (includes[header]) return true; // 已直接 include
  // 常见传递关系（libstdc++ GCC11 语义）：
  const isPairUtil = (name === 'pair' || name === 'make_pair' || name === 'move' || name === 'forward');
  // 包含 <utility> → pair/make_pair/move/forward
  if (includes['utility'] && isPairUtil) return true;
  // 包含 <algorithm> → pair/make_pair/begin/end（算法内部使用 pair）
  if (includes['algorithm'] && (isPairUtil || name === 'begin' || name === 'end')) return true;
  // 包含 <map>/<set>/<unordered_map>/<unordered_set> → 传递提供 pair/make_pair（关联容器内部使用）
  if ((includes['map'] || includes['set'] || includes['unordered_map'] || includes['unordered_set']) && (name === 'pair' || name === 'make_pair')) return true;
  return false;
}

/* 移除源码中的注释与字符串/字符字面量（保留预处理行与换行结构），
 * 返回可用于实体扫描的"代码主体"。 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // 字符串 / 字符字面量（含前缀）
    if (c === '"' || c === "'") {
      const q = c;
      // 处理前缀 u8/L/u/U/R
      out += ' ';
      // 回退：若上一个字符是标识符/前缀，忽略（简单处理：直接跳字符串体）
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === q) { i++; break; }
        out += d === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* 提取用户显式 include 集合（#include <X> 形式），排除注释/字符串。
 * 返回 { includes: {name:true}, hasBits: boolean } */
function extractIncludes(src) {
  const clean = stripNonCode(src);
  const includes = {};
  const re = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  let m;
  let hasBits = false;
  while ((m = re.exec(clean))) {
    const h = m[1];
    includes[h] = true;
    if (h === 'bits/stdc++.h') hasBits = true;
  }
  return { includes: includes, hasBits: hasBits };
}

/* 检测是否使用 using namespace std；用于裸标识符匹配。 */
function usesStdNamespace(src) {
  const clean = stripNonCode(src);
  return /using\s+namespace\s+std\b/.test(clean);
}

/* 提取用户自定义的顶层/命名空间函数名，避免把用户自己的函数误判为 std 实体。 */
function userDefinedFunctionNames(clean) {
  const names = {};
  // 覆盖：返回类型 名称(参数) {  与  void 名称(...)  、模板 <...> 返回类型 名称(...) {
  const re = /(?:^|[{;}\n])\s*(?:template\s*<[^>]*>\s*)?(?:(?:[A-Za-z_]\w*)\s*[&*]?\s+)?(?:[A-Za-z_]\w*)\s+(?:[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/g;
  let m;
  while ((m = re.exec(clean))) {
    const full = m[0];
    const inner = /(?:[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{$/.exec(full);
    if (inner) names[inner[1]] = true;
  }
  return names;
}

/* 从代码主体中提取 P0 实体引用。
 * 返回 [{ name, header, qualified }] */
function findEntityRefs(clean) {
  const refs = [];
  const seen = {};
  const add = function (name, header, qualified) {
    const key = name + (qualified ? ':q' : ':b');
    if (seen[key]) return;
    seen[key] = true;
    refs.push({ name: name, header: header, qualified: qualified });
  };
  const hasStdNs = /using\s+namespace\s+std\b/.test(clean);
  const userDefs = userDefinedFunctionNames(clean);
  let m;

  // 1) std:: 限定引用（最可靠）：std::sort / std::vector / std::begin 等
  const qRe = /\bstd::\s*([A-Za-z_]\w*)/g;
  while ((m = qRe.exec(clean))) {
    const name = m[1];
    const own = OWNERSHIP[name];
    if (own) add(name, own[0], true);
  }

  // 2) 裸标识符（仅当 using namespace std）—— 按类型分层判定，排除成员调用
  if (hasStdNs) {
    for (const name of Object.keys(OWNERSHIP)) {
      const own = OWNERSHIP[name];
      const header = own[0], kind = own[1];
      if (userDefs[name]) continue; // 用户自定义同名符号 → 不判裸形式
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      if (kind === 'TYPE_LIKE') {
        // 类型实例化：vector<、std::vector 已在上方处理；裸 X< 可靠（成员不会这样写）
        const instRe = new RegExp('\\b' + esc + '\\s*<', 'g');
        while ((m = instRe.exec(clean))) add(name, header, false);
      } else if (kind === 'FREE_FN') {
        // 自由函数调用：裸 f( 且左侧不是 . 或 ->（排除成员方法）
        const callRe = new RegExp('(?<![\\w.>\\-])' + esc + '\\s*\\(', 'g');
        while ((m = callRe.exec(clean))) add(name, header, false);
      }
      // kind === 'STD_ONLY'：裸形式不判（成员冲突，仅 std:: 限定已在上方处理）
    }
  }
  return refs;
}

/* 主检查入口。
 * @param {string} code 用户源码
 * @param {object} opts { strict:boolean }
 * @returns {{ ok:boolean, skipped:boolean, reason:string, missing:Array<{name,header,qualified}> }}
 */
function check(code) {
  const src = code || '';
  const { includes, hasBits } = extractIncludes(src);

  // bits 显式包含 → 直接豁免（GCC11 语义：常用标准库头已全部包含）
  if (hasBits) {
    return { ok: true, skipped: true, reason: 'bits/stdc++.h 豁免', missing: [] };
  }

  const clean = stripNonCode(src);
  const refs = findEntityRefs(clean);
  const missing = [];

  for (const r of refs) {
    // 已显式 include 该头 → OK
    if (includes[r.header]) continue;
    // libstdc++ 传递提供 → 豁免（防误杀）
    if (isTransitiveProvided(includes, r.name, r.header)) continue;
    missing.push(r);
  }

  if (missing.length === 0) {
    return { ok: true, skipped: false, reason: 'P0 高频实体头均显式包含', missing: [] };
  }

  // 去重 missing（按 header + name）
  const seen = {};
  const uniqMissing = missing.filter(function (r) {
    const k = r.name + '|' + r.header;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  return {
    ok: false, skipped: false,
    reason: '缺失标准头：' + uniqMissing.map(function (r) { return r.name + ' 需要 <' + r.header + '>'; }).join('，'),
    missing: uniqMissing
  };
}

export { check, OWNERSHIP, extractIncludes, usesStdNamespace };
