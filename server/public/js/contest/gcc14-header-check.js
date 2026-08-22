/* GCC 14 compatibility precheck for proven libc++ transitive-include mismatches. */

const PROVEN_MISMATCHES = Object.freeze([
  {name: 'sort', header: 'algorithm', pattern: /\bstd\s*::\s*sort\s*\(/},
  {name: 'vector', header: 'vector', pattern: /\bstd\s*::\s*vector\s*</},
  {name: 'make_unique', header: 'memory', pattern: /\bstd\s*::\s*make_unique\s*</},
  {name: 'invoke', header: 'functional', pattern: /\bstd\s*::\s*invoke\s*\(/},
  {name: 'optional', header: 'optional', pattern: /\bstd\s*::\s*optional\s*</}
]);

function stripCommentsAndLiterals(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => match.replace(/[^\n]/g, ' '));
}

function explicitHeaders(source) {
  const headers = new Set();
  const withoutComments = String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const match of withoutComments.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
    headers.add(match[1]);
  }
  return headers;
}

function check(source) {
  const headers = explicitHeaders(source);
  if (headers.has('bits/stdc++.h')) {
    return {ok: true, skipped: true, reason: 'explicit bits/stdc++.h', missing: []};
  }
  const code = stripCommentsAndLiterals(source).replace(/^\s*#.*$/gm, '');
  const missing = PROVEN_MISMATCHES
    .filter(item => !headers.has(item.header) && item.pattern.test(code))
    .map(({name, header}) => ({name, header}));
  return missing.length ? {
    ok: false,
    skipped: false,
    reason: 'GCC 14 requires explicit standard headers: ' + missing.map(item =>
      'std::' + item.name + ' requires <' + item.header + '>').join('; '),
    missing
  } : {ok: true, skipped: false, reason: 'no proven GCC14 mismatch', missing: []};
}

export {check, PROVEN_MISMATCHES};
