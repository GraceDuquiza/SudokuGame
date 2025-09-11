'use strict';

/* ========================================================================
  Sudoku Learn — TABLE VERSION (Vanilla JS)
  - Strict check: only accepts the unique-solution digit.
  - Fast generator/solver (bitmasks + MRV) with time/try budgets per level.
  - Undo/redo, hints, notes, timer, mistakes, personal bests.
  - Hardened localStorage I/O, safe DOM updates, frame-buster protection.
  - Clear docs: every important function has JSDoc above it.
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

/** Max number of hints the player can request per puzzle. */
const MAX_HINTS = 5;
/** If true, only the correct solution digit is accepted in a cell. */
const STRICT_SOLUTION_CHECK = true;

/**
 * Difficulty tuning (9×9 only).
 * - min/maxClues: smaller → harder.
 * - requireSinglesSolvable: true means puzzle should be solvable by singles only.
 * - minSearchNodes: "hardness" measured by how many nodes the backtracker needed.
 * - maxTries / maxGenMs: guardrails so generation stays responsive.
 */
const DIFF_CONFIG = {
  beginner:     { type: '4x4' }, // 4×4 stays simple & fast

  // Human-solvable by singles; moderate search so it’s not trivial
  intermediate: { minClues: 37, maxClues: 44, requireSinglesSolvable: true,
                  minSearchNodes: 80, maxTries: 18, maxGenMs: 300 },

  // Noticeably harder; allow non-singles; moderate budget
  advanced:     { minClues: 28, maxClues: 34, requireSinglesSolvable: false,
                  minSearchNodes: 300, maxTries: 22, maxGenMs: 550 },

  // Ultra-hard expert (desktop-ish budget). For faster mobile expert, tighten maxGenMs.
  expert:       { minClues: 19, maxClues: 22, requireSinglesSolvable: false,
                  minSearchNodes: 1200, maxTries: 36, maxGenMs: 1400 },
};

/* ------------------------------ Tiny query helpers -------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ------------------------------ Small utilities ---------------------- */

/**
 * Return high-resolution time safely (perf.now on modern browsers; Date.now fallback).
 */
const nowMs = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now()
  : Date.now();

/**
 * Format seconds as mm:ss or hh:mm:ss.
 */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
}

/**
 * Return a shallow shuffled copy (uses stable Math.random() sort trick).
 * Fast enough for our small arrays (<= 81).
 */
function shuffled(arr) {
  return arr.slice().sort(() => Math.random() - 0.5);
}

/** Notes <Set> <-> Array helpers for saving to JSON safely. */
function serializeNotes(notesObj) { const out = {}; for (const [k, s] of Object.entries(notesObj)) out[k] = [...s]; return out; }
function deserializeNotes(raw) { const out = {}; for (const [k, a] of Object.entries(raw || {})) out[k] = new Set(a); return out; }

/* ------------------------------ Sanitizers (hardening) ----------------
   Everything read from localStorage is validated/coerced to prevent
   corrupted saves or unintended HTML in template strings.
-----------------------------------------------------------------------*/

/** Coerce to integer or fallback. */
function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Clamp integer to [min, max], or fallback to def. */
function clampInt(v, min, max, def = min) {
  v = toInt(v, def);
  return (v < min || v > max) ? def : v;
}

/** Ensure a grid array has length N*N with values in [0..N]. */
function cleanGridArray(a, N) {
  const len = N * N;
  if (!Array.isArray(a) || a.length !== len) return Array(len).fill(0);
  return a.map(v => clampInt(v, 0, N, 0));
}

/** Ensure notes: indices in [0..N*N-1], digits in [1..N]. */
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

/* ========================= FAST INDEX MAPS & BITMASKS ===================
   Solver/generator hot path uses bitmasks for speed:
   - Each row/col/box keeps a 9-bit mask (or 4-bit for 4×4).
   - 1 means digit is used; 0 means available.
   - FULL_MASK = (1 << N) - 1
   - MRV: pick the empty cell with the fewest candidates.
========================================================================= */

/** Cached per-size maps to avoid recomputing row/col/box lookups. */
let MAPS = null;

/**
 * Build and cache row/col/box maps (and helpers) for size N and box B.
 * @param {number} N - board size (4 or 9)
 * @param {number} B - box size (2 or 3)
 */
function buildIndexMaps(N, B) {
  if (MAPS && MAPS.N === N && MAPS.B === B) return MAPS;
  const ROW_OF = new Int16Array(N * N);
  const COL_OF = new Int16Array(N * N);
  const BOX_OF = new Int16Array(N * N);
  const CELLS_IN_BOX = Array.from({ length: N * N }, () => []);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      ROW_OF[i] = r;
      COL_OF[i] = c;
      const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
      const boxIndex = br + Math.floor(c / B);
      BOX_OF[i] = br + Math.floor(c / B) + (Math.floor(r / B) * B - br);
      // Correct box index: (Math.floor(r/B) * B) + Math.floor(c/B)
      BOX_OF[i] = Math.floor(r / B) * B + Math.floor(c / B);
    }
  }
  // Pre-list indices for each box (handy for some heuristics)
  for (let i = 0; i < N * N; i++) CELLS_IN_BOX[BOX_OF[i]].push(i);

  const FULL_MASK = (1 << N) - 1;
  const bit = (v) => 1 << (v - 1);
  const popcount = (m) => {
    // Hamming weight for at most 9 bits; small and very fast.
    m = m - ((m >>> 1) & 0x55555555);
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    return (((m + (m >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  };
  /** Convert mask to list of digits [1..N]. */
  const maskToDigits = (m) => {
    const out = [];
    for (let v = 1; v <= N; v++) if (m & bit(v)) out.push(v);
    return out;
  };

  MAPS = { N, B, ROW_OF, COL_OF, BOX_OF, CELLS_IN_BOX, FULL_MASK, bit, popcount, maskToDigits };
  return MAPS;
}

/**
 * Compute row/col/box masks for a given grid.
 * @param {number[]} g - flat grid
 * @param {object} M - index maps (buildIndexMaps)
 */
function computeMasks(g, M) {
  const rows = new Int16Array(M.N);
  const cols = new Int16Array(M.N);
  const boxes = new Int16Array(M.N);
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (!v) continue;
    const b = M.bit(v);
    rows[M.ROW_OF[i]] |= b;
    cols[M.COL_OF[i]] |= b;
    boxes[M.BOX_OF[i]] |= b;
  }
  return { rows, cols, boxes };
}

/** Get candidate mask for cell i from masks. 1-bits mean digit allowed. */
function candidateMask(i, masks, M) {
  const used = masks.rows[M.ROW_OF[i]] | masks.cols[M.COL_OF[i]] | masks.boxes[M.BOX_OF[i]];
  return (M.FULL_MASK ^ used);
}

/* =============================== SOLVER =================================
   Bitmask backtracking + MRV for speed. Can run in three modes:
   - Normal solve (return a single solution).
   - Count-only (stop after >1 solution).
   - Metric (count "nodes" explored as a rough difficulty signal).
=========================================================================== */

/**
 * Backtracking solver (bitmask + MRV).
 * @param {number[]} puzzle - flat grid with 0 = empty
 * @param {number} N - size (4 or 9)
 * @param {number} B - box size (2 or 3)
 * @param {object} opts - { countOnly: boolean, wantMetrics: boolean, maxSolutions: number }
 * @returns {{solved:boolean, solution:number[]|null, solutionsCount:number, nodes:number}}
 */
function solveBacktrackingCore(puzzle, N, B, opts = {}) {
  const { countOnly = false, wantMetrics = false, maxSolutions = 2 } = opts;
  const M = buildIndexMaps(N, B);
  const g = puzzle.slice();
  const masks = computeMasks(g, M);
  const empties = [];
  for (let i = 0; i < g.length; i++) if (g[i] === 0) empties.push(i);

  let solutions = 0;
  let nodes = 0;
  let solvedOnce = null;

  // Choose next empty using MRV (fewest candidates)
  function selectMRV() {
    let bestIdx = -1, bestCount = 1e9;
    for (let k = 0; k < empties.length; k++) {
      const i = empties[k];
      if (g[i] !== 0) continue;
      const cm = candidateMask(i, masks, M);
      const cnt = M.popcount(cm);
      if (cnt === 0) return { i, cm, cnt: 0 };
      if (cnt < bestCount) { bestCount = cnt; bestIdx = i; }
      if (bestCount === 1) break;
    }
    const cm = bestIdx >= 0 ? candidateMask(bestIdx, masks, M) : 0;
    return { i: bestIdx, cm, cnt: bestIdx >= 0 ? M.popcount(cm) : 0 };
  }

  function assign(i, v) {
    g[i] = v;
    const b = M.bit(v);
    masks.rows[M.ROW_OF[i]] |= b;
    masks.cols[M.COL_OF[i]] |= b;
    masks.boxes[M.BOX_OF[i]] |= b;
  }
  function unassign(i, v) {
    g[i] = 0;
    const b = M.bit(v);
    masks.rows[M.ROW_OF[i]] &= ~b;
    masks.cols[M.COL_OF[i]] &= ~b;
    masks.boxes[M.BOX_OF[i]] &= ~b;
  }

  function bt() {
    // Completed?
    if (g.every(Boolean)) {
      solutions++;
      if (!countOnly && !solvedOnce) solvedOnce = g.slice();
      return (countOnly && solutions >= maxSolutions) || !countOnly; // early exit
    }

    const pick = selectMRV();
    if (pick.i === -1 || pick.cnt === 0) return false; // dead end

    // Randomize candidate order for variety
    const cand = shuffled(M.maskToDigits(pick.cm));

    for (let k = 0; k < cand.length; k++) {
      const v = cand[k];
      assign(pick.i, v);
      nodes++;
      if (bt()) return true;  // early-exit policy handled above
      unassign(pick.i, v);
    }
    return false;
  }

  bt();

  return {
    solved: solutions > 0,
    solution: solvedOnce,
    solutionsCount: solutions,
    nodes: wantMetrics ? nodes : 0
  };
}

/**
 * Public: Solve one solution (for gameplay / recovery).
 */
function solveBacktracking(p, N, B, countOnly = false) {
  const res = solveBacktrackingCore(p, N, B, { countOnly, wantMetrics: false, maxSolutions: 2 });
  return {
    solved: res.solved,
    solution: res.solution,
    solutionsCount: res.solutionsCount
  };
}

/**
 * Public: Solve and return difficulty metric ("nodes").
 * Higher nodes ≈ harder under this solver.
 */
function solveBacktrackingWithMetrics(p, N, B) {
  const res = solveBacktrackingCore(p, N, B, { countOnly: false, wantMetrics: true, maxSolutions: 1 });
  return { solved: res.solved, nodes: res.nodes, solutionsCount: res.solutionsCount };
}

/** Test if a puzzle has exactly one solution (fast cut-off at 2). */
function hasUniqueSolution(p, N, B) {
  return solveBacktrackingCore(p, N, B, { countOnly: true, wantMetrics: false, maxSolutions: 2 }).solutionsCount === 1;
}

/* ============================== GENERATION ==============================
   - Generate a full valid grid quickly (bitmasks + MRV).
   - Carve clues while preserving uniqueness and respecting difficulty targets.
   - Guard with per-difficulty try/time budgets so UI stays responsive.
=========================================================================== */

/**
 * Construct a random full valid solution grid with bitmask MRV.
 */
function generateFullSolution(N, B) {
  const M = buildIndexMaps(N, B);
  const g = Array(N * N).fill(0);
  const masks = { rows: new Int16Array(N), cols: new Int16Array(N), boxes: new Int16Array(N) };
  const order = shuffled([...Array(N * N).keys()]); // fill order randomized

  function selectMRV() {
    let best = -1, bestCnt = 1e9, bestMask = 0;
    for (let idx = 0; idx < order.length; idx++) {
      const i = order[idx];
      if (g[i] !== 0) continue;
      const cm = candidateMask(i, masks, M);
      const cnt = M.popcount(cm);
      if (cnt === 0) return { i, cm, cnt: 0 };
      if (cnt < bestCnt) { bestCnt = cnt; best = i; bestMask = cm; }
      if (bestCnt === 1) break;
    }
    return { i: best, cm: bestMask, cnt: bestCnt };
  }

  function assign(i, v) {
    g[i] = v;
    const b = M.bit(v);
    masks.rows[M.ROW_OF[i]] |= b;
    masks.cols[M.COL_OF[i]] |= b;
    masks.boxes[M.BOX_OF[i]] |= b;
  }
  function unassign(i, v) {
    g[i] = 0;
    const b = M.bit(v);
    masks.rows[M.ROW_OF[i]] &= ~b;
    masks.cols[M.COL_OF[i]] &= ~b;
    masks.boxes[M.BOX_OF[i]] &= ~b;
  }

  function bt() {
    const pick = selectMRV();
    if (pick.i === -1) return true;      // full
    if (pick.cnt === 0) return false;    // dead

    const cand = shuffled(M.maskToDigits(pick.cm));
    for (let k = 0; k < cand.length; k++) {
      const v = cand[k];
      assign(pick.i, v);
      if (bt()) return true;
      unassign(pick.i, v);
    }
    return false;
  }

  bt();
  return g;
}

/**
 * Remove clues while keeping uniqueness, down to a min-clues threshold.
 * Used for 4×4 beginner and as a generic fallback.
 */
function generatePuzzle(N, B) {
  const minClues = (N === 4) ? 6 : 34;
  const sol = generateFullSolution(N, B);
  const idxs = shuffled([...Array(N * N).keys()]);
  const puzzle = sol.slice();
  let clues = N * N;

  for (let t = 0; t < idxs.length; t++) {
    const idx = idxs[t];
    if (puzzle[idx] === 0) continue;
    const keep = puzzle[idx];
    puzzle[idx] = 0; clues--;
    if (!hasUniqueSolution(puzzle, N, B)) {
      puzzle[idx] = keep; clues++;
    } else if (clues <= minClues) {
      break;
    }
  }
  return { puzzle, solution: sol };
}

/**
 * Generate a 9×9 puzzle tailored to the requested difficulty.
 * Uses try/time budgets so generation remains responsive on slower devices.
 */
function generatePuzzleForDifficulty(diff, N, B) {
  // 4×4 / beginner uses the simple (and fast) generator.
  if (N === 4 || diff === 'beginner') return generatePuzzle(N, B);

  const cfg = DIFF_CONFIG[diff] || DIFF_CONFIG.intermediate;
  const MAX_TRIES = cfg.maxTries ?? 20;
  const deadline  = nowMs() + (cfg.maxGenMs ?? 500);

  let best = null; // track the best candidate when time/tries run out

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (nowMs() > deadline) break;

    // 1) Start from a fresh full solution
    const sol = generateFullSolution(N, B);
    const puzzle = sol.slice();
    let clues = N * N;

    // 2) Carve clues toward minClues, keeping uniqueness
    const order = shuffled([...Array(N * N).keys()]);
    for (const idx of order) {
      if (puzzle[idx] === 0) continue;
      const keep = puzzle[idx];
      puzzle[idx] = 0; clues--;
      if (!hasUniqueSolution(puzzle, N, B)) { puzzle[idx] = keep; clues++; }
      if (clues <= cfg.minClues || nowMs() > deadline) break;
    }

    // 3) Nudge toward <= maxClues (still unique)
    const order2 = shuffled([...Array(N * N).keys()]);
    for (const idx of order2) {
      if (puzzle[idx] === 0) continue;
      const keep = puzzle[idx];
      puzzle[idx] = 0; clues--;
      if (!hasUniqueSolution(puzzle, N, B) || clues < cfg.minClues) { puzzle[idx] = keep; clues++; }
      if (clues <= cfg.maxClues || nowMs() > deadline) break;
    }

    // Reject if out of clue band
    if (clues < cfg.minClues || clues > cfg.maxClues) {
      // keep closest as a fallback
      const mid = (cfg.minClues + cfg.maxClues) >> 1;
      if (!best || Math.abs(clues - mid) < Math.abs(best.clues - mid)) {
        best = { puzzle: puzzle.slice(), solution: sol.slice(), clues, nodes: 0 };
      }
      continue;
    }

    // 4) Quick “human” and “search hardness” checks
    const singles = solveWithSingles(puzzle, N, B);
    const metrics = solveBacktrackingWithMetrics(puzzle, N, B); // counts nodes
    const unique  = hasUniqueSolution(puzzle, N, B);
    if (!unique) continue;

    const okSingles = cfg.requireSinglesSolvable ? singles.solved : !singles.solved;
    const okNodes   = (metrics.nodes || 0) >= (cfg.minSearchNodes || 0);

    if (okSingles && okNodes) {
      return { puzzle, solution: sol };
    }

    // keep a decent fallback
    if (!best || metrics.nodes > (best.nodes || -1)) {
      best = { puzzle: puzzle.slice(), solution: sol.slice(), clues, nodes: metrics.nodes };
    }
  }

  // Fallbacks when we run out of time/tries
  if (best) return { puzzle: best.puzzle, solution: best.solution };
  return generatePuzzle(N, B); // basic unique + minClues
}

/* ------------------------------ Index helpers ------------------------- */
/** Convert row/col to flat index. */
function rcToIndex(r, c, N) { return r * N + c; }
/** Indices in the same row as index i. */
function rowIndices(i, N) { const r = Math.floor(i / N); return Array.from({ length: N }, (_, c) => rcToIndex(r, c, N)); }
/** Indices in the same column as index i. */
function colIndices(i, N) { const c = i % N; return Array.from({ length: N }, (_, r) => rcToIndex(r, c, N)); }
/** Indices in the same box as index i. */
function boxIndices(i, N, B) {
  const r = Math.floor(i / N), c = i % N;
  const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
  const out = [];
  for (let rr = 0; rr < B; rr++) for (let cc = 0; cc < B; cc++) out.push(rcToIndex(br + rr, bc + cc, N));
  return out;
}

/* ------------------------------ Candidates / constraints ---------------
   Note: These simple Set-based helpers are used only for UI-ish tasks
   (notes & hints). The heavy solver/generator uses the fast bitmask engine.
-------------------------------------------------------------------------*/
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

/* ------------------------------ Grid building ------------------------- */
let cells = [];       // <td> elements (one per cell)
let cellInners = [];  // <div class="cell-inner"> inside each td
let lastVal = [];     // cache to avoid re-render
let lastNotesSig = [];

/**
 * Build the HTML for an empty N×N table body with thick box borders.
 */
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

/**
 * Create/refresh the visible table based on current N, B.
 * Uses a build guard to avoid race conditions during rebuilds.
 */

function buildGridTable() {
  if (!gridTable || isBuilding) return;
  isBuilding = true;
  const token = ++buildToken;

  const N = state.size, B = state.boxSize;

  // If you have this util, keep it. (Not CSP-related)
  if (typeof buildIndexMaps === 'function') buildIndexMaps(N, B);

  // ❌ REMOVE this (blocked by CSP): gridTable.style.maxWidth = ...
  // ✅ Let CSS decide width based on data-n
  gridTable.dataset.n = String(N);

  // Rebuild table markup (now without any inline styles; see gridHTML below)
  gridTable.innerHTML = gridHTML(N, B);

  // Cache references
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

function gridHTML(N, B) {
  let html = '<colgroup>';
  // ❌ Do NOT set <col style="width:...%"> — blocked by CSP
  // ✅ Equal columns will be handled by CSS (table-layout: fixed)
  for (let c = 0; c < N; c++) html += '<col>';
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

/**
 * Safety: ensure the table truly matches N×N (covers odd dynamic resizes).
 */
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

/**
 * Toggle a note digit in a cell's Set (creates set on demand).
 */
function toggleNote(i, n) {
  if (!state.notes[i]) state.notes[i] = new Set();
  const s = state.notes[i];
  if (s.has(n)) s.delete(n); else s.add(n);
  if (s.size === 0) delete state.notes[i];
}

/**
 * Build HTML for a 3×3 (or 2×2) mini notes grid.
 */
function buildNotesHTML(N, notesSet) {
  const small = (N === 4);
  const slots = small ? 4 : 9;
  let html = `<div class="notes ${small ? 'small' : ''}">`;
  for (let v = 1; v <= slots; v++) html += `<div class="note">${notesSet.has(v) ? v : ''}</div>`;
  html += `</div>`;
  return html;
}

/* ------------------------------ Rendering -------------------------------- */

/**
 * Paint a single cell from current state (value, notes, highlights).
 * Uses small caches to avoid unnecessary DOM writes.
 */
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

  // If value changed, update text and clear notes render cache
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

/**
 * Paint the entire board and HUD bits.
 */
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

/**
 * Update only same-number highlighting (fast path).
 */
function repaintHighlightsOnly() {
  if (!cells.length) return;
  const total = state.size * state.size;
  for (let i = 0; i < total; i++) {
    const td = cells[i]; const val = state.grid[i];
    td.classList.toggle('sameNumber', state.highlightNumber != null && val === state.highlightNumber);
  }
}

/* ------------------------------ Highlight control ---------------------- */

/** Toggle number highlighting on the board. */
function setHighlightNumber(num) {
  state.highlightNumber = (state.highlightNumber === num ? null : num);
  repaintHighlightsOnly();
  updateNumpadActiveStyle();
}

/* ------------------------------ Numpad counters ------------------------ */

/** Count remaining placements per digit (for the HUD under each button). */
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

/** Update the remaining counts visible on each number key. */
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

/** Visually toggle the active number in the numpad. */
function updateNumpadActiveStyle() {
  if (!keysEl) return;
  $$('#keys button').forEach(btn => {
    const n = +btn.dataset.value;
    btn.classList.toggle('active', n === state.highlightNumber);
  });
}

/* ------------------------------ Input & gameplay ----------------------- */

/**
 * Board click: select cell; clicking a filled cell toggles highlight by its value.
 */
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

/**
 * Push a snapshot onto the undo stack (and clear redo).
 * We keep only the necessary diffable state.
 */
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

/** Undo last action, restoring a saved snapshot. */
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

/**
 * Briefly mark a cell as “good” (green) for visual feedback.
 */
function flashGood(i, ms = 480) {
  state.goodFlash.add(i);
  paintCell(i);
  setTimeout(() => { state.goodFlash.delete(i); paintCell(i); }, ms);
}

/**
 * Local row/col/box validity check for non-strict mode (kept for completeness).
 */
function isPlacementValidLocal(i) {
  const N = state.size, B = state.boxSize, val = state.grid[i];
  if (val === 0) return true;
  const row = rowIndices(i, N).map(j => state.grid[j]);
  const col = colIndices(i, N).map(j => state.grid[j]);
  const box = boxIndices(i, N, B).map(j => state.grid[j]);
  const onlyOnce = a => a.filter(v => v === val).length === 1;
  return onlyOnce(row) && onlyOnce(col) && onlyOnce(box);
}

/**
 * Main placement handler. In strict mode, only the solution digit is accepted.
 * Supports notes-mode toggling and “exhausted digit” UX.
 */
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

  // Avoid placing a digit that's already exhausted (unless we're replacing it)
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

/**
 * Clear the selected editable cell (value + notes).
 */
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

/** Find a naked single: a cell with exactly one candidate. */
function findNakedSingle(g, N, B) {
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0) {
      const c = candidatesFor(i, g, N, B);
      if (c.length === 1) return { idx: i, value: c[0] };
    }
  }
  return null;
}

/** Find a hidden single: the only position in a unit (row/col/box) for a digit. */
function findHiddenSingle(g, N, B) {
  // rows
  for (let r = 0; r < N; r++) {
    const cells = Array.from({ length: N }, (_, c) => rcToIndex(r, c, N));
    const pos = Array(N + 1).fill(null).map(() => []);
    for (const i of cells) if (g[i] === 0) {
      for (const v of candidatesFor(i, g, N, B)) pos[v].push(i);
    }
    for (let v = 1; v <= N; v++) if (pos[v].length === 1) return { idx: pos[v][0], value: v };
  }
  // cols
  for (let c = 0; c < N; c++) {
    const cells = Array.from({ length: N }, (_, r) => rcToIndex(r, c, N));
    const pos = Array(N + 1).fill(null).map(() => []);
    for (const i of cells) if (g[i] === 0) {
      for (const v of candidatesFor(i, g, N, B)) pos[v].push(i);
    }
    for (let v = 1; v <= N; v++) if (pos[v].length === 1) return { idx: pos[v][0], value: v };
  }
  // boxes
  for (let br = 0; br < N; br += B) {
    for (let bc = 0; bc < N; bc += B) {
      const i0 = rcToIndex(br, bc, N);
      const cells = boxIndices(i0, N, B);
      const pos = Array(N + 1).fill(null).map(() => []);
      for (const i of cells) if (g[i] === 0) {
        for (const v of candidatesFor(i, g, N, B)) pos[v].push(i);
      }
      for (let v = 1; v <= N; v++) if (pos[v].length === 1) return { idx: pos[v][0], value: v };
    }
  }
  return null;
}

/**
 * Try to solve using only naked + hidden singles.
 * Used to gate "intermediate must be singles-solvable".
 */
function solveWithSingles(original, N, B) {
  const g = original.slice();
  let steps = 0;
  while (true) {
    let move = findNakedSingle(g, N, B);
    if (!move) move = findHiddenSingle(g, N, B);
    if (!move) break;
    g[move.idx] = move.value;
    steps++;
  }
  return { solved: g.every(v => v !== 0), steps };
}

/**
 * Provide a hint: prefer naked single; else reveal one random empty cell's correct value.
 */
function hint() {
  if (state.gameOver) return;
  if (state.hintsUsed >= MAX_HINTS) return coach('⚠️ No more hints!');

  let move = findNakedSingle(state.grid, state.size, state.boxSize);
  if (!move) {
    const empties = [];
    for (let i = 0; i < state.grid.length; i++) if (state.grid[i] === 0) empties.push(i);
    if (!empties.length) return coach('🤔 No hints needed!');
    const idx = empties[Math.floor(Math.random() * empties.length)];
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

/** Show a game-over overlay and offer restart/quit. */
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

/**
 * If the current grid matches the stored solution exactly, stop the timer,
 * award points, record PB, and show the win overlay with Next/ Quit.
 */
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

/** Write the clock text to the UI safely. */
function writeClocks(text) { if (clockEl2) clockEl2.textContent = text; }

/** Show/hide Pause/Resume buttons depending on timer state. */
function syncTimerButtons() {
  if (!btnPause || !btnResume) return;
  const running = !!state.timerId;
  btnPause.hidden = !running;
  btnResume.hidden = running;
}

/** Update the clock every second while running. */
function tickClock() {
  const sec = state.elapsed + (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0);
  writeClocks(fmtTime(sec));
}

/** Start the game timer. */
function startTimer() { stopTimer(); state.startTime = Date.now(); state.timerId = setInterval(tickClock, 1000); tickClock(); syncTimerButtons(); }

/** Stop/pause the game timer and persist elapsed time. */
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

/** Resume a paused timer. */
function resumeTimer() { if (state.timerId) return; state.startTime = Date.now(); state.timerId = setInterval(tickClock, 1000); tickClock(); syncTimerButtons(); }

/** Fully reset the clock display & counters. */
function resetTimer() { stopTimer(); state.elapsed = 0; writeClocks('00:00'); save(); syncTimerButtons(); }

/** Show a short helpful message (textContent for safety). */
function coach(msg) { if (coachMsg) coachMsg.textContent = msg; }

/* ------------------------------ Lives / hearts ------------------------- */

/** Update the ♥♥♥ UI based on the number of mistakes. */
function updateLives() {
  if (!livesEl) return;
  const totalLives = 5;
  const remaining = Math.max(0, totalLives - state.mistakes);
  livesEl.textContent = '❤'.repeat(remaining) + '♡'.repeat(totalLives - remaining);
}

/* ------------------------------ Save / Load --------------------------- */

/**
 * Persist the current game into localStorage (best-effort).
 */
function save() {
  const data = {
    difficulty: state.difficulty,
    size: state.size,
    givens: state.givens,
    grid: state.grid,
    solution: state.solution, // keep the reference solution
    notes: serializeNotes(state.notes),
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

/**
 * Load save from localStorage (validated); return true if loaded.
 */
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

/** Update board dimensions from difficulty choice. */
function setBoardSizeFromDifficulty(diff) {
  if (diff === 'beginner') { state.size = 4; state.boxSize = 2; }
  else { state.size = 9; state.boxSize = 3; }
}

/* ------------------------------ Challenge label ----------------------- */

/** Update the text that shows current difficulty and puzzle number. */
function updateChallengeLabel() {
  if (!challengeLabel) return;
  const names = { beginner: '🌱 Beginner', intermediate: '⭐ Intermediate', advanced: '🔥 Advanced', expert: '🏆 Expert' };
  challengeLabel.textContent = `${names[state.difficulty] || state.difficulty} — Puzzle ${state.puzzleNumber} of ${state.totalPuzzles}`;
}

/* ------------------------------ New / Restart -------------------------- */

/**
 * Create a fresh puzzle and start the timer.
 * Uses a tiny setTimeout(0) so the UI can paint “Generating…” before work.
 */
function newGame() {
  if (isBuilding) return;

  coach('⏳ Generating puzzle…');
  setTimeout(() => {
    resetTimer();
    Object.assign(state, {
      hintsUsed: 0, hintTarget: null, hintValue: null,
      mistakes: 0, mistakeCells: new Set(), gameOver: false,
      undoStack: [], redoStack: [], score: 0,
      notes: {}, highlightNumber: null, goodFlash: new Set(),
    });

    setBoardSizeFromDifficulty(state.difficulty);

    const { puzzle, solution } =
      generatePuzzleForDifficulty(state.difficulty, state.size, state.boxSize);

    state.givens   = puzzle.slice();
    state.grid     = puzzle.slice();
    state.solution = solution.slice();

    if (newGameBtn) newGameBtn.disabled = true;
    buildGridTable();
    buildKeys();
    startTimer();
    save();
    updateBestTimeUI();
    setTimeout(() => { if (newGameBtn) newGameBtn.disabled = false; }, 300);
    coach('🎲 New puzzle ready!');
  }, 0);
}

/**
 * Restart current puzzle using the same givens/solution (fresh timer & UI).
 */
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

/**
 * Build the 1..N number buttons and wire click handlers.
 */
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

/** Cache DOM references for all UI elements (null-safe). */
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
    notesToggle.setAttribute('aria-pressed', String(state.notesMode));
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

/**
 * Main entry: load/save, build UI, create a puzzle if none loaded.
 * Ensures a valid board size, then either resumes or starts a new game.
 */
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
