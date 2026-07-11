# EP Lab Tycoon — interactive prototype

A low-fidelity, playable **storyboard prototype** for *EP Lab Tycoon*: a simulation game that lets electrophysiology (EP) lab teams test operational decisions — staffing, scheduling, recovery-bed management, and emergencies — *before* they affect real patients.

Built for **MSE 401 — Management Engineering Design Project I**, University of Waterloo, Spring 2026.

- **Team 7 / Group 10:** Prerak Arora, Thomas Huang, Dominic Lino Kee, Aaron Liu
- **Industry partner:** Dr. William Chan (St. Mary's General Hospital / Waterloo Regional Health Network)

## The problem

Over 200,000 Canadians are referred for cardiac ablation each year, and most wait more than a year. The bottleneck is operational, not clinical — scheduling, recovery-bed availability, room turnover, and staffing. Tools that train clinical skills and tools that model budgets and staffing exist separately, so no one can see how a change in one part of the lab ripples through throughput, staff fatigue, and cost. EP Lab Tycoon is built to answer exactly that.

## Run it

Play it live: **https://t8huang.github.io/EP-Lab-Tycoon-Prototype/**

Or open `index.html` in any modern browser. No build step and nothing to install.

> Note: icons currently load from a CDN, so keep internet on. An offline build can inline them for demos on locked-down networks.

## What the prototype shows

Two modes, reached from the title screen.

### 1. Play a shift (narrative)

A single day in the lab as a choose-your-path game:

- **Randomized events** — every shift opens with a staffing decision, then draws 3 of 7 events (sick call, recovery-bed gridlock, emergency add-on, equipment fault, supply shortage, a tech leaving, an add-on request) in random order, so no two runs are alike
- Each choice **ripples through the KPIs** — cases done, patient wait, staff strain, patient safety, and cost
- **Priorities, not right answers** — before the shift you pick what counts as a good day (Balanced, Safety first, Throughput push, or Staff wellbeing). All scoring, coaching, and benchmarks are relative to those weights. This is deliberate: real operational decisions have no universal best, only trade-offs under a value system — the tool makes that value system explicit and lets you change it
- **Coach feedback** — an exact solver enumerates every decision path for the day's draw. After each choice it tells you which option scored highest *under your priorities*, and narrates the trade-off you made ("yours gained throughput but gave up more on patient safety")
- **Shift report** — benchmarks your day against the full 81-path outcome distribution: the average shift (exact expected score under random choices), your percentile, and stars graded relative to what the day allowed. It also re-solves the day under the *other* priority profiles and reports how many calls would flip ("under Throughput push, 2 of today's 4 calls would flip") — demonstrating that "best" moves with the value weights

### 2. Lab planner (what-if)

The decision-support view. Sliders for cases booked, procedure rooms, physicians, nurses, technologists, and recovery beds, with live outputs (cases done, wait, staff strain, safety, overtime, cost per case). A two-stage bottleneck model — the procedure side is limited by `min(rooms, physicians, nurses, techs)`, the recovery side by beds, and throughput is the tighter of the two — flags the binding constraint and recommends the single change that adds the most throughput (or the resource you can trim without losing output). It also searches the full configuration space for two optimal setups at the chosen demand — the **leanest lab** that clears every case and a **sustainable lab** that also keeps strain ≤ 65 — each with a one-click Apply.

Numbers and choices are illustrative — the goal is to communicate the concept, UX, and the "ripple" idea for the design review, not final game balancing.

## Version history

See [CHANGELOG.md](CHANGELOG.md) for the full evolution (v1 → v7), with a **playable archived copy of every version** in [`versions/`](versions/).

## Status

Low-fidelity prototype for the Week 7–9 design review / gallery walk. The full game is planned in Unity.
