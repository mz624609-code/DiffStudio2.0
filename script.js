'use strict';
/* =====================================================================
 * DiffStudio — local code analysis & repair engine
 * Pure vanilla JS. No network. No eval. Source is treated as untrusted
 * text and always HTML-escaped before rendering.
 * ===================================================================== */

/* ---------------- constants & language configuration ---------------- */

const HIGHLIGHT_LIMIT = 150000;   // chars; above this, skip token coloring
const ANALYZE_LIMIT   = 400000;   // chars; above this, skip rule analysis
const MAX_FILE_BYTES  = 2 * 1024 * 1024;

const LANG_LABEL = { cpp:'C++', python:'Python', javascript:'JavaScript', java:'Java', plaintext:'Plain text' };
const EXT_FOR    = { cpp:'cpp', python:'py', javascript:'js', java:'java', plaintext:'txt' };
const MODE_LABEL = { corrected:'Corrected Code', improved:'Improved / Modern', custom:'Custom Transformation', original:'Original Source' };

function S(list){ return new Set(list.split(/\s+/).filter(Boolean)); }

const LANG_CONFIG = {
  cpp: {
    keywords: S(`alignas alignof asm auto break case catch class concept const consteval constexpr constinit
      const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit
      export extern false final for friend goto if inline mutable namespace new noexcept not operator override
      private protected public requires return sizeof static static_assert static_cast struct switch template
      this thread_local throw true try typedef typeid typename union using virtual volatile while`),
    types: S(`bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t
      string wstring size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t vector map set array pair`),
    builtins: S(`cout cin cerr clog wcout wcin endl std NULL nullptr`),
    lineComment: '//', hashComment: false, preprocessor: true, template: false, blockComment: true
  },
  python: {
    keywords: S(`False None True and as assert async await break case class continue def del elif else except
      finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield`),
    types: S(`int float str bool list dict tuple set bytes object`),
    builtins: S(`print len range input open enumerate zip map filter sum min max abs sorted type isinstance super
      self Exception ValueError TypeError IndexError KeyError AttributeError RuntimeError StopIteration`),
    lineComment: null, hashComment: true, preprocessor: false, template: false, blockComment: false
  },
  javascript: {
    keywords: S(`async await break case catch class const continue debugger default delete do else export extends
      false finally for from function get if import in instanceof let new null of return set static super switch
      this throw true try typeof undefined var void while with yield`),
    types: S(``),
    builtins: S(`console document window Math JSON Array Object String Number Boolean Promise Map Set WeakMap Symbol
      RegExp Error TypeError Date parseInt parseFloat isNaN setTimeout setInterval clearTimeout fetch require module exports process globalThis`),
    lineComment: '//', hashComment: false, preprocessor: false, template: true, blockComment: true
  },
  java: {
    keywords: S(`abstract assert break byte case catch char class const continue default do double else enum extends
      final finally float for goto if implements import instanceof int interface long native new null package private
      protected public record return short static strictfp super switch synchronized this throw throws transient
      true false try void volatile var yield sealed permits`),
    types: S(`boolean byte char double float int long short String Object Integer Double Boolean Long Character List Map Set ArrayList HashMap Optional`),
    builtins: S(`System Math Thread Runnable Exception RuntimeException IllegalArgumentException Iterable Override`),
    lineComment: '//', hashComment: false, preprocessor: false, template: false, blockComment: true
  },
  plain: { keywords: new Set(), types: new Set(), builtins: new Set(),
           lineComment: null, hashComment: false, preprocessor: false, template: false, blockComment: false }
};

const TOKEN_CLASS = {
  comment:'tk-comment', string:'tk-string', number:'tk-number', keyword:'tk-keyword',
  type:'tk-type', builtin:'tk-builtin', 'function':'tk-fn', operator:'tk-op',
  punct:'tk-pn', preproc:'tk-pre'
};

const CPP_STARTERS = S(`return break continue throw goto cout cin cerr clog wcout wcin using typedef
  int float double char bool long short unsigned signed void auto wchar_t size_t string std const static register volatile constexpr`);
const JS_STARTERS  = S(`return break continue throw debugger const let var yield await`);
const JAVA_STARTERS= S(`return break continue throw assert int double float char boolean long short byte String Object var final static volatile transient`);

const DEMOS = {
  cpp: `#include <iostream>
using namespace std;

int main() {
    int total = 0
    cout >> total << endl;

    for (int i = 0; i < 5; i++) {
        total += i;
    }

    if (total = 10) {
        cout << "Total is ten" << endl;
    }

    return 0;
}
`,
  python: `def greet(name)
    if name == null
        print "Hello " + name
    active = true
    items = [1, 2, 3]
    count = items.length
    return count

greet("Ada")
`,
  javascript: `var count = 5;
var message = "hello";

if (count == 5) {
    console.log(message);
    count = count + 1;
}

function double(n) {
    return n * 2;
`,
  java: `public class Main {
    public static void main(String[] args) {
        int value = 7
        if (value = 7) {
            System.out.println("seven");
        }
    }
}
`
};

/* ---------------- state & element cache ---------------- */

const state = {
  activeTab: 'corrected',
  analysis: null,          // {lang, effLang, tokens, masked, lineStarts, diagnostics}
  output: { code: '', mode: 'corrected', lang: 'plaintext' },
  wrap: false,
  gutterCount: -1,
  customShown: false,
  clearArmed: false,
  clearTimer: null,
  analyzeTimer: null,
  hlQueued: false
};

const els = {};
function cacheEls(){
  const ids = ['status-dot','status-text','nav-lang','btn-wrap','file-name','language-select','btn-upload',
    'file-input','btn-demo','btn-clear','editor-body','editor-gutter','editor-hl','editor-hl-code','editor-input',
    'editor-empty','drop-overlay','stat-lines','stat-chars','stat-lang','btn-analyze','analyzer-status','count-errors',
    'count-warnings','count-lines','inspector','diagnostics-list','diag-summary','tab-corrected','tab-improved',
    'tab-custom','custom-panel','custom-input','btn-apply-custom','custom-status','output-mode','output-view',
    'output-code','changes-list','btn-copy','btn-export','btn-reset-output','toast-region'];
  ids.forEach(id => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    els[key] = document.getElementById(id);
    if (!els[key]) console.error('[DiffStudio] Missing element #' + id);
  });
}

/* ---------------- small utilities ---------------- */

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildLineStarts(src){
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}
function offsetToLC(lineStarts, off){
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi){ const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: off - lineStarts[lo] + 1 };
}

function maskSource(src, tokens, keepStrings){
  // Same-length copy of src where comments (and optionally strings) are
  // blanked out. String quote delimiters are preserved so end-of-statement
  // positions stay accurate. Offsets remain valid for the original source.
  let out = '', pos = 0;
  for (const t of tokens){
    if (t.s > pos) out += src.slice(pos, t.s);
    const txt = src.slice(t.s, t.e);
    if (t.t === 'comment'){
      out += ' '.repeat(txt.length);
    } else if (t.t === 'string' && !keepStrings){
      if (txt.length >= 2) out += txt[0] + ' '.repeat(txt.length - 2) + txt[txt.length - 1];
      else out += ' '.repeat(txt.length);
    } else {
      out += txt;
    }
    pos = t.e;
  }
  out += src.slice(pos);
  return out;
}

function setStatus(kind, text){
  els.statusText.textContent = text;
  els.analyzerStatus.textContent = text;
  els.statusDot.className = 'dot dot-' + kind;
}

function showToast(msg, kind){
  const t = document.createElement('div');
  t.className = 'toast toast-' + (kind || 'info');
  t.setAttribute('role', 'status');
  t.textContent = msg;
  els.toastRegion.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
}

/* ---------------- tokenizer ---------------- */

function tokenizeCode(src, lang){
  const cfg = LANG_CONFIG[lang] || LANG_CONFIG.plain;
  const toks = [];
  const n = src.length;
  let i = 0;
  const OPCH = '+-*/%=<>!&|^~?';
  while (i < n){
    const c = src[i];
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r'){
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      toks.push({ t:'plain', s:i, e:j }); i = j; continue;
    }
    // line comment
    if (cfg.lineComment && src.startsWith(cfg.lineComment, i)){
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      toks.push({ t:'comment', s:i, e:j }); i = j; continue;
    }
    // python hash comment
    if (cfg.hashComment && c === '#'){
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      toks.push({ t:'comment', s:i, e:j }); i = j; continue;
    }
    // block comment
    if (cfg.blockComment && c === '/' && src[i + 1] === '*'){
      let j = src.indexOf('*/', i + 2);
      j = (j === -1) ? n : j + 2;
      toks.push({ t:'comment', s:i, e:j }); i = j; continue;
    }
    // C/C++ preprocessor directive at line start
    if (cfg.preprocessor && c === '#'){
      let k = i - 1, lineStart = true;
      while (k >= 0 && src[k] !== '\n'){
        if (src[k] !== ' ' && src[k] !== '\t'){ lineStart = false; break; }
        k--;
      }
      if (lineStart){
        let j = src.indexOf('\n', i); if (j === -1) j = n;
        toks.push({ t:'preproc', s:i, e:j }); i = j; continue;
      }
    }
    // strings / chars / template literals
    if (c === '"' || c === "'" || (cfg.template && c === '`')){
      let j = i + 1;
      if (lang === 'python' && (src.startsWith('"""', i) || src.startsWith("'''", i))){
        const q = src.substr(i, 3);
        const idx = src.indexOf(q, i + 3);
        j = (idx === -1) ? n : idx + 3;
      } else {
        while (j < n){
          if (src[j] === '\\'){ j += 2; continue; }
          if (src[j] === c){ j++; break; }
          if (src[j] === '\n' && c !== '`') break; // unterminated single-line string
          j++;
        }
      }
      if (j > n) j = n;
      toks.push({ t:'string', s:i, e:j }); i = j; continue;
    }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))){
      let j = i;
      if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')){
        j += 2;
        while (j < n && /[0-9a-fA-F']/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9']/.test(src[j])) j++;
        if (src[j] === '.'){ j++; while (j < n && /[0-9']/.test(src[j])) j++; }
        if (src[j] === 'e' || src[j] === 'E'){
          let k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (/[0-9]/.test(src[k] || '')){ j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
        }
        while (j < n && /[fFlLuUzZ]/.test(src[j])) j++;
      }
      toks.push({ t:'number', s:i, e:j }); i = j; continue;
    }
    // identifiers & keywords
    if (/[A-Za-z_$]/.test(c)){
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let type = 'ident';
      if (cfg.keywords.has(word)) type = 'keyword';
      else if (cfg.types.has(word)) type = 'type';
      else if (cfg.builtins.has(word)) type = 'builtin';
      else {
        let p = toks.length - 1;
        while (p >= 0 && toks[p].t === 'plain') p--;
        if (p >= 0 && toks[p].t === 'keyword'){
          const pw = src.slice(toks[p].s, toks[p].e);
          if (pw === 'def' || pw === 'class' || pw === 'function') type = 'function';
        }
        if (type === 'ident'){
          let k = j;
          while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
          if (src[k] === '(') type = 'function';
        }
      }
      toks.push({ t:type, s:i, e:j }); i = j; continue;
    }
    // operators
    if (OPCH.includes(c)){
      let j = i + 1;
      while (j < n && OPCH.includes(src[j])) j++;
      toks.push({ t:'operator', s:i, e:j }); i = j; continue;
    }
    // punctuation
    if ('()[]{};,.'.includes(c) || c === ':'){
      toks.push({ t:'punct', s:i, e:i + 1 }); i++; continue;
    }
    toks.push({ t:'plain', s:i, e:i + 1 }); i++;
  }
  return toks;
}

/* ---------------- rendering helpers ---------------- */

function buildHighlightHTML(src, tokens){
  let html = '', pos = 0;
  for (const t of tokens){
    if (t.s > pos) html += escapeHtml(src.slice(pos, t.s));
    const txt = escapeHtml(src.slice(t.s, t.e));
    const cls = TOKEN_CLASS[t.t];
    html += cls ? `<span class="${cls}">${txt}</span>` : txt;
    pos = t.e;
  }
  html += escapeHtml(src.slice(pos));
  if (src.endsWith('\n')) html += ' ';
  return html;
}

function highlightInto(codeEl, src, lang){
  if (!src){ codeEl.innerHTML = ''; return; }
  if (src.length > HIGHLIGHT_LIMIT){ codeEl.textContent = src; return; }
  codeEl.innerHTML = buildHighlightHTML(src, tokenizeCode(src, LANG_CONFIG[lang] ? lang : 'plain'));
}

/* ---------------- language detection ---------------- */

function detectLanguage(src){
  const s = (src || '').slice(0, 6000);
  if (!s.trim()) return 'plaintext';
  const sc = { cpp:0, python:0, javascript:0, java:0 };
  if (/#include\s*</.test(s)) sc.cpp += 3;
  if (/\bstd::/.test(s)) sc.cpp += 2;
  if (/\b(cout|cin|endl)\b/.test(s)) sc.cpp += 3;
  if (/^\s*(using\s+namespace|int\s+main\s*\()/m.test(s)) sc.cpp += 2;
  if (/^\s*def\s+\w+/m.test(s)) sc.python += 3;
  if (/^\s*elif\b/m.test(s)) sc.python += 2;
  if (/\bprint\s*\(/.test(s)) sc.python += 1;
  if (/\bimport\s+\w+/.test(s)) sc.python += 1;
  if (/^\s*\w[^;{}\n]*:\s*$/m.test(s)) sc.python += 1;
  if (/\b(const|let)\s+\w/.test(s)) sc.javascript += 2;
  if (/=>\s*[{(]/.test(s)) sc.javascript += 2;
  if (/\bconsole\.\w/.test(s)) sc.javascript += 2;
  if (/\bfunction\s+\w/.test(s)) sc.javascript += 1;
  if (/\b(document|window)\./.test(s)) sc.javascript += 2;
  if (/\bpublic\s+(static\s+)?(void|class)/.test(s)) sc.java += 3;
  if (/\bSystem\.out\./.test(s)) sc.java += 3;
  if (/\bvoid\s+main\s*\(/.test(s)) sc.java += 2;
  let best = 'plaintext', bs = 0;
  for (const k of Object.keys(sc)) if (sc[k] > bs){ bs = sc[k]; best = k; }
  return bs >= 2 ? best : 'plaintext';
}

function resolveLanguage(src){
  const sel = els.languageSelect.value;
  if (sel && sel !== 'auto') return sel;
  return detectLanguage(src || '');
}

/* ---------------- diagnostic factory & analysis core ---------------- */

function mkDiag(o){
  return Object.assign({ rule:'GEN', severity:'warning', message:'', start:0, end:0,
                         token:'', suggestion:'', fix:null }, o);
}
function forEachLine(ctx, fn){
  const { src, lineStarts } = ctx;
  const n = lineStarts.length;
  for (let i = 0; i < n; i++){
    const ls = lineStarts[i];
    const le = (i + 1 < n) ? lineStarts[i + 1] - 1 : src.length;
    fn(i, ls, le, src.slice(ls, le), ctx.masked.slice(ls, le));
  }
}
function lineObjects(ctx){
  const arr = [];
  forEachLine(ctx, (i, ls, le, raw, mask) => arr.push({ i, ls, le, raw, mask }));
  return arr;
}
function nextNonEmpty(lines, idx){
  for (let i = idx + 1; i < lines.length; i++) if (lines[i].mask.trim()) return lines[i];
  return null;
}

function analyzeSource(src, langPref){
  const lang = (langPref && langPref !== 'auto') ? langPref : detectLanguage(src);
  const effLang = lang === 'typescript' ? 'javascript' : lang;
  const tokens = tokenizeCode(src, effLang);
  const masked = maskSource(src, tokens, false);
  const lineStarts = buildLineStarts(src);
  const ctx = { src, lang: effLang, selLang: lang, tokens, masked, lineStarts };
  let diagnostics = [];
  if (src.length <= ANALYZE_LIMIT){
    if (effLang === 'cpp') diagnostics = diagnostics.concat(rulesCpp(ctx));
    else if (effLang === 'python') diagnostics = diagnostics.concat(rulesPython(ctx));
    else if (effLang === 'javascript') diagnostics = diagnostics.concat(rulesJs(ctx));
    else if (effLang === 'java') diagnostics = diagnostics.concat(rulesJava(ctx));
    if (LANG_CONFIG[effLang]) diagnostics = diagnostics.concat(checkBrackets(ctx));
  }
  diagnostics.sort((a, b) => (a.start - b.start) ||
    ((a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)));
  diagnostics.forEach(d => {
    const lc = offsetToLC(lineStarts, d.start);
    d.line = lc.line; d.col = lc.col;
  });
  return { lang, effLang, tokens, masked, lineStarts, diagnostics };
}

/* ---------------- shared rule helpers ---------------- */

function checkBrackets(ctx){
  const D = [];
  const stack = [];
  const pair = { ')':'(', ']':'[', '}':'{' };
  for (const t of ctx.tokens){
    if (t.t !== 'punct' || t.e - t.s !== 1) continue;
    const ch = ctx.src[t.s];
    if (ch === '(' || ch === '[' || ch === '{'){
      stack.push({ ch, t });
    } else if (ch === ')' || ch === ']' || ch === '}'){
      if (!stack.length){
        D.push(mkDiag({ rule:'BR-CLOSE', severity:'error', start:t.s, end:t.e, token:ch,
          message:`Unmatched closing '${ch}' — no corresponding opening bracket was found before it.`,
          suggestion:`Remove this '${ch}' or add the missing opening bracket earlier.` }));
      } else {
        const top = stack.pop();
        if (top.ch !== pair[ch]){
          const plc = offsetToLC(ctx.lineStarts, top.t.s);
          D.push(mkDiag({ rule:'BR-MATCH', severity:'error', start:t.s, end:t.e, token:ch,
            message:`Closing '${ch}' does not match opening '${top.ch}' from line ${plc.line}.`,
            suggestion:`Use '${pair[ch] === top.ch ? ch : Object.keys(pair).find(k => pair[k] === top.ch)}' to close the '${top.ch}' opened on line ${plc.line}.` }));
        }
      }
    }
  }
  for (const r of stack){
    D.push(mkDiag({ rule:'BR-OPEN', severity:'error', start:r.t.s, end:r.t.e, token:r.ch,
      message:`Unmatched opening '${r.ch}' — no closing '${Object.keys(pair).find(k => pair[k] === r.ch)}' was found.`,
      suggestion:'Add the missing closing bracket at the appropriate place.' }));
  }
  return D;
}

function missingSemicolons(ctx, opt){
  const D = [];
  const lines = lineObjects(ctx);
  for (let idx = 0; idx < lines.length; idx++){
    const L = lines[idx];
    const mt = L.mask.trim();
    if (!mt) continue;
    if (/[;{},:\\[]$/.test(mt) || /=>$/.test(mt)) continue;
    if (/^[#)\]}]/.test(mt)) continue;
    if (ctx.lang === 'cpp' && L.raw.trimStart().startsWith('#')) continue;
    if (/^(if|for|while|switch|do)\b/.test(mt)) continue;
    if (/\belse\s*$/.test(mt)) continue;
    if (/^\w+\s*:/.test(mt)) continue;          // labels, access specifiers, case-like
    if (/^namespace\b/.test(mt)) continue;
    const firstWord = (mt.match(/^\w+/) || [''])[0];
    const looksStmt = opt.starters.has(firstWord) ||
      /^[A-Za-z_$][\w$.]*(\s*\(|\s*=|\+\+|--|<<|>>)/.test(mt);
    if (!looksStmt) continue;
    const next = nextNonEmpty(lines, idx);
    if (mt.endsWith(')') && next && next.mask.trimStart().startsWith('{')) continue; // definition header
    if (next && /^[+\-*\/%&|?=.,:<>)\]]/.test(next.mask.trimStart())) continue;      // continuation
    let endOff = L.le;
    while (endOff > L.ls && /\s/.test(ctx.masked[endOff - 1])) endOff--;
    if (endOff <= L.ls) continue;
    D.push(mkDiag({ rule: opt.rule, severity:'error', start:endOff, end:endOff, token:';',
      message:'This statement appears to be missing its terminating semicolon.',
      suggestion:"Add ';' at the end of the statement.",
      fix:{ start:endOff, end:endOff, text:';', label:"insert ';'" } }));
  }
  return D;
}

function assignInCondition(ctx, rule){
  const D = [];
  const re = /\b(if|while)\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(ctx.masked))){
    const inner = m[2];
    const innerStart = m.index + m[0].indexOf('(') + 1;
    for (let k = 0; k < inner.length; k++){
      const ch = inner[k];
      const prev = inner[k - 1] || '', next = inner[k + 1] || '';
      if (ch === '=' && next !== '=' && prev !== '=' &&
          !'=!<>+-*/%&|^'.includes(prev) && prev !== '"' && prev !== "'" &&
          next !== '"' && next !== "'"){
        D.push(mkDiag({ rule, severity:'warning', start:innerStart + k, end:innerStart + k + 1, token:'=',
          message:`Assignment inside '${m[1]}(...)' condition — this assigns a value instead of comparing.`,
          suggestion:"Use '==' if a comparison was intended; keep only if assignment-in-condition is deliberate." }));
        break;
      }
    }
  }
  return D;
}

function varDeclarations(ctx){
  const out = [];
  const { tokens, src, masked } = ctx;
  tokens.forEach((t, i) => {
    if (t.t !== 'keyword' || src.slice(t.s, t.e) !== 'var') return;
    let j = i + 1;
    while (j < tokens.length && tokens[j].t === 'plain') j++;
    if (j >= tokens.length || tokens[j].t !== 'ident') return; // destructuring etc.
    const name = src.slice(tokens[j].s, tokens[j].e);
    const re = new RegExp('\\b' + escapeRegExp(name) + '\\b\\s*(?:\\+\\+|--|(?:[-+*/%&|^]|<<|>>)?=(?!=))');
    const reassigned = re.test(masked.slice(tokens[j].e));
    const rep = reassigned ? 'let' : 'const';
    out.push(mkDiag({ rule:'JS-VAR', severity:'warning', start:t.s, end:t.e, token:'var',
      message:`'var' is function-scoped and hoisted; '${rep}' is block-scoped and ${reassigned
        ? 'appropriate here (the variable is reassigned).'
        : 'safe here (the variable is never reassigned).'}`,
      suggestion:`Replace 'var' with '${rep}'.`,
      fix:{ start:t.s, end:t.e, text:rep, label:`replace 'var' with '${rep}'` } }));
  });
  return out;
}

/* ---------------- C++ rules ---------------- */

function rulesCpp(ctx){
  const D = [];
  const { tokens, masked, src } = ctx;

  // stream direction: cout >> x / cin << x
  let dir = 0;
  for (const t of tokens){
    const txt = src.slice(t.s, t.e);
    if (t.t === 'punct' && txt === ';'){ dir = 0; continue; }
    if (t.t === 'ident' || t.t === 'builtin' || t.t === 'keyword'){
      if (txt === 'cout' || txt === 'cerr' || txt === 'clog' || txt === 'wcout') dir = 1;
      else if (txt === 'cin' || txt === 'wcin') dir = -1;
      else if (txt === 'endl' && dir === 1){
        D.push(mkDiag({ rule:'CPP-ENDL', severity:'warning', start:t.s, end:t.e, token:'endl',
          message:"'endl' flushes the stream on every call; a plain '\\n' is usually sufficient and faster.",
          suggestion:"Use the Improved tab to replace 'endl' with '\\n' (keep endl only when a flush is required)." }));
      }
      continue;
    }
    if (t.t === 'operator'){
      if (dir === 1 && txt === '>>'){
        D.push(mkDiag({ rule:'CPP-STREAM-OUT', severity:'error', start:t.s, end:t.e, token:'>>',
          message:"'>>' on an output stream (cout) attempts extraction; output uses '<<'.",
          suggestion:"Use '<<' to write to cout.",
          fix:{ start:t.s, end:t.e, text:'<<', label:"replace '>>' with '<<'" } }));
      } else if (dir === -1 && txt === '<<'){
        D.push(mkDiag({ rule:'CPP-STREAM-IN', severity:'error', start:t.s, end:t.e, token:'<<',
          message:"'<<' on an input stream (cin) attempts insertion; input uses '>>'.",
          suggestion:"Use '>>' to read from cin.",
          fix:{ start:t.s, end:t.e, text:'>>', label:"replace '<<' with '>>'" } }));
      }
    }
  }

  // suspicious -+ / +- operator runs
  const reOp = /([A-Za-z_]\w*\]?)[ \t]*(-\+|\+-)[ \t]*(?=[A-Za-z_$\d(])/g;
  let m;
  while ((m = reOp.exec(masked))){
    const opStart = m.index + m[0].indexOf(m[2]);
    D.push(mkDiag({ rule:'CPP-OP-TYPO', severity:'warning', start:opStart, end:opStart + 2, token:m[2],
      message:`Unusual operator sequence '${m[2]}'. It may be a typo for '++', '--', or a binary '+'/'-' combined with a unary sign.`,
      suggestion:'Ambiguous — left unchanged. Pick the intended operator manually.' }));
  }

  D.push(...assignInCondition(ctx, 'CPP-ASSIGN-COND'));
  D.push(...missingSemicolons(ctx, { starters: CPP_STARTERS, rule:'CPP-SEMI' }));
  return D;
}

/* ---------------- Python rules ---------------- */

function rulesPython(ctx){
  const D = [];
  const lines = lineObjects(ctx);
  const kwRe = /^(def|class|if|elif|else|for|while|try|except|finally|with)\b/;

  for (let idx = 0; idx < lines.length; idx++){
    const L = lines[idx];
    const mt = L.mask.trim();
    if (!mt) continue;

    // mixed tabs & spaces indentation
    const indent = (L.raw.match(/^[ \t]*/) || [''])[0];
    if (indent.includes(' ') && indent.includes('\t')){
      D.push(mkDiag({ rule:'PY-INDENT', severity:'warning', start:L.ls, end:L.ls + indent.length,
        token:'indentation',
        message:'This line mixes tabs and spaces in its indentation, which can cause subtle indentation errors.',
        suggestion:'Use spaces only (PEP 8 recommends 4 spaces per level).' }));
    }

    // missing colon after block header
    if (kwRe.test(mt) && !mt.endsWith(':') && !mt.endsWith('\\')){
      const kw = mt.match(kwRe)[1];
      let endOff = L.le;
      while (endOff > L.ls && /\s/.test(ctx.masked[endOff - 1])) endOff--;
      if (endOff > L.ls){
        D.push(mkDiag({ rule:'PY-COLON', severity:'error', start:endOff, end:endOff, token:':',
          message:`'${kw}' block header is missing its trailing colon.`,
          suggestion:"Add ':' at the end of the header line.",
          fix:{ start:endOff, end:endOff, text:':', label:`insert ':' after '${kw}' header` } }));
      }
    }

    // Python 2 style print statement
    const pm = /^\s*print\b(?!\s*\()/.exec(L.mask);
    if (pm){
      let s = L.ls + pm[0].length;
      let e = L.le;
      while (e > s && /\s/.test(ctx.masked[e - 1])) e--;
      const expr = ctx.src.slice(s, e).trim();
      if (expr && !/^[=+\-*/%<>|&^]/.test(expr)){
        D.push(mkDiag({ rule:'PY-PRINT', severity:'error', start:L.ls + pm[0].index, end:L.ls + pm[0].index + pm[0].length,
          token:'print',
          message:'Python 2 style print statement; print is a function in Python 3.',
          suggestion:'Wrap the arguments in parentheses: print(...).',
          fix:{ start:s, end:e, text:'(' + expr + ')', label:'convert to print(...)' } }));
      }
    }

    // lowercase true / false / null
    const reBool = /\b(true|false|null)\b/g;
    let bm;
    while ((bm = reBool.exec(L.mask))){
      const abs = L.ls + bm.index;
      if (ctx.masked[abs - 1] === '.') continue;
      const word = bm[1];
      const rep = word === 'null' ? 'None' : (word === 'true' ? 'True' : 'False');
      D.push(mkDiag({ rule: word === 'null' ? 'PY-NULL' : 'PY-BOOL', severity:'warning',
        start:abs, end:abs + word.length, token:word,
        message:`'${word}' is not defined in Python; the boolean/none literals are capitalized${word === 'null' ? " ('null' is a JavaScript keyword)" : ''}.`,
        suggestion:`Replace '${word}' with '${rep}'.`,
        fix:{ start:abs, end:abs + word.length, text:rep, label:`replace '${word}' with '${rep}'` } }));
    }

    // x.length -> len(x)
    const reLen = /\b([A-Za-z_]\w*)\s*\.\s*length\b/g;
    let lm;
    while ((lm = reLen.exec(L.mask))){
      const abs = L.ls + lm.index;
      D.push(mkDiag({ rule:'PY-LENGTH', severity:'warning', start:abs, end:abs + lm[0].length,
        token:lm[0],
        message:`'${lm[1]}.length' is JavaScript style; Python uses the len() builtin.`,
        suggestion:`Use 'len(${lm[1]})'.`,
        fix:{ start:abs, end:abs + lm[0].length, text:`len(${lm[1]})`, label:`replace '${lm[0]}' with 'len(${lm[1]})'` } }));
    }
  }
  return D;
}

/* ---------------- JavaScript rules ---------------- */

function rulesJs(ctx){
  const D = [];
  const { tokens, src } = ctx;

  tokens.forEach((t, i) => {
    if (t.t !== 'operator') return;
    const op = src.slice(t.s, t.e);
    if (op !== '==' && op !== '!=') return;
    let j = i + 1;
    while (j < tokens.length && tokens[j].t === 'plain') j++;
    const nx = j < tokens.length ? src.slice(tokens[j].s, tokens[j].e) : '';
    const nullish = (nx === 'null' || nx === 'undefined');
    const strict = op + '=';
    D.push(mkDiag({ rule: op === '==' ? 'JS-EQ' : 'JS-NEQ', severity:'warning', start:t.s, end:t.e, token:op,
      message:`'${op}' performs type coercion; strict '${strict}' is usually intended.` +
        (nullish ? " (Comparing with null/undefined via '==' also matches the other nullish value, so this is left unchanged.)" : ''),
      suggestion:`Use '${strict}' for strict comparison.`,
      fix: nullish ? null : { start:t.s, end:t.e, text:strict, label:`replace '${op}' with '${strict}'` } }));
  });

  D.push(...varDeclarations(ctx));
  D.push(...assignInCondition(ctx, 'JS-ASSIGN-COND'));
  D.push(...missingSemicolons(ctx, { starters: JS_STARTERS, rule:'JS-SEMI' }));
  return D;
}

/* ---------------- Java rules ---------------- */

function rulesJava(ctx){
  const D = [];
  D.push(...assignInCondition(ctx, 'JAVA-ASSIGN-COND'));
  D.push(...missingSemicolons(ctx, { starters: JAVA_STARTERS, rule:'JAVA-SEMI' }));
  return D;
}

/* ---------------- fix application ---------------- */

function applyFixes(src, fixes){
  const fs = fixes.slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));
  let out = '', pos = 0;
  const applied = [], skipped = [];
  for (const f of fs){
    if (f.start < pos){ skipped.push(f); continue; }
    out += src.slice(pos, f.start) + f.text;
    pos = f.end;
    applied.push(f);
  }
  out += src.slice(pos);
  return { code: out, applied, skipped };
}

/* ---------------- analysis run & right-panel rendering ---------------- */

function runAnalysis(){
  const src = els.editorInput.value;
  if (!src.trim()){
    state.analysis = null;
    renderInspector();
    renderDiagnostics([]);
    updateMetrics(0, 0, src ? src.split('\n').length : 0);
    setStatus('ready', 'Ready — waiting for source');
    return;
  }
  setStatus('busy', 'Analyzing…');
  setTimeout(() => {
    try {
      const res = analyzeSource(src, els.languageSelect.value);
      state.analysis = res;
      renderInspector();
      renderDiagnostics(res.diagnostics);
      const errs = res.diagnostics.filter(d => d.severity === 'error').length;
      updateMetrics(errs, res.diagnostics.length - errs, src.split('\n').length);
      const langName = LANG_LABEL[res.lang] || res.lang;
      els.navLang.textContent = langName + (els.languageSelect.value === 'auto' ? ' · auto' : '');
      els.statLang.textContent = langName;
      if (src.length > ANALYZE_LIMIT) setStatus('warn', 'Source too large — analysis skipped');
      else if (res.effLang === 'plaintext') setStatus('warn', 'Unsupported syntax check');
      else if (res.diagnostics.length === 0) setStatus('ok', 'No issues detected');
      else setStatus('issues', `Analysis complete — ${res.diagnostics.length} finding${res.diagnostics.length === 1 ? '' : 's'}`);
      refreshActiveSolution();
    } catch (err){
      console.error('[DiffStudio] analysis error:', err);
      setStatus('warn', 'Analysis failed — see console');
    }
  }, 30);
}

function updateMetrics(errors, warnings, lines){
  els.countErrors.textContent = String(errors);
  els.countWarnings.textContent = String(warnings);
  els.countLines.textContent = String(lines);
  document.getElementById('metric-errors').classList.toggle('hot', errors > 0);
  document.getElementById('metric-warnings').classList.toggle('hot', warnings > 0);
}

function renderInspector(){
  const box = els.inspector;
  const src = els.editorInput.value;
  if (!src.trim() || !state.analysis){
    box.innerHTML = '<p class="inspector-empty">Load or type source code to see the annotated inspector.</p>';
    return;
  }
  const { tokens, diagnostics, lineStarts } = state.analysis;
  const lines = src.split('\n');

  const diagsByLine = new Map();
  diagnostics.forEach((d, di) => {
    const ln = offsetToLC(lineStarts, d.start).line;
    if (!diagsByLine.has(ln)) diagsByLine.set(ln, []);
    diagsByLine.get(ln).push({ d, di });
  });

  let g = 0, html = '';
  for (let li = 0; li < lines.length; li++){
    const ls = lineStarts[li];
    const le = ls + lines[li].length;
    const lineTokens = [];
    let k = g;
    while (k < tokens.length && tokens[k].s < le){
      if (tokens[k].e > ls) lineTokens.push(tokens[k]);
      k++;
    }
    while (g < tokens.length && tokens[g].e <= le) g++;

    const cuts = new Set([ls, le]);
    for (const t of lineTokens){ cuts.add(Math.max(t.s, ls)); cuts.add(Math.min(t.e, le)); }
    const lineDiags = diagsByLine.get(li + 1) || [];
    const insertions = [];
    for (const { d, di } of lineDiags){
      if (d.start === d.end){
        if (d.start >= ls && d.start <= le) insertions.push({ d, di, off: d.start });
        continue;
      }
      cuts.add(Math.max(d.start, ls)); cuts.add(Math.min(d.end, le));
    }
    const pts = Array.from(cuts).sort((a, b) => a - b);
    const findTok = off => {
      for (const t of lineTokens) if (off >= t.s && off < t.e) return t;
      return null;
    };
    const findDeco = (a, b) => {
      let best = null;
      for (const { d, di } of lineDiags){
        if (d.start === d.end) continue;
        if (d.start < b && d.end > a){
          if (!best || (d.severity === 'error' && best.d.severity !== 'error')) best = { d, di };
        }
      }
      return best;
    };
    let lineHtml = '';
    for (const ins of insertions) if (ins.off === ls){
      lineHtml += `<span class="ghost ghost-${ins.d.severity === 'error' ? 'err' : 'warn'}" data-d="${ins.di}">${escapeHtml(ins.d.fix ? ins.d.fix.text : '•')}</span>`;
    }
    for (let p = 0; p < pts.length - 1; p++){
      const a = pts[p], b = pts[p + 1];
      if (a === b) continue;
      const text = src.slice(a, b);
      const tok = findTok(a);
      const deco = findDeco(a, b);
      let cls = tok ? (TOKEN_CLASS[tok.t] || '') : '';
      if (deco) cls = (cls ? cls + ' ' : '') + 'deco-' + (deco.d.severity === 'error' ? 'err' : 'warn');
      const attrs = deco ? ` data-d="${deco.di}"` : '';
      lineHtml += cls ? `<span class="${cls}"${attrs}>${escapeHtml(text)}</span>` : escapeHtml(text);
      for (const ins of insertions) if (ins.off === b){
        lineHtml += `<span class="ghost ghost-${ins.d.severity === 'error' ? 'err' : 'warn'}" data-d="${ins.di}">${escapeHtml(ins.d.fix ? ins.d.fix.text : '•')}</span>`;
      }
    }
    html += `<div class="il" id="il-${li + 1}"><span class="ln">${li + 1}</span><span class="lc">${lineHtml || '&nbsp;'}</span></div>`;
  }
  box.innerHTML = html;
}

function renderDiagnostics(diags){
  els.diagSummary.textContent = diags.length ? `${diags.length} finding${diags.length === 1 ? '' : 's'}` : 'No findings';
  if (!diags.length){
    els.diagnosticsList.innerHTML =
      '<li class="diag-empty">No issues matched the local heuristic rules. This analyzer is not a compiler — a clean result means the implemented checks found nothing, not that the code is guaranteed valid.</li>';
    return;
  }
  const MAX = 200;
  let html = '';
  diags.slice(0, MAX).forEach((d, di) => {
    const sevCls = d.severity === 'error' ? 'error' : 'warning';
    html += `<li class="diag diag-${sevCls}" data-idx="${di}" tabindex="0" role="button"
        aria-label="${sevCls} ${escapeHtml(d.rule)} at line ${d.line}: ${escapeHtml(d.message)}">
      <div class="diag-head">
        <span class="sev sev-${sevCls}">${d.severity === 'error' ? 'ERROR' : 'WARNING'}</span>
        <span class="rule">${escapeHtml(d.rule)}</span>
        <span class="pos">Ln ${d.line}, Col ${d.col}</span>
      </div>
      <p class="diag-msg">${escapeHtml(d.message)}</p>
      ${d.token ? `<p class="diag-token">token: <code>${escapeHtml(d.token)}</code></p>` : ''}
      ${d.suggestion ? `<p class="diag-fix">Suggested fix: ${escapeHtml(d.suggestion)}</p>` : ''}
      <button class="jump" data-idx="${di}" type="button">Jump to code ↗</button>
    </li>`;
  });
  if (diags.length > MAX) html += `<li class="diag-empty">…and ${diags.length - MAX} more findings.</li>`;
  els.diagnosticsList.innerHTML = html;
}

function navigateToDiag(d, di){
  const lineEl = document.getElementById('il-' + d.line);
  if (lineEl){
    els.inspector.scrollTop = Math.max(0,
      lineEl.offsetTop - els.inspector.clientHeight / 2 + lineEl.offsetHeight / 2);
    els.inspector.querySelectorAll(`[data-d="${di}"]`).forEach(sp => {
      sp.classList.remove('flash');
      void sp.offsetWidth;
      sp.classList.add('flash');
      setTimeout(() => sp.classList.remove('flash'), 1300);
    });
  }
  const ta = els.editorInput;
  ta.focus();
  const end = d.end > d.start ? d.end : Math.min(d.start + 1, ta.value.length);
  try { ta.setSelectionRange(d.start, end); } catch (_) {}
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (d.line - 1) * lh - ta.clientHeight / 2 + lh);
}

/* ---------------- editor behavior ---------------- */

function toggleEmptyState(){
  els.editorEmpty.hidden = els.editorInput.value.length > 0;
}

function updateGutter(src){
  const count = src ? src.split('\n').length : 0;
  if (count === state.gutterCount) return;
  state.gutterCount = count;
  els.editorGutter.textContent = count ? Array.from({ length: count }, (_, i) => i + 1).join('\n') : '';
  const digits = String(Math.max(count, 1)).length;
  els.editorGutter.parentElement.style.width = (digits + 2.4) + 'ch';
}

function updateHighlight(){
  const src = els.editorInput.value;
  toggleEmptyState();
  updateGutter(src);
  if (src.length > HIGHLIGHT_LIMIT){
    els.editorHlCode.textContent = src;
    return;
  }
  highlightInto(els.editorHlCode, src, resolveLanguage(src));
}

function updateStats(){
  const v = els.editorInput.value;
  els.statLines.textContent = String(v ? v.split('\n').length : 0);
  els.statChars.textContent = String(v.length);
  els.statLang.textContent = LANG_LABEL[resolveLanguage(v)] || '—';
}

function syncScroll(){
  const ta = els.editorInput;
  els.editorHl.scrollTop = ta.scrollTop;
  els.editorHl.scrollLeft = ta.scrollLeft;
  els.editorGutter.style.transform = `translateY(${-ta.scrollTop}px)`;
}

function insertText(text){
  const ta = els.editorInput;
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
  if (!ok){
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function onEditorKeydown(e){
  const ta = els.editorInput;
  if (e.key === 'Tab'){
    e.preventDefault();
    if (e.shiftKey){
      const before = ta.value.slice(0, ta.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineHead = ta.value.slice(lineStart, lineStart + 2);
      if (lineHead === '  '){
        ta.setSelectionRange(lineStart, lineStart + 2);
        insertText('');
      }
    } else {
      insertText('  ');
    }
    return;
  }
  if (e.key === 'Enter'){
    e.preventDefault();
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const currentLine = before.slice(lineStart);
    const indent = (currentLine.match(/^[ \t]*/) || [''])[0];
    const prevCh = before.replace(/[ \t]+$/, '').slice(-1);
    const after = ta.value.slice(ta.selectionEnd);
    const nextCh = after.replace(/^[ \t]+/, '')[0] || '';
    const opensBlock = prevCh === '{' || prevCh === ':' || prevCh === '(';
    if (opensBlock && nextCh === '}'){
      const extra = indent + '  ';
      insertText('\n' + extra + '\n' + indent);
      const newPos = pos + 1 + extra.length;
      ta.setSelectionRange(newPos, newPos);
    } else {
      insertText('\n' + indent + (opensBlock ? '  ' : ''));
    }
  }
}

function scheduleAnalysis(){
  clearTimeout(state.analyzeTimer);
  state.analyzeTimer = setTimeout(runAnalysis, 650);
}

function onEditorInput(){
  if (!state.hlQueued){
    state.hlQueued = true;
    requestAnimationFrame(() => { state.hlQueued = false; updateHighlight(); });
  }
  updateStats();
  scheduleAnalysis();
}

function setWrap(on){
  state.wrap = on;
  els.editorInput.wrap = on ? 'soft' : 'off';
  els.editorBody.classList.toggle('wrap', on);
  els.btnWrap.setAttribute('aria-pressed', String(on));
  els.btnWrap.textContent = 'Wrap: ' + (on ? 'on' : 'off');
  syncScroll();
}

function setSource(text, fileName, langValue){
  els.editorInput.value = text;
  if (langValue) els.languageSelect.value = langValue;
  els.fileName.textContent = fileName || 'untitled';
  updateHighlight();
  updateStats();
  runAnalysis();
}

/* ---------------- file handling ---------------- */

function langFromExtension(name){
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { cpp:'cpp', cc:'cpp', cxx:'cpp', h:'cpp', hpp:'cpp', py:'python',
                js:'javascript', ts:'typescript', java:'java', txt:null };
  return (ext in map) ? map[ext] : undefined; // undefined => unsupported
}

function handleFileUpload(file){
  if (!file) return;
  const mapped = langFromExtension(file.name);
  if (mapped === undefined){
    showToast('Unsupported file type. Use .cpp .cc .cxx .py .js .ts .java or .txt', 'err');
    return;
  }
  if (file.size > MAX_FILE_BYTES){
    showToast('File is too large (limit 2 MB). Current source was kept.', 'err');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showToast('Could not read the file. Current source was kept.', 'err');
  reader.onload = () => {
    try {
      const text = String(reader.result || '');
      const selVal = mapped === 'typescript' ? 'javascript' : (mapped || 'auto');
      setSource(text, file.name, selVal);
      if (mapped === 'typescript'){
        showToast('TypeScript loaded with JavaScript rules — type annotations may be read imperfectly.', 'info');
      } else {
        showToast(`Loaded ${file.name}`, 'ok');
      }
    } catch (err){
      console.error(err);
      showToast('Failed to load file contents.', 'err');
    }
  };
  reader.readAsText(file);
}

function loadDemo(){
  let lang = els.languageSelect.value;
  if (lang === 'auto' || !DEMOS[lang]){ lang = 'cpp'; els.languageSelect.value = 'cpp'; }
  const ext = { cpp:'.cpp', python:'.py', javascript:'.js', java:'.java' }[lang];
  setSource(DEMOS[lang], 'demo' + ext, lang);
  showToast(`Loaded ${lang} demo`, 'ok');
}

function clearEditor(){
  const btn = els.btnClear;
  if (!els.editorInput.value){ return; }
  if (!state.clearArmed){
    state.clearArmed = true;
    btn.textContent = 'Confirm clear?';
    state.clearTimer = setTimeout(() => { state.clearArmed = false; btn.textContent = 'Clear'; }, 2500);
    return;
  }
  clearTimeout(state.clearTimer);
  state.clearArmed = false;
  btn.textContent = 'Clear';
  setSource('', 'untitled', null);
  showToast('Editor cleared', 'info');
}

function setupDragDrop(){
  let depth = 0;
  const body = els.editorBody;
  body.addEventListener('dragenter', e => { e.preventDefault(); depth++; els.dropOverlay.classList.add('visible'); });
  body.addEventListener('dragover', e => { e.preventDefault(); });
  body.addEventListener('dragleave', e => { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) els.dropOverlay.classList.remove('visible'); });
  body.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; els.dropOverlay.classList.remove('visible');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFileUpload(f);
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

/* ---------------- solution generation ---------------- */

function renderSolution(code, items, opts){
  opts = opts || {};
  const mode = opts.mode || state.activeTab;
  state.output = { code: code || '', mode, lang: opts.lang || resolveLanguage(code || els.editorInput.value) };
  els.outputMode.textContent = MODE_LABEL[mode] || 'Output';
  if (code){
    highlightInto(els.outputCode, code, state.output.lang);
  } else {
    els.outputCode.innerHTML = '<span class="tk-comment">// No output yet — choose a tab and run its action.</span>';
  }
  const icons = { ok:'✓', warn:'⚠', info:'ℹ' };
  els.changesList.innerHTML = (items && items.length)
    ? items.map(it => `<li class="chg chg-${it.kind}">${icons[it.kind] || 'ℹ'} ${escapeHtml(it.text)}</li>`).join('')
    : '<li class="chg chg-info">No notes.</li>';
}

function generateCorrectedCode(){
  const src = els.editorInput.value;
  if (!src.trim()){
    renderSolution('', [{ kind:'info', text:'Nothing to correct — the editor is empty.' }], { mode:'corrected' });
    return;
  }
  try {
    const res = analyzeSource(src, els.languageSelect.value);
    const fixes = [];
    const items = [];
    const unresolved = [];
    for (const d of res.diagnostics){
      if (d.fix) fixes.push(Object.assign({ rule:d.rule, line:d.line }, d.fix));
      else unresolved.push(d);
    }
    const { code, applied, skipped } = applyFixes(src, fixes);
    applied.forEach(f => items.push({ kind:'ok',
      text:`[${f.rule}] line ${f.line}: ${f.label}.` }));
    skipped.forEach(f => items.push({ kind:'warn',
      text:`[${f.rule}] line ${f.line}: skipped overlapping fix (${f.label}).` }));
    unresolved.forEach(d => items.push({ kind:'warn',
      text:`[${d.rule}] line ${d.line}: ${d.message} — left unchanged for review.` }));
    if (!applied.length && !unresolved.length){
      items.push({ kind:'info', text:'No confident automatic fixes were applicable for this source.' });
    }
    items.push({ kind:'info', text:'Heuristic engine: only high-confidence fixes were applied; everything else is preserved verbatim.' });
    renderSolution(code, items, { mode:'corrected', lang:res.effLang });
  } catch (err){
    console.error(err);
    renderSolution(src, [{ kind:'warn', text:'Correction failed unexpectedly; original code shown.' }], { mode:'corrected' });
  }
}

function fstringTransform(src){
  const tokens = tokenizeCode(src, 'python');
  const masked = maskSource(src, tokens, true); // keep strings, blank comments
  const chainRe = /"(?:[^"\\\n]|\\.)*"(?:[ \t]*\+[ \t]*(?:"(?:[^"\\\n]|\\.)*"|[A-Za-z_]\w*))+/g;
  const matches = [];
  let m;
  while ((m = chainRe.exec(masked))) matches.push({ s:m.index, e:m.index + m[0].length });
  let count = 0;
  for (let i = matches.length - 1; i >= 0; i--){
    const { s, e } = matches[i];
    const partRe = /"((?:[^"\\\n]|\\.)*)"|([A-Za-z_]\w*)/g;
    const parts = [];
    let pm, ok = true;
    while ((pm = partRe.exec(src.slice(s, e)))){
      if (pm[1] !== undefined){
        if (pm[1].includes('{') || pm[1].includes('}')){ ok = false; break; }
        parts.push({ str:pm[1] });
      } else parts.push({ id:pm[2] });
    }
    if (!ok || !parts.some(p => p.id)) continue;
    const inner = parts.map(p => p.str !== undefined ? p.str : '{' + p.id + '}').join('');
    src = src.slice(0, s) + 'f"' + inner + '"' + src.slice(e);
    count++;
  }
  return { code:src, count };
}

function generateImprovedCode(){
  const src = els.editorInput.value;
  if (!src.trim()){
    renderSolution('', [{ kind:'info', text:'Nothing to improve — the editor is empty.' }], { mode:'improved' });
    return;
  }
  const lang = resolveLanguage(src);
  const items = [];
  let code = src;

  const cleaned = code.replace(/[ \t]+$/gm, '');
  if (cleaned !== code){
    const n = (code.match(/[ \t]+$/gm) || []).length;
    code = cleaned;
    items.push({ kind:'ok', text:`Removed trailing whitespace on ${n} line(s).` });
  }
  if (code && !code.endsWith('\n')){
    code += '\n';
    items.push({ kind:'ok', text:'Ensured the file ends with a newline.' });
  }

  if (lang === 'cpp'){
    const toks = tokenizeCode(code, 'cpp');
    const fixes = [];
    for (const t of toks){
      if ((t.t === 'builtin' || t.t === 'ident') && code.slice(t.s, t.e) === 'endl'){
        fixes.push({ start:t.s, end:t.e, text:"'\\n'", label:"endl → '\\n'" });
      }
    }
    if (fixes.length){
      code = applyFixes(code, fixes).code;
      items.push({ kind:'ok', text:`Replaced ${fixes.length} 'endl' with '\\n'.` });
      items.push({ kind:'info', text:"'endl' also flushes the stream. Restore it where a flush is required (e.g. before blocking input)." });
    } else {
      items.push({ kind:'info', text:"No 'endl' usage found to improve." });
    }
  } else if (lang === 'python'){
    const res = analyzeSource(code, 'python');
    const printFixes = res.diagnostics.filter(d => d.rule === 'PY-PRINT' && d.fix).map(d => d.fix);
    if (printFixes.length){
      code = applyFixes(code, printFixes).code;
      items.push({ kind:'ok', text:`Converted ${printFixes.length} Python 2 print statement(s) to print().` });
    }
    const fs = fstringTransform(code);
    if (fs.count){
      code = fs.code;
      items.push({ kind:'ok', text:`Converted ${fs.count} string concatenation(s) into f-string(s).` });
    }
    if (!printFixes.length && !fs.count){
      items.push({ kind:'info', text:'No safe Python modernizations found in this source.' });
    }
  } else if (lang === 'javascript'){
    const res = analyzeSource(code, 'javascript');
    const varFixes = res.diagnostics.filter(d => d.rule === 'JS-VAR' && d.fix).map(d => d.fix);
    if (varFixes.length){
      code = applyFixes(code, varFixes).code;
      items.push({ kind:'ok', text:`Modernized ${varFixes.length} 'var' declaration(s) to const/let based on reassignment analysis.` });
    } else {
      items.push({ kind:'info', text:"No 'var' declarations found to modernize." });
    }
  } else if (lang === 'java'){
    items.push({ kind:'info', text:'No automated improvements are enabled for Java yet — try “format indentation” in the Custom tab.' });
  } else {
    items.push({ kind:'info', text:'No improvement rules are available for this language.' });
  }
  renderSolution(code, items, { mode:'improved', lang });
}

/* ---------------- custom transformation engine ---------------- */

function supportedCommandsText(){
  return [
    'Supported local commands (natural language, matched by keywords):',
    '• convert the for loop to a while loop   (C++, JavaScript, Java; simple single-line headers)',
    '• convert the while loop to a for loop    (C++, JavaScript, Java)',
    '• modernize var declarations              (JavaScript)',
    '• replace endl with \\n                    (C++)',
    '• add error handling                      (JavaScript: wraps JSON.parse statements in try/catch)',
    '• format indentation                      (C++, JavaScript, Java)',
    '• explain the code                        (all languages; code left unchanged)',
    '• help                                    (shows this list)'
  ];
}

function parseCommand(text){
  const t = ' ' + text.toLowerCase() + ' ';
  if (/help|what can you|supported (commands|transformations)|list (commands|transformations)|summary of (commands|transformations)/.test(t)) return { id:'help' };
  if (/explain/.test(t)) return { id:'explain' };
  if (/format|indent/.test(t)) return { id:'format' };
  if (/error handling|try\s*\/\s*catch|try.?catch|try\s*except/.test(t)) return { id:'errhandle' };
  if (/\bendl\b/.test(t)) return { id:'endl' };
  if (/moderni[sz]e|use (const|let)|\bvar\b.*\b(const|let)\b|\b(const|let)\b.*\bvar\b/.test(t)) return { id:'modernize' };
  const fi = t.indexOf('for'), wi = t.indexOf('while');
  if (fi !== -1 && wi !== -1) return fi < wi ? { id:'for2while' } : { id:'while2for' };
  if (/to while|into while/.test(t)) return { id:'for2while' };
  if (/to for|into for/.test(t)) return { id:'while2for' };
  return null;
}

function findMatchingBrace(masked, openIdx){
  let depth = 1;
  for (let i = openIdx + 1; i < masked.length; i++){
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}'){ depth--; if (depth === 0) return i; }
  }
  return -1;
}

function cmdForToWhile(src, lang){
  let code = src, count = 0, guard = 0;
  while (guard++ < 10){
    const masked = maskSource(src === code ? maskSource(src, tokenizeCode(src, lang), false)
                                           : maskSource(code, tokenizeCode(code, lang), false), [], false) || '';
    // recompute cleanly each iteration:
    const mTokens = tokenizeCode(code, lang);
    const mMasked = maskSource(code, mTokens, false);
    const m = /\bfor\s*\(\s*([^;()]*)\s*;\s*([^;()]*)\s*;\s*([^;()]*)\s*\)\s*\{/.exec(mMasked);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(mMasked, open);
    if (close === -1){
      return { ok:false, message:'Found a for loop but could not locate its closing brace; code left unchanged.', code:src, items:[] };
    }
    const init = m[1].trim(), cond = m[2].trim(), upd = m[3].trim();
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const indent = (code.slice(lineStart, m.index).match(/^[ \t]*/) || [''])[0];
    const head = (init ? init + ';\n' + indent : '') + `while (${cond}) {`;
    const insert = upd ? indent + '  ' + upd + ';\n' + indent : '';
    code = code.slice(0, m.index) + head + code.slice(open + 1);
    const newClose = close - (open + 1 - m.index) + head.length;
    code = code.slice(0, newClose) + insert + code.slice(newClose);
    count++;
    void masked;
  }
  if (!count) return { ok:false, message:'No supported single-line for(...) loop with a brace body was found.', code:src, items:[] };
  return { ok:true, message:`Converted ${count} for loop(s) to while loop(s).`, code,
    items:[
      { kind:'ok', text:`Converted ${count} for loop(s) to while loop(s).` },
      { kind:'info', text:'Note: variables declared in the for header were moved above the loop, widening their scope slightly. Run “format indentation” to tidy spacing.' }
    ] };
}

function cmdWhileToFor(src, lang){
  const masked = maskSource(src, tokenizeCode(src, lang), false);
  const re = /\bwhile\s*\(\s*([^()]*)\s*\)\s*\{/g;
  const matches = [];
  let m;
  while ((m = re.exec(masked))) matches.push({ s:m.index, e:m.index + m[0].length, cond:m[1].trim() });
  if (!matches.length) return { ok:false, message:'No supported while(...) loop with a brace body was found.', code:src, items:[] };
  let code = src;
  for (let i = matches.length - 1; i >= 0; i--){
    const r = matches[i];
    code = code.slice(0, r.s) + `for (; ${r.cond}; ) {` + code.slice(r.e);
  }
  return { ok:true, message:`Rewrote ${matches.length} while loop(s) as header-only for loops.`, code,
    items:[{ kind:'ok', text:`Rewrote ${matches.length} while loop(s) as for(;condition;) loops. Init/update were not invented — add them manually if needed.` }] };
}

function cmdModernizeJs(src){
  const res = analyzeSource(src, 'javascript');
  const fixes = res.diagnostics.filter(d => d.rule === 'JS-VAR' && d.fix).map(d => d.fix);
  if (!fixes.length) return { ok:true, message:'No var declarations found to modernize.', code:src,
    items:[{ kind:'info', text:'No var declarations found; nothing changed.' }] };
  const code = applyFixes(src, fixes).code;
  return { ok:true, message:`Modernized ${fixes.length} declaration(s).`, code,
    items:[{ kind:'ok', text:`Replaced ${fixes.length} 'var' with const/let (const only when never reassigned).` }] };
}

function cmdEndl(src){
  const toks = tokenizeCode(src, 'cpp');
  const fixes = [];
  for (const t of toks){
    if ((t.t === 'builtin' || t.t === 'ident') && src.slice(t.s, t.e) === 'endl'){
      fixes.push({ start:t.s, end:t.e, text:"'\\n'" });
    }
  }
  if (!fixes.length) return { ok:true, message:'No endl usage found.', code:src,
    items:[{ kind:'info', text:'No endl found; nothing changed.' }] };
  return { ok:true, message:`Replaced ${fixes.length} endl occurrence(s).`, code:applyFixes(src, fixes).code,
    items:[
      { kind:'ok', text:`Replaced ${fixes.length} 'endl' with '\\n'.` },
      { kind:'info', text:'Keep endl where an explicit flush is required.' }
    ] };
}

function cmdErrorHandling(src, lang){
  if (lang !== 'javascript'){
    return { ok:false,
      message:'Automatic error handling currently supports JavaScript JSON.parse statements only. For other cases, wrap the risky call in try/catch manually.',
      code:src, items:[] };
  }
  const masked = maskSource(src, tokenizeCode(src, 'javascript'), false);
  const mlines = masked.split('\n');
  const ranges = [];
  let off = 0;
  mlines.forEach(ml => {
    const ls = off; off += ml.length + 1;
    if (/JSON\.parse\s*\(/.test(ml) && !/^try\b/.test(ml.trim())) ranges.push({ ls, le:ls + ml.length });
  });
  if (!ranges.length) return { ok:false, message:'No JSON.parse(...) call found to wrap.', code:src, items:[] };
  let code = src;
  for (let k = ranges.length - 1; k >= 0; k--){
    const r = ranges[k];
    const origLine = src.slice(r.ls, r.le);
    const ind = (origLine.match(/^[ \t]*/) || [''])[0];
    const trimmed = origLine.trim();
    const block = `try {\n${ind}  ${trimmed}\n${ind}} catch (err) {\n${ind}  console.error("Invalid JSON:", err);\n${ind}}`;
    code = code.slice(0, r.ls) + block + code.slice(r.le);
  }
  return { ok:true, message:`Wrapped ${ranges.length} JSON.parse statement(s) in try/catch.`, code,
    items:[{ kind:'ok', text:`Wrapped ${ranges.length} JSON.parse statement(s) in try/catch.` }] };
}

function reindentCode(src, lang){
  if (lang === 'python'){
    return { code:src, changed:false,
      note:'Automatic re-indentation is disabled for Python because indentation is semantic.' };
  }
  const masked = maskSource(src, tokenizeCode(src, lang), false);
  const lines = src.split('\n');
  const mlines = masked.split('\n');
  let depth = 0;
  const out = [];
  let changed = 0;
  for (let i = 0; i < lines.length; i++){
    const mt = mlines[i].trim();
    if (!mt){ out.push(''); if (lines[i] !== '') changed++; continue; }
    let d = depth;
    if (/^[}\])]/.test(mt)) d = Math.max(0, depth - 1);
    const rebuilt = '  '.repeat(d) + lines[i].trim();
    if (rebuilt !== lines[i]) changed++;
    out.push(rebuilt);
    for (const ch of mlines[i]){
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return { code:out.join('\n'), changed, note:null };
}

function cmdFormat(src, lang){
  if (lang === 'python'){
    return { ok:true, message:'Python indentation was left untouched (it is semantic).', code:src,
      items:[{ kind:'info', text:'Automatic re-indentation is disabled for Python because indentation changes program meaning.' }] };
  }
  const r = reindentCode(src, lang);
  if (!r.changed) return { ok:true, message:'Indentation already consistent; nothing changed.', code:src,
    items:[{ kind:'info', text:'No indentation changes were needed.' }] };
  return { ok:true, message:`Re-indented ${r.changed} line(s) with 2-space steps.`, code:r.code,
    items:[{ kind:'ok', text:`Re-indented ${r.changed} line(s) based on brace depth (strings/comments excluded from counting).` }] };
}

function buildExplanation(src, res){
  const out = [];
  const lines = src.split('\n').length;
  out.push(`Language: ${LANG_LABEL[res.lang] || res.lang} · ${lines} lines · ${src.length} characters.`);
  const defs = [];
  let reFn;
  if (res.effLang === 'python') reFn = /^\s*def\s+([A-Za-z_]\w*)/gm;
  else if (res.effLang === 'javascript') reFn = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  else reFn = /\b([A-Za-z_]\w*)\s*\([^()]*\)\s*\{/g;
  const skip = new Set(['if','for','while','switch','catch','return','sizeof']);
  let m;
  while ((m = reFn.exec(src)) && defs.length < 25){
    if (!skip.has(m[1]) && !defs.includes(m[1])) defs.push(m[1]);
  }
  out.push(defs.length ? `Functions/methods found: ${defs.join(', ')}.` : 'No function definitions detected.');
  const ifs = (src.match(/\bif\b/g) || []).length;
  const fors = (src.match(/\bfor\b/g) || []).length;
  const whiles = (src.match(/\bwhile\b/g) || []).length;
  out.push(`Control flow (raw text counts): ${ifs} if, ${fors} for, ${whiles} while.`);
  if (res.diagnostics.length){
    out.push(`Static analysis matched ${res.diagnostics.length} finding(s): ` +
      res.diagnostics.slice(0, 5).map(d => `[${d.rule} line ${d.line}]`).join(', ') +
      (res.diagnostics.length > 5 ? ' …' : '') + '.');
  } else {
    out.push('Static analysis matched no heuristic rules on this source.');
  }
  out.push('This explanation was generated locally from lightweight pattern analysis — the code itself was not modified.');
  return out;
}

function applyCustomTransformation(){
  const instr = (els.customInput.value || '').trim();
  const statusEl = els.customStatus;
  const setStat = (txt, kind) => { statusEl.textContent = txt; statusEl.className = 'custom-status ' + (kind || ''); };
  if (!instr){ setStat('Enter an instruction first.', 'warn'); return; }
  const src = els.editorInput.value;
  if (!src.trim()){ setStat('The editor is empty — load some code first.', 'warn'); return; }
  const lang = resolveLanguage(src);
  const cmd = parseCommand(instr);
  if (!cmd){
    setStat('Instruction not supported by the offline engine.', 'err');
    renderSolution(src,
      [{ kind:'warn', text:`The instruction “${instr}” is not supported. This offline engine cannot perform arbitrary AI-style code generation.` },
       ...supportedCommandsText().map(t => ({ kind:'info', text:t }))],
      { mode:'custom', lang });
    return;
  }
  let r;
  switch (cmd.id){
    case 'help':
      r = { ok:true, message:'Supported command reference shown in the output notes.', code:src,
            items: supportedCommandsText().map(t => ({ kind:'info', text:t })) };
      break;
    case 'explain':
      r = { ok:true, message:'Explanation generated — the code was left unchanged.', code:src,
            items: buildExplanation(src, analyzeSource(src, els.languageSelect.value)).map(t => ({ kind:'info', text:t })) };
      break;
    case 'format':
      r = cmdFormat(src, lang); break;
    case 'errhandle':
      r = cmdErrorHandling(src, lang); break;
    case 'endl':
      if (lang !== 'cpp') r = { ok:false, message:'endl replacement applies to C++ sources only.', code:src, items:[] };
      else r = cmdEndl(src);
      break;
    case 'modernize':
      if (lang !== 'javascript') r = { ok:false, message:'Declaration modernization applies to JavaScript sources only.', code:src, items:[] };
      else r = cmdModernizeJs(src);
      break;
    case 'for2while':
      if (!['cpp','javascript','java'].includes(lang)) r = { ok:false, message:'for→while conversion supports C++, JavaScript and Java only.', code:src, items:[] };
      else r = cmdForToWhile(src, lang);
      break;
    case 'while2for':
      if (!['cpp','javascript','java'].includes(lang)) r = { ok:false, message:'while→for conversion supports C++, JavaScript and Java only.', code:src, items:[] };
      else r = cmdWhileToFor(src, lang);
      break;
    default:
      r = { ok:false, message:'Instruction not supported.', code:src, items:[] };
  }
  renderSolution(r.code, (r.items && r.items.length) ? r.items : [{ kind:'info', text:'No changes were made.' }],
                 { mode:'custom', lang });
  setStat(r.message, r.ok ? 'ok' : 'warn');
}

/* ---------------- tabs ---------------- */

function activateTab(name){
  state.activeTab = name;
  const tabs = [els.tabCorrected, els.tabImproved, els.tabCustom];
  tabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  els.customPanel.hidden = (name !== 'custom');
  if (name === 'corrected') generateCorrectedCode();
  else if (name === 'improved') generateImprovedCode();
  else if (!state.customShown){
    state.customShown = true;
    renderSolution('', [{ kind:'info', text:'Type an instruction above and press Apply Transformation. Enter “help” to list supported commands.' }], { mode:'custom' });
  }
}

function refreshActiveSolution(){
  if (state.activeTab === 'corrected') generateCorrectedCode();
  else if (state.activeTab === 'improved') generateImprovedCode();
}

/* ---------------- copy & export ---------------- */

async function copyText(text){
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (__) { return false; }
  }
}

async function copySolution(){
  if (!state.output.code){ showToast('Nothing to copy yet.', 'err'); return; }
  const ok = await copyText(state.output.code);
  showToast(ok ? 'Code copied to clipboard.' : 'Copy failed — clipboard permission denied.', ok ? 'ok' : 'err');
}

function exportSolution(){
  const code = state.output.code;
  if (!code){ showToast('Nothing to export yet.', 'err'); return; }
  const ext = EXT_FOR[state.output.lang] || 'txt';
  let base = (els.fileName.textContent || 'code').replace(/\.[^.]+$/, '');
  if (!base || base === '—') base = 'diffstudio';
  const suffix = { corrected:'corrected', improved:'improved', custom:'transformed', original:'original' }[state.output.mode] || 'output';
  const name = `${base}.${suffix}.${ext}`;
  try {
    const blob = new Blob([code], { type:'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${name}`, 'ok');
  } catch (err){
    console.error(err);
    showToast('Export failed.', 'err');
  }
}

/* ---------------- initialization ---------------- */

function initializeApp(){
  cacheEls();

  els.editorInput.addEventListener('input', onEditorInput);
  els.editorInput.addEventListener('scroll', syncScroll);
  els.editorInput.addEventListener('keydown', onEditorKeydown);

  els.languageSelect.addEventListener('change', () => {
    updateHighlight();
    updateStats();
    runAnalysis();
  });

  els.btnUpload.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    handleFileUpload(els.fileInput.files && els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.btnDemo.addEventListener('click', loadDemo);
  els.btnClear.addEventListener('click', clearEditor);
  els.btnAnalyze.addEventListener('click', runAnalysis);
  els.btnWrap.addEventListener('click', () => setWrap(!state.wrap));

  setupDragDrop();

  [els.tabCorrected, els.tabImproved, els.tabCustom].forEach(t => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
  });
  document.querySelector('.tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = ['corrected','improved','custom'];
    let idx = order.indexOf(state.activeTab);
    idx = (idx + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length;
    activateTab(order[idx]);
    ({ corrected:els.tabCorrected, improved:els.tabImproved, custom:els.tabCustom })[order[idx]].focus();
  });

  els.diagnosticsList.addEventListener('click', e => {
    const card = e.target.closest('.diag');
    if (!card || !state.analysis) return;
    const idx = Number(card.dataset.idx);
    const d = state.analysis.diagnostics[idx];
    if (d) navigateToDiag(d, idx);
  });
  els.diagnosticsList.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.diag');
    if (!card || !state.analysis) return;
    e.preventDefault();
    const d = state.analysis.diagnostics[Number(card.dataset.idx)];
    if (d) navigateToDiag(d, Number(card.dataset.idx));
  });

  els.btnApplyCustom.addEventListener('click', applyCustomTransformation);
  els.customInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); applyCustomTransformation(); }
  });

  els.btnCopy.addEventListener('click', copySolution);
  els.btnExport.addEventListener('click', exportSolution);
  els.btnResetOutput.addEventListener('click', () => {
    renderSolution(els.editorInput.value, [{ kind:'info', text:'Showing the original source unchanged.' }], { mode:'original' });
    showToast('Output reset to original source', 'info');
  });

  updateHighlight();
  updateStats();
  activateTab('corrected');
  setStatus('ready', 'Ready');
}

document.addEventListener('DOMContentLoaded', initializeApp);