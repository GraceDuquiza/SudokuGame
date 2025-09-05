/* ==========================================================
    Sudoku Learn — TABLE VERSION (Vanilla JS)
    ----------------------------------------------------------
    Features:
    ✅ Beginner → 4x4 board (2x2 boxes)
    ✅ Intermediate/Advanced/Expert → 9x9 board (3x3 boxes)
    ✅ Puzzle generator with unique solutions
    ✅ Hints (max 5 per game)
    ✅ Notes mode (tiny helper numbers)
    ✅ Mistakes tracked (5 hearts → Game Over)
    ✅ Undo / Redo (go back and forward in moves)
    ✅ Timer + auto save (progress is saved if reloaded)
    ✅ Scoring system (earn points for correct moves)
    ✅ Challenge Mode (20 puzzles per difficulty)
   ========================================================== */

/* ----------------------------------------------------------
    DOM SELECTOR SHORTCUTS
   ---------------------------------------------------------- */
const $  = (sel) => document.querySelector(sel);   // selects first match
const $$ = (sel) => document.querySelectorAll(sel); // selects all matches

/* ----------------------------------------------------------
    HELPER FUNCTIONS
   ---------------------------------------------------------- */
// Format seconds → "MM:SS"
function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// Shuffle array randomly (used for puzzle generation)
function shuffled(arr) {
  return arr.slice().sort(() => Math.random() - 0.5);
}

/* ----------------------------------------------------------
    GAME STATE (all important variables live here)
   ---------------------------------------------------------- */
const state = {
    difficulty: "beginner",   // beginner, intermediate, advanced, expert
    size: 9, boxSize: 3,      // board + sub-box size (adjusted later)

    givens: [], grid: [],     // puzzle givens + current grid

    selected: null,           // currently selected cell
    notesMode: false,         // notes toggle
    notes: {},                // note numbers inside cells

    startTime: null, elapsed: 0, timerId: null, // timer tracking

    hintsUsed: 0, hintTarget: null,             // hint system
    mistakes: 0, mistakeCells: new Set(),       // mistake tracking
    gameOver: false,

    undoStack: [], redoStack: [], // undo/redo history

    score: 0,        // score for current puzzle
    totalScore: 0,   // running score across puzzles

    puzzleNumber: 1,   // challenge mode (1 to 20)
    totalPuzzles: 20
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

const SAVE_KEY = "sudoku.learn.table.v1"; // key for localStorage

/* ==========================================================
    SAVE & LOAD SYSTEM
    ----------------------------------------------------------
    - save(): stores game state in localStorage
    - load(): restores last saved state
    - clearSave(): deletes saved progress + resets scores
   ========================================================== */
function save() {
    const data = {
        difficulty: state.difficulty,
        size: state.size,
        givens: state.givens,
        grid: state.grid,
        elapsed: state.elapsed + (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0),
        hintsUsed: state.hintsUsed,
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

      // restore settings
      state.difficulty = d.difficulty || "beginner";
      setBoardSizeFromDifficulty(state.difficulty);

      // restore progress
      state.givens = d.givens;
      state.grid = d.grid;
      state.elapsed = d.elapsed;
      state.hintsUsed = d.hintsUsed;
      state.mistakes = d.mistakes;
      state.mistakeCells = new Set(d.mistakeCells);
      state.score = d.score || 0;
      state.totalScore = d.totalScore || 0;
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
    render();               
    coach("🗑️ Progress cleared. Starting fresh!");
}

/* ==========================================================
    DIFFICULTY → BOARD SIZE
    Beginner = 4x4
    Others = 9x9
   ========================================================== */
function setBoardSizeFromDifficulty(diff) {
  if (diff === "beginner") {
      state.size = 4;
      state.boxSize = 2;
  } else {
      state.size = 9;
      state.boxSize = 3;
  }
}

/* ==========================================================
    CHALLENGE LABEL (above the board)
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
    INDEX HELPERS (row/col/box positions)
   ========================================================== */
function rcToIndex(r, c, N) { return r * N + c; }
function rowIndices(i, N) { const r = Math.floor(i / N); return Array.from({ length: N }, (_, c) => rcToIndex(r, c, N)); }
function colIndices(i, N) { const c = i % N; return Array.from({ length: N }, (_, r) => rcToIndex(r, c, N)); }
function boxIndices(i, N, B) {
    const r = Math.floor(i / N), c = i % N;
    const br = Math.floor(r / B) * B, bc = Math.floor(c / B) * B;
    const v = [];
    for (let rr = 0; rr < B; rr++) for (let cc = 0; cc < B; cc++) v.push(rcToIndex(br + rr, bc + cc, N));
    return v;
}

/* ==========================================================
    CANDIDATES (valid numbers for a cell)
   ========================================================== */
function usedInRow(i, g, N) { return new Set(rowIndices(i, N).map(j => g[j]).filter(v => v)); }
function usedInCol(i, g, N) { return new Set(colIndices(i, N).map(j => g[j]).filter(v => v)); }
function usedInBox(i, g, N, B) { return new Set(boxIndices(i, N, B).map(j => g[j]).filter(v => v)); }
function candidatesFor(i, g, N, B) {
    if (g[i] !== 0) return [];
    const used = new Set([...usedInRow(i, g, N), ...usedInCol(i, g, N), ...usedInBox(i, g, N, B)]);
    return [...Array(N).keys()].map(x => x + 1).filter(v => !used.has(v));
}

/* ==========================================================
    PUZZLE GENERATION
   ========================================================== */
// Backtracking solver
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
      } return false;
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
    RENDERING
   ========================================================== */
function buildGridTable() {
  const N = state.size, B = state.boxSize;
  gridTable.innerHTML = ""; const tb = document.createElement("tbody");
  for (let r = 0; r < N; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < N; c++) {
      const i = rcToIndex(r, c, N);
      const td = document.createElement("td"); td.className = "cell"; td.dataset.idx = i;
      if ((c + 1) % B === 0 && c !== N - 1) td.classList.add("box-right");
      if ((r + 1) % B === 0 && r !== N - 1) td.classList.add("box-bottom");
      td.addEventListener("click", () => selectCell(i));
      tr.appendChild(td);
    } tb.appendChild(tr);
  } gridTable.appendChild(tb);
}
function render() {
  const N = state.size;
  $$("#gridTable td.cell").forEach(td => {
    const i = +td.dataset.idx, val = state.grid[i], given = state.givens[i] !== 0;
    td.className = "cell";
    if ((i % N + 1) % state.boxSize === 0 && i % N !== N - 1) td.classList.add("box-right");
    if ((Math.floor(i / N) + 1) % state.boxSize === 0 && Math.floor(i / N) !== N - 1) td.classList.add("box-bottom");
    if (given) td.classList.add("prefilled");
    if (state.selected === i) td.classList.add("selected");
    if (state.mistakeCells.has(i)) td.classList.add("mistakeNumber");
    if (state.hintTarget === i) td.classList.add("hint-highlight");
    td.textContent = val || "";
  });

  hintsUsedEl.textContent = state.hintsUsed;
  mistakesEl.textContent = state.mistakes;
  // Show both current puzzle score + running total
  scoreEl.textContent = `${state.score} (Total: ${state.totalScore})`;
  updateLives();
  updateChallengeLabel(); // keep challenge info fresh
}

/* ==========================================================
    INPUT & GAMEPLAY
   ========================================================== */
function selectCell(i) { if (!state.gameOver) { state.selected = i; render(); } }
function pushUndo() { state.undoStack.push({ grid: state.grid.slice(), selected: state.selected, score: state.score }); 
  state.redoStack = []; }
function undo() { if (!state.undoStack.length) return coach("↩️ Nothing to undo!"); const s = state.undoStack.pop(); 
  state.redoStack.push({ grid: state.grid.slice(), selected: state.selected, score: state.score }); state.grid = s.grid; 
  state.selected = s.selected; state.score = s.score; render(); save(); coach("↩️ Undid your last move."); }
function redo() { if (!state.redoStack.length) return coach("↪️ Nothing to redo!"); const s = state.redoStack.pop(); 
  state.undoStack.push({ grid: state.grid.slice(), selected: state.selected, score: state.score }); state.grid = s.grid; 
  state.selected = s.selected; state.score = s.score; render(); save(); coach("↪️ Redid your move."); }
function placeNumber(num) {
  if (state.gameOver || state.selected == null || state.givens[state.selected] !== 0) return;
  pushUndo(); state.grid[state.selected] = num;
  if (!isPlacementValid(state.selected)) {
    state.mistakes++; state.mistakeCells.add(state.selected); state.score = Math.max(0, state.score - 5);
    if (state.mistakes >= 5) return gameOver();
    coach("❌ Oops! That number doesn’t fit.");
  } else {
    state.mistakeCells.delete(state.selected); state.score += 10; coach("✅ Nice choice!");
  }
  render(); save(); checkWin();
}
function eraseCell() { if (state.gameOver || state.selected == null || state.givens[state.selected] !== 0) return; pushUndo(); 
  state.grid[state.selected] = 0; state.mistakeCells.delete(state.selected); render(); save(); coach("🧽 Cleared that box."); }
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
    state.hintsUsed++; state.hintTarget = move.idx; render();
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
      <h2>💀 GAME OVER</h2>
      <p>Your score: <strong>${state.score}</strong></p>
      <p>Total score: <strong>${state.totalScore}</strong></p>
      <div class="buttons">
        <button id="restartAfter">🔄 Try Again</button>
        <button id="quitGame">Quit</button>
      </div>`;
    document.body.appendChild(o);
    $("#restartAfter").addEventListener("click", () => { document.body.removeChild(o); state.score = 0; newGame(); });
    $("#quitGame").addEventListener("click", () => { document.body.removeChild(o); state.score = 0; state.totalScore = 0; 
      clearSave(); coach("👋 Thanks for playing! Start a new game when ready."); });
}

function checkWin() {
  if (state.grid.every(v => v !== 0) && isValidSudoku(state.grid, state.size, state.boxSize)) {
    stopTimer();
    state.score += 100;             // finishing bonus
    state.totalScore += state.score;

    // 🎉 Overlay
    const winOverlay = document.createElement("div");
    winOverlay.className = "game-over";
    winOverlay.innerHTML = `
      <h2>🎉 You solved it!</h2>
      <p>Score this game: <strong>${state.score}</strong></p>
      <p>Total Score: <strong>${state.totalScore}</strong></p>
      <div style="margin-top:20px;">
        <button id="nextChallenge">Next Challenge</button>
        <button id="quitGame">Quit</button>
      </div>
    `;
    document.body.appendChild(winOverlay);

    $("#nextChallenge").addEventListener("click", () => {
      document.body.removeChild(winOverlay);
      state.score = 0;
      state.puzzleNumber++;
      newGame();
    });
    $("#quitGame").addEventListener("click", () => {
      document.body.removeChild(winOverlay);
      state.score = 0;
      state.totalScore = 0;
      clearSave();
      coach("👋 Thanks for playing! Start a new game when ready.");
    });

    render();
    save();
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
function startTimer() { stopTimer(); state.startTime = Date.now(); 
  state.timerId = setInterval(() => { timeEl.textContent = fmtTime(state.elapsed + Math.floor((Date.now() - state.startTime) / 1000)); }, 1000); }
function stopTimer() { if (state.timerId) { clearInterval(state.timerId); 
  state.elapsed += Math.floor((Date.now() - state.startTime) / 1000); state.startTime = null; state.timerId = null; } }
function coach(msg) { coachMsg.textContent = msg; }

/* ==========================================================
    LIVES
   ========================================================== */
function updateLives() { const totalLives = 5; const remaining = Math.max(0, totalLives - state.mistakes); 
  livesEl.textContent = "❤".repeat(remaining) + "♡".repeat(totalLives - remaining); }

/* ==========================================================
    NEW GAME & RESTART
   ========================================================== */
function newGame() {
  stopTimer();
  Object.assign(state, { hintsUsed: 0, hintTarget: null, mistakes: 0, mistakeCells: new Set(), gameOver: false, elapsed: 0, undoStack: [], redoStack: [], score: 0 });
  setBoardSizeFromDifficulty(state.difficulty);
  const { puzzle } = generatePuzzle(state.size, state.boxSize);
  state.givens = puzzle.slice(); state.grid = puzzle.slice();
  buildGridTable(); buildKeys(); render(); timeEl.textContent = "00:00"; startTimer(); save();
}
function restartGameSamePuzzle() { stopTimer(); Object.assign(state, { grid: state.givens.slice(), mistakes: 0, mistakeCells: new Set(), hintsUsed: 0, hintTarget: null, gameOver: false, elapsed: 0, undoStack: [], redoStack: [], score: 0 }); render(); timeEl.textContent = "00:00"; startTimer(); save(); }

/* ==========================================================
    NUMPAD
   ========================================================== */
function buildKeys() { keysEl.innerHTML = ""; for (let v = 1; v <= state.size; v++) { const b = document.createElement("button"); 
  b.textContent = v; b.addEventListener("click", () => placeNumber(v)); keysEl.appendChild(b); } }

/* ==========================================================
    EVENTS + INIT
   ========================================================== */
newGameBtn.addEventListener("click", newGame);
restartBtn.addEventListener("click", restartGameSamePuzzle);
hintBtn.addEventListener("click", hint);
eraseBtn.addEventListener("click", eraseCell);
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

notesToggle.addEventListener("click", () => { state.notesMode = !state.notesMode; notesToggle.textContent = `Notes: ${state.notesMode ? "On" : "Off"}`; 
  coach(state.notesMode ? "📝 Notes ON: Tap a box, then tap numbers to make tiny helper notes." : "👆 Tap a box, then choose a number. Use Notes if you’re not sure."); });
errorCheck.addEventListener("change", () => { state.showMistakes = errorCheck.checked; render(); });
difficultySel.addEventListener("change", () => { state.difficulty = difficultySel.value; 
  setBoardSizeFromDifficulty(state.difficulty); state.puzzleNumber = 1; newGame(); });
clearProgressBtn.addEventListener("click", () => { clearSave(); coach("Save cleared"); });

function init() { const had = load(); buildGridTable(); buildKeys(); render(); if (had) startTimer(); 
  else { state.difficulty = difficultySel.value; setBoardSizeFromDifficulty(state.difficulty); newGame(); } }
init();
