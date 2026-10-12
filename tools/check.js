#!/usr/bin/env node
/**
 * RT static integrity check — run before every deploy.
 *
 *   node tools/check.js
 *
 * Exists because three days of production bugs (lvlMap out of scope, seven
 * undefined f54 helpers, an admin tab that threw on open) were all things a
 * machine could have found instantly. `node --check` proves a file PARSES; it
 * says nothing about whether the functions it calls exist.
 *
 * Every check here corresponds to a bug that actually shipped.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let FAIL = 0, WARN = 0;
const fail = (c, m) => { FAIL++; console.log(`  FAIL  [${c}] ${m}`); };
const warn = (c, m) => { WARN++; console.log(`  warn  [${c}] ${m}`); };
const head = (t) => console.log(`\n=== ${t} ===`);

/**
 * DELIBERATELY NOT a tokenizer.
 *
 * The first version stripped comments then string literals, and on index.html it
 * ate 95 of 261 function declarations and two thirds of the file: a string
 * containing "//" defeats the comment pass, after which the string pass swallows
 * everything to the next quote. The result was 59 false "undefined function"
 * failures for functions that plainly exist.
 *
 * A checker that cries wolf is worse than no checker — it trains you to ignore
 * it. So this only removes BLOCK comments, which cannot be confused with
 * anything, and every check below is written to tolerate the residue. Where that
 * is not possible the check is simply not made. Prefer silence to noise.
 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Whole-line comments only. Prose like "WRITE_TRUNCATE (…)" was being read
    // as a call to TRUNCATE(); dropping these lines removes nearly all of it
    // without the risk of mangling a string that happens to contain "//".
    .split('\n')
    .filter(l => !/^\s*(?:\/\/|\*)/.test(l))
    // Trailing comments too, but only cut at a "//" with BALANCED QUOTES before
    // it — so 'https://...' inside a string is never mistaken for a comment.
    .map(l => {
      for (let i = 0; i < l.length - 1; i++) {
        if (l[i] !== '/' || l[i + 1] !== '/') continue;
        const before = l.slice(0, i);
        const sq = (before.match(/(?<!\\)'/g) || []).length;
        const dq = (before.match(/(?<!\\)"/g) || []).length;
        const bt = (before.match(/(?<!\\)`/g) || []).length;
        if (sq % 2 === 0 && dq % 2 === 0 && bt % 2 === 0) return before;
      }
      return l;
    })
    .join('\n');
}

function scripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n');
}

function declared(src) {
  const s = src, d = new Set();   // raw: see strip()'s note
  for (const m of s.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
  for (const m of s.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) d.add(m[1]);
  for (const m of s.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
  for (const m of s.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g))
    m[1].split(',').forEach(p => { const n = p.trim().split(/[=\s]/)[0]; if (n) d.add(n); });
  for (const m of s.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
  for (const m of s.matchAll(/\bfor\s*\(\s*(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s+(?:in|of)\b/g)) d.add(m[1]);
  return d;
}

// Bare-identifier calls only: foo(...) but never obj.foo(...)
function calls(src) {
  const s = strip(src), c = new Map();   // block comments only
  const re = /(^|[^\w$.\]])\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m; while ((m = re.exec(s))) {
    const n = m[2];
    c.set(n, (c.get(n) || 0) + 1);
  }
  return c;
}

const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','function','new','delete','void','in','of','do','else','case','throw','instanceof','await','yield','async','super']);
const GLOBALS = new Set([
  'Object','Array','String','Number','Boolean','Date','Math','JSON','RegExp','Error','TypeError','Promise',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'setTimeout','clearTimeout','setInterval','clearInterval','alert','confirm','prompt','fetch','require',
  'Symbol','Map','Set','WeakMap','AbortController','URLSearchParams','FormData','Blob','File','FileReader',
  'IntersectionObserver','MutationObserver','ResizeObserver','CustomEvent','Event','Image','Audio','Worker',
  'TextEncoder','TextDecoder','btoa','atob','structuredClone','queueMicrotask','requestAnimationFrame',
  // Apps Script services
  'SpreadsheetApp','DriveApp','GmailApp','MailApp','UrlFetchApp','Utilities','Logger','Session','ScriptApp',
  'PropertiesService','CacheService','LockService','HtmlService','ContentService','CalendarApp','BigQuery',
  'DocumentApp','FormApp','Charts','Browser','console'
]);

/**
 * Words that appear inside ANY quoted span in the file.
 *
 * String contents cannot be stripped safely (that is what broke the first
 * version), so prose inside a log message like 'Tantrum Total (min)' reads as a
 * call to Total(). Excluding anything that also appears inside quotes removes
 * every one of those.
 *
 * The trade, stated plainly: a genuinely missing function whose name ALSO
 * appears in a log message would be skipped. That is a narrow miss, and the
 * _helper check below is exact for the convention this codebase actually
 * follows — it is what found the seven missing f54 helpers.
 */
function wordsInStrings(src) {
  const w = new Set();
  for (const re of [/'([^'\n]*)'/g, /"([^"\n]*)"/g]) {
    let m; while ((m = re.exec(src)))
      for (const t of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) w.add(t[0]);
  }
  return w;
}

function undefinedCalls(src, label, extraKnown) {
  const d = declared(src), c = calls(src), inStr = wordsInStrings(src), missing = [];
  for (const [name, n] of c) {
    if (KEYWORDS.has(name) || GLOBALS.has(name)) continue;
    if (d.has(name)) continue;
    if (inStr.has(name)) continue;
    if (extraKnown && extraKnown.has(name)) continue;
    missing.push(`${name}() — ${n} call${n > 1 ? 's' : ''}`);
  }
  return missing;
}

// ── 1. syntax ────────────────────────────────────────────────────────────────
head('Syntax');
const FILES = { 'Code.gs': read('Code.gs'), 'BigQuerySync.gs': read('BigQuerySync.gs') };
const HTML = { 'index.html': read('index.html'), 'clinical/index.html': read('clinical/index.html') };
const HTMLJS = {};
for (const [f, src] of Object.entries(HTML)) HTMLJS[f] = scripts(src);

const vm = require('vm');
for (const [f, src] of Object.entries(FILES)) {
  try { new vm.Script(src, { filename: f }); console.log(`  ok    ${f}`); }
  catch (e) { fail('syntax', `${f}: ${e.message}`); }
}
for (const [f, src] of Object.entries(HTMLJS)) {
  try { new vm.Script(src, { filename: f }); console.log(`  ok    ${f} (inline JS)`); }
  catch (e) { fail('syntax', `${f}: ${e.message}`); }
}

// ── 2. ES5 in the .gs files ──────────────────────────────────────────────────
head('ES5 compliance (Code.gs / BigQuerySync.gs)');
for (const [f, src] of Object.entries(FILES)) {
  const s = strip(src);
  const hits = [];
  if (/=>/.test(s)) hits.push('arrow function');
  if (/\bconst\s+[A-Za-z_$]/.test(s)) hits.push('const');
  if (/\blet\s+[A-Za-z_$]/.test(s)) hits.push('let');
  if (/\?\?/.test(s)) hits.push('??');
  if (/\?\./.test(s)) hits.push('?.');
  // ...args / [...xs / {...o — NOT the ellipsis in a log string like 'sid=ab...'
  if (/\.\.\.[A-Za-z_$\[{]/.test(s)) hits.push('spread');
  if (/\bclass\s+[A-Za-z_$]/.test(s)) hits.push('class');
  if (hits.length) fail('es5', `${f}: ${hits.join(', ')}`);
  else console.log(`  ok    ${f}`);
}

// ── 3. called but never defined — the f54 / lvlMap class ─────────────────────
head('Called but never defined');
const gsAll = FILES['Code.gs'] + '\n' + FILES['BigQuerySync.gs'];
const gsDeclared = declared(gsAll);
for (const [f, src] of Object.entries(FILES)) {
  const miss = undefinedCalls(src, f, gsDeclared);
  if (miss.length) miss.forEach(m => fail('undef', `${f}: ${m}`));
  else console.log(`  ok    ${f}`);
}
// For the inline HTML JS a bare-identifier sweep produces too many false
// positives to be useful without a real parser (DOM callbacks, library globals,
// locally-scoped helpers). The on* handler check below covers the case that
// actually bit us, precisely. Not guessing here is the point.
for (const f of Object.keys(HTMLJS)) console.log(`  skip  ${f} (handler check covers this precisely)`);

// The _-prefixed convention makes this exact in the .gs files — it is how the
// seven missing f54 helpers were found.
head('Private _helpers defined (.gs)');
{
  const d = declared(gsAll);
  const missing = new Set();
  for (const m of strip(gsAll).matchAll(/(?<![\w.])(_[A-Za-z]\w*)\s*\(/g))
    if (!d.has(m[1])) missing.add(m[1]);
  if (missing.size) [...missing].forEach(n => fail('undef', `${n}() called but never defined`));
  else console.log('  ok    every _helper called is defined');
}

// ── 4. inline handlers referencing undefined functions ───────────────────────
head('Inline on* handlers -> defined functions');
for (const [f, html] of Object.entries(HTML)) {
  const d = declared(HTMLJS[f]);
  const bad = new Set();
  for (const m of html.matchAll(/\bon[a-z]+\s*=\s*["']([^"']+)["']/g)) {
    // (?<![\w.]) so document.getElementById(...) and /re/.test(...) inside an
    // attribute are not read as calls to getElementById() or test().
    for (const call of m[1].matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = call[1];
      if (KEYWORDS.has(n) || GLOBALS.has(n) || d.has(n)) continue;
      bad.add(n);
    }
  }
  if (bad.size) [...bad].forEach(n => fail('handler', `${f}: on*="${n}(...)" is not defined`));
  else console.log(`  ok    ${f}`);
}

// ── 5. canary markers must match ─────────────────────────────────────────────
head('Build canary');
const a = (FILES['Code.gs'].match(/var APP_BUILD\s*=\s*'([^']+)'/) || [])[1];
const b = (FILES['BigQuerySync.gs'].match(/var BQ_SYNC_BUILD\s*=\s*'([^']+)'/) || [])[1];
if (!a || !b) fail('canary', `missing marker (APP_BUILD=${a}, BQ_SYNC_BUILD=${b})`);
else if (a !== b) fail('canary', `mismatch: APP_BUILD=${a} vs BQ_SYNC_BUILD=${b}`);
else console.log(`  ok    both ${a}`);

// ── 6. duplicate top-level function definitions ──────────────────────────────
head('Duplicate function definitions');
for (const [f, src] of Object.entries(Object.assign({}, FILES, HTMLJS))) {
  // COLUMN 0 only. An indented `function csvQ()` is a LOCAL helper inside an
  // enclosing function — two of those in two different functions is correct
  // scoping, not a collision. Matching indentation reported exactly that.
  const seen = new Map();
  for (const m of strip(src).matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm))
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1);
  if (dupes.length) dupes.forEach(([n, c]) => fail('dupe', `${f}: ${n}() defined ${c}x — the later one silently wins`));
  else console.log(`  ok    ${f}`);
}

// ── 7. frontend actions <-> doPost router ────────────────────────────────────
head('Frontend actions have a doPost handler');
const router = FILES['Code.gs'];
const handled = new Set();
for (const m of router.matchAll(/data\.action\s*===\s*'([^']+)'/g)) handled.add(m[1]);
const posted = new Set();
for (const src of Object.values(HTMLJS))
  for (const m of src.matchAll(/action\s*:\s*'([^']+)'/g)) posted.add(m[1]);
// doPost ends with a catch-all `else { processSession(data); }`, so an action
// with no branch is not an error — it is a session write. That is by design for
// 'saveSession', and it is also a HAZARD: any MISSPELLED action silently becomes
// a session write instead of failing. So: warn, name them, do not fail.
const hasFallthrough = /\}\s*else\s*\{[^}]*processSession\(/.test(router);
const orphan = [...posted].filter(x => !handled.has(x));
if (!orphan.length) {
  console.log(`  ok    ${posted.size} posted actions all handled (${handled.size} branches)`);
} else if (hasFallthrough) {
  orphan.forEach(x => warn('router', `'${x}' has no branch — falls through to processSession(). Intended for the session write; anything else here is a typo that would silently write a session.`));
} else {
  orphan.forEach(x => fail('router', `frontend posts action '${x}' with no doPost branch and no fallthrough`));
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(FAIL ? `FAILED — ${FAIL} problem(s), ${WARN} warning(s)` : `PASSED — 0 problems, ${WARN} warning(s)`);
process.exit(FAIL ? 1 : 0);
