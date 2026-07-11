# EP Lab Tycoon — version history

Every version of the prototype is archived in [`versions/`](versions/) as a standalone, playable HTML file. Because this repo is served by GitHub Pages, you can **play any version live**:

| Version | Play it | Date | Theme |
|---|---|---|---|
| v1 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v1-playable-storyboard.html) | Jul 2, 2026 | Playable storyboard |
| v2 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v2-randomized-events.html) | Jul 2, 2026 | Randomized events + title screen |
| v3 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v3-lab-planner.html) | Jul 2, 2026 | Lab planner (what-if mode) |
| v4 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v4-settings-carry-through.html) | Jul 2, 2026 | Planner settings carry into the game |
| v5 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v5-optimizer-coach.html) | Jul 6, 2026 | Optimizer coach + optimal lab setups |
| v6 | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/versions/v6-average-benchmark.html) | Jul 9, 2026 | Average-shift benchmark |
| **v7 (current)** | [play](https://t8huang.github.io/EP-Lab-Tycoon-Prototype/) | Jul 10, 2026 | Switchable priorities — no single right answer |

---

## v1 — Playable storyboard (Jul 2, 2026) · commit `353ebb7`

The original low-fidelity prototype for the MSE 401 design review / gallery walk.

- A choose-your-path **storyboard** of one day in an EP lab: cover screen → 4 fixed decision scenes (open the day, nurse sick call, recovery-bed gridlock, emergency add-on) → shift report.
- Every choice ripples through five live KPIs: cases done, average wait, staff strain, patient safety, and overtime cost.
- Star rating (1–5) at the end of the shift, based on a weighted score across the KPIs.
- Filmstrip along the bottom showing the fixed scene sequence; "low-fi prototype" badge and course footer.
- Single self-contained HTML file, no build step.

## v2 — Randomized events + game title screen (Jul 2, 2026) · commit `346429a`

Feedback: the fixed scenario list telegraphed the day and read as a slideshow, not a game.

- **Removed** the "low-fi prototype" badge, the footer disclaimer, and the filmstrip.
- Each shift now opens with the staffing decision, then draws **3 of 7 events in random order** (sick call, bed crunch, emergency, equipment fault, supply shortage, tech leaving, add-on request) — no two runs alike. Four of those events were newly written for this version.
- Rebuilt the cover as a **game title screen**: wordmark, ECG heartbeat motif, "Today's board" loadout tiles.
- Recalibrated star thresholds for the randomized event pool (verified over 40,000 simulated games: ~13/23/26/25/13% across 1–5 stars, zero errors).

## v3 — Lab planner, what-if mode (Jul 2, 2026) · commits `519fbcc`, `4a0133f`

The decision-support view the project report had only teased — the core of the capstone concept.

- New **Lab planner** mode on the title screen: sliders for cases booked, procedure rooms, physicians, nurses, technologists, and recovery beds.
- Live projected outputs: cases done, average wait, staff strain, patient safety, overtime, cost per case.
- **Two-stage bottleneck model**: procedure capacity = min(rooms, physicians, nurses, techs) × cases/room; recovery capacity = beds × patients/bed; throughput = the tighter of the two. The binding constraint is named the moment it appears.
- Recommendation engine: the single resource change that adds the most throughput — or the resource you can cut without losing output.

## v4 — Planner settings carry into the game (Jul 2, 2026) · commits `7a02efd`, `ef549d6`

Feedback: the two modes were disconnected — tuning the lab should change the game you play.

- The planner now writes a shared config that drives everything: the title-screen board tiles, the in-game lab board (N labs, N beds), the intro briefing, and the case target.
- **"Play this shift"** button in the planner jumps straight into a run with the current setup.
- Shift difficulty is seeded from the lab's resourcing (a stretched lab starts more stressed), and case progress scales with demand so high-booking days stay winnable with the right lab (verified over 20,000 games per configuration).
- Fix: extra labs (3rd/4th room) show as idle, not running, on the opening screen.

## v5 — Optimizer coach + optimal lab setups (Jul 6, 2026) · commit `debaebb`

Feedback: players couldn't tell whether they chose well or how to improve.

- **Exact decision solver**: once the day's events are dealt, the game enumerates all 3⁴ = 81 decision paths with the real state-transition and scoring functions.
- After each choice, a coach line reports whether it was the top-scoring play (assuming optimal play afterward) — and if not, which one was.
- Shift report benchmarks the run against the day's best possible and marks every decision ✓ or names the better option.
- Lab planner searches all 6,144 slider configurations for two optima at the chosen demand — the **leanest lab** that clears every case and a **sustainable lab** (strain ≤ 65) — each with one-click Apply.
- `window.__ep` test hooks (`hint()`, `best()`) for automated verification.

## v6 — Average-shift benchmark (Jul 9, 2026) · commit `f76f541`

Feedback: "how much better than the average?" — with a real distribution behind it, not an invented number.

- The 81-path enumeration now yields the day's full outcome **distribution**, from which the report derives the **average shift** (the exact expected score under uniform-random choices), the best possible, and the player's **percentile**.
- New report line: "Average shift 3★ · Best possible 5★ · You 4★ — you scored 6% above an average shift, better than 78% of the ways today could have gone."
- The distribution is per-day and per-lab, so "average" always reflects the difficulty actually played. (It is *not* a normal distribution — it's discrete, bounded, mildly left-skewed, and its shape changes with the event draw; the mean and percentile are computed empirically and assume nothing about shape.)

## v7 — Switchable priorities: no single right answer (Jul 10, 2026) · commit `f66c6c4` — **current**

Design principle (team decision): a realistic operations simulation must not claim a universal "best" decision — only trade-offs under a value system. This version makes the value system explicit, visible, and changeable.

- Title screen gains **priority profiles**: Balanced · Safety first · Throughput push · Staff wellbeing. All scoring, coaching, and benchmarks re-solve under the chosen weights.
- Coach language drops right/wrong framing: *"highest-scoring call under your priorities,"* with automatic **trade-off narration** — "yours gained throughput but gave up more on patient safety."
- Stars are graded **relative to the day's own 81-outcome distribution** (percentile-based), so they stay calibrated under any weighting.
- The report states the active priorities and weights, then re-solves the same day under the other profiles and reports how many calls would **flip** ("under Balanced, 4 of today's 4 calls would flip") — concrete proof that "best" moves with the values.
- Lab-ceiling insight now keys off the best reachable end-state ("even the highest-scoring line ends at 5/8 cases — that ceiling is the lab setup, not your choices").

---

*Prototype by Team 7 (Prerak Arora, Thomas Huang, Dominic Lino Kee, Aaron Liu) for MSE 401, University of Waterloo. Built iteratively with AI assistance (Claude); all versions verified by automated play-through testing before release.*
