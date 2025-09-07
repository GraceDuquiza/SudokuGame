# Sudoku Learn (Vanilla JS)

A mobile-friendly Sudoku built with plain HTML/CSS/JS. Stable grid , Notes mode, undo/redo, smart hints, same-number highlight, numpad counting, and a timer.

## Features

- **Stable grid**  
  The board is built in one shot (HTML string with `<colgroup>`), so column widths are fixed and won’t “shrink” on rapid New Puzzle clicks. Each `<td>` contains a `.cell-inner` that enforces a perfect 1:1 square via `aspect-ratio`, keeping cells uniform on all screens.

- **Beginner 4×4 and standard 9×9 boards**  
  Choose 4×4 (with 2×2 boxes) for quick practice or 9×9 (with 3×3 boxes) for the classic challenge. The UI adapts automatically (board size, numpad length, note grid size).

- **Notes mode (pencil-marks) with undo/redo and persistence**  
  Toggle **Notes** to add/remove small candidate numbers in an empty cell. Notes are saved to localStorage, included in undo/redo history, and auto-cleared in a cell when you commit a final number. They reset on New/Restart to avoid stale hints.

- **Smart hints (naked singles), auto-clears after correct fill**  
  Hints look for forced moves (cells with exactly one legal candidate). The suggested cell is highlighted and the message shows the value. Once you place that correct value, the highlight automatically disappears.

- **Same-number highlight (tap a filled cell or a numpad digit)**  
  Click any filled cell (e.g., a **7**) to highlight every **7** on the board in blue great for spotting gaps. Tap the same cell/digit again to toggle the highlight off. You can also tap a numpad key to highlight that digit globally (even without a selected, editable cell).

- **Numpad counters (live “remaining digits”)**  
  Each numpad key shows how many of that digit are still available to place (e.g., “**5** · **3 left**”). Counts update instantly as you fill/erase cells. When a digit is fully used, the key dims but remains tappable for highlight. The numpad stays horizontal and scrolls on narrow phones; it shows **1–4** for 4×4 and **1–9** for 9×9.


## Getting Started
- Open `index.html` directly **or** start a quick server:
  ```bash
  python -m http.server 5500
  # then visit http://localhost:5500


### Tech Used

- **Vanilla JavaScript (ES6+)** — no frameworks, no build step.
- **HTML5 table** with atomic `<colgroup>` build for stable grid sizing.
- **CSS3** with `aspect-ratio` on a `.cell-inner` for perfect square cells.
- **LocalStorage** for save/resume, notes persistence, and session timing.
- **Responsive layout** and mobile-friendly numpad.

---

### Target Users

- **Beginners** who want a gentle 4×4 introduction to Sudoku.  
- **Casual players** who want a fast, clean 9×9 experience on desktop or phone.  
- **Teachers & parents** looking for a simple practice tool (notes + hints).  
- **Speed solvers** who appreciate quick input, undo/redo, and highlighting.

---

### How to Play / Basic Usage

**1) Choose a difficulty**
- **Beginner** → 4×4 board (2×2 boxes)  
- **Intermediate / Advanced / Expert** → 9×9 board (3×3 boxes)

**2) Start a puzzle**
- Click **New Puzzle**. The grid is generated and the **timer** starts.  
- The app **auto-saves** your progress.

**3) Select a cell**
- Click/tap any empty cell to select it (it will highlight).

**4) Enter numbers**
- Use the **numpad** below the board or your **keyboard** (`1–4` or `1–9`).  
- If **Notes** are **OFF**: the number is **placed** in the cell.  
- If **Notes** are **ON**: tapping a number **toggles a small pencil-mark** inside the cell (doesn’t commit the value).

**5) Notes mode (pencil-marks)**
- Toggle **Notes** to switch between candidates and final entries.  
- Notes are **saved**, included in **undo/redo**, and **cleared** when you place a final number in that cell.

**6) Numpad counters (live “remaining” per digit)**
- Each key shows **how many of that digit are still available** to place on the board (e.g., `5 · 3 left`).  
- Counters update instantly as you place/erase numbers.  
- When a digit is fully used, the key **dims** (still tappable for highlight).

**7) Same-number highlight**
- Click any **filled cell** (e.g., a 7) to **highlight all 7s** in blue across the board.  
- Click the **same cell (or numpad digit) again** to toggle the highlight **off**.  
- You can also tap a **numpad digit** (with no editable cell selected) to highlight that digit globally.

**8) Hints**
- Click **Hint** to reveal a **naked single** (a cell that has exactly one legal value).  
- The hint cell gets a **yellow highlight** and the suggested value appears in the coach message.  
- Once you place that value correctly, the hint highlight **auto-clears**.

**9) Erase, Undo, Redo**
- **Erase** clears the selected non-given cell (and its notes).  
- **Undo/Redo** steps include grid changes **and** notes changes.

**10) Error checking (optional)**
- Toggle **Error Check** to visually mark mistakes as you place numbers.

**11) Win & restart**
- When the grid is valid and complete, you’ll see a **Win overlay** with your score and a **Next Challenge** button.  
- **Restart Puzzle** resets the same puzzle; **New Puzzle** generates a fresh one.

---

### Accessibility & Mobile Notes

- The board and numpad are fully **clickable/tappable**.  
- On small phones, the numpad is a **single horizontal rail** that **scrolls** if needed.  
- Numbers in the grid and numpad use the same **Cambria Math** font for visual consistency.


## Author

**Grace Duquiza Olesen** — Aspiring Software Engineer (BSc Computer Science).  
Feel free to open issues or suggestions via the repository.