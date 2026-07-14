/* Saccade: RSVP + ORP speed reader for academic text.
   Everything runs client-side; documents and positions live in localStorage. */
'use strict';

const LS = localStorage;
const REF = 'REF';
const RAMP_N = 10;

/* ---------------- element refs ---------------- */
const el = {};
[
  'docTitle','wordsToday','btnLibrary','btnToc','btnSettings','btnHelp',
  'loader','pasteBox','btnLoadText','fileInput','btnSample','urlInput','btnFetchUrl',
  'readerUI','stage','wordbox','pre','orp','post','chunkbox','pauseHint','strip','reader',
  'btnBackPara','btnBackSent','btnPlay','btnFwdSent','btnFwdPara','scrub',
  'wpmDown','wpmVal','wpmUp','btnReaderView','pct','timeLeft',
  'drawerSettings','drawerLibrary','drawerToc','drawerNotes','libList','tocList','btnNew',
  'helpModal','btnCloseHelp','breakOverlay','breakCount','btnSkipBreak','dropOverlay','toast',
  'setTheme','setFont','setSize','setGuides','setAutoFocus','setBionic','setStripMode',
  'setRamp','setLongWords','setPunct','setChunk','setBreakEvery','setCites','setMath','setRefs',
  'setSpeedMode','setDailyGoal','btnNotes','noteCount','btnMark','sectmap','sprint','unitWpm',
  'chipPass1','searchInput','searchResults','noteList','btnReplayNotes','btnCopyNotes','btnClearNotes',
  'recapModal','recapBody','btnRecapReplay','btnRecapClose','statsModal','statsBody','btnStatsClose',
  'backdrop','cardSub','markPulse','syncOff','syncOn','syncTokenInput','btnSyncConnect','btnSyncNow',
  'btnSyncOffBtn','syncStatus',
  'btnReview','reviewCount','btnReviewDoc','btnRecapReview','reviewModal','reviewProgress','reviewSec',
  'reviewPrompt','reviewCue','reviewAnswer','reviewReveal','reviewGrade','reviewAgain','reviewGood',
  'reviewQuit','setReviewMode','btnExport','importInput','installNote'
].forEach(id => el[id] = document.getElementById(id));

/* ---------------- settings ---------------- */
const DEFAULTS = {
  wpm: 320, chunk: 1, theme: 'dark', font: 'hyper', size: 1,
  guides: true, autoFocus: true, bionic: true, stripMode: 'sentence',
  ramp: true, longWords: true, punct: 1, breakEvery: 8, dailyGoal: 5000,
  speedMode: 'manual', firstPass: false, reviewMode: 'cloze',
  cites: 'collapse', math: 'collapse', refs: 'skip'
};
let settings = Object.assign({}, DEFAULTS, JSON.parse(LS.getItem('saccade.settings') || '{}'));
if (!settings._v2) { settings.font = 'hyper'; settings._v2 = true; }
function saveSettings() { LS.setItem('saccade.settings', JSON.stringify(settings)); }

const FONTS = {
  hyper: '"Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace'
};
const COMMON = new Set((window.COMMON_WORDS || '').split(' '));

/* ---------------- state ---------------- */
const state = {
  doc: null,            // {id, title, blocks:[{text,type,ref}]}
  tokens: [],           // {t, core, type, block, sent, endS, endB, heading}
  units: null,          // Float64Array multiplier units per token
  cum: null,            // cumulative units, length N+1
  idx: 0,
  playing: false,
  timer: null,
  ramp: 0,
  playedMs: 0,
  saveCounter: 0,
  lastSent: -1,
  lastBlock: -1,
  readerBuilt: false,
  lastScroll: 0,
  sections: [],         // {title, start, end, level}
  secOfTok: null,       // Uint16Array token -> section index
  segEls: [],           // section map segment elements
  lastSec: -1,
  autoStreak: 0,        // tokens advanced since last rewind (auto speed)
  finished: false
};

/* ---------------- utilities ---------------- */
function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function docId(title, blocks) {
  let s = title + '|' + blocks.length + '|';
  for (const b of blocks) { s += b.text; if (s.length > 4000) break; }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + s.length.toString(36);
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}
function fmtTime(sec) {
  if (sec < 90) return Math.max(0, Math.round(sec)) + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
}
function fmtWords(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

/* ---------------- text parsing (plain / markdown) ---------------- */
function cleanInline(s) {
  return s.replace(/(\*\*|__|~~)/g, '').replace(/(^|\s)[*_](\S[^*_]*\S)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
          .replace(/`+/g, '').replace(/\s+/g, ' ').trim();
}
function parsePlain(text, titleHint) {
  text = String(text).replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^(#{1,6}\s.*)$/gm, '\n$1\n');
  const parts = text.split(/\n\s*\n+/);
  const blocks = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const hm = p.match(/^(#{1,6})\s+(.*)$/s);
    if (hm) {
      blocks.push({ text: cleanInline(hm[2].replace(/\n+/g, ' ')), type: hm[1].length <= 2 ? 'h2' : 'h3' });
      continue;
    }
    const one = p.replace(/\n+/g, ' ').trim();
    const wc = one.split(/\s+/).length;
    const headingish = wc <= 12 && !/[.!?:;,]$/.test(one) &&
      (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(one) || (one === one.toUpperCase() && /[A-Z]{3}/.test(one)));
    if (headingish) { blocks.push({ text: cleanInline(one), type: 'h3' }); continue; }
    const lines = p.split('\n');
    let acc = '';
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (acc.endsWith('-') && /^[a-z]/.test(t)) acc = acc.slice(0, -1) + t;
      else acc += (acc ? ' ' : '') + t;
    }
    const cleaned = cleanInline(acc);
    if (cleaned) blocks.push({ text: cleaned, type: 'p' });
  }
  markReferences(blocks);
  let title = (titleHint || '').trim();
  if (!title) {
    const h = blocks.find(b => b.type !== 'p');
    title = h ? h.text : (blocks[0] ? blocks[0].text.split(/\s+/).slice(0, 8).join(' ') : 'Untitled');
  }
  return { title: title.slice(0, 120), blocks };
}
const REF_RE = /^(references|bibliography|works cited|literature cited)\b/i;
function markReferences(blocks) {
  let inRef = false;
  for (const b of blocks) {
    const t = b.text.trim();
    if (!inRef && REF_RE.test(t) && t.length < 60) {
      inRef = true;
      b.ref = true;
      if (b.type === 'p') b.type = 'h2';
      continue;
    }
    if (inRef && b.type !== 'p' &&
        (/^(appendix|supplement|annex|acknowledg|data availability|online appendix)/i.test(t) ||
         /^[A-Z][.\d]*\s+[A-Z]/.test(t))) inRef = false;
    b.ref = inRef;
  }
}

/* ---------------- PDF extraction ---------------- */
function splitColumns(items, vw) {
  const mid = vw / 2;
  let cross = 0, left = 0, right = 0;
  for (const it of items) {
    const x0 = it.x, x1 = it.x + (it.w || 0);
    if (x0 < mid - 8 && x1 > mid + 8) cross++;
    else if ((x0 + x1) / 2 <= mid) left++;
    else right++;
  }
  const n = items.length;
  if (n > 30 && cross / n < 0.1 && left / n > 0.2 && right / n > 0.2) {
    const L = [], R = [];
    for (const it of items) {
      const x0 = it.x, x1 = it.x + (it.w || 0);
      if ((x0 < mid - 8 && x1 > mid + 8) || (x0 + x1) / 2 <= mid) { it.col = 0; L.push(it); }
      else { it.col = 1; R.push(it); }
    }
    return [L, R];
  }
  items.forEach(it => it.col = 0);
  return [items];
}
function linesFromItems(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) <= Math.max(2, it.h * 0.45)) cur.items.push(it);
    else { if (cur) groups.push(cur); cur = { y: it.y, items: [it] }; }
  }
  if (cur) groups.push(cur);
  return groups.map(g => {
    const its = g.items.sort((a, b) => a.x - b.x);
    let text = '', prev = null;
    for (const it of its) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > Math.max(1, it.h * 0.12)) text += ' ';
      }
      text += it.s;
      prev = it;
    }
    const hs = its.map(i => i.h).sort((a, b) => a - b);
    const size = hs[Math.floor(hs.length / 2)];
    return { text: text.replace(/\s+/g, ' ').trim(), y: g.y, x: its[0].x, h: size, size, col: its[0].col || 0 };
  }).filter(l => l.text);
}
async function extractPdf(buf, fallbackTitle) {
  if (!window.pdfjsLib) throw new Error('PDF engine not loaded');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let metaTitle = '';
  try {
    const md = await pdf.getMetadata();
    metaTitle = ((md.info && md.info.Title) || '').trim();
    if (/^(untitled|microsoft word|\.doc|\.dvi|\.tex)/i.test(metaTitle)) metaTitle = '';
  } catch (e) { /* no metadata */ }
  const pageLines = [];
  const freq = new Map();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const vw = page.view[2] - page.view[0], vh = page.view[3] - page.view[1];
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h });
    }
    const lines = [];
    for (const col of splitColumns(items, vw)) linesFromItems(col).forEach(l => lines.push(l));
    for (const l of lines) {
      l.page = p; l.vh = vh;
      l.norm = l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
      if (l.y > vh * 0.86 || l.y < vh * 0.12) freq.set(l.norm, (freq.get(l.norm) || 0) + 1);
    }
    pageLines.push(lines);
  }
  const lines = [];
  for (const pls of pageLines) for (const l of pls) {
    if ((l.y > l.vh * 0.86 || l.y < l.vh * 0.12) && (freq.get(l.norm) || 0) >= 3) continue;
    if (/^\d{1,4}$/.test(l.text)) continue;
    if (/^arxiv:\d{4}\.\d{4,5}/i.test(l.text)) continue;
    lines.push(l);
  }
  pdf.destroy();
  if (!lines.length) throw new Error('no extractable text; this may be a scanned PDF');
  const sizes = lines.map(l => l.size).sort((a, b) => a - b);
  const med = sizes[Math.floor(sizes.length / 2)] || 10;
  const blocks = [];
  let cur = '', prev = null;
  const flush = () => { const t = cur.trim(); if (t) blocks.push({ text: t.replace(/\s+/g, ' '), type: 'p' }); cur = ''; };
  for (const l of lines) {
    const wc = l.text.split(/\s+/).length;
    const isHead = l.size > med * 1.17 && wc <= 16 && /[A-Za-z]/.test(l.text);
    if (isHead) {
      flush();
      blocks.push({ text: l.text, type: l.size > med * 1.45 ? 'h2' : 'h3' });
      prev = l;
      continue;
    }
    let brk = false;
    if (prev && prev.page === l.page && prev.col === l.col) {
      const gap = prev.y - l.y;
      if (gap > l.h * 1.9) brk = true;
      if (!brk && l.x - prev.x > l.h * 0.8 && /[.!?]["')\]]*$/.test(prev.text)) brk = true;
    }
    if (brk) flush();
    if (cur.endsWith('-') && /^[a-z]/.test(l.text)) cur = cur.slice(0, -1) + l.text;
    else cur += (cur ? ' ' : '') + l.text;
    prev = l;
  }
  flush();
  markReferences(blocks);
  let title = metaTitle;
  if (!title) {
    const p1 = pageLines[0] || [];
    const big = p1.slice().sort((a, b) => b.size - a.size)[0];
    title = (big && big.size > med * 1.2) ? big.text : (fallbackTitle || 'PDF document');
  }
  return { title: title.slice(0, 120), blocks };
}

/* ---------------- citations ---------------- */
function isCitation(inner) {
  if (!/(19|20)\d{2}/.test(inner)) return false;
  if (/^(see |also |e\.g\.,? |cf\. )*[^,;]{0,60}?(et al\.?|[A-Z][\w'’-]+(( and | & )[A-Z][\w'’-]+)?),? ?\(?(19|20)\d{2}[a-z]?/.test(inner)) return true;
  if (/^(19|20)\d{2}[a-z]?([;,] ?(19|20)\d{2}[a-z]?)*$/.test(inner)) return true;
  if (/;/.test(inner) && inner.split(';').every(s => /(19|20)\d{2}/.test(s))) return true;
  return false;
}
function stripCitations(text, collapse) {
  const rep = collapse ? ' ' + REF + ' ' : ' ';
  text = text.replace(/\(([^()]{1,160})\)/g, (m, inner) => isCitation(inner) ? rep : m);
  text = text.replace(/\[\d{1,3}(\s*[-–]\s*\d{1,3})?(\s*,\s*\d{1,3}(\s*[-–]\s*\d{1,3})?)*\]/g, rep);
  return text;
}

/* ---------------- tokenizer ---------------- */
const ABBREV = new Set(['al','fig','figs','eq','eqs','sec','secs','ch','vs','cf','resp','approx','no','nos','vol','vols','pp','p','ed','eds','etc','ie','eg','st','dr','mr','mrs','ms','prof','univ','dept','inc','jr','sr','ca','cca','ibid','op','cit','repr','trans','viz','esp']);
function classify(w) {
  if (w.indexOf(REF) !== -1) return { t: w.replace(REF, '(ref)'), core: 'ref', type: 'ref' };
  const core = w.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  if (/^[\d.,;:%+()\[\]\-–—/]*\d[\d.,;:%+()\[\]\-–—/]*%?$/.test(w)) return { t: w, core, type: 'num' };
  let syms = 0;
  for (const c of w) if (!/[A-Za-z0-9À-ɏ.,;:'’"“”()\[\]!?\-–—]/.test(c)) syms++;
  const mathy = /[\\^_{}=<>|~]/.test(w) || syms / w.length > 0.25;
  if (mathy && !(core.length > 3 && syms === 0)) return { t: w, core, type: 'math' };
  return { t: w, core, type: 'word' };
}
function isSentenceEnd(tok, nxt) {
  if (!/[.!?…]["'’”)\]]*$/.test(tok.t)) return false;
  const bare = tok.core.toLowerCase().replace(/[^a-z]/g, '');
  if (ABBREV.has(bare)) return false;
  if (/^[A-Z]$/.test(tok.core)) return false;
  if (nxt) {
    if (nxt.type === 'ref') return false;
    const c = (nxt.t.replace(/^["'“‘(\[]+/, '')[0]) || '';
    if (!/[A-Z0-9]/.test(c)) return false;
  }
  return true;
}
function tokenizeDoc(doc) {
  const tokens = [];
  let sent = 0;
  doc.blocks.forEach((blk, bi) => {
    if (blk.ref && settings.refs === 'skip') return;
    let text = blk.text;
    if (settings.cites !== 'keep') text = stripCitations(text, settings.cites === 'collapse');
    const raw = text.split(/\s+/).filter(Boolean);
    let words = [];
    for (const w of raw) {
      if (/^[.,;:!?)"'’”\]]+$/.test(w) && words.length) { words[words.length - 1].t += w; continue; }
      words.push(classify(w));
    }
    if (settings.math === 'collapse') {
      const out = [];
      let run = 0;
      for (const tk of words) {
        if (tk.type === 'math') {
          run++;
          if (run === 1) out.push(tk);
          else if (run === 2) { out[out.length - 1] = { t: '[math]', core: 'math', type: 'math' }; }
          continue;
        }
        run = 0;
        out.push(tk);
      }
      words = out;
    }
    const heading = blk.type !== 'p';
    const n = words.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const tk = words[i];
      tk.block = bi;
      tk.heading = heading;
      tk.sent = sent;
      tk.endB = i === n - 1;
      tk.endS = heading ? tk.endB : (isSentenceEnd(tk, words[i + 1]) || tk.endB);
      // first-pass mode: headings plus the first sentence of each paragraph
      const cut = settings.firstPass && !heading && tk.endS && i < n - 1;
      if (cut) tk.endB = true;
      if (tk.endS) sent++;
      tokens.push(tk);
      if (cut) break;
    }
  });
  return tokens;
}

/* ---------------- pacing model ---------------- */
function unitsFor(tok) {
  let m = 1;
  const L = tok.core.length;
  if (settings.longWords) {
    m += Math.min(1.4, Math.max(0, L - 6) * 0.055);
    if (/\d/.test(tok.core) && /[a-zA-Z]/.test(tok.core)) m += 0.3;
    if (/^[A-Z]{2,6}s?$/.test(tok.core)) m += 0.25;
    if (tok.type === 'word' && L >= 5 && COMMON.size > 100 && !COMMON.has(tok.core.toLowerCase())) m += 0.22;
  }
  if (tok.type === 'num') m += 0.4;
  if (tok.type === 'math') m += 0.9;
  if (tok.type === 'ref') m = 0.55;
  if (tok.heading) m += 0.6;
  let p = 0;
  if (tok.endS) p += 1.35;
  else if (/[,;:]["'’”)\]]*$/.test(tok.t)) p += 0.5;
  if (tok.endB) p += 1.1;
  return m + p * settings.punct;
}
function computeUnits() {
  const N = state.tokens.length;
  state.units = new Float64Array(N);
  state.cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    state.units[i] = unitsFor(state.tokens[i]);
    state.cum[i + 1] = state.cum[i] + state.units[i];
  }
}

/* ---------------- sections ---------------- */
function buildSections() {
  const toks = state.tokens;
  const secs = [];
  let cur = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const isHeadStart = t.heading && (i === 0 || toks[i - 1].block !== t.block);
    if (i === 0 || isHeadStart) {
      if (cur) cur.end = i - 1;
      const blk = state.doc.blocks[t.block];
      cur = {
        title: t.heading ? blk.text : 'Start',
        start: i, end: toks.length - 1,
        level: (t.heading && blk.type === 'h3') ? 3 : 2
      };
      secs.push(cur);
    }
  }
  state.sections = secs;
  const so = new Uint16Array(toks.length);
  secs.forEach((s, si) => { for (let i = s.start; i <= s.end; i++) so[i] = Math.min(si, 65535); });
  state.secOfTok = so;
}
function buildSectMap() {
  const secs = state.sections;
  if (!secs.length || secs.length === 1) { el.sectmap.innerHTML = ''; state.segEls = []; return; }
  el.sectmap.innerHTML = secs.map((s, si) =>
    `<div class="seg" data-si="${si}" style="flex-grow:${s.end - s.start + 1}" title="${escHtml(s.title.slice(0, 60))}"><div class="fill"></div></div>`
  ).join('');
  state.segEls = Array.from(el.sectmap.children);
  state.lastSec = -1;
}
function updateSectMap() {
  if (!state.segEls.length || !state.secOfTok) return;
  const si = state.secOfTok[state.idx];
  if (si !== state.lastSec) {
    state.lastSec = si;
    state.segEls.forEach((seg, k) => {
      seg.classList.toggle('done', k < si);
      seg.classList.toggle('cur', k === si);
      if (k > si) seg.firstChild.style.width = '0';
    });
  }
  const s = state.sections[si];
  const frac = (state.idx - s.start) / Math.max(1, s.end - s.start);
  state.segEls[si].firstChild.style.width = Math.round(frac * 100) + '%';
}

/* ---------------- rendering ---------------- */
function orpIndex(t) {
  const m = t.t.match(/[\p{L}\p{N}]/u);
  const start = m ? m.index : 0;
  const L = (t.core || t.t).length;
  const o = L <= 1 ? 0 : L <= 5 ? 1 : L <= 9 ? 2 : L <= 13 ? 3 : 4;
  return Math.min(start + o, t.t.length - 1);
}
function fitFont(box, len, threshold, base) {
  const k = len > threshold ? Math.max(0.45, threshold / len) : 1;
  box.style.fontSize = k < 1 ? `calc(${base} * ${settings.size} * ${k.toFixed(2)})` : '';
}
function renderWord(a, b) {
  const toks = state.tokens;
  if (!toks.length) return;
  const isCard = toks[a].heading;
  if (isCard && state.sections.length > 1 && state.secOfTok) {
    const si = state.secOfTok[a];
    el.cardSub.textContent = 'section ' + (si + 1) + ' of ' + state.sections.length;
    el.cardSub.classList.remove('hidden');
  } else {
    el.cardSub.classList.add('hidden');
  }
  if (b > a || isCard) {
    el.wordbox.classList.add('hidden');
    el.chunkbox.classList.remove('hidden');
    const txt = toks.slice(a, b + 1).map(t => t.t).join(' ');
    fitFont(el.chunkbox, txt.length, isCard ? 42 : 30, 'clamp(26px, 5.2vw, 46px)');
    el.chunkbox.textContent = txt;
    el.chunkbox.style.opacity = '';
  } else {
    el.chunkbox.classList.add('hidden');
    el.wordbox.classList.remove('hidden');
    const t = toks[a];
    const pv = orpIndex(t);
    el.pre.textContent = t.t.slice(0, pv);
    el.orp.textContent = t.t[pv] || '';
    el.post.textContent = t.t.slice(pv + 1);
    fitFont(el.wordbox, t.t.length, 17, 'clamp(30px, 6.5vw, 56px)');
    el.wordbox.style.opacity = (t.type === 'ref' || t.type === 'math') ? 0.55 : '';
  }
}
function renderStrip(force) {
  if (settings.stripMode === 'off') { el.strip.classList.add('hidden'); return; }
  el.strip.classList.remove('hidden');
  const toks = state.tokens;
  if (!toks.length) { el.strip.innerHTML = ''; return; }
  const sentId = toks[state.idx].sent;
  if (force || sentId !== state.lastSent) {
    state.lastSent = sentId;
    let a = state.idx, b = state.idx;
    while (a > 0 && toks[a - 1].sent === sentId) a--;
    while (b < toks.length - 1 && toks[b + 1].sent === sentId) b++;
    let html = '';
    for (let i = a; i <= b; i++) html += `<span data-i="${i}">${escHtml(toks[i].t)}</span> `;
    el.strip.innerHTML = html;
  }
  const old = el.strip.querySelector('.cur');
  if (old) old.classList.remove('cur');
  const now = el.strip.querySelector(`[data-i="${state.idx}"]`);
  if (now) now.classList.add('cur');
}
function renderReaderHi() {
  if (el.reader.classList.contains('hidden') || !state.tokens.length) return;
  const bi = state.tokens[state.idx].block;
  if (bi === state.lastBlock) return;
  state.lastBlock = bi;
  const old = el.reader.querySelector('.curblock');
  if (old) old.classList.remove('curblock');
  const now = el.reader.querySelector(`[data-b="${bi}"]`);
  if (now) {
    now.classList.add('curblock');
    const t = Date.now();
    if (t - state.lastScroll > 700) {
      state.lastScroll = t;
      now.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}
function renderFrame(force) {
  const N = state.tokens.length;
  if (!N) return;
  state.idx = clamp(state.idx, 0, N - 1);
  const [a, b] = chunkRange(state.idx);
  renderWord(a, b);
  renderStrip(force);
  renderReaderHi();
  el.scrub.max = N - 1;
  el.scrub.value = state.idx;
  el.pct.textContent = Math.round(100 * state.idx / Math.max(1, N - 1)) + '%';
  const secLeft = (state.cum[N] - state.cum[state.idx]) * 60 / settings.wpm;
  el.timeLeft.textContent = fmtTime(secLeft) + ' left';
  updateSectMap();
  if (state.playing && settings.breakEvery > 0) {
    const ms = Math.max(0, settings.breakEvery * 60000 - state.playedMs);
    el.sprint.textContent = Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0');
  } else el.sprint.textContent = '';
}

/* ---------------- playback ---------------- */
const FUNC_WORD = /^(of|the|a|an|to|in|on|at|for|and|or|is|are|was|by|as|it)$/i;
function chunkRange(i) {
  const toks = state.tokens;
  if (!toks.length) return [i, i];
  if (toks[i].heading) {
    // headings display as one card
    let j = i;
    while (j + 1 < toks.length && toks[j + 1].heading && toks[j + 1].block === toks[i].block) j++;
    return [i, j];
  }
  if (settings.chunk <= 1) return [i, i];
  let j = i;
  while (j - i + 1 < settings.chunk && j + 1 < toks.length &&
         !toks[j].endS && !toks[j].endB &&
         toks[j + 1].block === toks[i].block && !toks[j + 1].heading) j++;
  // avoid stranding a short function word at the start of the next chunk
  if (j + 1 < toks.length && !toks[j].endS && !toks[j].endB &&
      toks[j + 1].block === toks[i].block && !toks[j + 1].heading &&
      FUNC_WORD.test(toks[j + 1].core) && !toks[j + 1].endS && !toks[j + 1].endB) j++;
  return [i, j];
}
function play() {
  if (!state.tokens.length) return;
  if (state.finished) { state.idx = 0; state.finished = false; }
  state.playing = true;
  state.ramp = settings.ramp ? RAMP_N : 0;
  el.btnPlay.innerHTML = '&#10074;&#10074;';
  el.pauseHint.classList.add('hidden');
  armDim();
  scheduleNext();
}
function scheduleNext() {
  clearTimeout(state.timer);
  const [a, b] = chunkRange(state.idx);
  renderFrame();
  let units = 0;
  for (let i = a; i <= b; i++) units += state.units[i];
  let dur = units * (60000 / settings.wpm);
  if (state.ramp > 0) { dur *= 1 + state.ramp * 0.09; state.ramp--; }
  if (state.tokens[a].heading) dur = Math.max(dur, 1100);   // section card dwell
  dur = Math.max(45, dur);
  state.timer = setTimeout(() => {
    state.playedMs += dur;
    addWords(b - a + 1);
    state.autoStreak += b - a + 1;
    if (settings.speedMode === 'auto' && state.autoStreak >= 350) {
      state.autoStreak = 0;
      nudgeWpm(1.03);
    }
    if (b + 1 >= state.tokens.length) { finishDoc(); return; }
    state.idx = b + 1;
    if (settings.breakEvery > 0 && state.playedMs >= settings.breakEvery * 60000) { startBreak(); return; }
    if (++state.saveCounter >= 25) { savePos(); state.saveCounter = 0; }
    scheduleNext();
  }, dur);
}
function nudgeWpm(f) {
  const v = clamp(Math.round(settings.wpm * f / 5) * 5, 150, 700);
  if (v === settings.wpm) return;
  if (f < 1 && v >= settings.wpm) return;   // clamping must never reverse the signal
  if (f > 1 && v <= settings.wpm) return;
  settings.wpm = v;
  saveSettings();
  el.wpmVal.textContent = v;
}
function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  el.btnPlay.innerHTML = '&#9654;';
  el.pauseHint.classList.remove('hidden');
  undim();
  savePos();
  renderFrame(true);
}
function togglePlay() { state.playing ? pause() : play(); }
function finishDoc() {
  state.idx = state.tokens.length - 1;
  state.finished = true;
  pause();
  if (state.doc && state.doc.ephemeral) { toast('Review pass done.'); return; }
  const hls = getHls();
  const secs = Math.max(1, state.sections.length);
  el.recapBody.innerHTML =
    `<div class="bignum">${fmtWords(state.tokens.length)} words</div>` +
    `<p>${secs} section${secs > 1 ? 's' : ''} · ${hls.length} sentence${hls.length === 1 ? '' : 's'} saved to notes</p>` +
    (hls.length
      ? '<p>Test yourself on them now while they are fresh. Trying to recall a claim beats re-reading it, and each card comes back on a spaced schedule so it lasts.</p>'
      : '<p>Next time, press h on the claims worth keeping. The app then quizzes you on them and reschedules each by how well you did.</p>');
  el.btnRecapReview.classList.toggle('hidden', !hls.length);
  el.btnRecapReplay.classList.toggle('hidden', !hls.length);
  el.recapModal.classList.remove('hidden');
}
let lastRewindNudge = 0;
function seek(i, opts) {
  state.finished = false;
  // rewinds signal "too fast", but pure navigation (scrub, toc, search, notes)
  // does not, and repeated drag events only count once per 1.5s
  if (settings.speedMode === 'auto' && state.tokens.length && i < state.idx - 3 && !(opts && opts.nav)) {
    const now = Date.now();
    if (now - lastRewindNudge > 1500) { nudgeWpm(0.95); lastRewindNudge = now; }
    state.autoStreak = 0;
  }
  state.idx = clamp(i, 0, state.tokens.length - 1);
  if (state.playing) { state.ramp = settings.ramp ? Math.max(state.ramp, 5) : 0; scheduleNext(); }
  else renderFrame(true);
}
function sentStart(i) {
  const toks = state.tokens;
  let a = i;
  while (a > 0 && toks[a - 1].sent === toks[i].sent) a--;
  return a;
}
function jumpSent(dir) {
  const toks = state.tokens;
  if (!toks.length) return;
  const i = state.idx;
  if (dir === 0) { seek(sentStart(i)); return; }
  if (dir < 0) {
    const a = sentStart(i);
    if (i - a > 2) { seek(a); return; }        // restart current sentence first
    let p = a - 1;
    if (p < 0) { seek(0); return; }
    seek(sentStart(p));
  } else {
    let b = i;
    while (b < toks.length - 1 && toks[b].sent === toks[i].sent) b++;
    seek(b === i ? i : (toks[b].sent === toks[i].sent ? toks.length - 1 : b));
  }
}
function jumpPara(dir) {
  const toks = state.tokens;
  if (!toks.length) return;
  const bi = toks[state.idx].block;
  if (dir < 0) {
    let a = state.idx;
    while (a > 0 && toks[a - 1].block === bi) a--;
    if (state.idx - a > 2) { seek(a); return; }
    let p = a - 1;
    if (p < 0) { seek(0); return; }
    const pb = toks[p].block;
    while (p > 0 && toks[p - 1].block === pb) p--;
    seek(p);
  } else {
    let b = state.idx;
    while (b < toks.length - 1 && toks[b + 1].block === bi) b++;
    seek(Math.min(b + 1, toks.length - 1));
  }
}

/* ---------------- rest breaks ---------------- */
let breakInterval = null;
function startBreak() {
  state.playing = false;
  clearTimeout(state.timer);
  el.btnPlay.innerHTML = '&#9654;';
  savePos();
  let count = 12;
  el.breakCount.textContent = count;
  el.breakOverlay.classList.remove('hidden');
  breakInterval = setInterval(() => {
    count--;
    el.breakCount.textContent = count;
    if (count <= 0) endBreak(!document.hidden);   // never auto-resume into a hidden tab
  }, 1000);
}
function endBreak(resume) {
  clearInterval(breakInterval);
  breakInterval = null;
  el.breakOverlay.classList.add('hidden');
  state.playedMs = 0;
  if (resume) play();
  else renderFrame(true);
}

/* ---------------- focus dim ---------------- */
let dimTimer = null;
function armDim() {
  if (!settings.autoFocus) return;
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => { if (state.playing) document.body.classList.add('dimmed'); }, 2600);
}
function undim() {
  document.body.classList.remove('dimmed');
  clearTimeout(dimTimer);
}
document.addEventListener('pointermove', () => {
  if (document.body.classList.contains('dimmed')) { undim(); armDim(); }
}, { passive: true });

/* ---------------- stats ---------------- */
function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
let stats = JSON.parse(LS.getItem('saccade.stats') || '{}');
if (stats.d !== today()) stats = { d: today(), w: 0 };
let days = {};
try { days = JSON.parse(LS.getItem('saccade.days') || '{}'); } catch (e) { days = {}; }
let statFlush = 0;
function flushStats() {
  LS.setItem('saccade.stats', JSON.stringify(stats));
  days[stats.d] = Math.max(days[stats.d] || 0, stats.w);
  const keys = Object.keys(days);
  if (keys.length > 45) {
    // keys are unpadded ('2026-7-13'), so sort numerically by component
    keys.sort((a, b) => {
      const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
      return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
    });
    for (const k of keys.slice(0, keys.length - 45)) delete days[k];
  }
  LS.setItem('saccade.days', JSON.stringify(days));
}
function addWords(n) {
  if (stats.d !== today()) { flushStats(); stats = { d: today(), w: 0 }; }
  stats.w += n;
  updateWordsToday();
  if (++statFlush >= 40) { flushStats(); statFlush = 0; }
}
function updateWordsToday() {
  const g = settings.dailyGoal || 0;
  let txt = '';
  if (stats.w > 0 || g > 0) txt = fmtWords(stats.w) + (g ? ' / ' + fmtWords(g) : ' today');
  el.wordsToday.textContent = txt;
  el.wordsToday.classList.toggle('goal-hit', g > 0 && stats.w >= g);
  if (g > 0 && stats.w >= g && !stats.gDone) { stats.gDone = true; toast('Daily goal reached.'); }
}
function dayKeyOffset(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return { key: d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(), label: 'SMTWTFS'[d.getDay()] };
}
function showStats() {
  if (state.playing) pause();
  flushStats();
  const seven = [];
  for (let k = 6; k >= 0; k--) {
    const d = dayKeyOffset(k);
    seven.push({ label: d.label, v: d.key === stats.d ? stats.w : (days[d.key] || 0), isToday: k === 0 });
  }
  let streak = 0;
  for (let k = 0; k < 400; k++) {
    const d = dayKeyOffset(k);
    const v = d.key === stats.d ? stats.w : (days[d.key] || 0);
    if (v > 0) streak++;
    else { if (k === 0) { streak = 0; continue; } break; }
  }
  const max = Math.max(1, ...seven.map(s => s.v), settings.dailyGoal || 0);
  const bars = seven.map((s, i) => {
    const h = Math.round(52 * s.v / max);
    return `<rect class="bar${s.isToday ? ' today' : ''}" x="${i * 14 + 2}" y="${56 - h}" width="10" height="${Math.max(1, h)}" rx="2"></rect>` +
           `<text x="${i * 14 + 7}" y="66" text-anchor="middle" font-size="6" fill="var(--dim)">${s.label}</text>`;
  }).join('');
  const goalLine = settings.dailyGoal
    ? `<line class="goalline" x1="0" x2="100" y1="${56 - Math.round(52 * settings.dailyGoal / max)}" y2="${56 - Math.round(52 * settings.dailyGoal / max)}"></line>` : '';
  el.statsBody.innerHTML =
    `<svg viewBox="0 0 100 68" preserveAspectRatio="none">${goalLine}${bars}</svg>` +
    `<div class="row"><span>Today</span><b>${fmtWords(stats.w)} words</b></div>` +
    `<div class="row"><span>Last 7 days</span><b>${fmtWords(seven.reduce((a, s) => a + s.v, 0))} words</b></div>` +
    `<div class="row"><span>Streak</span><b>${streak} day${streak === 1 ? '' : 's'}</b></div>`;
  el.statsModal.classList.remove('hidden');
}

/* ---------------- reader view / toc ---------------- */
function bionicHtml(text) {
  return escHtml(text).split(' ').map(w => {
    const m = w.match(/^([^A-Za-z0-9À-ɏ]*)([A-Za-z0-9À-ɏ'’-]+)(.*)$/);
    if (!m) return w;
    const core = m[2];
    const k = core.length <= 3 ? 1 : Math.ceil(core.length * 0.4);
    return m[1] + '<b>' + core.slice(0, k) + '</b>' + core.slice(k) + m[3];
  }).join(' ');
}
function buildReader() {
  if (!state.doc) return;
  let html = '';
  state.doc.blocks.forEach((b, bi) => {
    const tag = b.type === 'p' ? 'p' : b.type;
    const skipped = b.ref && settings.refs === 'skip';
    const cls = b.ref ? ' class="refblock"' : '';
    const content = (settings.bionic && !skipped) ? bionicHtml(b.text) : escHtml(b.text);
    html += `<${tag} data-b="${bi}"${cls}>${content}</${tag}>`;
  });
  el.reader.innerHTML = html;
  state.readerBuilt = true;
  state.lastBlock = -1;
}
function toggleReader() {
  const show = el.reader.classList.contains('hidden');
  if (show) {
    if (!state.readerBuilt) buildReader();
    el.reader.classList.remove('hidden');
    state.lastBlock = -1;
    renderReaderHi();
  } else el.reader.classList.add('hidden');
}
function firstTokenOfBlock(bi) {
  const toks = state.tokens;
  let fallback = -1;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].block === bi) return i;
    if (fallback < 0 && toks[i].block > bi) fallback = i;
  }
  return fallback < 0 ? Math.max(0, toks.length - 1) : fallback;
}
function buildToc() {
  if (!state.doc || !state.cum) { el.tocList.innerHTML = ''; return; }
  const perTok = 60 / settings.wpm;
  const curSec = state.secOfTok ? state.secOfTok[state.idx] : -1;
  el.tocList.innerHTML = state.sections.map((s, si) => {
    const mins = (state.cum[s.end + 1] - state.cum[s.start]) * perTok;
    return `<div class="tocitem ${s.level === 3 ? 'lvl3' : ''} ${state.idx > s.end ? 'past' : ''} ${si === curSec ? 'on' : ''}" data-si="${si}">` +
      `<span>${escHtml(s.title.slice(0, 90))}</span><span class="mins">${fmtTime(mins)}</span></div>`;
  }).join('') || '<p class="set-note">No sections detected in this document.</p>';
}
let searchTimer = null;
function runSearch() {
  const q = el.searchInput.value.trim().toLowerCase();
  if (q.length < 3 || !state.doc) {
    el.searchResults.classList.add('hidden');
    el.searchResults.innerHTML = '';
    el.tocList.classList.remove('hidden');
    return;
  }
  const hits = [];
  state.doc.blocks.forEach((b, bi) => {
    if (hits.length >= 30) return;
    const pos = b.text.toLowerCase().indexOf(q);
    if (pos < 0) return;
    const s = Math.max(0, pos - 40), e = Math.min(b.text.length, pos + q.length + 40);
    hits.push(`<div class="hit" data-b="${bi}">${s > 0 ? '…' : ''}${escHtml(b.text.slice(s, pos))}<b>${escHtml(b.text.slice(pos, pos + q.length))}</b>${escHtml(b.text.slice(pos + q.length, e))}${e < b.text.length ? '…' : ''}</div>`);
  });
  el.searchResults.innerHTML = hits.join('') || '<p class="set-note">No matches.</p>';
  el.searchResults.classList.remove('hidden');
  el.tocList.classList.add('hidden');
}

/* ---------------- deletion tombstones (so deletes survive sync) ---------------- */
let dead = { docs: {}, hl: {} };   // docs: {docId: ts}; hl: {docId: {textHash: ts}}
try { dead = Object.assign({ docs: {}, hl: {} }, JSON.parse(LS.getItem('saccade.dead') || '{}')); } catch (e) {}
function saveDead() { try { LS.setItem('saccade.dead', JSON.stringify(dead)); } catch (e) {} }
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function tombstoneDoc(id) { dead.docs[id] = Date.now(); saveDead(); }
function untombstoneDoc(id) { if (dead.docs[id]) { delete dead.docs[id]; saveDead(); } }
function tombstoneHl(docId, text) {
  (dead.hl[docId] = dead.hl[docId] || {})[hashText(text)] = Date.now();
  saveDead();
}

/* ---------------- highlights / notes ---------------- */
function hlKey() { return 'saccade.hl.' + state.doc.id; }
function getHls() {
  if (!state.doc) return [];
  try { return JSON.parse(LS.getItem(hlKey()) || '[]'); } catch (e) { return []; }
}
function setHls(a) {
  if (!state.doc || state.doc.ephemeral) return;
  try { LS.setItem(hlKey(), JSON.stringify(a)); } catch (e) { toast('Could not save note (storage full).'); }
  updateNoteCount();
  schedulePush();
}
function updateNoteCount() {
  const n = state.doc && !state.doc.ephemeral ? getHls().length : 0;
  el.noteCount.textContent = n || '';
}
function pulse(msg) {
  el.markPulse.textContent = msg;
  el.markPulse.classList.add('show');
  setTimeout(() => el.markPulse.classList.remove('show'), 900);
}
function markCurrent() {
  if (!state.tokens.length || !state.doc) return;
  if (state.doc.ephemeral) { pulse('already a note'); return; }
  const toks = state.tokens;
  const i = state.idx;
  let a = i, b = i;
  while (a > 0 && toks[a - 1].sent === toks[i].sent) a--;
  while (b < toks.length - 1 && toks[b + 1].sent === toks[i].sent) b++;
  const text = toks.slice(a, b + 1).map(t => t.t).join(' ');
  const sec = state.sections.length && state.secOfTok ? state.sections[state.secOfTok[a]].title : '';
  const hls = getHls();
  if (hls.some(h => h.text === text)) { pulse('already saved'); return; }
  if (dead.hl[state.doc.id] && dead.hl[state.doc.id][hashText(text)]) {
    delete dead.hl[state.doc.id][hashText(text)];   // deliberate re-save beats old deletion
    saveDead();
  }
  const now = Date.now();
  hls.push({ b: toks[a].block, text, sec, added: now, srs: initSrs(now) });
  setHls(hls);
  pulse('saved ✓');
  if (!el.drawerNotes.classList.contains('hidden')) renderNotes();
}
function renderNotes() {
  const hls = getHls();
  el.noteList.innerHTML = hls.map((h, k) => `
    <div class="noteitem" data-k="${k}">
      <div class="q">${escHtml(h.text)}</div>
      <div class="nm"><span>${escHtml((h.sec || '').slice(0, 40))}</span><span class="del" data-k="${k}">delete</span></div>
    </div>`).join('') || '<p class="set-note">Nothing saved yet in this document.</p>';
}
function jumpToHl(h) {
  const start = firstTokenOfBlock(h.b);
  const firstWord = h.text.split(' ')[0];
  const toks = state.tokens;
  for (let i = start; i < toks.length && toks[i].block === h.b; i++) {
    if (toks[i].t === firstWord) { seek(i, { nav: true }); return; }
  }
  seek(start, { nav: true });
}
function notesMarkdown() {
  const hls = getHls();
  let md = '# Notes: ' + state.doc.title + '\n_' + new Date().toISOString().slice(0, 10) + ' · Saccade_\n';
  let lastSec = null;
  for (const h of hls) {
    if (h.sec && h.sec !== lastSec) { md += '\n## ' + h.sec + '\n'; lastSec = h.sec; }
    md += '\n> ' + h.text + '\n';
  }
  return md;
}
function copyNotes() {
  const hls = getHls();
  if (!hls.length) { toast('No notes to copy yet.'); return; }
  const md = notesMarkdown();
  const done = () => toast('Copied ' + hls.length + ' notes as markdown.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(md).then(done).catch(() => fallbackCopy(md, done));
  } else fallbackCopy(md, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  if (ok) done();
  else toast('Copy blocked by the browser. Use the text view to select manually.', 4000);
}
function replayNotes() {
  const hls = getHls();
  if (!hls.length) { toast('No notes yet. Press h while reading to save sentences.'); return; }
  const src = state.doc;
  const blocks = [];
  let lastSec = null;
  for (const h of hls) {
    if (h.sec && h.sec !== lastSec) { blocks.push({ text: h.sec, type: 'h3' }); lastSec = h.sec; }
    blocks.push({ text: h.text, type: 'p' });
  }
  el.recapModal.classList.add('hidden');
  openDoc({ title: 'Highlights: ' + src.title, blocks, ephemeral: true });
  toast('Re-streaming your ' + hls.length + ' saved sentences.');
}

/* ---------------- spaced retrieval practice ----------------
   Notes are for testing yourself, not re-reading. Each saved highlight
   carries a small SM-2-style schedule; grading it reschedules when it
   next comes due. Retrieval + spacing are the two highest-utility study
   moves in the literature (Roediger & Karpicke 2006; Dunlosky 2013). */
const DAY = 86400000;
const REVIEW_CAP = 20;   // keep a session short; overdue items roll forward silently
function initSrs(added) {
  return { due: (added || Date.now()) + DAY, interval: 0, reps: 0, lapses: 0, ease: 2.3, last: 0 };
}
function gradeSrs(h, good) {
  const s = h.srs || (h.srs = initSrs(h.added));
  const now = Date.now();
  s.last = now;
  if (!good) {
    s.lapses = (s.lapses || 0) + 1;
    s.reps = 0;
    s.interval = 0;
    s.ease = Math.max(1.3, (s.ease || 2.3) - 0.2);
    s.due = now + 10 * 60000;                 // relearn in ~10 min, same session
  } else {
    s.reps = (s.reps || 0) + 1;
    s.ease = Math.min(2.8, (s.ease || 2.3) + 0.05);
    if (s.reps === 1) s.interval = 1;
    else if (s.reps === 2) s.interval = 3;
    else s.interval = Math.min(365, Math.round((s.interval || 1) * s.ease));
    s.due = now + s.interval * DAY;
  }
}
function readHls(docId) { try { return JSON.parse(LS.getItem('saccade.hl.' + docId) || '[]'); } catch (e) { return []; } }
function dueItems() {
  const now = Date.now();
  const out = [];
  for (const e of libIndex()) {
    readHls(e.id).forEach((h, idx) => {
      const due = h.srs ? h.srs.due : (h.added || 0) + DAY;
      if (due <= now) out.push({ docId: e.id, docTitle: e.title, idx, h });
    });
  }
  out.sort((a, b) => (a.h.srs ? a.h.srs.due : 0) - (b.h.srs ? b.h.srs.due : 0));
  return out;
}
function updateReviewBadge() {
  const n = dueItems().length;
  el.btnReview.classList.toggle('hidden', n === 0);
  el.reviewCount.textContent = n > 99 ? '99+' : n;
}
const FUNC_SKIP = /^(the|and|for|that|this|with|from|have|been|were|are|was|which|their|these|those|such|than|then|also|into|over|when|what|will|would|could|should|about|there|where|between|because|however|therefore)$/i;
function makeCloze(text) {
  const parts = text.split(/(\s+)/);        // keep whitespace tokens so we can rebuild
  const cand = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^\s*$/.test(parts[i])) continue;
    const w = parts[i];
    if (w.indexOf('(ref)') > -1 || w.indexOf('[math]') > -1) continue;
    const m = w.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’-]*)([^\p{L}\p{N}]*)$/u);
    if (!m) continue;
    const core = m[2];
    if (core.length < 4 || FUNC_SKIP.test(core)) continue;
    if (i <= 1) continue;                    // keep the opening word as a cue
    let score = core.length;
    if (!COMMON.has(core.toLowerCase())) score += 6;
    if (/\d/.test(core)) score += 4;
    if (/^[A-Z]{2,}$/.test(core)) score += 3;
    else if (/^[A-Z]/.test(core)) score += 1;
    cand.push({ i, core, pre: m[1], post: m[3], score });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.score - a.score);
  const nBlanks = text.split(/\s+/).length >= 16 ? 2 : 1;
  const chosen = cand.slice(0, nBlanks);
  const byIdx = new Map(chosen.map(c => [c.i, c]));
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (/^\s*$/.test(parts[i])) { html += parts[i] ? ' ' : ''; continue; }
    const c = byIdx.get(i);
    if (c) {
      const width = Math.min(12, Math.max(4, c.core.length));
      html += escHtml(c.pre) + `<span class="blank">${' '.repeat(width)}</span>` + escHtml(c.post);
    } else html += escHtml(parts[i]);
  }
  return { html, answers: chosen.sort((a, b) => a.i - b.i).map(c => c.core) };
}
function answerHtml(text, answers) {
  if (!answers || !answers.length) return escHtml(text);
  let out = escHtml(text);
  for (const a of answers) {
    // unicode-aware boundaries so possessives, hyphens, and accents highlight;
    // g flag so a repeated answer word is marked at every occurrence
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(^|[^\\p{L}\\p{N}])(' + esc + ')(?![\\p{L}\\p{N}])', 'gu'),
      (_m, pre, w) => pre + '<span class="hit">' + w + '</span>');
  }
  return out;
}

let review = null;   // { deck, pos, revealed, done, hit }
function startReview(deck, label) {
  deck = deck.filter(c => c && c.h && c.h.text);
  if (!deck.length) { toast('Nothing to review yet. Save sentences with h while reading.'); return; }
  if (state.playing) pause();
  closeDrawers();
  el.recapModal.classList.add('hidden');
  review = { deck: deck.slice(0, REVIEW_CAP), pos: 0, revealed: false, done: 0, hit: 0, label: label || '' };
  el.reviewModal.classList.remove('hidden');
  renderCard();
}
function renderCard() {
  const card = review.deck[review.pos];
  const h = card.h;
  el.reviewProgress.textContent = (review.pos + 1) + ' / ' + review.deck.length;
  el.reviewSec.textContent = [card.docTitle, h.sec].filter(Boolean).join(' · ').slice(0, 60);
  const cloze = settings.reviewMode === 'cloze' ? makeCloze(h.text) : null;
  if (cloze) {
    el.reviewPrompt.innerHTML = cloze.html;
    el.reviewCue.textContent = 'Say the missing word' + (cloze.answers.length > 1 ? 's' : '') + ', then reveal.';
    review.answers = cloze.answers;
  } else {
    el.reviewPrompt.innerHTML = '<span class="recallcue">' + escHtml(h.text.split(/\s+/).slice(0, 4).join(' ')) + ' …</span>';
    el.reviewCue.textContent = 'Recall the whole claim, then reveal.';
    review.answers = null;
  }
  el.reviewAnswer.innerHTML = answerHtml(h.text, review.answers);
  el.reviewAnswer.classList.add('hidden');
  el.reviewGrade.classList.add('hidden');
  el.reviewReveal.classList.remove('hidden');
  review.revealed = false;
}
function revealCard() {
  if (!review || review.revealed) return;
  el.reviewAnswer.classList.remove('hidden');
  el.reviewGrade.classList.remove('hidden');
  el.reviewReveal.classList.add('hidden');
  review.revealed = true;
}
function gradeHl(docId, text, good) {
  // key by text, not array index: a background sync merge can reorder or drop
  // items in the doc's highlight array between deck-build and grading
  const hls = readHls(docId);
  const h = hls.find(x => x.text === text);
  if (!h) return true;                 // already deleted/merged away: nothing to persist
  gradeSrs(h, good);
  try { LS.setItem('saccade.hl.' + docId, JSON.stringify(hls)); }
  catch (e) { return false; }          // quota: the reschedule did not save
  schedulePush();
  return true;
}
function gradeCard(good) {
  if (!review || !review.revealed) return;
  const card = review.deck[review.pos];
  if (!gradeHl(card.docId, card.h.text, good)) {
    toast('Storage full: could not save this card. Free up space and try again.', 3600);
    return;
  }
  review.done++;
  if (good) review.hit++;
  review.pos++;
  if (review.pos >= review.deck.length) endReview();
  else renderCard();
}
function endReview() {
  const r = review;
  review = null;
  el.reviewModal.classList.add('hidden');
  updateReviewBadge();
  if (state.doc && !el.drawerNotes.classList.contains('hidden')) renderNotes();
  if (r && r.done) {
    const pct = Math.round(100 * r.hit / r.done);
    toast('Recalled ' + r.hit + ' of ' + r.done + ' (' + pct + '%). Missed cards come back sooner.', 3600);
  }
}
function reviewDoc() {
  if (!state.doc || state.doc.ephemeral) { toast('Open a document to review its notes.'); return; }
  const id = state.doc.id;
  startReview(getHls().map((h, idx) => ({ docId: id, docTitle: '', idx, h })), 'doc');
}

/* ---------------- library / persistence ---------------- */
function libIndex() { try { return JSON.parse(LS.getItem('saccade.lib') || '[]'); } catch (e) { return []; } }
function persistDoc() {
  const d = state.doc;
  untombstoneDoc(d.id);     // opening a doc is a deliberate re-add
  try {
    LS.setItem('saccade.doc.' + d.id, JSON.stringify({ title: d.title, blocks: d.blocks }));
    let ix = libIndex().filter(e => e.id !== d.id);
    ix.unshift({ id: d.id, title: d.title, words: state.tokens.length, last: Date.now(), bodyless: false });
    // cache eviction, not user intent: past the 20 most-recent docs, drop only
    // the body. Keep the lib entry so positions, notes, and the review schedule
    // stay visible and keep coming due. Hard-cap the index so it cannot grow forever.
    for (let i = 20; i < ix.length; i++) {
      if (LS.getItem('saccade.doc.' + ix[i].id)) { LS.removeItem('saccade.doc.' + ix[i].id); ix[i].bodyless = true; }
    }
    if (ix.length > 300) {
      for (const rm of ix.slice(300)) {
        LS.removeItem('saccade.doc.' + rm.id);
        LS.removeItem('saccade.pos.' + rm.id);
        LS.removeItem('saccade.hl.' + rm.id);
      }
      ix = ix.slice(0, 300);
    }
    LS.setItem('saccade.lib', JSON.stringify(ix));
    LS.setItem('saccade.last', d.id);
    schedulePush();
  } catch (e) {
    toast('Document too large to save for resume. Reading works, position will not persist.');
  }
}
function curBlockWord() {
  const toks = state.tokens;
  if (!toks.length) return { b: 0, w: 0 };
  const t = toks[state.idx];
  let w = 0, i = state.idx;
  while (i > 0 && toks[i - 1].block === t.block) { i--; w++; }
  const N = Math.max(1, toks.length - 1);
  return { b: t.block, w, pct: Math.round(100 * state.idx / N) };
}
function restorePos(pk) {
  if (!pk) { state.idx = 0; return; }
  let i = firstTokenOfBlock(pk.b);
  let w = pk.w || 0;
  const toks = state.tokens;
  while (w-- > 0 && i + 1 < toks.length && toks[i + 1].block === toks[i].block) i++;
  state.idx = i;
}
function savePos() {
  if (!state.doc || state.doc.ephemeral) return;
  try {
    const pks = JSON.stringify(curBlockWord());
    const changed = LS.getItem('saccade.pos.' + state.doc.id) !== pks;
    LS.setItem('saccade.pos.' + state.doc.id, pks);
    flushStats();
    // stamp freshness only when the position actually moved, so an idle tab
    // closed days later cannot outrank real reading on the other device
    if (changed) {
      const ix = libIndex();
      const e = ix.find(x => x.id === state.doc.id);
      if (e) { e.last = Date.now(); LS.setItem('saccade.lib', JSON.stringify(ix)); }
      schedulePush();
    }
  } catch (e) { /* quota */ }
}
function renderLib() {
  const ix = libIndex();
  el.libList.innerHTML = ix.map(e => {
    let pct = 0;
    try { pct = (JSON.parse(LS.getItem('saccade.pos.' + e.id) || '{}').pct) || 0; } catch (err) {}
    const noBody = e.remoteOnly || e.bodyless;
    const tag = e.remoteOnly ? ' &#183; text on other device' : (e.bodyless ? ' &#183; reload the file to read' : '');
    return `<div class="libitem${noBody ? ' remoteonly' : ''}" data-id="${e.id}">
      <div class="t">${escHtml(e.title)}</div>
      <div class="m"><span>${fmtWords(e.words)} words &#183; ${pct}%${tag}</span><span class="del" data-id="${e.id}">delete</span></div>
    </div>`;
  }).join('') || '<p style="color:var(--dim);font-size:13px">Nothing here yet.</p>';
}

/* ---------------- document lifecycle ---------------- */
function openDoc(doc) {
  pause0();
  doc.id = doc.id || docId(doc.title, doc.blocks);
  state.doc = doc;
  state.tokens = tokenizeDoc(doc);
  if (!state.tokens.length) { toast('No readable text found in that document.'); showLoader(); return; }
  computeUnits();
  buildSections();
  buildSectMap();
  if (doc.ephemeral) {
    state.idx = 0;
  } else {
    let pk = null;
    try { pk = JSON.parse(LS.getItem('saccade.pos.' + doc.id) || 'null'); } catch (e) {}
    restorePos(pk);
  }
  state.lastSent = -1;
  state.lastBlock = -1;
  state.readerBuilt = false;
  state.playedMs = 0;
  state.finished = false;
  state.autoStreak = 0;
  el.reader.classList.add('hidden');
  buildToc();
  updateNoteCount();
  el.docTitle.textContent = doc.title;
  el.docTitle.title = doc.title;
  el.loader.classList.add('hidden');
  el.readerUI.classList.remove('hidden');
  if (!doc.ephemeral) persistDoc();
  renderFrame(true);
  closeDrawers();
}
function pause0() { state.playing = false; clearTimeout(state.timer); if (breakInterval) endBreak(false); }
function showLoader() {
  pause0();
  el.readerUI.classList.add('hidden');
  el.loader.classList.remove('hidden');
  btnBackToDoc.classList.toggle('hidden', !state.doc);
}
function finishLoad(doc) {
  if (!doc.blocks.length) { toast('Nothing readable found.'); return; }
  openDoc(doc);
  el.pasteBox.value = '';
  el.urlInput.value = '';
}
function retokenize() {
  if (!state.doc) return;
  const pk = curBlockWord();
  state.tokens = tokenizeDoc(state.doc);
  computeUnits();
  buildSections();
  buildSectMap();
  restorePos(pk);
  state.lastSent = -1;
  state.lastBlock = -1;
  state.readerBuilt = false;
  if (!el.reader.classList.contains('hidden')) buildReader();
  buildToc();
  renderFrame(true);
  // kill any pending frame timer that closed over the old token array
  clearTimeout(state.timer);
  if (state.playing) scheduleNext();
}

/* ---------------- loaders ---------------- */
async function handleFile(f) {
  if (!f) return;
  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
    toast('Extracting PDF...');
    try {
      const doc = await extractPdf(await f.arrayBuffer(), f.name.replace(/\.pdf$/i, ''));
      finishLoad(doc);
      toast('Loaded: ' + doc.title, 2000);
    } catch (e) {
      toast('PDF extraction failed: ' + e.message, 4200);
    }
  } else {
    finishLoad(parsePlain(await f.text(), f.name.replace(/\.(txt|md|markdown)$/i, '')));
  }
}
async function fetchUrl(u) {
  u = (u || '').trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  toast('Fetching...');
  try {
    const r = await fetch('https://r.jina.ai/' + u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let text = await r.text();
    let title = '';
    const tm = text.match(/^Title:\s*(.+)$/m);
    if (tm) title = tm[1].trim();
    const ci = text.indexOf('Markdown Content:');
    if (ci > -1) text = text.slice(ci + 17);
    finishLoad(parsePlain(text, title || u.replace(/^https?:\/\//, '').slice(0, 80)));
  } catch (err) {
    toast('Could not fetch that URL (' + err.message + '). Paste the text instead.', 4500);
  }
}

/* ---------------- sample ---------------- */
const SAMPLE = `# Saccade, in two minutes

## The single word in front of you

You are about to read without moving your eyes. Normal reading spends roughly a third of its time on saccades, the small jumps your eyes make between words (Rayner, 1998). This tool removes them. Words arrive at a fixed point, one at a time, and the red letter marks where your eye naturally locks onto each word. Researchers call that spot the optimal recognition point.

Press space to start and pause. Speed is on the arrow keys: up is faster, down is slower. Start around 300 words per minute and raise it once the rhythm feels boring. Boring is the signal that you have headroom.

## When you feel lost

Pause. The full sentence appears below the word, with your place marked. Press the left arrow once to restart the sentence, and again to step back a sentence at a time. Lean on this: comprehension comes from cheap rewinds, not from gritting your teeth.

The pacing is not constant. Longer and rarer words stay on screen longer, numbers like 1,847,203 get extra time, and the display breathes at commas, full stops, and paragraph breaks. A short warm-up ramp eases you back in every time you resume.

## Making it stick

Speed without retention is just decoration. When a sentence matters, press h, or hold your finger on the word on a touch screen, and it lands in your notes with its section attached. Open notes with n. From there you can jump back to any saved sentence, copy everything out as markdown, or replay just your saved sentences as a fast review pass. When you finish a document you get a recap with one tap into that replay.

The thin bar above the scrubber is the section map: one segment per section, filled as you go. Tap a segment to jump. If picking a speed is itself a distraction, tap the wpm label to switch to auto: the reader slows down every time you rewind and creeps up while you cruise.

## Reading real papers

Drop a PDF anywhere on this page. Saccade strips running headers and footers, joins hyphenated line breaks, handles two-column layouts, and detects section headings so you can jump around from the contents panel. Inline citations collapse to a quick (ref) marker by default, equation fragments like E = mc^2 or \\alpha_i + \\beta X_t compress into a single token, and the references section is skipped entirely. All of it is adjustable in settings.

For a brand-new paper, tap the 1st pass chip first: you get only the headings and the first sentence of every paragraph, which is usually the skeleton of the argument. Then switch it off and read in full. Try the Skim, Read, and Study presets before touching individual knobs. Skim for triage, Read for normal papers, Study for proofs and dense theory.

## References

Rayner, K. (1998). Eye movements in reading and information processing: 20 years of research. Psychological Bulletin, 124(3), 372-422.`;

/* ---------------- presets ---------------- */
const PRESETS = {
  skim: { wpm: 450, punct: 0.6, cites: 'skip', math: 'collapse', refs: 'skip', chunk: 1, firstPass: false },
  read: { wpm: 320, punct: 1.0, cites: 'collapse', math: 'collapse', refs: 'skip', chunk: 1, firstPass: false },
  study: { wpm: 230, punct: 1.5, cites: 'keep', math: 'keep', refs: 'include', chunk: 1, firstPass: false }
};
function applyPreset(name) {
  Object.assign(settings, PRESETS[name]);
  saveSettings();
  syncInputs();
  el.wpmVal.textContent = settings.wpm;
  el.chipPass1.classList.remove('on');
  retokenize();
  document.querySelectorAll('.chip[data-preset]').forEach(c => c.classList.toggle('on', c.dataset.preset === name));
}

/* ---------------- settings plumbing ---------------- */
function applyChrome() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--font-word', FONTS[settings.font] || FONTS.sans);
  document.documentElement.style.setProperty('--scale', settings.size);
  document.body.classList.toggle('noguides', !settings.guides);
}
function syncInputs() {
  el.setTheme.value = settings.theme;
  el.setFont.value = settings.font;
  el.setSize.value = settings.size;
  el.setGuides.checked = settings.guides;
  el.setAutoFocus.checked = settings.autoFocus;
  el.setBionic.checked = settings.bionic;
  el.setStripMode.value = settings.stripMode;
  el.setRamp.checked = settings.ramp;
  el.setLongWords.checked = settings.longWords;
  el.setPunct.value = settings.punct;
  el.setChunk.value = settings.chunk;
  el.setBreakEvery.value = settings.breakEvery;
  el.setCites.value = settings.cites;
  el.setMath.value = settings.math;
  el.setRefs.value = settings.refs;
  el.setSpeedMode.value = settings.speedMode;
  el.setDailyGoal.value = settings.dailyGoal;
  el.setReviewMode.value = settings.reviewMode;
  el.chipPass1.classList.toggle('on', !!settings.firstPass);
  el.wpmVal.textContent = settings.wpm;
  syncSpeedModeUi();
}
function clearPresetChips() { document.querySelectorAll('.chip[data-preset]').forEach(c => c.classList.remove('on')); }
function bindSetting(input, key, kind, transform) {
  const apply = () => {
    settings[key] = transform ? transform(input) : input.value;
    saveSettings();
    clearPresetChips();
    if (kind === 'chrome') applyChrome();
    else if (kind === 'retok') retokenize();
    else if (kind === 'units') { computeUnits(); renderFrame(true); }
    else if (kind === 'strip') renderFrame(true);
    else if (kind === 'reader') { state.readerBuilt = false; if (!el.reader.classList.contains('hidden')) buildReader(); renderFrame(true); }
    else if (kind === 'chunk') renderFrame(true);
    else if (kind === 'speedmode') syncSpeedModeUi();
    else if (kind === 'goal') updateWordsToday();
  };
  input.addEventListener('change', apply);
  if (input.type === 'range') input.addEventListener('input', apply);
}
function setWpm(v) {
  settings.wpm = clamp(Math.round(v / 10) * 10, 100, 1000);
  saveSettings();
  el.wpmVal.textContent = settings.wpm;
  renderFrame();
}

/* ---------------- drawers / modals ---------------- */
function closeDrawers() {
  [el.drawerSettings, el.drawerLibrary, el.drawerToc, el.drawerNotes].forEach(d => d.classList.add('hidden'));
  el.backdrop.classList.add('hidden');
}
function toggleDrawer(d) {
  const open = d.classList.contains('hidden');
  closeDrawers();
  if (open) {
    if (state.playing) pause();   // panels take attention; never read behind them
    if (d === el.drawerLibrary) renderLib();
    if (d === el.drawerNotes) renderNotes();
    if (d === el.drawerToc) buildToc();
    d.classList.remove('hidden');
    el.backdrop.classList.remove('hidden');
  }
}
function closeAll() {
  closeDrawers();
  el.helpModal.classList.add('hidden');
  el.recapModal.classList.add('hidden');
  el.statsModal.classList.add('hidden');
  if (review) endReview();
  document.body.classList.remove('focusmode');
}

/* ---------------- events ---------------- */
el.btnPlay.addEventListener('click', togglePlay);
el.btnBackSent.addEventListener('click', () => jumpSent(-1));
el.btnFwdSent.addEventListener('click', () => jumpSent(1));
el.btnBackPara.addEventListener('click', () => jumpPara(-1));
el.btnFwdPara.addEventListener('click', () => jumpPara(1));
el.wpmUp.addEventListener('click', () => setWpm(settings.wpm + 20));
el.wpmDown.addEventListener('click', () => setWpm(settings.wpm - 20));
el.scrub.addEventListener('input', () => seek(parseInt(el.scrub.value, 10), { nav: true }));
el.btnReaderView.addEventListener('click', toggleReader);
document.querySelectorAll('.chip[data-preset]').forEach(c => c.addEventListener('click', () => applyPreset(c.dataset.preset)));
el.chipPass1.addEventListener('click', () => {
  settings.firstPass = !settings.firstPass;
  saveSettings();
  el.chipPass1.classList.toggle('on', settings.firstPass);
  retokenize();
  toast(settings.firstPass ? 'First pass: headings and first sentences only.' : 'Full text restored.');
});
el.btnMark.addEventListener('click', markCurrent);
el.btnNotes.addEventListener('click', () => {
  if (state.doc && state.doc.ephemeral) { toast('You are replaying your notes right now.'); return; }
  toggleDrawer(el.drawerNotes);
});
el.btnReplayNotes.addEventListener('click', () => { closeDrawers(); replayNotes(); });
el.btnReviewDoc.addEventListener('click', reviewDoc);
el.btnReview.addEventListener('click', () => startReview(dueItems(), 'due'));
el.btnCopyNotes.addEventListener('click', copyNotes);
let clearArmed = null;
el.btnClearNotes.addEventListener('click', () => {
  if (clearArmed) {
    clearTimeout(clearArmed); clearArmed = null;
    getHls().forEach(h => tombstoneHl(state.doc.id, h.text));
    setHls([]);
    renderNotes();
    el.btnClearNotes.textContent = 'Clear';
    toast('Notes cleared.');
  } else {
    el.btnClearNotes.textContent = 'Really clear?';
    clearArmed = setTimeout(() => { clearArmed = null; el.btnClearNotes.textContent = 'Clear'; }, 3000);
  }
});
el.noteList.addEventListener('click', e => {
  const del = e.target.closest('.del');
  const item = e.target.closest('.noteitem');
  if (!item) return;
  const hls = getHls();
  const k = parseInt((del || item).dataset.k, 10);
  if (del) {
    if (hls[k]) tombstoneHl(state.doc.id, hls[k].text);
    hls.splice(k, 1);
    setHls(hls);
    renderNotes();
    return;
  }
  if (hls[k]) { jumpToHl(hls[k]); closeDrawers(); }
});
el.unitWpm.addEventListener('click', () => {
  settings.speedMode = settings.speedMode === 'auto' ? 'manual' : 'auto';
  saveSettings();
  syncSpeedModeUi();
  toast(settings.speedMode === 'auto' ? 'Auto speed: rewinds slow it down, cruising speeds it up.' : 'Manual speed.');
});
function syncSpeedModeUi() {
  el.unitWpm.classList.toggle('auto', settings.speedMode === 'auto');
  el.unitWpm.textContent = settings.speedMode === 'auto' ? 'auto' : 'wpm';
  el.setSpeedMode.value = settings.speedMode;
}
el.wordsToday.addEventListener('click', showStats);
el.btnStatsClose.addEventListener('click', () => el.statsModal.classList.add('hidden'));
el.btnRecapClose.addEventListener('click', () => el.recapModal.classList.add('hidden'));
el.btnRecapReplay.addEventListener('click', replayNotes);
el.btnRecapReview.addEventListener('click', () => { el.recapModal.classList.add('hidden'); reviewDoc(); });
el.reviewReveal.addEventListener('click', revealCard);
el.reviewAgain.addEventListener('click', () => gradeCard(false));
el.reviewGood.addEventListener('click', () => gradeCard(true));
el.reviewQuit.addEventListener('click', endReview);
[el.helpModal, el.statsModal, el.recapModal].forEach(m =>
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

let suppressClicksUntil = 0;   // timestamp; survives iOS not synthesizing a click
el.stage.addEventListener('click', e => {
  if (Date.now() < suppressClicksUntil) return;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const r = el.stage.getBoundingClientRect();
  const fx = (e.clientX - r.left) / Math.max(1, r.width);
  if (coarse && fx < 0.18) jumpSent(-1);          // edge taps jump sentences (touch only)
  else if (coarse && fx > 0.82) jumpSent(1);
  else togglePlay();
});
let touchX = 0, touchY = 0, lpTimer = null;
el.stage.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => { suppressClicksUntil = Date.now() + 700; markCurrent(); }, 500);  // hold to highlight
}, { passive: true });
el.stage.addEventListener('touchmove', e => {
  const dx = e.touches[0].clientX - touchX;
  const dy = e.touches[0].clientY - touchY;
  if (Math.hypot(dx, dy) > 12) clearTimeout(lpTimer);
}, { passive: true });
el.stage.addEventListener('touchend', e => {
  clearTimeout(lpTimer);
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 45 && Math.abs(dy) < 70) {
    suppressClicksUntil = Date.now() + 700;
    dx < 0 ? jumpSent(1) : jumpSent(-1);
  }
}, { passive: true });
el.stage.addEventListener('touchcancel', () => clearTimeout(lpTimer), { passive: true });

el.strip.addEventListener('click', e => {
  const s = e.target.closest('span[data-i]');
  if (s) seek(parseInt(s.dataset.i, 10));
});
el.reader.addEventListener('click', e => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  const bi = parseInt(b.dataset.b, 10);
  const blk = state.doc.blocks[bi];
  if (blk.ref && settings.refs === 'skip') { toast('References are skipped. Change it in settings to read them.'); return; }
  seek(firstTokenOfBlock(bi), { nav: true });
});
el.tocList.addEventListener('click', e => {
  const t = e.target.closest('.tocitem');
  if (!t) return;
  const s = state.sections[parseInt(t.dataset.si, 10)];
  if (s) seek(s.start, { nav: true });
  closeDrawers();
});
el.sectmap.addEventListener('click', e => {
  const seg = e.target.closest('.seg');
  if (!seg) return;
  const s = state.sections[parseInt(seg.dataset.si, 10)];
  if (s) seek(s.start, { nav: true });
});
el.searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
el.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { el.searchInput.blur(); closeDrawers(); }
  if (e.key === 'Enter' && !el.searchResults.classList.contains('hidden')) {
    const first = el.searchResults.querySelector('.hit');
    if (first) { seek(firstTokenOfBlock(parseInt(first.dataset.b, 10)), { nav: true }); closeDrawers(); }
  }
});
el.searchResults.addEventListener('click', e => {
  const h = e.target.closest('.hit');
  if (!h) return;
  seek(firstTokenOfBlock(parseInt(h.dataset.b, 10)), { nav: true });
  closeDrawers();
});
el.backdrop.addEventListener('click', closeDrawers);
el.libList.addEventListener('click', e => {
  const del = e.target.closest('.del');
  if (del) {
    e.stopPropagation();
    const id = del.dataset.id;
    LS.removeItem('saccade.doc.' + id);
    LS.removeItem('saccade.pos.' + id);
    LS.removeItem('saccade.hl.' + id);
    LS.setItem('saccade.lib', JSON.stringify(libIndex().filter(x => x.id !== id)));
    if (LS.getItem('saccade.last') === id) LS.removeItem('saccade.last');
    tombstoneDoc(id);       // so sync propagates the delete instead of resurrecting it
    schedulePush();
    renderLib();
    return;
  }
  const item = e.target.closest('.libitem');
  if (!item) return;
  try {
    const d = JSON.parse(LS.getItem('saccade.doc.' + item.dataset.id));
    if (d) openDoc({ id: item.dataset.id, title: d.title, blocks: d.blocks });
    else toast('The full text is not stored on this device (older document or synced without its body). Load the file again to reopen it; your notes and place are kept.', 5500);
  } catch (err) { toast('Could not open that document.'); }
});

el.btnLibrary.addEventListener('click', () => toggleDrawer(el.drawerLibrary));
el.btnToc.addEventListener('click', () => toggleDrawer(el.drawerToc));
el.btnSettings.addEventListener('click', () => toggleDrawer(el.drawerSettings));
el.btnHelp.addEventListener('click', () => {
  if (el.helpModal.classList.contains('hidden') && state.playing) pause();
  el.helpModal.classList.toggle('hidden');
});
el.btnCloseHelp.addEventListener('click', () => el.helpModal.classList.add('hidden'));
el.btnSkipBreak.addEventListener('click', () => endBreak(true));
el.btnNew.addEventListener('click', () => { closeDrawers(); showLoader(); });

el.btnLoadText.addEventListener('click', () => {
  const t = el.pasteBox.value.trim();
  if (!t) { toast('Paste some text first.'); return; }
  finishLoad(parsePlain(t, ''));
});
el.btnSample.addEventListener('click', () => finishLoad(parsePlain(SAMPLE, '')));
el.fileInput.addEventListener('change', () => { handleFile(el.fileInput.files[0]); el.fileInput.value = ''; });
el.btnFetchUrl.addEventListener('click', () => fetchUrl(el.urlInput.value));
el.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchUrl(el.urlInput.value); });

const btnBackToDoc = document.createElement('button');
btnBackToDoc.className = 'btn hidden';
btnBackToDoc.textContent = '← Back to reading';
btnBackToDoc.addEventListener('click', () => {
  el.loader.classList.add('hidden');
  el.readerUI.classList.remove('hidden');
  renderFrame(true);
});
document.querySelector('.loader-inner').prepend(btnBackToDoc);

/* settings inputs */
bindSetting(el.setTheme, 'theme', 'chrome');
bindSetting(el.setFont, 'font', 'chrome');
bindSetting(el.setSize, 'size', 'chrome', i => parseFloat(i.value));
bindSetting(el.setGuides, 'guides', 'chrome', i => i.checked);
bindSetting(el.setAutoFocus, 'autoFocus', 'none', i => i.checked);
bindSetting(el.setBionic, 'bionic', 'reader', i => i.checked);
bindSetting(el.setStripMode, 'stripMode', 'strip');
bindSetting(el.setRamp, 'ramp', 'none', i => i.checked);
bindSetting(el.setLongWords, 'longWords', 'units', i => i.checked);
bindSetting(el.setPunct, 'punct', 'units', i => parseFloat(i.value));
bindSetting(el.setChunk, 'chunk', 'chunk', i => parseInt(i.value, 10));
bindSetting(el.setBreakEvery, 'breakEvery', 'none', i => parseInt(i.value, 10));
bindSetting(el.setCites, 'cites', 'retok');
bindSetting(el.setMath, 'math', 'retok');
bindSetting(el.setRefs, 'refs', 'retok');
bindSetting(el.setSpeedMode, 'speedMode', 'speedmode');
bindSetting(el.setDailyGoal, 'dailyGoal', 'goal', i => parseInt(i.value, 10));
bindSetting(el.setReviewMode, 'reviewMode', 'none');

/* keyboard */
const PLAYBACK_KEYS = [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '0', 'h', 'b', 'f', 'r'];
document.addEventListener('keydown', e => {
  if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
  if (!el.breakOverlay.classList.contains('hidden')) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endBreak(true); }
    return;
  }
  if (!el.reviewModal.classList.contains('hidden')) {
    if (e.repeat || !review) return;   // a held Space must not reveal then grade in one press
    if (e.key === 'Escape') { e.preventDefault(); endReview(); }
    else if (!review.revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); revealCard(); }
    else if (review.revealed && (e.key === '1' || e.key === 'ArrowLeft')) { e.preventDefault(); gradeCard(false); }
    else if (review.revealed && (e.key === '2' || e.key === 'ArrowRight')) { e.preventDefault(); gradeCard(true); }
    return;
  }
  const modal = [el.recapModal, el.statsModal, el.helpModal].find(m => !m.classList.contains('hidden'));
  if (modal) {
    if (e.key === ' ' || e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); modal.classList.add('hidden'); }
    return;
  }
  if (!el.loader.classList.contains('hidden') && PLAYBACK_KEYS.includes(e.key)) return;
  if (state.playing) { undim(); armDim(); }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); e.shiftKey ? jumpPara(-1) : jumpSent(-1); break;
    case 'ArrowRight': e.preventDefault(); e.shiftKey ? jumpPara(1) : jumpSent(1); break;
    case 'ArrowUp': e.preventDefault(); setWpm(settings.wpm + 20); break;
    case 'ArrowDown': e.preventDefault(); setWpm(settings.wpm - 20); break;
    case '0': jumpSent(0); break;
    case 'h': markCurrent(); break;
    case 'b': if (state.tokens.length) seek(state.idx - 30); break;
    case 'f': document.body.classList.toggle('focusmode'); break;
    case 'r': if (state.doc) toggleReader(); break;
    case 'l': toggleDrawer(el.drawerLibrary); break;
    case 't': toggleDrawer(el.drawerToc); break;
    case 'n':
      if (state.doc && state.doc.ephemeral) { toast('You are replaying your notes right now.'); break; }
      toggleDrawer(el.drawerNotes);
      break;
    case 's': toggleDrawer(el.drawerSettings); break;
    case 'v': startReview(dueItems(), 'due'); break;
    case '/': e.preventDefault(); if (el.drawerToc.classList.contains('hidden')) toggleDrawer(el.drawerToc); el.searchInput.focus(); break;
    case '?': el.helpModal.classList.toggle('hidden'); break;
    case 'Escape': closeAll(); break;
  }
});

/* drag and drop */
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; el.dropOverlay.classList.remove('hidden'); });
window.addEventListener('dragleave', e => { if (--dragDepth <= 0) { dragDepth = 0; el.dropOverlay.classList.add('hidden'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  el.dropOverlay.classList.add('hidden');
  if (e.dataTransfer.files && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

/* ---------------- sync (private GitHub Gist) ----------------
   Optional. A token with only the gist scope lives in localStorage on this
   device; it is never written into the synced payload or the repo. */
const GIST_DESC = 'Saccade reader sync';
const GIST_FILE = 'saccade-sync.json';
let sync = null;
try { sync = JSON.parse(LS.getItem('saccade.sync') || 'null'); } catch (e) { sync = null; }
let pushTimer = null, lastPull = 0, pushing = false;

function ghHeaders(token) {
  return { Authorization: 'Bearer ' + (token || sync.token), Accept: 'application/vnd.github+json' };
}
function syncUiUpdate(msg) {
  const on = !!(sync && sync.token && sync.gistId);
  el.syncOff.classList.toggle('hidden', on);
  el.syncOn.classList.toggle('hidden', !on);
  if (on) el.syncStatus.textContent = msg ||
    ('Connected. Last sync: ' + (sync.at ? new Date(sync.at).toLocaleString() : 'not yet'));
}
async function syncConnect() {
  const token = el.syncTokenInput.value.trim();
  if (!token) { toast('Paste a GitHub token (gist scope) first.'); return; }
  toast('Connecting sync...');
  try {
    let gistId = null;
    for (let page = 1; page <= 3 && !gistId; page++) {
      const r = await fetch('https://api.github.com/gists?per_page=100&page=' + page, { headers: ghHeaders(token) });
      if (r.status === 401 || r.status === 403) throw new Error('token rejected; it needs the gist scope');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const gists = await r.json();
      const hit = gists.find(g => g.description === GIST_DESC);
      if (hit) gistId = hit.id;
      if (gists.length < 100) break;
    }
    if (!gistId) {
      const c = await fetch('https://api.github.com/gists', {
        method: 'POST', headers: ghHeaders(token),
        body: JSON.stringify({ description: GIST_DESC, public: false, files: { [GIST_FILE]: { content: '{}' } } })
      });
      if (!c.ok) throw new Error('could not create gist (HTTP ' + c.status + ')');
      gistId = (await c.json()).id;
    }
    sync = { token, gistId, at: 0 };
    LS.setItem('saccade.sync', JSON.stringify(sync));
    el.syncTokenInput.value = '';
    await syncPull(true);
    await syncPush();
    syncUiUpdate();
    toast('Sync connected. Do the same once on your other device.');
  } catch (e) {
    toast('Sync failed: ' + e.message, 5000);
  }
}
function syncDisconnect() {
  LS.removeItem('saccade.sync');
  sync = null;
  syncUiUpdate();
  toast('Sync disconnected. Everything stays on this device.');
}
function collectPayload(capForGist = true) {
  const lib = libIndex();
  const payload = { v: 1, at: Date.now(), lib, docs: {}, pos: {}, hl: {}, days, dead, statsToday: { d: stats.d, w: stats.w } };
  for (const e of lib) {
    try {
      payload.pos[e.id] = JSON.parse(LS.getItem('saccade.pos.' + e.id) || 'null');
      payload.hl[e.id] = JSON.parse(LS.getItem('saccade.hl.' + e.id) || '[]');
      payload.docs[e.id] = JSON.parse(LS.getItem('saccade.doc.' + e.id) || 'null');
    } catch (err) { /* skip corrupt entries */ }
  }
  let body = JSON.stringify(payload);
  // a local backup keeps every doc body; only the gist push sheds bodies to fit
  if (capForGist && body.length > 800000) {
    // keep positions and notes for everything; shed the largest doc bodies
    const sized = lib.map(e => ({ id: e.id, n: (JSON.stringify(payload.docs[e.id]) || '').length }))
      .sort((a, b) => b.n - a.n);
    for (const s of sized) {
      if (body.length <= 800000) break;
      payload.docs[s.id] = null;
      body = JSON.stringify(payload);
    }
  }
  return body;
}
async function syncPush(fast) {
  if (!sync || pushing) return;
  pushing = true;
  try {
    // merge remote first so a device that has not pulled recently cannot
    // overwrite the gist with a stale library (skipped when the page is
    // being hidden and there is only time for one request)
    if (!fast && Date.now() - lastPull > 10000) {
      const ok = await syncPull(true);
      if (!ok) throw new Error('could not merge the remote copy first; push skipped');
    }
    const reqBody = JSON.stringify({ files: { [GIST_FILE]: { content: collectPayload() } } });
    const opts = { method: 'PATCH', headers: ghHeaders(), body: reqBody };
    if (fast && reqBody.length < 60000) opts.keepalive = true;   // survives iOS backgrounding
    const r = await fetch('https://api.github.com/gists/' + sync.gistId, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sync.at = Date.now();
    LS.setItem('saccade.sync', JSON.stringify(sync));
    syncUiUpdate();
  } catch (e) {
    syncUiUpdate('Push failed: ' + e.message);
  }
  pushing = false;
}
function schedulePush() {
  if (!sync) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncPush, 15000);
}
async function syncPull(force) {
  if (!sync) return false;
  if (!force && Date.now() - lastPull < 60000) return true;
  try {
    const r = await fetch('https://api.github.com/gists/' + sync.gistId, { headers: ghHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const g = await r.json();
    const f = g.files && g.files[GIST_FILE];
    if (f) {
      let content = f.content;
      if (f.truncated && f.raw_url) {
        const rr = await fetch(f.raw_url);
        if (!rr.ok) throw new Error('raw fetch HTTP ' + rr.status);
        content = await rr.text();
      }
      const p = JSON.parse(content || '{}');
      if (p && p.v) mergeRemote(p);
    }
    lastPull = Date.now();          // only a successful merge counts as "pulled"
    sync.at = Date.now();
    LS.setItem('saccade.sync', JSON.stringify(sync));
    syncUiUpdate();
    return true;
  } catch (e) {
    lastPull = 0;
    syncUiUpdate('Pull failed: ' + e.message);
    return false;
  }
}
function mergeRemote(p, opts) {
  const restore = opts && opts.restore;   // manual backup import: additive only
  const localIx = libIndex();
  const map = new Map(localIx.map(e => [e.id, e]));
  const curId = state.doc && !state.doc.ephemeral ? state.doc.id : null;
  const curLastBefore = curId && map.get(curId) ? (map.get(curId).last || 0) : 0;
  let changed = false;
  // union tombstones first (newest timestamp wins), then honor them. A manual
  // restore skips this so an old backup's deletions cannot wipe current data;
  // this device's own local tombstones still apply below.
  if (!restore && p.dead) {
    for (const id in (p.dead.docs || {})) {
      if ((p.dead.docs[id] || 0) > (dead.docs[id] || 0)) dead.docs[id] = p.dead.docs[id];
    }
    for (const id in (p.dead.hl || {})) {
      dead.hl[id] = dead.hl[id] || {};
      for (const hash in p.dead.hl[id]) {
        if ((p.dead.hl[id][hash] || 0) > (dead.hl[id][hash] || 0)) dead.hl[id][hash] = p.dead.hl[id][hash];
      }
    }
    saveDead();
  }
  for (const re of (p.lib || [])) {
    // a doc deleted on any device after it was last read stays deleted
    if (dead.docs[re.id] && dead.docs[re.id] >= (re.last || 0)) continue;
    const le = map.get(re.id);
    const remoteNewer = !le || (re.last || 0) > (le.last || 0);
    if (!le) {
      if (p.docs && p.docs[re.id]) {
        try {
          LS.setItem('saccade.doc.' + re.id, JSON.stringify(p.docs[re.id]));
          map.set(re.id, Object.assign({}, re, { remoteOnly: undefined }));
          changed = true;
        } catch (err) { /* quota; skip this doc body */ }
      } else {
        // doc body was shed for size: keep the entry so positions, notes,
        // and the library listing survive round-trips
        map.set(re.id, Object.assign({}, re, { remoteOnly: true }));
        changed = true;
      }
      untombstoneDoc(re.id);
    } else if (remoteNewer) {
      le.last = re.last;
      le.words = re.words || le.words;
      changed = true;
    }
    if (remoteNewer && p.pos && p.pos[re.id]) {
      try { LS.setItem('saccade.pos.' + re.id, JSON.stringify(p.pos[re.id])); } catch (err) {}
    }
    if (p.hl && p.hl[re.id] && p.hl[re.id].length) {
      try {
        const cur = JSON.parse(LS.getItem('saccade.hl.' + re.id) || '[]');
        const byText = new Map(cur.map(h => [h.text, h]));
        const deadHl = dead.hl[re.id] || {};
        let touched = false;
        for (const h of p.hl[re.id]) {
          const ts = deadHl[hashText(h.text)];
          if (ts && ts >= (h.added || 0)) continue;   // deleted after it was saved
          const local = byText.get(h.text);
          if (!local) { cur.push(h); byText.set(h.text, h); touched = true; }
          else if (h.srs && (h.srs.last || 0) > (local.srs ? (local.srs.last || 0) : -1)) {
            local.srs = h.srs; touched = true;         // adopt the newer review schedule
          }
        }
        if (touched) {
          cur.sort((a, b) => (a.added || 0) - (b.added || 0));
          LS.setItem('saccade.hl.' + re.id, JSON.stringify(cur));
          changed = true;
        }
      } catch (err) {}
    }
  }
  // apply doc tombstones locally: delete anything removed on the other device
  for (const id in dead.docs) {
    const le = map.get(id);
    if (le && dead.docs[id] >= (le.last || 0)) {
      map.delete(id);
      LS.removeItem('saccade.doc.' + id);
      LS.removeItem('saccade.pos.' + id);
      LS.removeItem('saccade.hl.' + id);
      if (LS.getItem('saccade.last') === id) LS.removeItem('saccade.last');
      changed = true;
    }
  }
  // apply highlight tombstones locally
  for (const id in dead.hl) {
    try {
      const cur = JSON.parse(LS.getItem('saccade.hl.' + id) || '[]');
      const kept = cur.filter(h => {
        const ts = dead.hl[id][hashText(h.text)];
        return !(ts && ts >= (h.added || 0));
      });
      if (kept.length !== cur.length) {
        LS.setItem('saccade.hl.' + id, JSON.stringify(kept));
        changed = true;
      }
    } catch (err) {}
  }
  if (changed) LS.setItem('saccade.lib', JSON.stringify([...map.values()].sort((a, b) => (b.last || 0) - (a.last || 0))));
  if (p.days) for (const k in p.days) if ((p.days[k] || 0) > (days[k] || 0)) days[k] = p.days[k];
  if (p.statsToday && p.statsToday.d === stats.d && p.statsToday.w > stats.w) stats.w = p.statsToday.w;
  LS.setItem('saccade.days', JSON.stringify(days));
  updateWordsToday();
  updateNoteCount();
  updateReviewBadge();
  // if the other device read further in the currently open doc, follow it
  // (never on a manual restore: that would yank the reader mid-session)
  if (!restore && curId && !state.playing && p.pos && p.pos[curId]) {
    const re = (p.lib || []).find(e => e.id === curId);
    if (re && (re.last || 0) > curLastBefore) {
      const pk = p.pos[curId];
      const cur = curBlockWord();
      if (pk && Math.abs((pk.pct || 0) - (cur.pct || 0)) > 1) {
        restorePos(pk);
        renderFrame(true);
        toast('Position synced from your other device.');
      }
    }
  }
}
el.btnSyncConnect.addEventListener('click', syncConnect);
el.btnSyncNow.addEventListener('click', () => { syncPull(true).then(() => syncPush()); });
el.btnSyncOffBtn.addEventListener('click', syncDisconnect);

/* ---------------- backup / restore (local durability) ---------------- */
function copyBackupFallback(json) {
  const done = () => toast('Backup copied to the clipboard. Paste it into a note or file to keep it.', 5000);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(done).catch(() => fallbackCopy(json, done));
  else fallbackCopy(json, done);
}
function exportData() {
  let json;
  try { json = collectPayload(false); } catch (e) { toast('Backup failed: ' + e.message, 4000); return; }
  const fname = 'saccade-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  // installed iOS PWAs ignore <a download> and click() silently no-ops, so prefer
  // the share sheet there, which iOS honors, and only claim success on a real save path
  if (standalone && navigator.canShare) {
    try {
      const file = new File([json], fname, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: fname })
          .then(() => toast('Backup ready in the share sheet.'))
          .catch(err => { if (!err || err.name !== 'AbortError') copyBackupFallback(json); });
        return;
      }
    } catch (e) { /* fall through */ }
  }
  if (!('download' in document.createElement('a')) || standalone) { copyBackupFallback(json); return; }
  try {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Backup downloaded.');
  } catch (e) { copyBackupFallback(json); }
}
async function importData(file) {
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (!p || !p.v) throw new Error('not a Saccade backup file');
    mergeRemote(p, { restore: true });   // additive: never applies the backup's deletions or yanks the reader
    updateReviewBadge();
    updateNoteCount();
    if (!el.drawerLibrary.classList.contains('hidden')) renderLib();
    toast('Backup merged. Your existing data was kept.');
  } catch (e) { toast('Restore failed: ' + e.message, 4500); }
}
el.btnExport.addEventListener('click', exportData);
el.importInput.addEventListener('change', () => { importData(el.importInput.files[0]); el.importInput.value = ''; });
function updateInstallNote() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) { el.installNote.textContent = 'Installed as an app. It works offline.'; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  el.installNote.innerHTML = ios
    ? 'On iPad or iPhone: tap Share, then <b>Add to Home Screen</b> to install it as an offline app and stop Safari from clearing your data.'
    : 'Install it (address-bar install icon, or Add to Home Screen) so the browser does not clear your library.';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.playing) pause();
    if (sync) { clearTimeout(pushTimer); syncPush(true); }
  } else if (sync) {
    syncPull(false);
  }
});
window.addEventListener('beforeunload', savePos);
window.addEventListener('pagehide', () => {   // beforeunload is unreliable on iOS
  savePos();
  if (sync) { clearTimeout(pushTimer); syncPush(true); }
});

/* ---------------- init ---------------- */
function init() {
  applyChrome();
  syncInputs();
  updateWordsToday();
  const last = LS.getItem('saccade.last');
  let opened = false;
  if (last) {
    try {
      const d = JSON.parse(LS.getItem('saccade.doc.' + last));
      if (d && d.blocks && d.blocks.length) { openDoc({ id: last, title: d.title, blocks: d.blocks }); opened = true; }
    } catch (e) { /* corrupted entry */ }
  }
  if (!opened) showLoader();
  syncUiUpdate();
  updateReviewBadge();
  updateInstallNote();
  if (dueItems().length) toast(dueItems().length + ' card' + (dueItems().length === 1 ? '' : 's') + ' due for review. Press v or tap the ↻.', 4000);
  if (sync) syncPull(true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();

/* test hook */
window.Saccade = {
  state, settings, openDoc, finishLoad, parsePlain, extractPdf, tokenizeDoc,
  play, pause, seek, handleFile, markCurrent, getHls, replayNotes, notesMarkdown,
  collectPayload, mergeRemote, runSearch, showStats, buildSections,
  makeCloze, gradeSrs, initSrs, dueItems, startReview, reviewDoc, gradeCard, revealCard,
  updateReviewBadge, exportData, importData,
  get review() { return review; }
};
