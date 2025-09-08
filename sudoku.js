'use strict';

/* ==========================================================
  Sudoku Learn — TABLE VERSION (Vanilla JS)

  Included:
  - Stable table grid + aspect-ratio squares
  - Build guard (prevents overlapping renders)
  - Notes with persistence + undo/redo
  - Smart hint highlight that clears itself appropriately
  - “Highlight same number” (tap filled cell or numpad digit)
  - Numpad counters (remaining digits; dims at 0)
  - ⏱️ Timer (in this file): Pause / Resume / Stop, saved time  // ✅ NEW
  - 🏅 Personal Best (PB) per difficulty (in Status card)        // ✅ NEW
========================================================== */


/* ----------------------------------------------------------
  DOM SELECTOR SHORTCUTS
  - Tiny helpers to shorten querySelector usage across the file.
---------------------------------------------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);


/* ----------------------------------------------------------
  SMALL HELPERS
---------------------------------------------------------- */
/**
 * Format a number of seconds into "mm:ss" (or "hh:mm:ss" if ≥ 1h).
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
 * Return a shallowly shuffled copy of an array.
 */
function shuffled(arr) { return arr.slice().sort(() => Math.random() - 0.5); }

/**
 * Serialize notes object {index: Set} → plain JSON-able object.
 */
function serializeNotes(notesObj) {
  const out = {};
  for (const [k, set] of Object.entries(notesObj)) out[k] = Array.from(set);
  return out;
}

/**
 * Deserialize notes plain object → {index: Set}.
 */
function deserializeNotes(rawObj) {
  const out = {};
  for (const [k, arr] of Object.entries(rawObj || {})) out[k] = new Set(arr);
  return out;
}


/* ----------------------------------------------------------
  GAME STATE (single source of truth)
---------------------------------------------------------- */
const state = {
  difficulty: 'beginner',
  size: 9,                 // 4 or 9 (set by difficulty)
  boxSize: 3,              // 2 for 4×4, 3 for 9×9

  // Grid
  givens: [],              // immutable clues (the puzzle definition)
  grid: [],                // current entries (0 = empty)

  // Selection, notes & highlighting
  selected: null,
  notesMode: false,
  notes: {},               // { index: Set(numbers) }
  highlightNumber: null,   // digit to highlight (1..N) or null

  // ⏱️ Timer (managed here)
  startTime: null,         // ms when current run started (null when paused)
  elapsed: 0,              // committed seconds across pauses
  timerId: null,           // setInterval handle (truthy = running)

  // Hints & mistakes
  hintsUsed: 0, hintTarget: null, hintValue: null,
  mistakes: 0, mistakeCells: new Set(), gameOver: false,

  // Undo/redo stacks
  undoStack: [], redoStack: [],

  // Scoring
  score: 0, totalScore: 0,

  // Challenge label
  puzzleNumber: 1, totalPuzzles: 20,
};


/* ----------------------------------------------------------
  DOM ELEMENTS
---------------------------------------------------------- */
const difficultySel    = $('#difficulty');
const gridTable        = $('#gridTable');
const keysEl           = $('#keys');
const newGameBtn       = $('#newGame');
const restartBtn       = $('#restartGame');
const hintBtn          = $('#hintBtn');
const notesToggle      = $('#notesToggle');
const eraseBtn         = $('#eraseBtn');
const undoBtn          = $('#undoBtn');
const redoBtn          = $('#redoBtn');
const errorCheck       = $('#errorCheck');
const hintsUsedEl      = $('#hintsUsed');
const mistakesEl       = $('#mistakes');
const livesEl          = $('#lives');
const coachMsg         = $('#coachMsg');
const clearProgressBtn = $('#clearProgress');
const scoreEl          = $('#score');
const challengeLabel   = $('#challengeLabel');

// ⏱️ Timer controls (supports kebab or camel IDs)           // ✅ NEW
const clockEl2  = $('#clock');                  // Timer controls clock (your visible clock)
const btnPause  = $('#btn-pause')  || $('#btnPause');
const btnResume = $('#btn-resume') || $('#btnResume');
const btnStop   = $('#btn-stop')   || $('#btnStop');

// 🏅 PB UI (Option A: Status card only)                     // ✅ NEW
const bestTimeEl = $('#bestTime');              // <strong id="bestTime">—</strong>

const SAVE_KEY = 'sudoku.learn.table.v1';

// PB storage (seconds per difficulty)                       // ✅ NEW
const BEST_KEY = 'sudoku.bestTimes.v1';
let bestTimes = { beginner: null, intermediate: null, advanced: null, expert: null };


/* ----------------------------------------------------------
  BUILD GUARDS (avoid overlapping builds)
---------------------------------------------------------- */
let isBuilding = false;
let buildToken = 0;


/* ==========================================================
  SAVE / LOAD (game progress)
========================================================== */
/**
 * Save the whole game state snapshot to localStorage.
 * - Timer: persists committed elapsed + current running delta.
 */
function save() {
  const data = {
    difficulty: state.difficulty,
    size: state.size,
    givens: state.givens,
    grid: state.grid,
    notes: serializeNotes(state.notes),

    elapsed:
      state.elapsed +
      (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0),

    hintsUsed: state.hintsUsed,
    hintTarget: state.hintTarget,
    mistakes: state.mistakes,
    mistakeCells: Array.from(state.mistakeCells),
    score: state.score,
    totalScore: state.totalScore,
    puzzleNumber: state.puzzleNumber,
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

/**
 * Load the saved snapshot (if any) from localStorage.
 * - Timer: restores elapsed seconds but does not auto-start ticking.
 */
function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    state.difficulty   = d.difficulty || 'beginner';
    setBoardSizeFromDifficulty(state.difficulty);
    state.givens       = d.givens;
    state.grid         = d.grid;
    state.notes        = deserializeNotes(d.notes);
    state.elapsed      = Number(d.elapsed) || 0; // show saved time (timer starts later)

    state.hintsUsed    = d.hintsUsed;
    state.hintTarget   = d.hintTarget ?? null;
    state.mistakes     = d.mistakes;
    state.mistakeCells = new Set(d.mistakeCells);
    state.score        = d.score || 0;
    state.totalScore   = d.totalScore || 0;
    state.puzzleNumber = d.puzzleNumber || 1;

    difficultySel.value = state.difficulty;
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear save and reset long-lived progress counters.
 */
function clearSave() {
  localStorage.removeItem(SAVE_KEY);
  state.score = 0;
  state.totalScore = 0;
  state.puzzleNumber = 1;
  setBoardSizeFromDifficulty(state.difficulty);
  render();
  coach('🗑️ Progress cleared. Starting fresh!');
}


/* ==========================================================
  PERSONAL BEST (PB) HELPERS                                  // ✅ NEW
========================================================== */
/** Load PBs for all difficulties. */
function loadBestTimes() {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (raw) bestTimes = { ...bestTimes, ...JSON.parse(raw) };
  } catch {}
}
/** Save PBs. */
function saveBestTimes() {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(bestTimes)); } catch {}
}
/** Get PB seconds for a difficulty (or null). */
function getBestSecondsFor(diff) {
  const v = bestTimes[diff];
  return (typeof v === 'number' && v >= 0) ? v : null;
}
/** Set PB if `seconds` beats the current PB; returns true when a new PB is recorded. */
function setPersonalBest(diff, seconds) {
  const cur = getBestSecondsFor(diff);
  if (cur == null || seconds < cur) {
    bestTimes[diff] = seconds;
    saveBestTimes();
    updateBestTimeUI();
    return true;
  }
  return false;
}
/** Paint the PB in the Status card for the *current* difficulty. */
function updateBestTimeUI() {
  if (!bestTimeEl) return;
  const v = getBestSecondsFor(state.difficulty);
  bestTimeEl.textContent = v == null ? '—' : fmtTime(v);
}


/* ==========================================================
  DIFFICULTY → BOARD SIZE
========================================================== */
/**
 * Switch board size and box size when difficulty changes.
 */
function setBoardSizeFromDifficulty(diff) {
  if (diff === 'beginner') {
    state.size = 4; state.boxSize = 2;
  } else {
    state.size = 9; state.boxSize = 3;
  }
}


/* ==========================================================
  CHALLENGE LABEL
========================================================== */
/** Update the top label (difficulty name + puzzle X/Y). */
function updateChallengeLabel() {
  const names = {
    beginner: '🌱 Beginner',
    intermediate: '⭐ Intermediate',
    advanced: '🔥 Advanced',
    expert: '🏆 Expert',
  };
  challengeLabel.textContent =
    `${names[state.difficulty]} Challenge — Puzzle ${state.puzzleNumber} of ${state.totalPuzzles}`;
}


/* ==========================================================
  INDEX HELPERS
========================================================== */
/** Convert row/col → linear index. */
function rcToIndex(r, c, N) { return r * N + c; }
/** All indices in the row of cell index `i`. */
function rowIndices(i, N)   { const r = Math.floor(i / N); return Array.from({ length: N }, (_, c) => rcToIndex(r, c, N)); }
/** All indices in the column (column = i % N). */
function colIndices(i, N)   { const c = i % N;            return Array.from({ length: N }, (_, r) => rcToIndex(r, c, N)); }
/** All indices in the box of cell index `i`. */
function boxIndices(i, N, B) {
  // ✅ FIX: include "cc < B" (prevents crash from old typo)
  const r = Math.floor(i / N), c = i % N;
  const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
  const v = [];
  for (let rr = 0; rr < B; rr++) {
    for (let cc = 0; cc < B; cc++) {
      v.push(rcToIndex(br + rr, bc + cc, N));
    }
  }
  return v;
}


/* ==========================================================
  CANDIDATES
========================================================== */
/** Set of used numbers in the row of index `i`. */
function usedInRow(i, g, N)     { return new Set(rowIndices(i, N).map(j => g[j]).filter(v => v)); }
/** Set of used numbers in the column of index `i`. */
function usedInCol(i, g, N)     { return new Set(colIndices(i, N).map(j => g[j]).filter(v => v)); }
/** Set of used numbers in the box of index `i`. */
function usedInBox(i, g, N, B)  { return new Set(boxIndices(i, N, B).map(j => g[j]).filter(v => v)); }
/** Available candidates for cell index `i` on grid `g`. */
function candidatesFor(i, g, N, B) {
  if (g[i] !== 0) return [];
  const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
  return [...Array(N).keys()].map(x => x + 1).filter(v => !used.has(v));
}


/* ==========================================================
  PUZZLE GENERATION
========================================================== */
/**
 * Backtracking solver; returns {solved, solution, solutionsCount}.
 * - If `limit=true`, it only needs to count up to >1 to prove non-unique.
 */
function solveBacktracking(p, N, B, limit = false) {
  const g = p.slice(); let count = 0;
  function bt() {
    let idx = g.findIndex(x => x === 0);
    if (idx === -1) { count++; return true; }
    for (const v of shuffled(candidatesFor(idx, g, N, B))) {
      g[idx] = v;
      if (bt()) { if (!limit) return true; if (count > 1) return true; }
      g[idx] = 0;
    }
    return false;
  }
  const solved = bt();
  return { solved, solution: solved ? g.slice() : null, solutionsCount: count };
}
/** Test if a puzzle has a unique solution. */
function hasUniqueSolution(p, N, B) { return solveBacktracking(p, N, B, true).solutionsCount === 1; }
/** Generate a fully solved valid grid. */
function generateFullSolution(N, B) {
  const g = Array(N * N).fill(0);
  function fill(i = 0) {
    if (i === N * N) return true;
    for (const v of shuffled([...Array(N).keys()].map(x => x + 1))) {
      const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
      if (!used.has(v)) { g[i] = v; if (fill(i + 1)) return true; g[i] = 0; }
    }
    return false;
  }
  fill(0); return g;
}
/** Carve a puzzle from a solved grid, keeping uniqueness & a minimum clue count. */
function generatePuzzle(N, B) {
  const minClues = (N === 4) ? 6 : 32;
  const sol = generateFullSolution(N, B);
  let puzzle = sol.slice();
  for (const idx of shuffled([...Array(N * N).keys()])) {
    const keep = puzzle[idx]; puzzle[idx] = 0;
    if (!hasUniqueSolution(puzzle, N, B)) puzzle[idx] = keep;
    else if (puzzle.filter(v => v).length <= minClues) break;
  }
  return { puzzle, solution: sol };
}


/* ==========================================================
  GRID BUILDING (Atomic + guarded)
========================================================== */
/** Build the table HTML for an NxN grid with box borders. */
function gridHTML(N, B) {
  let html = '';

  // Lock column count/width
  html += '<colgroup>';
  for (let c = 0; c < N; c++) html += `<col style="width:${100 / N}%">`;
  html += '</colgroup>';

  // Rows & cells
  html += '<tbody>';
  for (let r = 0; r < N; r++) {
    html += '<tr>';
    for (let c = 0; c < N; c++) {
      const i = rcToIndex(r, c, N);
      const boxRight  = ((c + 1) % B === 0 && c !== N - 1) ? ' box-right'  : '';
      const boxBottom = ((r + 1) % B === 0 && r !== N - 1) ? ' box-bottom' : '';
      html += `
        <td class="cell${boxRight}${boxBottom}" data-idx="${i}">
          <div class="cell-inner"
               style="width:100%;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;">
          </div>
        </td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';

  return html;
}

/**
 * Build the grid *atomically* and guard against overlapping builds.
 */
function buildGridTable() {
  if (isBuilding) return;
  isBuilding = true;
  const token = ++buildToken;

  const N = state.size, B = state.boxSize;

  // Slightly smaller board for 4×4
  gridTable.style.maxWidth = (N === 4) ? '360px' : '500px';

  // Build atomically
  gridTable.innerHTML = gridHTML(N, B);
  gridTable.dataset.n = String(N);

  // Let layout settle, then verify and render
  requestAnimationFrame(() => {
    if (token !== buildToken) { isBuilding = false; return; }
    ensureNxN();
    isBuilding = false;
    render();
  });
}

/** Confirm the table is NxN; if not, rebuild it. */
function ensureNxN() {
  const N = state.size;
  const rows = gridTable.querySelectorAll('tbody tr').length;
  const cols = gridTable.querySelectorAll('colgroup col').length;
  if (rows !== N || cols !== N) {
    console.warn('Grid mismatch → rebuilding', { rows, cols, expected: N });
    gridTable.innerHTML = gridHTML(N, state.boxSize);
    gridTable.dataset.n = String(N);
  }
}


/* ==========================================================
  NOTES (pencil-marks)
========================================================== */
/** Toggle a single note value in cell `i`. */
function toggleNote(i, n) {
  if (!state.notes[i]) state.notes[i] = new Set();
  const s = state.notes[i];
  if (s.has(n)) s.delete(n); else s.add(n);
  if (s.size === 0) delete state.notes[i]; // keep object sparse
}

/** Return the 2×2 (4×4 grid) or 3×3 (9×9 grid) small note HTML. */
function buildNotesHTML(N, notesSet) {
  const isSmall = (N === 4);        // 4×4 → 2×2 notes
  const slots   = isSmall ? 4 : 9;
  let html = `<div class="notes ${isSmall ? 'small' : ''}">`;
  for (let v = 1; v <= slots; v++) {
    html += `<div class="note">${notesSet.has(v) ? v : ''}</div>`;
  }
  html += `</div>`;
  return html;
}


/* ==========================================================
  RENDER (writes numbers & state classes only)
========================================================== */
/**
 * Paint the current grid, classes, counts, lives, scores.
 * - Does not rebuild the table; just writes contents & CSS classes.
 */
function render() {
  if (state.hintTarget != null && state.grid[state.hintTarget] !== 0) {
    state.hintTarget = null;
    state.hintValue = null;
  }

  const N = state.size;

  $$('#gridTable td.cell').forEach(td => {
    const i   = +td.dataset.idx;
    const val = state.grid[i];
    const given = state.givens[i] !== 0;

    td.className = 'cell';
    const c = i % N, r = Math.floor(i / N);
    if ((c + 1) % state.boxSize === 0 && c !== N - 1) td.classList.add('box-right');
    if ((r + 1) % state.boxSize === 0 && r !== N - 1) td.classList.add('box-bottom');

    if (given) td.classList.add('prefilled');
    if (state.selected === i) td.classList.add('selected');
    if (state.mistakeCells.has(i)) td.classList.add('mistakeNumber');
    if (state.hintTarget === i) td.classList.add('hint-highlight');

    // Highlight all same numbers
    if (state.highlightNumber != null && val === state.highlightNumber) {
      td.classList.add('sameNumber');
    }

    const inner = td.firstElementChild; // .cell-inner
    if (!inner) return;

    if (val) {
      inner.textContent = val;
    } else {
      const notesSet = state.notes[i];
      if (notesSet && notesSet.size) {
        inner.innerHTML = buildNotesHTML(N, notesSet);
      } else {
        inner.textContent = '';
      }
    }
  });

  // Counters & UI bits
  updateNumpadCounts();
  updateNumpadActiveStyle();

  hintsUsedEl.textContent = state.hintsUsed;
  mistakesEl.textContent  = state.mistakes;
  scoreEl.textContent     = `${state.score} (Total: ${state.totalScore})`;

  updateChallengeLabel();
  updateLives();
}


/* ==========================================================
  HIGHLIGHT CONTROL
========================================================== */
/** Toggle highlighting on a given number. */
function setHighlightNumber(num) {
  state.highlightNumber = (state.highlightNumber === num ? null : num);
  render();
}

/** Tint the currently highlighted digit on the numpad. */
function updateNumpadActiveStyle() {
  $$('#keys button').forEach(btn => {
    const n = +btn.dataset.value;
    btn.classList.toggle('active', n === state.highlightNumber);
  });
}


/* ==========================================================
  NUMPAD COUNTS
========================================================== */
/** Compute remaining count by digit (N of each digit in an NxN sudoku). */
function remainingByDigit() {
  const N = state.size;
  const left = Array(N + 1).fill(N);
  for (const v of state.grid) if (v) left[v]--;
  for (let v = 1; v <= N; v++) left[v] = Math.max(0, left[v]);
  return left;
}

/** Update numpad “Remaining” bubbles & exhaust style. */
function updateNumpadCounts() {
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


/* ==========================================================
  INPUT & GAMEPLAY
========================================================== */
/** Click cell → select (and toggle highlight if it has a value). */
gridTable.addEventListener('click', (e) => {
  const td = e.target.closest('td.cell');
  if (!td || !gridTable.contains(td)) return;
  selectCell(+td.dataset.idx);
});

/** Select a cell by index, update highlight, and rerender. */
function selectCell(i) {
  if (state.gameOver) return;
  state.selected = i;

  const v = state.grid[i];
  if (v) state.highlightNumber = (state.highlightNumber === v ? null : v); // toggle same
  render();
}

/** Push a snapshot to the undo stack (and clear redo). */
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

/** Undo one step, pushing current state to redo. */
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
  render(); save(); coach('↩️ Undid your last move.');
}

/** Redo one step, pushing current state to undo. */
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
  render(); save(); coach('↪️ Redid your move.');
}

/**
 * Place a number OR toggle a note (Notes ON).
 * Guards against overfilling a digit via remaining counters.
 */
function placeNumber(num) {
  if (state.gameOver || state.selected == null) return;

  const selected = state.selected;
  const canEdit = state.givens[selected] === 0;

  if (!canEdit) { setHighlightNumber(num); return; }

  if (state.notesMode) {
    pushUndo();
    toggleNote(selected, num);
    state.highlightNumber = num;
    render(); save();
    return;
  }

  const left = remainingByDigit();
  const current = state.grid[selected];
  if (left[num] === 0 && current !== num) {
    state.highlightNumber = num;
    render();
    coach(`All ${num}’s are already placed.`);
    return;
  }

  pushUndo();
  state.grid[selected] = num;

  if (!isPlacementValid(selected)) {
    state.mistakes++;
    state.mistakeCells.add(selected);
    state.score = Math.max(0, state.score - 5);
    if (state.mistakes >= 5) return gameOver();
    coach('❌ Oops! That number doesn’t fit.');
  } else {
    state.mistakeCells.delete(selected);
    state.score += 10;
    coach('✅ Nice choice!');
    delete state.notes[selected];

    if (state.hintTarget === selected) {
      state.hintTarget = null;
      state.hintValue = null;
    }
  }

  state.highlightNumber = num;

  render();
  save();
  checkWin();
}

/** Erase an editable cell (value + notes). */
function eraseCell() {
  if (state.gameOver || state.selected == null) return;
  if (state.givens[state.selected] !== 0) return;
  pushUndo();
  state.grid[state.selected] = 0;
  delete state.notes[state.selected];
  state.mistakeCells.delete(state.selected);
  render(); save(); coach('🧽 Cleared that box.');
}

/** Validate that the value at index `i` is unique in its row/col/box. */
function isPlacementValid(i) {
  const N = state.size, B = state.boxSize, val = state.grid[i];
  if (val === 0) return true;
  const row = rowIndices(i, N).map(j => state.grid[j]);
  const col = colIndices(i, N).map(j => state.grid[j]);
  const box = boxIndices(i, N, B).map(j => state.grid[j]);
  return row.filter(v => v === val).length === 1 &&
         col.filter(v => v === val).length === 1 &&
         box.filter(v => v === val).length === 1;
}


/* ==========================================================
  HINTS
========================================================== */
/** Find a cell with exactly one candidate (naked single), if any. */
function findNakedSingle(g, N, B) {
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0) {
      const c = candidatesFor(i, g, N, B);
      if (c.length === 1) return { idx: i, value: c[0] };
    }
  }
  return null;
}

/** Show a hint if available; also highlight the hinted cell. */
function hint() {
  if (state.gameOver) return;
  if (state.hintsUsed >= 5) return coach('⚠️ No more hints!');

  const move = findNakedSingle(state.grid, state.size, state.boxSize);
  if (!move) return coach('🤔 No easy hints right now.');

  state.hintsUsed++;
  state.hintTarget = move.idx;
  state.hintValue  = move.value;
  render();
  coach(`💡 Hint ${state.hintsUsed}/5: This box should be ${move.value}.`);
  save();
}


/* ==========================================================
  GAME OVER & WIN
========================================================== */
/** End the game after too many mistakes; pause timer. */
function gameOver() {
  stopTimer();                 // pause timer on Game Over         // ✅ NEW
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
  $('#restartAfter').addEventListener('click', () => { document.body.removeChild(o); state.score = 0; newGame(); });
  $('#quitGame').addEventListener('click', () => {
    document.body.removeChild(o);
    state.score = 0; state.totalScore = 0; clearSave();
    coach('👋 Thanks for playing! Start a new game when ready.');
  });
}

/** Win check; on success, pause timer, score, and record PB. */
function checkWin() {
  if (state.grid.every(v => v !== 0) && isValidSudoku(state.grid, state.size, state.boxSize)) {
    stopTimer();               // pause timer and commit time       // ✅ NEW
    state.score += 100;
    state.totalScore += state.score;

    // 🏅 Record PB on win
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

    $('#nextChallenge').addEventListener('click', () => {
      document.body.removeChild(winOverlay);
      state.score = 0;
      state.puzzleNumber++;
      newGame();
    });
    $('#quitGame').addEventListener('click', () => {
      document.body.removeChild(winOverlay);
      state.score = 0; state.totalScore = 0; clearSave();
      coach('👋 Thanks for playing! Start a new game when ready.');
    });

    render(); save();
  }
}

/** Full-board validity check for rows, cols, boxes. */
function isValidSudoku(g, N, B) {
  const valid = a => new Set(a).size === N;
  for (let r = 0; r < N; r++) if (!valid(rowIndices(rcToIndex(r, 0, N), N).map(i => g[i]))) return false;
  for (let c = 0; c < N; c++) if (!valid(colIndices(c, N).map(i => g[i]))) return false;
  for (let br = 0; br < N; br += B) for (let bc = 0; bc < N; bc += B) {
    const box = [];
    for (let rr = 0; rr < B; rr++) for (let cc = 0; cc < B; cc++) box.push(g[rcToIndex(br + rr, bc + cc, N)]);
    if (!valid(box)) return false;
  }
  return true;
}


/* ==========================================================
  TIMER (all logic lives here)                                   // ✅ NEW
========================================================== */
/** Write the visible clock in the controls area (#clock). */
function writeClocks(text) {
  if (clockEl2) clockEl2.textContent = text;
}
/** Toggle Pause/Resume visibility based on running state. */
function syncTimerButtons() {
  if (!btnPause || !btnResume) return;
  const running = !!state.timerId;
  btnPause.hidden  = !running;
  btnResume.hidden = running;
}
/** Update the displayed time from committed + current run delta. */
function tickClock() {
  const sec = state.elapsed + (state.startTime
    ? Math.floor((Date.now() - state.startTime) / 1000)
    : 0);
  writeClocks(fmtTime(sec));
}
/** Start ticking (fresh from current elapsed; typically after reset/new). */
function startTimer() {
  stopTimer();                         // clear any previous interval & commit time
  state.startTime = Date.now();
  state.timerId = setInterval(tickClock, 1000);
  tickClock();                         // immediate update
  syncTimerButtons();
}
/** Pause (commit time; do not zero). */
function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
    state.elapsed += Math.floor((Date.now() - state.startTime) / 1000);
    state.startTime = null;
    tickClock();                       // show paused time
    save();                            // persist on pause
  }
  syncTimerButtons();
}
/** Resume after a pause. */
function resumeTimer() {
  if (state.timerId) return;
  state.startTime = Date.now();
  state.timerId = setInterval(tickClock, 1000);
  tickClock();
  syncTimerButtons();
}
/** Reset to 00:00 and keep paused. */
function resetTimer() {
  stopTimer();
  state.elapsed = 0;
  writeClocks('00:00');
  save();
  syncTimerButtons();
}

/** Tiny helper to write to the coach panel. */
function coach(msg) { coachMsg.textContent = msg; }


/* ==========================================================
  LIVES
========================================================== */
/** Repaint lives as filled/empty hearts based on mistake count. */
function updateLives() {
  const totalLives = 5;
  const remaining = Math.max(0, totalLives - state.mistakes);
  livesEl.textContent = '❤'.repeat(remaining) + '♡'.repeat(totalLives - remaining);
}


/* ==========================================================
  NEW PUZZLE / RESTART
========================================================== */
/**
 * Create a new puzzle, reset per-puzzle state, zero the timer, and start it.
 */
function newGame() {
  if (isBuilding) return;
  resetTimer(); // zero timer first

  // Reset puzzle-specific fields (keep totalScore)
  Object.assign(state, {
    hintsUsed: 0, hintTarget: null, hintValue: null,
    mistakes: 0, mistakeCells: new Set(),
    gameOver: false, elapsed: 0,
    undoStack: [], redoStack: [],
    score: 0,
    notes: {},                 // clear notes on new puzzle
    highlightNumber: null
  });

  setBoardSizeFromDifficulty(state.difficulty);

  const { puzzle } = generatePuzzle(state.size, state.boxSize);
  state.givens = puzzle.slice();
  state.grid   = puzzle.slice();

  if (newGameBtn) newGameBtn.disabled = true;

  buildGridTable();
  buildKeys();

  startTimer();  // begin ticking                               // ✅ NEW
  save();
  updateBestTimeUI(); // show PB for this difficulty             // ✅ NEW

  setTimeout(() => { if (newGameBtn) newGameBtn.disabled = false; }, 300);
}

/**
 * Restart the current puzzle (same givens), zero the timer, and start it.
 */
function restartGameSamePuzzle() {
  if (isBuilding) return;
  resetTimer();
  Object.assign(state, {
    grid: state.givens.slice(),
    mistakes: 0, mistakeCells: new Set(),
    hintsUsed: 0, hintTarget: null, hintValue: null,
    gameOver: false, elapsed: 0,
    undoStack: [], redoStack: [],
    score: 0,
    notes: {},
    highlightNumber: null
  });
  buildGridTable();
  buildKeys();
  startTimer();
  save();
  updateBestTimeUI(); // show PB again for current difficulty    // ✅ NEW
}


/* ==========================================================
  NUMPAD (1..N) — counters + interactions
========================================================== */
/**
 * Build the numpad for 1..N with a small "remain" counter for each digit.
 * Handles: click to place or (if non-editable) toggle highlight.
 */
function buildKeys() {
  keysEl.innerHTML = '';
  const N = state.size;
  keysEl.dataset.n = String(N);

  for (let v = 1; v <= N; v++) {
    const b = document.createElement('button');

    b.innerHTML = `
      <div class="digit">${v}</div>
      <div class="remain">0</div>
    `;
    b.dataset.value = String(v);

    b.addEventListener('click', () => {
      const selected = state.selected;
      const canEdit = selected != null && state.givens[selected] === 0;

      if (!canEdit) { setHighlightNumber(v); return; }
      placeNumber(v);
      state.highlightNumber = v;
      render();
    });

    keysEl.appendChild(b);
  }

  updateNumpadCounts();
  updateNumpadActiveStyle();
}


/* ==========================================================
  KEYBOARD SUPPORT (digits + timer shortcuts)
========================================================== */
/**
 * Keyboard: 
 * - Space toggles pause/resume
 * - Shift+S resets timer
 * - Digits 1..N place number (or highlight if not editable)
 */
document.addEventListener('keydown', (e) => {
  // Timer shortcuts
  if (e.code === 'Space') {
    e.preventDefault();
    state.timerId ? stopTimer() : resumeTimer();
    return;
  }
  if (e.code === 'KeyS' && e.shiftKey) {
    e.preventDefault();
    resetTimer();
    return;
  }

  // Digits → place/highlight
  const n = Number(e.key);
  if (!Number.isInteger(n)) return;
  if (n < 1 || n > state.size) return;

  const selected = state.selected;
  const canEdit = selected != null && state.givens[selected] === 0;

  if (!canEdit) { setHighlightNumber(n); return; }

  placeNumber(n);
  state.highlightNumber = n;
  render();
});


/* ==========================================================
  EVENTS + INIT
========================================================== */
// Buttons
newGameBtn.addEventListener('click', newGame);
restartBtn.addEventListener('click', restartGameSamePuzzle);
hintBtn.addEventListener('click', hint);
eraseBtn.addEventListener('click', eraseCell);
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// Timer control buttons                                         // ✅ NEW
if (btnPause)  btnPause.addEventListener('click', () => stopTimer());
if (btnResume) btnResume.addEventListener('click', () => resumeTimer());
if (btnStop)   btnStop.addEventListener('click', () => resetTimer());

// Toggles & options
notesToggle.addEventListener('click', () => {
  state.notesMode = !state.notesMode;
  notesToggle.textContent = `Notes: ${state.notesMode ? 'On' : 'Off'}`;
  coach(state.notesMode
    ? '📝 Notes ON: Tap a box, then tap numbers to make tiny helper notes.'
    : '👆 Notes OFF: Tap a box, then tap a number to place it.'
  );
});

errorCheck.addEventListener('change', () => {
  state.showMistakes = errorCheck.checked;
  render();
});

difficultySel.addEventListener('change', () => {
  state.difficulty = difficultySel.value;
  setBoardSizeFromDifficulty(state.difficulty);
  state.puzzleNumber = 1;
  updateBestTimeUI(); // show PB for the new difficulty          // ✅ NEW
  newGame();
});

clearProgressBtn.addEventListener('click', () => {
  clearSave();
  coach('Save cleared');
});

// Auto-pause when tab is hidden                                 // ✅ NEW
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.timerId) stopTimer();
});

// Persist on unload (defensive)
window.addEventListener('beforeunload', save);


/* ==========================================================
  INIT
========================================================== */
/**
 * Entrypoint: load PBs + progress, build board and keys, and paint timer.
 */
function init() {
  loadBestTimes();          // read PBs first                     // ✅ NEW
  const had = load();       // read game progress
  setBoardSizeFromDifficulty(state.difficulty);
  updateBestTimeUI();       // paint PB for current difficulty    // ✅ NEW

  // Safety: if saved size is weird, reset to beginner
  if (![4, 9].includes(state.size)) {
    console.warn('⚠️ Invalid board size detected:', state.size, '→ Resetting to 4');
    state.difficulty = 'beginner';
    setBoardSizeFromDifficulty(state.difficulty);
    clearSave();
    updateBestTimeUI();
  }

  if (had) {
    buildGridTable();
    buildKeys();
    // Show saved time but stay paused; player can Resume
    writeClocks(fmtTime(state.elapsed));
    syncTimerButtons();
  } else {
    state.difficulty = difficultySel.value;
    setBoardSizeFromDifficulty(state.difficulty);
    newGame(); // starts with a fresh timer
  }
}

// Defer-safe init (works with or without <script defer>)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
