# DiffStudio — Inspect. Understand. Repair.

A free, browser-based code analyzer and fix studio inspired by VS Code. Paste, type, or upload
source code; get token-level diagnostics, corrected code, modernized variants, and local
transformations — all with **zero servers, zero accounts, zero tracking**.

## Features
- Layered editor with real-time syntax highlighting (C++, Python, JavaScript, Java; TS via JS rules)
- Auto language detection, line numbers, Tab/Shift+Tab, smart Enter indent, word-wrap toggle
- Heuristic rule engine with token-level wavy underlines and clickable diagnostics
- Three solution modes: **Corrected Code**, **Improved / Modern**, **Custom Prompt**
- Upload / drag-drop / demo / clear, copy to clipboard, file export
- 100% local processing — works offline after the three files load

## Run locally
1. Save `index.html`, `style.css`, `script.js` in one folder.
2. Open `index.html` directly in any modern browser — or serve the folder:
   `python3 -m http.server 8000` → http://localhost:8000

## Deploy to GitHub Pages (free)
1. Create a new public GitHub repository (e.g. `diffstudio`).
2. Upload the three files to the `main` branch (root or any subfolder — all paths are relative).
3. Repo → **Settings → Pages → Source: Deploy from a branch → `main` / root** → Save.
4. After ~1 minute your app is live at `https://<user>.github.io/<repo>/`.
   It also works from any sub-path because no absolute URLs are used.
GitHub Pages itself is subject to GitHub's terms/account, but DiffStudio requires no paid
hosting, no API keys, and no backend.

## Supported transformations
| Mode | Language | Transformations |
|---|---|---|
| Corrected | C++ | `cout >>`→`<<`, `cin <<`→`>>`, missing `;` on clear statements |
| Corrected | Python | missing `:` on block headers, `print "x"`→`print("x")`, `true/false`→`True/False`, `null`→`None`, `x.length`→`len(x)` |
| Corrected | JS | `==`/`!=`→`===`/`!==` (except `== null`), `var`→`const`/`let` |
| Corrected | Java | missing `;` on clear statements |
| All | — | unmatched `()[]{}` and assignment-in-condition are **reported**, never silently rewritten |
| Improved | C++ | `endl`→`'\n'` · Python: py2 print + f-strings · JS: `const`/`let` · all: trailing whitespace/newline |
| Custom | — | for→while, while→for, modernize JS vars, replace endl, wrap `JSON.parse` in try/catch, format indentation, explain code, help |

## Known limitations
- This is a heuristic static analyzer, **not a compiler**; clean results are not guarantees.
- Multiline/complex statements can escape the semicolon heuristic; ambiguous fixes are left unchanged and explained.
- for→while requires a single-line header and brace body; TypeScript uses JavaScript rules.
- Python re-indentation is intentionally disabled (indentation is semantic).
- Very large files (>150 KB) drop token coloring; >400 KB skip rule analysis, with a status notice.

## Privacy
Your code never leaves the browser. No analytics, no ads, no limits. Free to use and modify.