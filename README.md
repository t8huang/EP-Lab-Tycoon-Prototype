# EP Lab Tycoon — interactive prototype

A low-fidelity, playable prototype for *EP Lab Tycoon*: a simulation game that lets electrophysiology (EP) lab teams test operational decisions — staffing, scheduling, recovery-bed management, and emergencies — *before* they affect real patients.

Built for **MSE 401 — Management Engineering Design Project I**, University of Waterloo, Spring 2026.

- **Team 7 / Group 10:** Prerak Arora, Thomas Huang, Dominic Lino Kee, Aaron Liu
- **Industry partner:** Dr. William Chan (St. Mary's General Hospital / Waterloo Regional Health Network)

## The problem

Over 200,000 Canadians are referred for cardiac ablation each year, and most wait more than a year. The bottleneck is operational, not clinical — scheduling, recovery-bed availability, room turnover, and staffing. Tools that train clinical skills and tools that model budgets and staffing exist separately, so no one can see how a change in one part of the lab ripples through throughput, staff fatigue, and cost. EP Lab Tycoon is built to answer exactly that.

## Run it

The current interface is **[`src/control.html`](src/control.html)** — open it in any modern browser. No build step and nothing to install.

It opens on a **Set up the day** screen and offers two modes from the top bar:

- **Run the lab yourself** — the hands-on control panel (default)
- **Play a guided day** — the scripted, decision-card experience

> Notes
>
> - Icons (Tabler) and the interface font (Hanken Grotesk) load from CDNs, so keep internet on. An offline build can inline them for demos on locked-down networks.
> - The root [`index.html`](index.html) is the **earlier v1–v7 narrative prototype**, kept for reference. Every past version is archived under [`versions/`](versions/).

## The simulation engine — [`src/sim.js`](src/sim.js)

Both modes run on one discrete-event simulation of a day in the lab, and **nothing on screen is authored** — every KPI is *measured* from the run:

- **Cases completed is never assigned** — it is the count of patients who reach *discharged*. Decisions don't write KPIs; they change the lab (open a room, hold a nurse back, cancel a case), the clock runs forward, and the consequences fall out.
- **Emergent bottlenecks** — case durations are lognormal (booking on the median while reality is right-skewed is why lists run late); recovery beds are only usable when a nurse is free to watch them; a full ward backs up recovery, which blocks the room. The bed-crunch cascade is something the model *does to you*, not a scripted event.
- **Deterministic** — same setup + same seed + same decisions gives byte-identical results, which lets an exact solver enumerate every decision path under common random numbers.
- **Priorities, not right answers** — four KPIs (patient safety, throughput, staff wellbeing, cost) are combined under a **switchable priority profile** (Balanced, Safety first, Throughput push, Staff wellbeing). "Best" moves with the value system — the tool makes that explicit and lets you change it.
- **Verified** — a self-test suite checks conservation, determinism, that a bigger lab completes more cases, that decisions and priorities actually change the outcome, and that the day stops at a plausible hour. Open [`src/selftest.html`](src/selftest.html), or run `node src/sim.js` in a terminal.

## The two modes

### 1. Run the lab yourself (hands-on control)

You are the charge nurse / lab manager driving the day by hand:

- **Set up the day** — cases booked, EP labs, physicians, nurses, techs, recovery beds, ward beds, and a priority. Type a number or use the steppers; there is no upper limit.
- **Change what's available at any moment** — pull or add staff, open/close rooms, adjust recovery and ward beds, and mark instruments (3D mapping, fluoroscopy, ablation-catheter stock) available or down. Unavailability shows up in red.
- **Advance each case yourself** — start a case, mark the procedure complete, move it to recovery, and discharge it. Buttons gate on real resources and tell you *why* they're disabled ("no nurse free", "mapping system down"); marking a procedure complete with no recovery bed leaves the patient blocking the room, exactly as it would in the lab.
- **Live dashboard** — an **ideal-vs-actual pace chart** (yellow = the plan, green = on or ahead, red = behind), a case-flow bar showing where every patient stands, a chat-style activity feed, and headline KPI tiles.
- **Timeline scrubber** — a play/pause control, a speed dial, and a draggable seek bar; scrub back to *review* how the day looked earlier (the graph rewinds with you) and return to live.
- **Shift report** — a star rating scored under your chosen priority, per-KPI bars, the day's pace graph, and the patients that roll to tomorrow.

### 2. Play a guided day (scripted) — [`src/play.html`](src/play.html)

A single day that plays out on its own and stops to ask you the calls:

- **A live room board** runs in real time, then pauses for an opening staffing decision plus 3 of 7 drawn shocks (sick call, ward-bed block, emergency add-on, equipment fault, supply shortage, a tech leaving, an add-on request), so no two runs are alike.
- **Counterfactual coach** — because the day is deterministic, after each choice it replays the *same day* under the options you didn't take and reports what would actually have happened ("holding the room reaches 6 cases but costs 95 minutes of overtime") — measured, not written.
- **Shift report** — benchmarks your day against every way it could have gone, with stars graded relative to what the day allowed.

(This mode is also embedded directly inside the "Play a guided day" tab of `control.html`.)

### Capacity dashboard — [`src/dashboard.html`](src/dashboard.html)

A supporting view: a waterfall of every booked case and where it went (completed vs. lost to no bed, no crew, equipment down, no time), plus where room time was lost — all measured from a simulated day.

## Version history

See [CHANGELOG.md](CHANGELOG.md) for the full evolution (v1 → v7), with a **playable archived copy of every version** in [`versions/`](versions/).

## Status

Low-fidelity prototype for the design review / gallery walk. The interface and numbers are illustrative — the goal is to communicate the concept, the UX, and the "ripple" idea, not final game balancing. The full game is planned in Unity.
