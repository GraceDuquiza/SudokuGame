'use strict';

/* ========================================================================
   Sudoku Learn — TABLE VERSION (Vanilla JS)
   - Solution-STRICT: accepts only the correct digit for a cell.
   - Robust DOM init: grid always renders; guards optional elements.
   - Undo/redo, hints, notes, timer, mistakes, personal bests.
   - LocalStorage save/load with input validation (hardening).
   - Frame-buster to prevent clickjacking when embedded.
========================================================================= */

/* ----------------------------------------------------------------------
   CLICKJACKING PROTECTION
   If someone tries to load the page inside an <iframe>, break out.
---------------------------------------------------------------------- */
if (window.top !== window.self) {
  try { window.top.location.replace(window.location.href); }
  catch { window.location.replace(window.location.href); }
}

/* ------------------------------ Config -------------------------------- */
const MAX_HINTS = 5;                 // How many hints per puzzle
const STRICT_SOLUTION_CHECK = true;  // Accept only the unique-solution digit

/* ------------------------------ Tiny query helpers -------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ------------------------------ Small utilities ---------------------- */
/** Format seconds as mm:ss or hh:mm:ss */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
}
/** Return a shuffled copy (Fisher-Yates lite via sort RNG) */
function shuffled(arr) { return arr.slice().sort(() => Math.random() - 0.5); }
/** Notes <Set> <-> Array helpers for saving in JSON */
function serializeNotes(notesObj) { const out = {}; for (const [k, s] of Object.entries(notesObj)) out[k] = [...s]; return out; }
function deserializeNotes(raw) { const out = {}; for (const [k, a] of Object.entries(raw || {})) out[k] = new Set(a); return out; }

/* ------------------------------ Sanitizers (hardening) ----------------
   Everything read from localStorage is coerced/validated so it cannot
   sneak HTML into template strings. This also prevents corrupted saves.
-----------------------------------------------------------------------*/
function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function clampInt(v, min, max, def = min) {
  v = toInt(v, def);
  return (v < min || v > max) ? def : v;
}
/** Ensure a grid array has length N*N with values in [0..N] */
function cleanGridArray(a, N) {
  const len = N * N;
  if (!Array.isArray(a) || a.length !== len) return Array(len).fill(0);
  return a.map(v => clampInt(v, 0, N, 0));
}
/** Ensure notes: indices in [0..N*N-1], digits in [1..N] */
function cleanNotes(raw, N) {
  const len = N * N;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, arr] of Object.entries(raw)) {
    const idx = toInt(k, -1);
    if (idx < 0 || idx >= len) continue;
    const s = new Set();
    if (Array.isArray(arr)) {
      for (const v of arr) {
        const vv = clampInt(v, 1, N, 0);
        if (vv) s.add(vv);
      }
    }
    if (s.size) out[idx] = s;
  }
  return out;
}

/* ------------------------------ Game state --------------------------- */
const state = {
  difficulty: 'beginner', // beginner → 4×4, others → 9×9
  size: 9,
  boxSize: 3,

  // Puzzle
  givens: [],     // starting puzzle (0 = blank)
  grid: [],       // current board values (0 = blank)
  solution: [],   // full correct solution

  // UI & modes
  selected: null,         // index of selected cell (0..N*N-1) or null
  notesMode: false,       // notes toggle
  notes: {},              // { index -> Set(digits) }
  highlightNumber: null,  // digit to highlight on the board

  // Timer
  startTime: null,
  elapsed: 0,
  timerId: null,

  // Hints & mistakes
  hintsUsed: 0, hintTarget: null, hintValue: null,
  mistakes: 0, mistakeCells: new Set(), gameOver: false,

  // Undo/redo stack snapshots
  undoStack: [], redoStack: [],

  // Scoring
  score: 0, totalScore: 0,

  // Challenge progress
  puzzleNumber: 1, totalPuzzles: 20,

  // Temporary visual feedback
  goodFlash: new Set(),
};

/* ------------------------------ DOM elements (late-bound) ------------- */
let difficultySel, gridTable, keysEl, newGameBtn, restartBtn, hintBtn, notesToggle,
    eraseBtn, undoBtn, redoBtn, hintsUsedEl, mistakesEl, livesEl, coachMsg,
    clearProgressBtn, scoreEl, challengeLabel, clockEl2, btnPause, btnResume,
    btnStop, bestTimeEl;

/* ------------------------------ Storage keys -------------------------- */
const SAVE_KEY = 'sudoku.learn.table.v2';
const BEST_KEY = 'sudoku.bestTimes.v1';
let bestTimes = { beginner: null, intermediate: null, advanced: null, expert: null };

/* ------------------------------ Build guard --------------------------- */
let isBuilding = false;
let buildToken = 0;

/* ------------------------------ Save / Load --------------------------- */
/** Persist current game into localStorage (best-effort). */
function save() {
  const data = {
    difficulty: state.difficulty,
    size: state.size,
    givens: state.givens,
    grid: state.grid,
    solution: state.solution, // keep the reference solution
    notes: serializeNotes(state.notes),

    // Persist elapsed up to this moment (timer may be running)
    elapsed: state.elapsed + (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0),

    hintsUsed: state.hintsUsed,
    hintTarget: state.hintTarget,
    mistakes: state.mistakes,
    mistakeCells: [...state.mistakeCells],
    score: state.score,
    totalScore: state.totalScore,
    puzzleNumber: state.puzzleNumber,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch {}
}

/** Try solving a puzzle to recover a missing solution (older saves). */
function trySolveForSolution(puzzle, N, B) {
  const out = solveBacktracking(puzzle, N, B, /*countOnly*/ false);
  return out.solved && out.solution ? out.solution : null;
}

/** Load save from localStorage (validated); return true if loaded. */
function load() {
  let raw = localStorage.getItem(SAVE_KEY);
  if (!raw) {
    // Back-compat with older key
    const oldRaw = localStorage.getItem('sudoku.learn.table.v1');
    if (oldRaw) raw = oldRaw;
  }
  if (!raw) return false;

  try {
    const d = JSON.parse(raw);

    // Difficulty must be one of known values
    state.difficulty = (d.difficulty === 'beginner' || d.difficulty === 'intermediate' ||
                        d.difficulty === 'advanced'  || d.difficulty === 'expert')
                        ? d.difficulty : 'beginner';

    setBoardSizeFromDifficulty(state.difficulty);
    const N = state.size;

    // Arrays must match expected shape, values clamped to ranges
    state.givens = cleanGridArray(d.givens, N);
    state.grid   = cleanGridArray(d.grid,   N);
    state.notes  = cleanNotes(d.notes, N);

    // Numbers are coerced; indices are clamped
    state.elapsed      = toInt(d.elapsed, 0);
    state.hintsUsed    = clampInt(d.hintsUsed, 0, MAX_HINTS, 0);
    state.hintTarget   = (typeof d.hintTarget === 'number') ? clampInt(d.hintTarget, 0, N*N-1, null) : null;
    state.mistakes     = clampInt(d.mistakes, 0, 999, 0);
    state.mistakeCells = new Set(Array.isArray(d.mistakeCells)
                          ? d.mistakeCells.map(x => clampInt(x, 0, N*N-1, -1)).filter(x => x >= 0)
                          : []);
    state.score        = toInt(d.score, 0);
    state.totalScore   = toInt(d.totalScore, 0);
    state.puzzleNumber = clampInt(d.puzzleNumber, 1, 9999, 1);

    // Ensure we have a matching-size solution
    if (Array.isArray(d.solution) && d.solution.length === N * N) {
      state.solution = cleanGridArray(d.solution, N);
    } else {
      const sol = trySolveForSolution(state.givens, N, state.boxSize);
      if (sol) state.solution = cleanGridArray(sol, N);
      else return false; // corrupted/unsolvable save → start new
    }

    if (difficultySel) difficultySel.value = state.difficulty;
    return true;
  } catch {
    return false;
  }
}

/** Clear persistent save and reset progress counters. */
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  state.score = 0;
  state.totalScore = 0;
  state.puzzleNumber = 1;
  setBoardSizeFromDifficulty(state.difficulty);
  renderAll();
  coach('🗑️ Progress cleared. Starting fresh!');
}

/* ------------------------------ Personal Bests ------------------------ */
function loadBestTimes() { try { const raw = localStorage.getItem(BEST_KEY); if (raw) bestTimes = { ...bestTimes, ...JSON.parse(raw) }; } catch {} }
function saveBestTimes() { try { localStorage.setItem(BEST_KEY, JSON.stringify(bestTimes)); } catch {} }
function getBestSecondsFor(diff) { const v = bestTimes[diff]; return (typeof v === 'number' && v >= 0) ? v : null; }
function setPersonalBest(diff, seconds) {
  const cur = getBestSecondsFor(diff);
  if (cur == null || seconds < cur) { bestTimes[diff] = seconds; saveBestTimes(); updateBestTimeUI(); return true; }
  return false;
}
function updateBestTimeUI() {
  if (!bestTimeEl) return;
  const v = getBestSecondsFor(state.difficulty);
  bestTimeEl.textContent = v == null ? '—' : fmtTime(v);
}

/* ------------------------------ Difficulty → board size ---------------- */
function setBoardSizeFromDifficulty(diff) {
  if (diff === 'beginner') { state.size = 4; state.boxSize = 2; }
  else { state.size = 9; state.boxSize = 3; }
}

/* ------------------------------ Challenge label ----------------------- */
function updateChallengeLabel() {
  if (!challengeLabel) return;
  const names = { beginner: '🌱 Beginner', intermediate: '⭐ Intermediate', advanced: '🔥 Advanced', expert: '🏆 Expert' };
  challengeLabel.textContent = `${names[state.difficulty] || state.difficulty} — Puzzle ${state.puzzleNumber} of ${state.totalPuzzles}`;
}

/* ------------------------------ Index helpers ------------------------- */
function rcToIndex(r, c, N) { return r * N + c; }
function rowIndices(i, N) { const r = Math.floor(i / N); return Array.from({ length: N }, (_, c) => rcToIndex(r, c, N)); }
function colIndices(i, N) { const c = i % N; return Array.from({ length: N }, (_, r) => rcToIndex(r, c, N)); }
function boxIndices(i, N, B) {
  const r = Math.floor(i / N), c = i % N;
  const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
  const out = [];
  for (let rr = 0; rr < B; rr++) for (let cc = 0; cc < B; cc++) out.push(rcToIndex(br + rr, bc + cc, N));
  return out;
}

/* ------------------------------ Candidates / constraints --------------- */
function usedInRow(i, g, N)    { return new Set(rowIndices(i, N).map(j => g[j]).filter(Boolean)); }
function usedInCol(i, g, N)    { return new Set(colIndices(i, N).map(j => g[j]).filter(Boolean)); }
function usedInBox(i, g, N, B) { return new Set(boxIndices(i, N, B).map(j => g[j]).filter(Boolean)); }
function candidatesFor(i, g, N, B) {
  if (g[i] !== 0) return [];
  const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
  const cand = [];
  for (let v = 1; v <= N; v++) if (!used.has(v)) cand.push(v);
  return cand;
}

/* ------------------------------ Solver / Generator (MRV) --------------- */
/** Backtracking solver, MRV ordering. When countOnly=true, counts solutions. */
function solveBacktracking(p, N, B, countOnly = false) {
  const g = p.slice();
  let solutions = 0;

  function nextEmptyMRV() {
    let idx = -1, bestLen = 1e9;
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== 0) continue;
      const cand = candidatesFor(i, g, N, B);
      if (cand.length === 0) return i;                // immediate dead end
      if (cand.length < bestLen) { bestLen = cand.length; idx = i; }
      if (bestLen === 1) break;                       // best possible
    }
    return idx;
  }

  function bt() {
    const i = nextEmptyMRV();
    if (i === -1) { solutions++; return true; }       // full grid
    const cand = shuffled(candidatesFor(i, g, N, B));
    for (let k = 0; k < cand.length; k++) {
      g[i] = cand[k];
      if (bt()) {
        if (!countOnly) return true;
        if (solutions > 1) return true;               // early exit if >1
      }
      g[i] = 0;
    }
    return false;
  }

  const solved = bt();
  return { solved, solution: solved ? g.slice() : null, solutionsCount: solutions };
}
function hasUniqueSolution(p, N, B) { return solveBacktracking(p, N, B, true).solutionsCount === 1; }
/** Construct a random full valid solution grid. */
function generateFullSolution(N, B) {
  const g = Array(N * N).fill(0);
  function fill(i = 0) {
    if (i === N * N) return true;
    if (g[i] !== 0) return fill(i + 1);
    const cand = shuffled([...Array(N).keys()].map(x => x + 1));
    for (let k = 0; k < cand.length; k++) {
      const v = cand[k];
      const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
      if (!used.has(v)) { g[i] = v; if (fill(i + 1)) return true; g[i] = 0; }
    }
    return false;
  }
  fill(0);
  return g;
}
/** Remove clues while keeping uniqueness, down to a min-clues threshold. */
function generatePuzzle(N, B) {
  const minClues = (N === 4) ? 6 : 34;
  const sol = generateFullSolution(N, B);
  const idxs = shuffled([...Array(N * N).keys()]);
  const puzzle = sol.slice();

  for (let t = 0; t < idxs.length; t++) {
    const idx = idxs[t];
    const keep = puzzle[idx];
    puzzle[idx] = 0;
    if (!hasUniqueSolution(puzzle, N, B)) {
      puzzle[idx] = keep;
    } else if (puzzle.filter(Boolean).length <= minClues) {
      break;
    }
  }
  return { puzzle, solution: sol };
}

/* ------------------------------ Grid building ------------------------- */
let cells = [];       // <td> elements (one per cell)
let cellInners = [];  // <div class="cell-inner"> inside each td
let lastVal = [];     // cache to avoid re-render
let lastNotesSig = [];

/** Return HTML for an empty N×N table body with thick box borders. */
function gridHTML(N, B) {
  let html = '<colgroup>';
  for (let c = 0; c < N; c++) html += `<col style="width:${100 / N}%">`;
  html += '</colgroup><tbody>';
  for (let r = 0; r < N; r++) {
    html += '<tr>';
    for (let c = 0; c < N; c++) {
      const i = rcToIndex(r, c, N);
      const boxRight  = ((c + 1) % B === 0 && c !== N - 1) ? ' box-right'  : '';
      const boxBottom = ((r + 1) % B === 0 && r !== N - 1) ? ' box-bottom' : '';
      html += `<td class="cell${boxRight}${boxBottom}" data-idx="${i}"><div class="cell-inner"></div></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  return html;
}

/** Create/refresh the visible table based on current N, B. */
function buildGridTable() {
  if (!gridTable || isBuilding) return;
  isBuilding = true;
  const token = ++buildToken;

  const N = state.size, B = state.boxSize;
  gridTable.style.maxWidth = (N === 4) ? '360px' : '500px';
  gridTable.innerHTML = gridHTML(N, B);
  gridTable.dataset.n = String(N);

  cells = Array.from(gridTable.querySelectorAll('td.cell'));
  cellInners = cells.map(td => td.firstElementChild);
  lastVal = Array(N * N).fill(undefined);
  lastNotesSig = Array(N * N).fill('');

  // Avoid layout thrash; render on next frame
  requestAnimationFrame(() => {
    if (token !== buildToken) { isBuilding = false; return; }
    ensureNxN();
    isBuilding = false;
    renderAll();
  });
}

/** Ensure the table truly matches N×N (safety during resizes). */
function ensureNxN() {
  if (!gridTable) return;
  const N = state.size;
  const rows = gridTable.querySelectorAll('tbody tr').length;
  const cols = gridTable.querySelectorAll('colgroup col').length;
  if (rows !== N || cols !== N) {
    gridTable.innerHTML = gridHTML(N, state.boxSize);
    gridTable.dataset.n = String(N);
    cells = Array.from(gridTable.querySelectorAll('td.cell'));
    cellInners = cells.map(td => td.firstElementChild);
    lastVal = Array(N * N).fill(undefined);
    lastNotesSig = Array(N * N).fill('');
  }
}

/* ------------------------------ Notes UI -------------------------------- */
/** Toggle a note digit in a cell's Set. */
function toggleNote(i, n) {
  if (!state.notes[i]) state.notes[i] = new Set();
  const s = state.notes[i];
  if (s.has(n)) s.delete(n); else s.add(n);
  if (s.size === 0) delete state.notes[i];
}
/** Build HTML for a 3×3 (or 2×2) mini notes grid. */
function buildNotesHTML(N, notesSet) {
  const small = (N === 4);
  const slots = small ? 4 : 9;
  let html = `<div class="notes ${small ? 'small' : ''}">`;
  for (let v = 1; v <= slots; v++) html += `<div class="note">${notesSet.has(v) ? v : ''}</div>`;
  html += `</div>`;
  return html;
}

/* ------------------------------ Rendering -------------------------------- */
/** Paint a single cell from current state. */
function paintCell(i) {
  if (!cells[i]) return;
  const td = cells[i];
  const inner = cellInners[i];

  const N = state.size;
  const val = state.grid[i];
  const given = state.givens[i] !== 0;

  td.classList.toggle('prefilled', given);
  td.classList.toggle('selected', state.selected === i);
  td.classList.toggle('mistakeNumber', state.mistakeCells.has(i));
  td.classList.toggle('hint-highlight', state.hintTarget === i);
  td.classList.toggle('goodNumber', state.goodFlash.has(i));

  const same = state.highlightNumber != null && val === state.highlightNumber;
  td.classList.toggle('sameNumber', same);

  // If the value changed, update the text and clear notes render cache
  if (lastVal[i] !== val) {
    lastVal[i] = val;
    lastNotesSig[i] = '';
    inner.textContent = val ? String(val) : '';
  }

  // Render notes overlay only when cell is blank
  if (val === 0) {
    const s = state.notes[i];
    const sig = s ? [...s].sort().join(',') : '';
    if (sig !== lastNotesSig[i]) {
      lastNotesSig[i] = sig;
      inner.innerHTML = s && s.size ? buildNotesHTML(N, s) : '';
    }
  }
}

/** Paint the entire board and HUD bits. */
function renderAll() {
  const total = state.size * state.size;
  for (let i = 0; i < total; i++) paintCell(i);

  updateNumpadCounts();
  updateNumpadActiveStyle();

  if (hintsUsedEl) hintsUsedEl.textContent = `${state.hintsUsed}/${MAX_HINTS}`;
  if (mistakesEl)  mistakesEl.textContent  = state.mistakes;
  if (scoreEl)     scoreEl.textContent     = `${state.score} (Total: ${state.totalScore})`;
  updateChallengeLabel();
  updateLives();
}

/** Update only same-number highlight classes (fast). */
function repaintHighlightsOnly() {
  if (!cells.length) return;
  const total = state.size * state.size;
  for (let i = 0; i < total; i++) {
    const td = cells[i]; const val = state.grid[i];
    td.classList.toggle('sameNumber', state.highlightNumber != null && val === state.highlightNumber);
  }
}

/* ------------------------------ Highlight control ---------------------- */
function setHighlightNumber(num) {
  state.highlightNumber = (state.highlightNumber === num ? null : num);
  repaintHighlightsOnly();
  updateNumpadActiveStyle();
}

/* ------------------------------ Numpad counters ------------------------ */
function remainingByDigit() {
  const N = state.size;
  const left = Array(N + 1).fill(N);
  for (let i = 0; i < state.grid.length; i++) {
    const v = state.grid[i];
    if (v) left[v]--;
  }
  for (let v = 1; v <= N; v++) if (left[v] < 0) left[v] = 0;
  return left;
}
function updateNumpadCounts() {
  if (!keysEl) return;
  const N = state.size;
  const left = remainingByDigit();
  keysEl.dataset.n = String(N);
  for (let v = 1; v <= N; v++) {
    const btn = keysEl.querySelector(`button[data-value="${v}"]`);
    if (!btn) continue;
    const remainEl = btn.querySelector('.remain');
    if (remainEl) remainEl.textContent = left[v];
    btn.classList.toggle('exhausted', left[v] === 0);
  }
}
function updateNumpadActiveStyle() {
  if (!keysEl) return;
  $$('#keys button').forEach(btn => {
    const n = +btn.dataset.value;
    btn.classList.toggle('active', n === state.highlightNumber);
  });
}

/* ------------------------------ Input & gameplay ----------------------- */
/** Board click → select cell; clicking a filled cell sets highlight. */
function onGridClick(e) {
  const td = e.target.closest('td.cell');
  if (!td || !gridTable || !gridTable.contains(td)) return;
  const prev = state.selected;
  state.selected = +td.dataset.idx;
  if (prev !== null) paintCell(prev);
  paintCell(state.selected);
  const v = state.grid[state.selected];
  if (v) setHighlightNumber(v);
}

/** Push a snapshot for undo (and clear redo). */
function pushUndo() {
  state.undoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber,
  });
  state.redoStack = [];
}
/** Undo last action. */
function undo() {
  if (!state.undoStack.length) return coach('↩️ Nothing to undo!');
  const s = state.undoStack.pop();
  state.redoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber,
  });
  state.grid = s.grid;
  state.notes = deserializeNotes(s.notes);
  state.selected = s.selected;
  state.score = s.score;
  state.highlightNumber = s.highlightNumber ?? null;
  renderAll(); save(); coach('↩️ Undid your last move.');
}
/** Redo previously undone action. */
function redo() {
  if (!state.redoStack.length) return coach('↪️ Nothing to redo!');
  const s = state.redoStack.pop();
  state.undoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber,
  });
  state.grid = s.grid;
  state.notes = deserializeNotes(s.notes);
  state.selected = s.selected;
  state.score = s.score;
  state.highlightNumber = s.highlightNumber ?? null;
  renderAll(); save(); coach('↪️ Redid your move.');
}

/** Briefly mark a cell as “good” (green) for visual feedback. */
function flashGood(i, ms = 480) {
  state.goodFlash.add(i);
  paintCell(i);
  setTimeout(() => { state.goodFlash.delete(i); paintCell(i); }, ms);
}

/** Old local rule check (only used when STRICT_SOLUTION_CHECK=false). */
function isPlacementValidLocal(i) {
  const N = state.size, B = state.boxSize, val = state.grid[i];
  if (val === 0) return true;
  const row = rowIndices(i, N).map(j => state.grid[j]);
  const col = colIndices(i, N).map(j => state.grid[j]);
  const box = boxIndices(i, N, B).map(j => state.grid[j]);
  const onlyOnce = a => a.filter(v => v === val).length === 1;
  return onlyOnce(row) && onlyOnce(col) && onlyOnce(box);
}

/** Main placement: only accept the correct digit (strict mode). */
function placeNumber(num) {
  if (state.gameOver || state.selected == null) return;
  const i = state.selected;
  if (state.givens[i] !== 0) { setHighlightNumber(num); return; }

  // Notes mode toggles candidates instead of placing a value
  if (state.notesMode) {
    pushUndo();
    toggleNote(i, num);
    state.highlightNumber = num;
    paintCell(i); save();
    return;
  }

  // Optional UX: avoid placing a digit that's already exhausted
  const left = remainingByDigit();
  const current = state.grid[i];
  if (left[num] === 0 && current !== num) {
    state.highlightNumber = num;
    repaintHighlightsOnly();
    coach(`All ${num}’s are already placed.`);
    return;
  }

  pushUndo();

  if (STRICT_SOLUTION_CHECK) {
    // Reject wrong digit (soft flash red, lose a heart, do not keep value)
    if (num !== state.solution[i]) {
      state.mistakes++;
      state.mistakeCells.add(i);
      paintCell(i);
      setTimeout(() => { state.mistakeCells.delete(i); paintCell(i); }, 450);
      coach('❌ Not the right number for this box. Try again!');
      if (mistakesEl) mistakesEl.textContent = state.mistakes;
      updateLives();
      save();
      if (state.mistakes >= 5) gameOver();
      return;
    }

    // Correct digit: place it, score, and flash green
    state.grid[i] = num;
    state.mistakeCells.delete(i);
    delete state.notes[i];
    state.score += 10;
    flashGood(i);
    coach('✅ Great! That’s the correct number.');

  } else {
    // Legacy/local validation mode
    state.grid[i] = num;
    if (!isPlacementValidLocal(i)) {
      state.mistakes++;
      state.mistakeCells.add(i);
      state.score = Math.max(0, state.score - 5);
      paintCell(i);
      if (state.mistakes >= 5) return gameOver();
      coach('❌ Oops! That number doesn’t fit.');
    } else {
      state.mistakeCells.delete(i);
      state.score += 10;
      delete state.notes[i];
      flashGood(i);
      coach('✅ Nice choice!');
    }
  }

  // HUD updates
  updateNumpadCounts();
  updateNumpadActiveStyle();
  if (hintsUsedEl) hintsUsedEl.textContent = `${state.hintsUsed}/${MAX_HINTS}`;
  if (mistakesEl)  mistakesEl.textContent  = state.mistakes;
  if (scoreEl)     scoreEl.textContent     = `${state.score} (Total: ${state.totalScore})`;
  updateLives();

  save();
  checkWin();
}

/** Clear the selected editable cell (value + notes). */
function eraseCell() {
  if (state.gameOver || state.selected == null) return;
  const i = state.selected;
  if (state.givens[i] !== 0) return;
  pushUndo();
  state.grid[i] = 0;
  delete state.notes[i];
  state.mistakeCells.delete(i);
  paintCell(i);
  updateNumpadCounts();
  save(); coach('🧽 Cleared that box.');
}

/* ------------------------------ Hints ---------------------------------- */
/** Find a naked single: cell with exactly one candidate. */
function findNakedSingle(g, N, B) {
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0) {
      const c = candidatesFor(i, g, N, B);
      if (c.length === 1) return { idx: i, value: c[0] };
    }
  }
  return null;
}
/** Provide a hint: prefer naked single, else reveal one correct cell. */
function hint() {
  if (state.gameOver) return;
  if (state.hintsUsed >= MAX_HINTS) return coach('⚠️ No more hints!');

  let move = findNakedSingle(state.grid, state.size, state.boxSize);
  if (!move) {
    const empties = [];
    for (let i = 0; i < state.grid.length; i++) if (state.grid[i] === 0) empties.push(i);
    if (!empties.length) return coach('🤔 No hints needed!');
    const idx = empties[0]; // deterministic; change to random if preferred
    move = { idx, value: state.solution[idx] };
  }

  const prev = state.hintTarget;
  state.hintsUsed++;
  state.hintTarget = move.idx;
  state.hintValue  = move.value;
  if (prev != null) paintCell(prev);
  paintCell(move.idx);
  coach(`💡 Hint ${state.hintsUsed}/${MAX_HINTS}: This box should be ${move.value}.`);
  if (hintsUsedEl) hintsUsedEl.textContent = `${state.hintsUsed}/${MAX_HINTS}`;
  save();
}

/* ------------------------------ Game over & win ------------------------ */
/** End the game: show overlay with score and restart/quit. */
function gameOver() {
  stopTimer();
  state.gameOver = true;
  coach('💀 Game Over! Out of hearts.');
  const o = document.createElement('div');
  o.className = 'game-over';
  o.innerHTML = `
    <div class="overlay-box">
      <h2>💀 GAME OVER</h2>
      <p>Your score: <strong>${state.score}</strong></p>
      <p>Total score: <strong>${state.totalScore}</strong></p>
      <div class="buttons">
        <button id="restartAfter">🔄 Try Again</button>
        <button id="quitGame">Quit</button>
      </div>
    </div>`;
  document.body.appendChild(o);
  $('#restartAfter')?.addEventListener('click', () => { document.body.removeChild(o); state.score = 0; newGame(); });
  $('#quitGame')?.addEventListener('click', () => {
    document.body.removeChild(o);
    state.score = 0; state.totalScore = 0; clearSave();
    coach('👋 Thanks for playing! Start a new game when ready.');
  });
}

/** Check solved: grid must exactly match the solution. */
function checkWin() {
  if (state.grid.length && state.grid.every((v, i) => v !== 0 && v === state.solution[i])) {
    stopTimer();
    state.score += 100;
    state.totalScore += state.score;

    const secondsUsed = state.elapsed;
    if (setPersonalBest(state.difficulty, secondsUsed)) {
      coach(`🏅 New personal best: ${fmtTime(secondsUsed)}!`);
    }

    const winOverlay = document.createElement('div');
    winOverlay.className = 'game-over';
    winOverlay.innerHTML = `
      <div class="overlay-box">
        <h2>🎉 You solved it!</h2>
        <p>Score this game: <strong>${state.score}</strong></p>
        <p>Total Score: <strong>${state.totalScore}</strong></p>
        <div class="buttons">
          <button id="nextChallenge">Next Challenge</button>
          <button id="quitGame">Quit</button>
        </div>
      </div>`;
    document.body.appendChild(winOverlay);

    $('#nextChallenge')?.addEventListener('click', () => {
      document.body.removeChild(winOverlay);
      state.score = 0;
      state.puzzleNumber++;
      newGame();
    });
    $('#quitGame')?.addEventListener('click', () => {
      document.body.removeChild(winOverlay);
      state.score = 0; state.totalScore = 0; clearSave();
      coach('👋 Thanks for playing! Start a new game when ready.');
    });

    save();
  }
}

/* ------------------------------ Timer ---------------------------------- */
function writeClocks(text) { if (clockEl2) clockEl2.textContent = text; }
/** Show/hide Pause/Resume buttons depending on timer state. */
function syncTimerButtons() {
  if (!btnPause || !btnResume) return;
  const running = !!state.timerId;
  btnPause.hidden = !running;
  btnResume.hidden = running;
}
/** Tick every second when running. */
function tickClock() {
  const sec = state.elapsed + (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0);
  writeClocks(fmtTime(sec));
}
function startTimer() { stopTimer(); state.startTime = Date.now(); state.timerId = setInterval(tickClock, 1000); tickClock(); syncTimerButtons(); }
function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
    state.elapsed += Math.floor((Date.now() - state.startTime) / 1000);
    state.startTime = null;
    tickClock(); save();
  }
  syncTimerButtons();
}
function resumeTimer() { if (state.timerId) return; state.startTime = Date.now(); state.timerId = setInterval(tickClock, 1000); tickClock(); syncTimerButtons(); }
function resetTimer() { stopTimer(); state.elapsed = 0; writeClocks('00:00'); save(); syncTimerButtons(); }
/** Show a short helpful message (uses textContent for safety). */
function coach(msg) { if (coachMsg) coachMsg.textContent = msg; }

/* ------------------------------ Lives / hearts ------------------------- */
function updateLives() {
  if (!livesEl) return;
  const totalLives = 5;
  const remaining = Math.max(0, totalLives - state.mistakes);
  livesEl.textContent = '❤'.repeat(remaining) + '♡'.repeat(totalLives - remaining);
}

/* ------------------------------ New / Restart -------------------------- */
/** Create a fresh puzzle and start the timer. */
function newGame() {
  if (isBuilding) return;
  resetTimer();

  Object.assign(state, {
    hintsUsed: 0, hintTarget: null, hintValue: null,
    mistakes: 0, mistakeCells: new Set(),
    gameOver: false,
    undoStack: [], redoStack: [],
    score: 0, notes: {}, highlightNumber: null, goodFlash: new Set(),
  });

  setBoardSizeFromDifficulty(state.difficulty);

  const { puzzle, solution } = generatePuzzle(state.size, state.boxSize);
  state.givens   = puzzle.slice();
  state.grid     = puzzle.slice();
  state.solution = solution.slice();  // keep the reference solution

  if (newGameBtn) newGameBtn.disabled = true;

  buildGridTable();
  buildKeys();

  startTimer();
  save();
  updateBestTimeUI();
  setTimeout(() => { if (newGameBtn) newGameBtn.disabled = false; }, 300);
}

/** Restart current puzzle using the same givens/solution. */
function restartGameSamePuzzle() {
  if (isBuilding) return;
  resetTimer();
  Object.assign(state, {
    grid: state.givens.slice(),           // same givens
    mistakes: 0, mistakeCells: new Set(),
    hintsUsed: 0, hintTarget: null, hintValue: null,
    gameOver: false,
    undoStack: [], redoStack: [],
    score: 0, notes: {}, highlightNumber: null, goodFlash: new Set(),
  });
  buildGridTable();
  buildKeys();
  startTimer();
  save();
  updateBestTimeUI();
}

/* ------------------------------ Numpad --------------------------------- */
/** Build the 1..N number buttons and wire clicks. */
function buildKeys() {
  if (!keysEl) return;
  keysEl.innerHTML = '';
  const N = state.size;
  keysEl.dataset.n = String(N);
  for (let v = 1; v <= N; v++) {
    const b = document.createElement('button');
    b.innerHTML = `<div class="digit">${v}</div><div class="remain">0</div>`;
    b.dataset.value = String(v);
    b.addEventListener('click', () => {
      const i = state.selected;
      const canEdit = i != null && state.givens[i] === 0;
      if (!canEdit) { setHighlightNumber(v); return; }
      placeNumber(v);
      state.highlightNumber = v;
      repaintHighlightsOnly();
    });
    keysEl.appendChild(b);
  }
  updateNumpadCounts();
  updateNumpadActiveStyle();
}

/* ------------------------------ Keyboard --------------------------------
   - Space: pause/resume
   - Shift+S: stop/reset
   - 1..N: place/highlight
---------------------------------------------------------------------------*/
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); state.timerId ? stopTimer() : resumeTimer(); return; }
  if (e.code === 'KeyS' && e.shiftKey) { e.preventDefault(); resetTimer(); return; }
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > state.size) return;
  const i = state.selected;
  const canEdit = i != null && state.givens[i] === 0;
  if (!canEdit) { setHighlightNumber(n); return; }
  placeNumber(n);
  state.highlightNumber = n;
  repaintHighlightsOnly();
});

/* ------------------------------ Wiring / Init -------------------------- */
/** Cache DOM references. */
function grabDom() {
  difficultySel    = $('#difficulty');
  gridTable        = $('#gridTable');
  keysEl           = $('#keys');
  newGameBtn       = $('#newGame');
  restartBtn       = $('#restartGame');
  hintBtn          = $('#hintBtn');
  notesToggle      = $('#notesToggle');
  eraseBtn         = $('#eraseBtn');
  undoBtn          = $('#undoBtn');
  redoBtn          = $('#redoBtn');
  hintsUsedEl      = $('#hintsUsed');
  mistakesEl       = $('#mistakes');
  livesEl          = $('#lives');
  coachMsg         = $('#coachMsg');
  clearProgressBtn = $('#clearProgress');
  scoreEl          = $('#score');
  challengeLabel   = $('#challengeLabel');
  clockEl2         = $('#clock');
  btnPause         = $('#btn-pause')  || $('#btnPause');
  btnResume        = $('#btn-resume') || $('#btnResume');
  btnStop          = $('#btn-stop')   || $('#btnStop');
  bestTimeEl       = $('#bestTime');
}

/** Attach event listeners (null-guarded). */
function bindEvents() {
  if (gridTable) gridTable.addEventListener('click', onGridClick);
  if (newGameBtn) newGameBtn.addEventListener('click', newGame);
  if (restartBtn) restartBtn.addEventListener('click', restartGameSamePuzzle);
  if (hintBtn) hintBtn.addEventListener('click', hint);
  if (eraseBtn) eraseBtn.addEventListener('click', eraseCell);
  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);

  if (btnPause)  btnPause.addEventListener('click', stopTimer);
  if (btnResume) btnResume.addEventListener('click', resumeTimer);
  if (btnStop)   btnStop.addEventListener('click', resetTimer);

  if (notesToggle) notesToggle.addEventListener('click', () => {
    state.notesMode = !state.notesMode;
    notesToggle.textContent = `Notes: ${state.notesMode ? 'On' : 'Off'}`;
    coach(state.notesMode
      ? '📝 Notes ON: Tap a box, then tap numbers to make tiny helper notes.'
      : '👆 Notes OFF: Tap a box, then tap a number to place it.'
    );
  });

  if (difficultySel) {
    difficultySel.addEventListener('change', () => {
      state.difficulty = difficultySel.value;
      setBoardSizeFromDifficulty(state.difficulty);
      state.puzzleNumber = 1;
      updateBestTimeUI();
      newGame();
    });
  }

  if (clearProgressBtn) clearProgressBtn.addEventListener('click', () => { clearSave(); coach('Save cleared'); });

  document.addEventListener('visibilitychange', () => { if (document.hidden && state.timerId) stopTimer(); });
  window.addEventListener('beforeunload', save);
}

/** Main entry: load/save, build UI, create a puzzle if none loaded. */
function init() {
  grabDom();
  loadBestTimes();
  const had = load();
  setBoardSizeFromDifficulty(state.difficulty);
  updateBestTimeUI();

  // Safety: unexpected size → reset to beginner 4×4
  if (![4, 9].includes(state.size)) {
    state.difficulty = 'beginner';
    setBoardSizeFromDifficulty(state.difficulty);
    clearSave();
    updateBestTimeUI();
  }

  bindEvents();

  if (had) {
    buildGridTable();
    buildKeys();
    writeClocks(fmtTime(state.elapsed));
    syncTimerButtons();
  } else {
    if (difficultySel && difficultySel.value) state.difficulty = difficultySel.value;
    setBoardSizeFromDifficulty(state.difficulty);
    newGame();
  }
}

/* Run once DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
