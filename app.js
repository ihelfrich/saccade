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
  'drawerSettings','drawerLibrary','drawerToc','libList','tocList','btnNew',
  'helpModal','btnCloseHelp','breakOverlay','breakCount','btnSkipBreak','dropOverlay','toast',
  'setTheme','setFont','setSize','setGuides','setAutoFocus','setBionic','setStripMode',
  'setRamp','setLongWords','setPunct','setChunk','setBreakEvery','setCites','setMath','setRefs'
].forEach(id => el[id] = document.getElementById(id));

/* ---------------- settings ---------------- */
const DEFAULTS = {
  wpm: 320, chunk: 1, theme: 'dark', font: 'sans', size: 1,
  guides: true, autoFocus: true, bionic: true, stripMode: 'sentence',
  ramp: true, longWords: true, punct: 1, breakEvery: 8,
  cites: 'collapse', math: 'collapse', refs: 'skip'
};
let settings = Object.assign({}, DEFAULTS, JSON.parse(LS.getItem('saccade.settings') || '{}'));
function saveSettings() { LS.setItem('saccade.settings', JSON.stringify(settings)); }

const FONTS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace'
};

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
  lastScroll: 0
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
      if (tk.endS) sent++;
      tokens.push(tk);
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
  if (b > a) {
    el.wordbox.classList.add('hidden');
    el.chunkbox.classList.remove('hidden');
    const txt = toks.slice(a, b + 1).map(t => t.t).join(' ');
    fitFont(el.chunkbox, txt.length, 30, 'clamp(26px, 5.2vw, 46px)');
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
}

/* ---------------- playback ---------------- */
function chunkRange(i) {
  const toks = state.tokens;
  if (settings.chunk <= 1 || !toks.length) return [i, i];
  let j = i;
  while (j - i + 1 < settings.chunk && j + 1 < toks.length &&
         !toks[j].endS && !toks[j].endB &&
         toks[j + 1].block === toks[i].block && !toks[j + 1].heading) j++;
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
  dur = Math.max(45, dur);
  state.timer = setTimeout(() => {
    state.playedMs += dur;
    addWords(b - a + 1);
    if (b + 1 >= state.tokens.length) { finishDoc(); return; }
    state.idx = b + 1;
    if (settings.breakEvery > 0 && state.playedMs >= settings.breakEvery * 60000) { startBreak(); return; }
    if (++state.saveCounter >= 25) { savePos(); state.saveCounter = 0; }
    scheduleNext();
  }, dur);
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
  toast('Finished: ' + fmtWords(state.tokens.length) + ' words. Press space to restart.');
}
function seek(i, opts) {
  state.finished = false;
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
    if (count <= 0) endBreak(true);
  }, 1000);
}
function endBreak(resume) {
  clearInterval(breakInterval);
  breakInterval = null;
  el.breakOverlay.classList.add('hidden');
  state.playedMs = 0;
  if (resume) play();
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
let statFlush = 0;
function addWords(n) {
  if (stats.d !== today()) stats = { d: today(), w: 0 };
  stats.w += n;
  updateWordsToday();
  if (++statFlush >= 40) { LS.setItem('saccade.stats', JSON.stringify(stats)); statFlush = 0; }
}
function updateWordsToday() {
  el.wordsToday.textContent = stats.w > 0 ? fmtWords(stats.w) + ' today' : '';
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
  if (!state.doc) return;
  let html = '';
  state.doc.blocks.forEach((b, bi) => {
    if (b.type === 'p') return;
    if (b.ref && settings.refs === 'skip') return;
    html += `<div class="tocitem ${b.type === 'h3' ? 'lvl3' : ''}" data-b="${bi}">${escHtml(b.text.slice(0, 90))}</div>`;
  });
  el.tocList.innerHTML = html || '<p style="color:var(--dim);font-size:13px">No sections detected in this document.</p>';
}

/* ---------------- library / persistence ---------------- */
function libIndex() { try { return JSON.parse(LS.getItem('saccade.lib') || '[]'); } catch (e) { return []; } }
function persistDoc() {
  const d = state.doc;
  try {
    LS.setItem('saccade.doc.' + d.id, JSON.stringify({ title: d.title, blocks: d.blocks }));
    let ix = libIndex().filter(e => e.id !== d.id);
    ix.unshift({ id: d.id, title: d.title, words: state.tokens.length, last: Date.now() });
    while (ix.length > 12) {
      const rm = ix.pop();
      LS.removeItem('saccade.doc.' + rm.id);
      LS.removeItem('saccade.pos.' + rm.id);
    }
    LS.setItem('saccade.lib', JSON.stringify(ix));
    LS.setItem('saccade.last', d.id);
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
  if (!state.doc) return;
  try {
    LS.setItem('saccade.pos.' + state.doc.id, JSON.stringify(curBlockWord()));
    LS.setItem('saccade.stats', JSON.stringify(stats));
  } catch (e) { /* quota */ }
}
function renderLib() {
  const ix = libIndex();
  el.libList.innerHTML = ix.map(e => {
    let pct = 0;
    try { pct = (JSON.parse(LS.getItem('saccade.pos.' + e.id) || '{}').pct) || 0; } catch (err) {}
    return `<div class="libitem" data-id="${e.id}">
      <div class="t">${escHtml(e.title)}</div>
      <div class="m"><span>${fmtWords(e.words)} words &#183; ${pct}%</span><span class="del" data-id="${e.id}">delete</span></div>
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
  let pk = null;
  try { pk = JSON.parse(LS.getItem('saccade.pos.' + doc.id) || 'null'); } catch (e) {}
  restorePos(pk);
  state.lastSent = -1;
  state.lastBlock = -1;
  state.readerBuilt = false;
  state.playedMs = 0;
  state.finished = false;
  el.reader.classList.add('hidden');
  buildToc();
  el.docTitle.textContent = doc.title;
  el.docTitle.title = doc.title;
  el.loader.classList.add('hidden');
  el.readerUI.classList.remove('hidden');
  persistDoc();
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
  restorePos(pk);
  state.lastSent = -1;
  state.lastBlock = -1;
  state.readerBuilt = false;
  if (!el.reader.classList.contains('hidden')) buildReader();
  buildToc();
  renderFrame(true);
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

## Reading real papers

Drop a PDF anywhere on this page. Saccade strips running headers and footers, joins hyphenated line breaks, handles two-column layouts, and detects section headings so you can jump around from the contents panel. Inline citations collapse to a quick (ref) marker by default, equation fragments like E = mc^2 or \\alpha_i + \\beta X_t compress into a single token, and the references section is skipped entirely. All of it is adjustable in settings.

Try the Skim, Read, and Study presets before touching individual knobs. Skim for triage, Read for normal papers, Study for proofs and dense theory.

## References

Rayner, K. (1998). Eye movements in reading and information processing: 20 years of research. Psychological Bulletin, 124(3), 372-422.`;

/* ---------------- presets ---------------- */
const PRESETS = {
  skim: { wpm: 450, punct: 0.6, cites: 'skip', math: 'collapse', refs: 'skip', chunk: 1 },
  read: { wpm: 320, punct: 1.0, cites: 'collapse', math: 'collapse', refs: 'skip', chunk: 1 },
  study: { wpm: 230, punct: 1.5, cites: 'keep', math: 'keep', refs: 'include', chunk: 1 }
};
function applyPreset(name) {
  Object.assign(settings, PRESETS[name]);
  saveSettings();
  syncInputs();
  el.wpmVal.textContent = settings.wpm;
  retokenize();
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.preset === name));
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
  el.wpmVal.textContent = settings.wpm;
}
function clearPresetChips() { document.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); }
function bindSetting(input, key, kind, transform) {
  input.addEventListener('change', () => {
    settings[key] = transform ? transform(input) : input.value;
    saveSettings();
    clearPresetChips();
    if (kind === 'chrome') applyChrome();
    else if (kind === 'retok') retokenize();
    else if (kind === 'units') { computeUnits(); renderFrame(true); }
    else if (kind === 'strip') renderFrame(true);
    else if (kind === 'reader') { state.readerBuilt = false; if (!el.reader.classList.contains('hidden')) buildReader(); renderFrame(true); }
    else if (kind === 'chunk') renderFrame(true);
  });
}
function setWpm(v) {
  settings.wpm = clamp(Math.round(v / 10) * 10, 100, 1000);
  saveSettings();
  el.wpmVal.textContent = settings.wpm;
  renderFrame();
}

/* ---------------- drawers / modals ---------------- */
function closeDrawers() {
  [el.drawerSettings, el.drawerLibrary, el.drawerToc].forEach(d => d.classList.add('hidden'));
}
function toggleDrawer(d) {
  const open = d.classList.contains('hidden');
  closeDrawers();
  if (open) {
    if (d === el.drawerLibrary) renderLib();
    d.classList.remove('hidden');
  }
}
function closeAll() {
  closeDrawers();
  el.helpModal.classList.add('hidden');
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
el.scrub.addEventListener('input', () => seek(parseInt(el.scrub.value, 10)));
el.btnReaderView.addEventListener('click', toggleReader);
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => applyPreset(c.dataset.preset)));

let swipeSuppress = false;
el.stage.addEventListener('click', () => { if (!swipeSuppress) togglePlay(); swipeSuppress = false; });
let touchX = 0, touchY = 0;
el.stage.addEventListener('touchstart', e => {
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });
el.stage.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 45 && Math.abs(dy) < 70) {
    swipeSuppress = true;
    dx < 0 ? jumpSent(1) : jumpSent(-1);
  }
}, { passive: true });

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
  seek(firstTokenOfBlock(bi));
});
el.tocList.addEventListener('click', e => {
  const t = e.target.closest('.tocitem');
  if (!t) return;
  seek(firstTokenOfBlock(parseInt(t.dataset.b, 10)));
  closeDrawers();
});
el.libList.addEventListener('click', e => {
  const del = e.target.closest('.del');
  if (del) {
    e.stopPropagation();
    const id = del.dataset.id;
    LS.removeItem('saccade.doc.' + id);
    LS.removeItem('saccade.pos.' + id);
    LS.setItem('saccade.lib', JSON.stringify(libIndex().filter(x => x.id !== id)));
    if (LS.getItem('saccade.last') === id) LS.removeItem('saccade.last');
    renderLib();
    return;
  }
  const item = e.target.closest('.libitem');
  if (!item) return;
  try {
    const d = JSON.parse(LS.getItem('saccade.doc.' + item.dataset.id));
    if (d) openDoc({ id: item.dataset.id, title: d.title, blocks: d.blocks });
  } catch (err) { toast('Could not open that document.'); }
});

el.btnLibrary.addEventListener('click', () => toggleDrawer(el.drawerLibrary));
el.btnToc.addEventListener('click', () => toggleDrawer(el.drawerToc));
el.btnSettings.addEventListener('click', () => toggleDrawer(el.drawerSettings));
el.btnHelp.addEventListener('click', () => el.helpModal.classList.toggle('hidden'));
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

/* keyboard */
document.addEventListener('keydown', e => {
  if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
  if (!el.breakOverlay.classList.contains('hidden')) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endBreak(true); }
    return;
  }
  if (state.playing) { undim(); armDim(); }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); e.shiftKey ? jumpPara(-1) : jumpSent(-1); break;
    case 'ArrowRight': e.preventDefault(); e.shiftKey ? jumpPara(1) : jumpSent(1); break;
    case 'ArrowUp': e.preventDefault(); setWpm(settings.wpm + 20); break;
    case 'ArrowDown': e.preventDefault(); setWpm(settings.wpm - 20); break;
    case '0': jumpSent(0); break;
    case 'f': document.body.classList.toggle('focusmode'); break;
    case 'r': if (state.doc) toggleReader(); break;
    case 'l': toggleDrawer(el.drawerLibrary); break;
    case 't': toggleDrawer(el.drawerToc); break;
    case 's': toggleDrawer(el.drawerSettings); break;
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

document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });
window.addEventListener('beforeunload', savePos);

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
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();

/* test hook */
window.Saccade = { state, settings, openDoc, finishLoad, parsePlain, extractPdf, tokenizeDoc, play, pause, seek, handleFile };
