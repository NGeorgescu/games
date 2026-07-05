# games

Small browser games, each a self-contained static page served via GitHub Pages.

**Live:** https://ngeorgescu.github.io/games/

## Contents

| Game | Play | Source |
|------|------|--------|
| **Hue Sense** — named-color quiz (Place · drill/lightning · Fine modes) | [play →](https://ngeorgescu.github.io/games/colors/) | [`colors/`](colors/) |
| **Grid Memory** — memorize a shuffled 5×5 grid of 1–25, then replace them | [play →](https://ngeorgescu.github.io/games/grid/) | [`grid/`](grid/) |
| **Mental Math** — learn &amp; drill mental-arithmetic tricks (×11, squaring, cube/fifth roots, hex→decimal, memorizing π to the Feynman point, …) | [play →](https://ngeorgescu.github.io/games/math/) | [`math/`](math/) |
| **COMBO** — Commander Off-Meta Brewing Optimizer; enter a Magic commander + colors, get every research link pre-filled into a checklist | [play →](https://ngeorgescu.github.io/games/commander/) | [`commander/`](commander/) |
| **Qubic** — 3-D tic-tac-toe on a 4×4×4 cube; four in a row across a layer, up the stack, or any diagonal. One page that flips between a flat 3/4 view and a [rotatable WebGL cube](https://ngeorgescu.github.io/games/qubic/?view=3d). vs-computer or 2-player | [play →](https://ngeorgescu.github.io/games/qubic/) | [`qubic/`](qubic/) |
| **Mastermind** — crack the hidden 4-peg, 6-color code from black/white feedback, or watch a built-in Knuth minimax solver crack any code in ≤5 guesses (opening 1122); includes a hint button | [play →](https://ngeorgescu.github.io/games/mastermind/) | [`mastermind/`](mastermind/) |
| **Fifteen** — take turns claiming numbers 1–9; first to hold three that sum to 15 wins. Secretly tic-tac-toe on the Lo Shu magic square (the eight 15-summing triples are its eight lines) — with a reveal toggle that maps your picks onto the 3×3 grid. Perfect-play minimax opponent (never loses) or an easy mode. Aka Number Scrabble / Pick15 | [play →](https://ngeorgescu.github.io/games/fifteen/) | [`fifteen/`](fifteen/) |
| **Chess repertoire explorer** | [play →](https://ngeorgescu.github.io/games/chess/repertoire.html) | [`chess/`](chess/) |
| **Trap or Tactic?** — a move played in a real Lichess game: did it lose to a tactic, or is it a strong-looking-risky move? Puzzles pulled live from the Lichess API (`/api/puzzle/next`, CC0), five relative difficulty levels, with an offline fallback set | [play →](https://ngeorgescu.github.io/games/blunders/) | [`blunders/`](blunders/) |

## Adding a game

Drop a folder containing an entry page (e.g. `mygame/index.html`), then add a row to the
table above and a tile to [`index.html`](index.html). Pages serves it at
`ngeorgescu.github.io/games/mygame/`.
