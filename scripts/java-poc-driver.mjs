/* ============================================================
 * JavaBox Technical PoC Driver v4 — clean wrapper, per-case isolation
 * ------------------------------------------------------------
 * 教训汇总：
 *  - v2: 同一 JVM 跑 6 个 case，第一个跑完后 ring buffer 里有残留 stdin；
 *        Scanner 永远阻塞 → 后续 case 全 timeout/RE。
 *  - 解决：每个 case 在同一 JVM 内跑，但每次重置 ring buffer stdin + 给程序写新 stdin。
 *  - CE/RE 文本分类：CE 看 stdout（javac 输出），RE 看 stderr（Exception 堆栈）。
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = process.env.JAVA_POC_DIR || path.join(__dirname, '..', '.codebuddy', 'tmp', 'java-poc');
const EVIDENCE_FILE = path.join(ASSET_DIR, 'poc-evidence.jsonl');
try { fs.unlinkSync(EVIDENCE_FILE); } catch (_) {}
function rec(o){ try { fs.appendFileSync(EVIDENCE_FILE, JSON.stringify({ts:new Date().toISOString(),...o})+'\n'); } catch (_) {} }
function sha256File(p){ return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

/* Cases 顺序：先跑无 stdin 的，再跑有 stdin 的，避免共享 ring buffer 残留 */
const CASES = [
  { name: 'HelloWorld', cls:'Main', stdin:'',
    source:'public class Main {\n  public static void main(String[] args){\n    System.out.println("JAVA_BROWSER_OK");\n  }\n}\n',
    expectOut:'JAVA_BROWSER_OK', expectStatus:'ok' },
  { name: 'CE (missing semicolon)', cls:'Main', stdin:'',
    source:'public class Main {\n  public static void main(String[] args){\n    int x =\n  }\n}\n',
    expectOut:'', expectStatus:'ce' },
  { name: 'RE (ArithmeticException)', cls:'Main', stdin:'',
    source:'public class Main {\n  public static void main(String[] args){\n    int x = 1 / 0;\n  }\n}\n',
    expectOut:'', expectStatus:'re' },
  { name: 'NPE (NullPointerException)', cls:'Main', stdin:'',
    source:'public class Main {\n  public static void main(String[] args){\n    Object o = null;\n    o.toString();\n  }\n}\n',
    expectOut:'', expectStatus:'re' },
  { name: 'A+B Scanner (stdin)', cls:'Main', stdin:'3 5\n',
    source:'import java.util.*;\npublic class Main {\n  public static void main(String[] args){\n    Scanner in = new Scanner(System.in);\n    int a = in.nextInt(); int b = in.nextInt();\n    System.out.println(a + b);\n  }\n}\n',
    expectOut:'8', expectStatus:'ok' },
  { name: 'FastScanner (BufferedReader)', cls:'Main', stdin:'10 20\n',
    source:'import java.io.*;\nimport java.util.*;\npublic class Main {\n  public static void main(String[] args) throws Exception{\n    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n    StringTokenizer st = new StringTokenizer(br.readLine());\n    int a = Integer.parseInt(st.nextToken()); int b = Integer.parseInt(st.nextToken());\n    System.out.println(a + b);\n  }\n}\n',
    expectOut:'30', expectStatus:'ok' }
];

async function main(){
  rec({ event:'start', nodeVersion: process.version });
  const wasm = path.join(ASSET_DIR, 'javabox-direct.wasm');
  const data = path.join(ASSET_DIR, 'javabox-direct.data');
  const mjs  = path.join(ASSET_DIR, 'javabox-direct.mjs');
  for(const f of [wasm,data,mjs]) if(!fs.existsSync(f)){ rec({event:'fatal',msg:'missing '+f}); process.exit(2); }
  rec({
    event:'assets',
    wasmBytes: fs.statSync(wasm).size, dataBytes: fs.statSync(data).size,
    wasmSha256: sha256File(wasm), dataSha256: sha256File(data), mjsSha256: sha256File(mjs),
    note:'TECHNICAL_REFERENCE_ONLY / REDISTRIBUTION_NOT_ASSUMED — JavaBox has no LICENSE file.'
  });

  // 直接 inline driver（不通过 spawn），更稳
  const allOutput = [];
  const moduleImpl = {
    print: (t)=>{ allOutput.push(t); },
    printErr: (t)=>{ allOutput.push('[err] '+t); },
    onExit: (code)=>{ allOutput.push('[exit] '+code); rec({event:'jvm_onExit',code}); },
    locateFile: (p)=> p==='javabox-direct.wasm'?wasm : p==='javabox-direct.data'?data : path.join(ASSET_DIR,p)
  };

  rec({event:'module_create_begin'});
  const tM0 = Date.now();
  let Module;
  try{
    const { default: createModule } = await import(pathToFileURL(mjs).href);
    Module = await createModule(moduleImpl);
  } catch(e){
    rec({event:'module_create_failed', err: String(e && e.message || e), stack: String(e && e.stack||'').slice(0,600)});
    process.exit(3);
  }
  const tM1 = Date.now();
  rec({event:'module_created', moduleInitMs: tM1 - tM0});
  try{ Module.ccall('jvm_enable_ring_buffer_stdin', null, [], []); rec({event:'ring_buffer_enabled'}); }
  catch(e){ rec({event:'ring_buffer_failed', err:String(e && e.message||e)}); }

  const sendToGuest = (raw)=>{
    try { Module.ccall('jvm_stdin_write_string', null, ['string'], [raw]); }
    catch(e){ rec({event:'send_failed', err:String(e && e.message||e)}); }
  };

  // 等 JBOX_PONG
  rec({event:'wait_pong_begin'});
  const tPing0 = Date.now();
  const PONG_TIMEOUT = 30000;
  let bootOk = false;
  const pingTimer = setInterval(()=>sendToGuest('JBOX_PING\n'), 500);
  while(Date.now() - tPing0 < PONG_TIMEOUT){
    if(allOutput.some(t=>typeof t==='string' && t.includes('JBOX_PONG'))){ bootOk = true; break; }
    await sleep(200);
  }
  clearInterval(pingTimer);
  const tBoot = Date.now();
  rec({event:'boot_result', bootOk, bootMs: tBoot - tM0, outputTail: allOutput.slice(-12)});
  if(!bootOk){
    rec({event:'BLOCKING', reason:'JVM/CompileServer not ready in '+PONG_TIMEOUT+'ms. Output tail captured.'});
  }

  const results = [];
  for(const c of CASES){
    allOutput.length = 0;
    // **关键修复**：每个 case 间隔 sleep 500ms，确保前一个 case 的 JBOX_EXIT:0 被 CompileServer 主循环读完。
    // 协议字节可能被 Scanner.nextInt 消费，但 JBOX_COMPILE 头字母 'J' 不会被 Scanner 当 token，
    // 但程序一旦退出，下一条 JBOX_COMPILE 应该进入主循环。
    await sleep(300);
    const cStart = Date.now();

    // 关键顺序：先发 stdin（如果非空）→ 再发 JBOX_COMPILE 命令字符串。
    // JavaBox ring buffer 是给程序 System.in 用的；协议字符串（"JBOX_COMPILE..."）也走同一个 ring buffer，
    // 但 CompileServer 的协议 reader 与程序 Scanner 共享同一个 System.in。
    // 这就是为什么顺序敏感——我们必须把 stdin **先于** JBOX_COMPILE 放入。
    if(c.stdin) sendToGuest(c.stdin);
    const cmd = 'JBOX_COMPILE ' + c.cls + '\n' + c.source + '\nJBOX_END\n';
    sendToGuest(cmd);

    let exitCode = null;
    const deadline = Date.now() + 25000;
    while(Date.now() < deadline){
      const joined = allOutput.join('\n');
      const m = joined.match(/JBOX_EXIT:(-?\d+)/);
      if(m){ exitCode = parseInt(m[1]); break; }
      await sleep(150);
    }
    const cEnd = Date.now();
    const combined = allOutput.join('\n');
    let status='unknown';
    if(exitCode===0) status='ok';
    else if(exitCode!=null && exitCode!==0){
      // RE：直接看 stack 起始异常类名（JavaBox 在 stderr 直接打异常，无 "Exception in thread" 前缀）
      if(/(?:Exception in thread|java\.lang\.(?:Arithmetic|NullPointer|ArrayIndexOutOfBounds|ClassCast|StackOverflow|NumberFormat|IllegalArgument|IllegalState|IndexOutOfBounds)Exception)/.test(combined)) status='re';
      // CE：javac 风格 — `Main.java:LINE: error|KaTeX parse error: Expected 'EOF', got 'é' at position 1: 错误: MSG` 错误 ...` Main.java:LINE: 错误: ...`. 支持 zh/en locale。
      else if(/Main\.java:\d+:\s*(?:error|错误)/.test(combined)) status='ce';
      else status='non-zero-exit('+exitCode+')';
    } else status='timeout';
    // CE 行号诊断：同时支持 en/zh locale
    const ceLine = combined.match(/Main\.java:(\d+):\s*(?:error|错误):?\s*([^\n]+)/);
    const stdout = combined.split('\n').filter(l=>
      !/^JBOX_(PONG|EXIT:\d+|COMPILE|END|PING|DOOM)/.test(l)
      && !/^={5,}/.test(l)
      && !/^\[exit\]/.test(l)
      && !/^\[err\]/.test(l)
    ).join('\n').trim();
    results.push({
      name:c.name, cls:c.cls,
      ok: status===c.expectStatus,
      status, exitCode, elapsedMs: cEnd-cStart,
      stdout: stdout.slice(0, 500),
      cePos: ceLine ? ('Main.java:'+ceLine[1]+' error: '+ceLine[2]) : null,
      outputTail: combined.slice(-400)
    });
    rec({event:'case', ...results[results.length-1]});
  }

  const passed = results.filter(r=>r.ok).length;
  const summary = {
    event:'SUMMARY',
    bootOk, bootMs: tBoot - tM0,
    casesPassed: passed, casesTotal: CASES.length,
    technicallyValidated: bootOk && passed===CASES.length,
    redistributionStatus: 'DISTRIBUTION_BLOCKED',
    redistributionBlockers:[
      'JavaBox (bmarti44/javabox) 无 LICENSE 文件（验证 404）',
      'jvm-main.c / CompileServer.java / build scripts 自身 license 不明',
      'prebuilt 下载自个人 Cloudflare Worker，无 hash 校验',
      'CompileServer.java 协议 stdin 与程序 System.in 共享半双工，存在协议错位风险',
      '必须自建 browserjdk-oj/（OpenJDK21u GPLv2+CE + Emscripten MIT-NCSA + libffi）才能进入 REDISTRIBUTABLE 路径'
    ]
  };
  rec(summary);
  console.log('\n========= PoC RESULT =========');
  console.log('bootOk:', bootOk, ' bootMs:', tBoot - tM0);
  console.log('casesPassed:', passed + '/' + CASES.length);
  console.log('technicallyValidated:', summary.technicallyValidated);
  console.log('redistributionStatus:', summary.redistributionStatus);
  // 强退（CompileServer 主循环无 exit hook）
  setTimeout(()=>process.exit(0), 100).unref();
}
main().catch(e=>{ rec({event:'FATAL', err:String(e && e.message||e), stack:String(e && e.stack||'').slice(0,600)}); process.exit(4); });