# Recorded runs

| File | What it is |
|---|---|
| `2026-09-13T23-02-05-095Z.json` | **Not a baseline.** First-ever live run, on Opus 5 with `max_tokens: 1024`. 7 of 20 coding calls were truncated at the cap and silently returned no codes, which is what the low recall numbers reflect. Kept as the record of that bug. |
| `2026-09-13T23-27-52-451Z.json` | **P2 baseline.** Same fixtures, same model, after the cap was raised to 4096 and truncation made fatal. This is the number P2 is measured against. |

Reminder from `../README.md`: the answer key was written by an AI, not a certified coder. These are regression numbers, not accuracy claims.
