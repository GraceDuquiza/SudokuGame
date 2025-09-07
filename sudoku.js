/* ==========================================================
    Sudoku Learn — TABLE VERSION (Vanilla JS)

    ✅ What this build includes
    - Stable grid (no shrinking): atomic <colgroup> build + .cell-inner aspect-ratio
    - Build guard + token to prevent race conditions on rapid clicks
    - Notes mode with persistence and undo/redo
    - Hint highlight auto-clears after a valid fill
    - “Highlight same number”:
        • Click a filled cell → all same numbers turn blue
        • Tap a numpad key (with no editable selection) → highlight that digit
        • After placing a number → highlight that number
    - NEW: Numpad counters (remaining digits)
        • Each numpad button shows how many of that digit are still missing
        • Counts drop toward 0; when 0, button fades (but still highlights)
   ========================================================== */


/* ----------------------------------------------------------
    DOM SELECTOR SHORTCUTS
   ---------------------------------------------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);


/* ----------------------------------------------------------
    SMALL HELPERS
   ---------------------------------------------------------- */
function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}
function shuffled(arr) { return arr.slice().sort(() => Math.random() - 0.5); }

// Convert notes {idx:Set} <-> plain object for JSON
function serializeNotes(notesObj) {
  const out = {};
  for (const [k, set] of Object.entries(notesObj)) out[k] = Array.from(set);
  return out;
}
function deserializeNotes(rawObj) {
  const out = {};
  for (const [k, arr] of Object.entries(rawObj || {})) out[k] = new Set(arr);
  return out;
}


/* ----------------------------------------------------------
    GAME STATE (single source of truth)
   ---------------------------------------------------------- */
const state = {
  difficulty: "beginner",
  size: 9,                  // 4 or 9 (set by difficulty)
  boxSize: 3,               // 2 for 4×4, 3 for 9×9

  givens: [],               // immutable clues
  grid: [],                 // current entries (0 = empty)

  // Selection, notes & highlighting
  selected: null,
  notesMode: false,
  notes: {},                // { index: Set(numbers) }
  highlightNumber: null,    // digit to highlight (1..N) or null

  // Timer
  startTime: null, elapsed: 0, timerId: null,

  // Hints & mistakes
  hintsUsed: 0, hintTarget: null, hintValue: null,
  mistakes: 0, mistakeCells: new Set(), gameOver: false,

  // Undo/redo
  undoStack: [], redoStack: [],

  // Scoring
  score: 0, totalScore: 0,

  // Challenge label
  puzzleNumber: 1, totalPuzzles: 20,
};


/* ----------------------------------------------------------
    DOM ELEMENTS
   ---------------------------------------------------------- */
const difficultySel    = $("#difficulty");
const gridTable        = $("#gridTable");
const keysEl           = $("#keys");
const newGameBtn       = $("#newGame");
const restartBtn       = $("#restartGame");
const hintBtn          = $("#hintBtn");
const notesToggle      = $("#notesToggle");
const eraseBtn         = $("#eraseBtn");
const undoBtn          = $("#undoBtn");
const redoBtn          = $("#redoBtn");
const errorCheck       = $("#errorCheck");
const timeEl           = $("#time");
const hintsUsedEl      = $("#hintsUsed");
const mistakesEl       = $("#mistakes");
const livesEl          = $("#lives");
const coachMsg         = $("#coachMsg");
const clearProgressBtn = $("#clearProgress");
const scoreEl          = $("#score");
const challengeLabel   = $("#challengeLabel");

const SAVE_KEY = "sudoku.learn.table.v1";


/* ----------------------------------------------------------
    BUILD GUARDS (avoid overlapping builds)
   ---------------------------------------------------------- */
let isBuilding = false;
let buildToken = 0;


/* ==========================================================
    SAVE / LOAD
   ========================================================== */
function save() {
  const data = {
    difficulty: state.difficulty,
    size: state.size,
    givens: state.givens,
    grid: state.grid,
    notes: serializeNotes(state.notes),
    elapsed: state.elapsed + (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0),
    hintsUsed: state.hintsUsed,
    hintTarget: state.hintTarget,
    mistakes: state.mistakes,
    mistakeCells: Array.from(state.mistakeCells),
    score: state.score,
    totalScore: state.totalScore,
    puzzleNumber: state.puzzleNumber
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    state.difficulty   = d.difficulty || "beginner";
    setBoardSizeFromDifficulty(state.difficulty);
    state.givens       = d.givens;
    state.grid         = d.grid;
    state.notes        = deserializeNotes(d.notes);
    state.elapsed      = d.elapsed;
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

function clearSave() {
  localStorage.removeItem(SAVE_KEY);
  state.score = 0;
  state.totalScore = 0;
  state.puzzleNumber = 1;
  setBoardSizeFromDifficulty(state.difficulty);
  render();
  coach("🗑️ Progress cleared. Starting fresh!");
}


/* ==========================================================
    DIFFICULTY → BOARD SIZE
   ========================================================== */
function setBoardSizeFromDifficulty(diff) {
  if (diff === "beginner") {
    state.size = 4; state.boxSize = 2;
  } else {
    state.size = 9; state.boxSize = 3;
  }
}


/* ==========================================================
    CHALLENGE LABEL
   ========================================================== */
function updateChallengeLabel() {
  const names = {
    beginner: "🌱 Beginner",
    intermediate: "⭐ Intermediate",
    advanced: "🔥 Advanced",
    expert: "🏆 Expert"
  };
  challengeLabel.textContent =
    `${names[state.difficulty]} Challenge — Puzzle ${state.puzzleNumber} of ${state.totalPuzzles}`;
}


/* ==========================================================
    INDEX HELPERS
   ========================================================== */
function rcToIndex(r, c, N) { return r * N + c; }
function rowIndices(i, N)   { const r = Math.floor(i / N); return Array.from({ length: N }, (_, c) => rcToIndex(r, c, N)); }
function colIndices(i, N)   { const c = i % N;            return Array.from({ length: N }, (_, r) => rcToIndex(r, c, N)); }
function boxIndices(i, N, B) {
  const r = Math.floor(i / N), c = i % N;
  const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
  const v = [];
  for (let rr = 0; rr < B; rr++) for (let cc = 0; cc < B; cc++) v.push(rcToIndex(br + rr, bc + cc, N));
  return v;
}


/* ==========================================================
    CANDIDATES
   ========================================================== */
function usedInRow(i, g, N)     { return new Set(rowIndices(i, N).map(j => g[j]).filter(v => v)); }
function usedInCol(i, g, N)     { return new Set(colIndices(i, N).map(j => g[j]).filter(v => v)); }
function usedInBox(i, g, N, B)  { return new Set(boxIndices(i, N, B).map(j => g[j]).filter(v => v)); }
function candidatesFor(i, g, N, B) {
  if (g[i] !== 0) return [];
  const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
  return [...Array(N).keys()].map(x => x + 1).filter(v => !used.has(v));
}


/* ==========================================================
    PUZZLE GENERATION
   ========================================================== */
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
function hasUniqueSolution(p, N, B) { return solveBacktracking(p, N, B, true).solutionsCount === 1; }
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
    - Build entire table HTML once (with <colgroup>)
    - Each <td> has a .cell-inner that keeps squares via aspect-ratio
   ========================================================== */
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

function buildGridTable() {
  if (isBuilding) return;
  isBuilding = true;
  const token = ++buildToken;

  const N = state.size, B = state.boxSize;

  // Slightly smaller board for 4×4
  gridTable.style.maxWidth = (N === 4) ? "360px" : "500px";

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
function toggleNote(i, n) {
  if (!state.notes[i]) state.notes[i] = new Set();
  const s = state.notes[i];
  if (s.has(n)) s.delete(n); else s.add(n);
  if (s.size === 0) delete state.notes[i]; // keep object sparse
}

function buildNotesHTML(N, notesSet) {
  const isSmall = (N === 4);        // 4×4 → 2×2 notes
  const slots   = isSmall ? 4 : 9;
  let html = `<div class="notes ${isSmall ? 'small' : ''}">`;
  for (let v = 1; v <= slots; v++) {
    html += `<div class="note">${notesSet.has(v) ? v : ""}</div>`;
  }
  html += `</div>`;
  return html;
}


/* ==========================================================
    RENDER (writes numbers & state classes only)
    - Adds .sameNumber to all cells equal to state.highlightNumber
    - Clears hint highlight if that cell gets filled
    - NEW: updates numpad counts & “exhausted” style
   ========================================================== */
function render() {
  if (state.hintTarget != null && state.grid[state.hintTarget] !== 0) {
    state.hintTarget = null;
    state.hintValue = null;
  }

  const N = state.size;

  $$("#gridTable td.cell").forEach(td => {
    const i   = +td.dataset.idx;
    const val = state.grid[i];
    const given = state.givens[i] !== 0;

    td.className = "cell";
    const c = i % N, r = Math.floor(i / N);
    if ((c + 1) % state.boxSize === 0 && c !== N - 1) td.classList.add("box-right");
    if ((r + 1) % state.boxSize === 0 && r !== N - 1) td.classList.add("box-bottom");

    if (given) td.classList.add("prefilled");
    if (state.selected === i) td.classList.add("selected");
    if (state.mistakeCells.has(i)) td.classList.add("mistakeNumber");
    if (state.hintTarget === i) td.classList.add("hint-highlight");

    // Highlight all same numbers
    if (state.highlightNumber != null && val === state.highlightNumber) {
      td.classList.add("sameNumber");
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
        inner.textContent = "";
      }
    }
  });

  // Counters & UI bits
  updateNumpadCounts();         // NEW
  updateNumpadActiveStyle();    // NEW

  hintsUsedEl.textContent = state.hintsUsed;
  mistakesEl.textContent  = state.mistakes;
  scoreEl.textContent     = `${state.score} (Total: ${state.totalScore})`;

  updateChallengeLabel();
  updateLives();
}


/* ==========================================================
    HIGHLIGHT CONTROL
   ========================================================== */
function setHighlightNumber(num) {
  state.highlightNumber = (state.highlightNumber === num ? null : num);
  render();
}

function updateNumpadActiveStyle() { // NEW: tint active numpad button
  $$("#keys button").forEach(btn => {
    const n = +btn.dataset.value;
    btn.classList.toggle("active", n === state.highlightNumber);
  });
}


/* ==========================================================
    NUMPAD COUNTS (NEW)
    - In a completed NxN Sudoku, each digit 1..N appears exactly N times.
    - “Remaining” = N minus how many are already on the board (givens + entries).
   ========================================================== */
function remainingByDigit() { // NEW: returns array [0..N] where idx v = remaining for digit v
  const N = state.size;
  const left = Array(N + 1).fill(N); // 1..N are seeded with N
  for (const v of state.grid) if (v) left[v]--;
  // Clamp to 0 in case of temporary overfills
  for (let v = 1; v <= N; v++) left[v] = Math.max(0, left[v]);
  return left;
}

function updateNumpadCounts() { // NEW: write counts under each numpad digit
  const N = state.size;
  const left = remainingByDigit();
  // keep layout rule in sync
  keysEl.dataset.n = String(N);

  for (let v = 1; v <= N; v++) {
    const btn = keysEl.querySelector(`button[data-value="${v}"]`);
    if (!btn) continue;
    const remainEl = btn.querySelector(".remain");
    if (remainEl) remainEl.textContent = left[v];

    // Visually “exhaust” when none left (still tappable for highlight)
    btn.classList.toggle("exhausted", left[v] === 0);
  }
}


/* ==========================================================
    INPUT & GAMEPLAY
   ========================================================== */

// Single delegated listener for all cells
gridTable.addEventListener("click", (e) => {
  const td = e.target.closest("td.cell");
  if (!td || !gridTable.contains(td)) return;
  selectCell(+td.dataset.idx);
});

function selectCell(i) {
  if (state.gameOver) return;
  state.selected = i;

  // Clicking a filled cell highlights that number everywhere
  const v = state.grid[i];
  if (v) state.highlightNumber = (state.highlightNumber === v ? null : v); // toggle if same
  render();
}

function pushUndo() {
  state.undoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber
  });
  state.redoStack = [];
}

function undo() {
  if (!state.undoStack.length) return coach("↩️ Nothing to undo!");
  const s = state.undoStack.pop();
  state.redoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber
  });
  state.grid = s.grid;
  state.notes = deserializeNotes(s.notes);
  state.selected = s.selected;
  state.score = s.score;
  state.highlightNumber = s.highlightNumber ?? null;
  render(); save(); coach("↩️ Undid your last move.");
}

function redo() {
  if (!state.redoStack.length) return coach("↪️ Nothing to redo!");
  const s = state.redoStack.pop();
  state.undoStack.push({
    grid: state.grid.slice(),
    notes: serializeNotes(state.notes),
    selected: state.selected,
    score: state.score,
    highlightNumber: state.highlightNumber
  });
  state.grid = s.grid;
  state.notes = deserializeNotes(s.notes);
  state.selected = s.selected;
  state.score = s.score;
  state.highlightNumber = s.highlightNumber ?? null;
  render(); save(); coach("↪️ Redid your move.");
}

/**
 * Place a number OR toggle a note (if Notes mode is ON).
 * - Notes ON  → toggle pencil-mark
 * - Notes OFF → commit value with validation & scoring
 * Guard: if a digit is exhausted (0 left) and we’re not replacing the same digit,
 *        block the placement but still allow highlighting.
 */
function placeNumber(num) {
  if (state.gameOver || state.selected == null) return;

  const selected = state.selected;
  const canEdit = state.givens[selected] === 0;

  // If we cannot edit the cell, treat as highlight tap
  if (!canEdit) {
    setHighlightNumber(num);
    return;
  }

  // Notes mode: toggle a pencil-mark instead of a final value
  if (state.notesMode) {
    pushUndo();
    toggleNote(selected, num);
    state.highlightNumber = num; // follow the digit with highlight
    render(); save();
    return;
  }

  // Guard against overfilling this digit
  const left = remainingByDigit();
  const current = state.grid[selected];
  if (left[num] === 0 && current !== num) {
    state.highlightNumber = num; // still allow highlight
    render();
    coach(`All ${num}’s are already placed.`);
    return;
  }

  // Normal mode: commit a value
  pushUndo();
  state.grid[selected] = num;

  if (!isPlacementValid(selected)) {
    state.mistakes++;
    state.mistakeCells.add(selected);
    state.score = Math.max(0, state.score - 5);
    if (state.mistakes >= 5) return gameOver();
    coach("❌ Oops! That number doesn’t fit.");
  } else {
    state.mistakeCells.delete(selected);
    state.score += 10;
    coach("✅ Nice choice!");

    // Clear notes in this cell after final entry
    delete state.notes[selected];

    // Clear hint highlight if we filled the hinted cell
    if (state.hintTarget === selected) {
      state.hintTarget = null;
      state.hintValue = null;
    }
  }

  // Follow the entered number with highlight
  state.highlightNumber = num;

  render();
  save();
  checkWin();
}

function eraseCell() {
  if (state.gameOver || state.selected == null) return;
  if (state.givens[state.selected] !== 0) return; // don't erase givens
  pushUndo();
  state.grid[state.selected] = 0;
  delete state.notes[state.selected];
  state.mistakeCells.delete(state.selected);
  render(); save(); coach("🧽 Cleared that box.");
}

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
function findNakedSingle(g, N, B) {
  for (let i = 0; i < g.length; i++) {
    if (g[i] === 0) {
      const c = candidatesFor(i, g, N, B);
      if (c.length === 1) return { idx: i, value: c[0] };
    }
  }
  return null;
}

function hint() {
  if (state.gameOver) return;
  if (state.hintsUsed >= 5) return coach("⚠️ No more hints!");

  const move = findNakedSingle(state.grid, state.size, state.boxSize);
  if (!move) return coach("🤔 No easy hints right now.");

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
function gameOver() {
  stopTimer(); state.gameOver = true; coach("💀 Game Over! Out of hearts.");
  const o = document.createElement("div");
  o.className = "game-over";
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
  $("#restartAfter").addEventListener("click", () => { document.body.removeChild(o); state.score = 0; newGame(); });
  $("#quitGame").addEventListener("click", () => {
    document.body.removeChild(o);
    state.score = 0; state.totalScore = 0; clearSave();
    coach("👋 Thanks for playing! Start a new game when ready.");
  });
}

function checkWin() {
  if (state.grid.every(v => v !== 0) && isValidSudoku(state.grid, state.size, state.boxSize)) {
    stopTimer();
    state.score += 100;
    state.totalScore += state.score;

    const winOverlay = document.createElement("div");
    winOverlay.className = "game-over";
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

    $("#nextChallenge").addEventListener("click", () => {
      document.body.removeChild(winOverlay);
      state.score = 0;
      state.puzzleNumber++;
      newGame();
    });
    $("#quitGame").addEventListener("click", () => {
      document.body.removeChild(winOverlay);
      state.score = 0; state.totalScore = 0; clearSave();
      coach("👋 Thanks for playing! Start a new game when ready.");
    });

    render(); save();
  }
}

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
    TIMER
   ========================================================== */
function startTimer() {
  stopTimer();
  state.startTime = Date.now();
  state.timerId = setInterval(() => {
    timeEl.textContent = fmtTime(state.elapsed + Math.floor((Date.now() - state.startTime) / 1000));
  }, 1000);
}
function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.elapsed += Math.floor((Date.now() - state.startTime) / 1000);
    state.startTime = null;
    state.timerId = null;
  }
}
function coach(msg) { coachMsg.textContent = msg; }


/* ==========================================================
    LIVES
   ========================================================== */
function updateLives() {
  const totalLives = 5;
  const remaining = Math.max(0, totalLives - state.mistakes);
  livesEl.textContent = "❤".repeat(remaining) + "♡".repeat(totalLives - remaining);
}


/* ==========================================================
    NEW PUZZLE (stable & guarded)
   ========================================================== */
function newGame() {
  if (isBuilding) return;   // ignore spam clicks during build
  stopTimer();

  // Reset puzzle-specific fields (keep totalScore)
  Object.assign(state, {
    hintsUsed: 0, hintTarget: null, hintValue: null,
    mistakes: 0, mistakeCells: new Set(),
    gameOver: false, elapsed: 0,
    undoStack: [], redoStack: [],
    score: 0,
    notes: {},                 // clear notes on new puzzle
    highlightNumber: null      // clear highlight on new puzzle
  });

  setBoardSizeFromDifficulty(state.difficulty);

  const { puzzle } = generatePuzzle(state.size, state.boxSize);
  state.givens = puzzle.slice();
  state.grid   = puzzle.slice();

  if (newGameBtn) newGameBtn.disabled = true;

  buildGridTable(); // render is called inside after layout settles
  buildKeys();      // builds 1..N buttons and counters

  timeEl.textContent = "00:00";
  startTimer();
  save();

  setTimeout(() => { if (newGameBtn) newGameBtn.disabled = false; }, 300);
}


/* ==========================================================
    RESTART SAME PUZZLE
   ========================================================== */
function restartGameSamePuzzle() {
  if (isBuilding) return;
  stopTimer();
  Object.assign(state, {
    grid: state.givens.slice(),
    mistakes: 0, mistakeCells: new Set(),
    hintsUsed: 0, hintTarget: null, hintValue: null,
    gameOver: false, elapsed: 0,
    undoStack: [], redoStack: [],
    score: 0,
    notes: {},                 // clear notes on restart
    highlightNumber: null
  });
  buildGridTable();
  buildKeys();
  timeEl.textContent = "00:00";
  startTimer();
  save();
}


/* ==========================================================
    NUMPAD (1..N) — counters + interactions
   ========================================================== */
function buildKeys() {
  keysEl.innerHTML = "";
  const N = state.size;
  keysEl.dataset.n = String(N); // for CSS layout

  for (let v = 1; v <= N; v++) {
    const b = document.createElement("button");

    // NEW: structure = big digit + small remaining count
    b.innerHTML = `
      <div class="digit">${v}</div>
      <div class="remain">0</div>
    `;
    b.dataset.value = String(v);

    // Click behavior:
    // - If we can edit a selected cell → place/notes with guards
    // - Else → just (toggle) highlight this digit
    b.addEventListener("click", () => {
      const selected = state.selected;
      const canEdit = selected != null && state.givens[selected] === 0;

      if (!canEdit) {
        setHighlightNumber(v);
        return;
      }
      placeNumber(v);
      state.highlightNumber = v;
      render();
    });

    keysEl.appendChild(b);
  }

  updateNumpadCounts();      // seed counts right away
  updateNumpadActiveStyle(); // seed highlight style
}


/* ==========================================================
    KEYBOARD SUPPORT (optional but handy)
   ========================================================== */
document.addEventListener("keydown", (e) => {
  const n = Number(e.key);
  if (!Number.isInteger(n)) return;
  if (n < 1 || n > state.size) return;

  const selected = state.selected;
  const canEdit = selected != null && state.givens[selected] === 0;

  if (!canEdit) {
    setHighlightNumber(n);     // highlight only
    return;
  }

  placeNumber(n);              // commit or note
  state.highlightNumber = n;   // follow the number
  render();
});


/* ==========================================================
    EVENTS + INIT
   ========================================================== */
newGameBtn.addEventListener("click", newGame);
restartBtn.addEventListener("click", restartGameSamePuzzle);
hintBtn.addEventListener("click", hint);
eraseBtn.addEventListener("click", eraseCell);
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

notesToggle.addEventListener("click", () => {
  state.notesMode = !state.notesMode;
  notesToggle.textContent = `Notes: ${state.notesMode ? "On" : "Off"}`;
  coach(state.notesMode
    ? "📝 Notes ON: Tap a box, then tap numbers to make tiny helper notes."
    : "👆 Notes OFF: Tap a box, then tap a number to place it."
  );
});

errorCheck.addEventListener("change", () => {
  state.showMistakes = errorCheck.checked;
  render();
});

difficultySel.addEventListener("change", () => {
  state.difficulty = difficultySel.value;
  setBoardSizeFromDifficulty(state.difficulty);
  state.puzzleNumber = 1;
  newGame();
});

clearProgressBtn.addEventListener("click", () => {
  clearSave();
  coach("Save cleared");
});


/* ==========================================================
    INIT
   ========================================================== */
function init() {
  const had = load();
  setBoardSizeFromDifficulty(state.difficulty);

  // Safety: if saved size is weird, reset to beginner
  if (![4, 9].includes(state.size)) {
    console.warn("⚠️ Invalid board size detected:", state.size, "→ Resetting to 4");
    state.difficulty = "beginner";
    setBoardSizeFromDifficulty(state.difficulty);
    clearSave();
  }

  if (had) {
    buildGridTable();
    buildKeys();
    startTimer();
  } else {
    state.difficulty = difficultySel.value;
    setBoardSizeFromDifficulty(state.difficulty);
    newGame();
  }
}
init();
