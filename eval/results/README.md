# Recorded runs

| File | What it is |
|---|---|
| `2026-09-13T23-02-05-095Z.json` | **Not a baseline.** First-ever live run, on Opus 5 with `max_tokens: 1024`. 7 of 20 coding calls were truncated at the cap and silently returned no codes, which is what the low recall numbers reflect. Kept as the record of that bug. |
| `2026-09-13T23-27-52-451Z.json` | **P2 baseline.** Same fixtures, same model, after the cap was raised to 4096 and truncation made fatal. This is the number P2 is measured against. |
| `2026-09-13T23-58-17-508Z.json` | **Baseline, second run.** Identical code and fixtures, ~30 minutes later. Exists to show how much the score moves with no change at all. |

## Run-to-run noise on identical code

| Metric | Run 1 | Run 2 | Swing |
|---|---:|---:|---:|
| Diagnosis recall | 100.0% | 96.2% | 4 pts |
| Procedure recall | 81.8% | 90.9% | 9 pts |
| E/M exact | 75.0% | 70.0% | 5 pts |
| E/M within one level | 80.0% | 80.0% | 0 |
| Linkage accuracy | 80.0% | 80.0% | 0 |
| Quote grounding | 86.2% | 90.6% | 4 pts |
| Necessity phrase recall | 54.3% | 56.5% | 2 pts |
| Forbidden codes | 3 | 1 | — |
| Upcoded visits | 0 | 1 | — |

So: a single-run movement under ~10 points on any recall metric is within noise.
Treat a P2 change as a regression only if it moves a metric by more than that,
or if it moves several in the same direction.

Two encounters got no visit-level code in *both* runs: 007 (thin documentation)
and 016 (chest-pain workup). The other E/M misses (001, 002, 014, 015) flipped
between runs. 007 and 016 are stable failures worth looking at; the rest are the
model's coin-flip on whether to emit an E/M line at all.

Reminder from `../README.md`: the answer key was written by an AI, not a certified coder. These are regression numbers, not accuracy claims.
