# EP Lab Tycoon — interactive prototype

A low-fidelity, playable **storyboard prototype** for *EP Lab Tycoon*: a simulation game that lets electrophysiology (EP) lab teams test operational decisions — staffing, scheduling, recovery-bed management, and emergencies — *before* they affect real patients.

Built for **MSE 401 — Management Engineering Design Project I**, University of Waterloo, Spring 2026.

- **Team 7 / Group 10:** Prerak Arora, Thomas Huang, Dominic Lino Kee, Aaron Liu
- **Industry partner:** Dr. William Chan (St. Mary's General Hospital / Waterloo Regional Health Network)

## The problem

Over 200,000 Canadians are referred for cardiac ablation each year, and most wait more than a year. The bottleneck is operational, not clinical — scheduling, recovery-bed availability, room turnover, and staffing. Tools that train clinical skills and tools that model budgets and staffing exist separately, so no one can see how a change in one part of the lab ripples through throughput, staff fatigue, and cost. EP Lab Tycoon is built to answer exactly that.

## Run it

Open `index.html` in any modern browser. No build step and nothing to install.

> Note: icons currently load from a CDN, so keep internet on. An offline build can inline them for demos on locked-down networks.

## What the prototype shows

A single day in the lab, as a choose-your-path storyboard:

- **Cover** — sets the scene (8 ablations booked, 2 EP labs, 4 recovery beds, the team)
- **4 decision points** — open the day (staffing), a nurse calls in sick, recovery-bed gridlock, an emergency add-on
- Each choice **ripples through the KPIs** — cases done, patient wait, staff strain, patient safety, and cost
- **Shift report** — a star rating, a recap of your decisions, and a decision-support "what-if" teaser

Numbers and choices are illustrative — the goal is to communicate the game loop and UX for the design review, not final game balancing.

## Status

Low-fidelity prototype for the Week 7–9 design review / gallery walk. The full game is planned in Unity.
