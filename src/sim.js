/* ===========================================================================
   EP Lab Tycoon — simulation model
   ---------------------------------------------------------------------------
   A discrete-event simulation of one day in an EP lab. No DOM, no rendering,
   no game logic. Everything the dashboard shows is MEASURED from this run —
   nothing is authored.

   The contract that matters:

     Cases completed is never assigned. It is
     patients.filter(p => p.status === 'discharged').length

   Decisions do not write KPIs. They change the lab (open a room, hold a nurse
   back, cancel a case, authorise overtime). The clock then runs forward and
   the consequences fall out.

   DETERMINISM
     runDay({config, seed, policy}) is a pure function. Same config + same seed
     + same decisions => byte-identical metrics. This is what lets the solver
     enumerate all 81 decision paths under common random numbers, exactly the
     way v5–v7 already do.

   USE
     Browser (classic script, no build step — keeps "just open index.html"):
       <script src="src/sim.js"></script>
       EPSim.runDay({config: {...}, seed: 1234, policy: fn})
     Node (for verification sweeps):
       const EPSim = require('./src/sim.js'); EPSim.selfTest();

   PARAMETERS
     Every number in section 1 is a PLACEHOLDER. They are plausible, not real.
     Case durations, crew ratios, recovery dwell, supply cost and funding are
     exactly the things to get from Dr. Chan — the model is built so that
     replacing them is a one-file edit and nothing else changes.
   =========================================================================== */

(function (root) {
  'use strict';

  /* ==========================================================================
     1. PARAMETERS  —  PLACEHOLDER VALUES, replace with site data
     ========================================================================== */

  /* Durations are lognormal: `median` is the booking time the scheduler uses,
     `sigma` is the spread of what actually happens. Scheduling on the median
     while reality is right-skewed is why real lists run late — that behaviour
     is emergent here, not scripted. */
  var CASE_TYPES = {
    af:     { label: 'AF ablation',    median: 210, sigma: 0.28, recovery: 150, inpatientRate: 0.15, supply: 4800, funding:  9200, baseRisk: 0.040 },
    svt:    { label: 'SVT ablation',   median: 105, sigma: 0.30, recovery: 120, inpatientRate: 0.05, supply: 2600, funding:  6100, baseRisk: 0.020 },
    vt:     { label: 'VT ablation',    median: 300, sigma: 0.35, recovery: 210, inpatientRate: 0.70, supply: 7400, funding: 14500, baseRisk: 0.090 },
    device: { label: 'Device implant', median:  75, sigma: 0.25, recovery:  75, inpatientRate: 0.25, supply: 5200, funding:  7300, baseRisk: 0.025 },
    eps:    { label: 'EP study',       median:  70, sigma: 0.30, recovery:  90, inpatientRate: 0.10, supply: 1400, funding:  3400, baseRisk: 0.012 }
  };

  var DEFAULT_MIX = { af: 0.42, svt: 0.20, device: 0.20, eps: 0.12, vt: 0.06 };

  /* Staff needed to RUN a room. The v7 planner used min(rooms,phys,nurses,techs),
     which implies one nurse per room. A real EP room is closer to this. Confirm
     the exact ratio with Dr. Chan — it changes every planner recommendation. */
  var CREW_PER_ROOM = { ep: 1, nurse: 1, tech: 2 };

  /* Recovery beds are useless without a nurse to watch them. This is what makes
     nurses contended between procedures and recovery — the central trade-off. */
  var BEDS_PER_RECOVERY_NURSE = 4;

  var TIMING = {
    dayStart:         7 * 60,
    firstCaseTarget:  8 * 60,   // FCOTS benchmark: first patient in room by 08:00
    scheduledEnd:    17 * 60,
    hardStop:        19 * 60,   // sweep unstarted cases here regardless
    setup:            25,
    turnover:         28,
    turnoverFatiguePenalty: 12, // extra turnover minutes at maximum crew fatigue
    firstCaseDelayMedian:   12, // consent, transport, anaesthesia — the classic cascade
    firstCaseDelaySigma:   0.9,
    breakEvery:      240,
    breakLength:      30,
    backupImagingFactor: 1.25   // running a case on backup imaging
  };

  /* Downstream of recovery. When the ward has no bed, an inpatient cannot leave
     recovery, so recovery fills, so the room cannot empty, so the room blocks.
     That cascade is the whole point of the model. */
  var WARD = { bedsAtStart: 2, releaseEvery: 75, releaseJitter: 30 };

  var COSTS = {
    hourly: { ep: 210, nurse: 58, tech: 52 },
    overtimeMultiplier: 1.5,
    roomHour: 145,
    bedHour: 22
  };

  var RISK = {
    fatigueGain: 1.8,           // at fatigue 1.0, complication risk x2.8
    substituteGain: 0.6,        // non-preferred device
    extraCaseMinutes: [15, 45],
    extraRecoveryMinutes: [60, 180],
    escalationChance: 0.25      // complication that needs an unplanned transfer
  };

  /* Normalisation bounds for the 0..1 KPIs the score is built from. Tunable —
     they set how harsh the grading is, not how the lab behaves.

     These are PER STAFF MEMBER, not totals. Totals do not survive a change of
     lab size: 480 minutes of overtime is a catastrophe for a team of three and
     a normal Tuesday for a team of twelve, and an absolute scale silently
     pins the staff KPI to zero on every busy day in a big lab. */
  var SCALE = {
    complicationRateAtZero: 0.12,  // 12% of cases with a complication => safety 0
    overtimeMinutesPerHead: 180,   // 3 h each is a rough day, not the end of the world
    missedBreaksPerHead:    2,
    costPerCaseAtZero:    15000,

    /* Patient safety is not only what happened in the room. A cancelled case is
       a patient who goes back on a list they have already been on for months —
       in this project's own framing, usually more than a year. Without this
       term the safest possible day is the day you cancel everything, and the
       model recommends running one room and going home. */
    safetyMix: { harm: 0.50, fatigue: 0.25, deferred: 0.25 },
    deferredHarmAtOneYear: 365
  };

  /* Deliberately far apart. The earlier spread (.40/.30/.20/.10 vs .55/.20/.15/.10)
     was close enough that all four profiles picked the same line on most days,
     which quietly made the priority selector decoration. If "there is no single
     right answer" is the point of the game, the value systems have to actually
     disagree. */
  var PROFILES = {
    balanced: { label: 'Balanced',        w: { safety: 0.35, through: 0.35, staff: 0.20, cost: 0.10 } },
    safety:   { label: 'Safety first',    w: { safety: 0.70, through: 0.12, staff: 0.12, cost: 0.06 } },
    through:  { label: 'Throughput push', w: { safety: 0.12, through: 0.70, staff: 0.10, cost: 0.08 } },
    staff:    { label: 'Staff wellbeing', w: { safety: 0.18, through: 0.12, staff: 0.65, cost: 0.05 } }
  };

  /* 6 cases across 2 rooms is roughly what this case mix actually supports:
     mean booked duration ~150 min + 25 setup + 28 turnover is ~3 cases per room
     per prime-time day. The v7 default of 8 was calibrated against the old
     authored model, not against durations. */
  var DEFAULT_CONFIG = {
    cases: 6, rooms: 2, phys: 2, nurses: 4, techs: 4, beds: 4,
    mix: null,          // null => DEFAULT_MIX
    shockCount: 3
  };

  var NAMES = ['Priya', 'Marcus', 'Dana', 'Tomas', 'Aiko', 'Ruth', 'Omar', 'Nia',
               'Kenji', 'Sara', 'Luc', 'Mei', 'Ivan', 'Grace', 'Sol', 'Bea'];

  /* Patients get names because "3 cases cancelled" is a statistic and
     "J. Okonkwo, waiting 412 days, bumped" is a decision you remember making.
     Initial + surname keeps them people without assuming anything about them. */
  var PATIENT_NAMES = [
    'J. Okonkwo', 'L. Marchetti', 'S. Nakamura', 'R. Bellefeuille', 'A. Haddad',
    'M. Oyelaran', 'D. Kowalczyk', 'T. Sandoval', 'E. Bhattacharya', 'C. Lindqvist',
    'P. Achterberg', 'N. Rahimi', 'V. Castellanos', 'H. Ferreira', 'B. Osei',
    'K. Voronova', 'F. Dumitrescu', 'G. Tremblay', 'W. Adeyemi', 'I. Sørensen',
    'O. Mwangi', 'Z. Petrov', 'Y. Nguyen', 'Q. Delacroix'
  ];

  /* NARRATIVE, keyed "<decision>:<option>". Deliberately separate from the
     mechanics above: a writer can rewrite every line here without touching a
     single number, and nothing in this table can change an outcome. The words
     are authored; the numbers are measured. */
  var OUTCOMES = {
    'opening:full':   'Both labs light up. Every pair of hands is on a procedure and nobody is spare.',
    'opening:float':  'You hold a nurse back. It costs you nothing yet, and it might cost you nothing all day.',
    'opening:deep':   'One room, deeply staffed. Calm, deliberate, and the board barely moves.',

    'sick-call:float':  'You move your float into recovery. If you kept one, the day barely notices.',
    'sick-call:agency': 'You call the agency. Someone is coming, but not for an hour.',
    'sick-call:short':  'You run recovery short and hope the beds turn over faster than they will.',

    'ward-block:hold':     'The patients stay put. Safe, and your beds stop being beds.',
    'ward-block:escalate': 'You get bed management on the phone and make it their problem too.',
    'ward-block:divert':   'You send the stable ones home the same day. Most of them should be fine.',

    'emergency:bump':   'You take the urgent case. Somewhere on the list, someone gets a phone call.',
    'emergency:append': 'You promise to fit it at the end. Everyone understands what that means.',
    'emergency:divert': 'You hand the patient to another team. Your day stays clean. That is the trade.',

    'equipment:backup': 'You carry on with backup imaging. Slower, more careful, more tiring.',
    'equipment:biomed': 'You stand the room down and let biomed do it properly.',
    'equipment:shift':  'You move the list next door and hope the other room can carry both.',

    'supply:ration':     'You protect the sickest and let the rest wait for the resupply.',
    'supply:courier':    'A courier is on the road with stock from across town.',
    'supply:substitute': 'You switch to the substitute catheter. It works. Nobody loves it.',

    'tech-leaves:go':       'You send them home. The rest of the team quietly absorbs it.',
    'tech-leaves:one-more': 'They stay for one more case. You will owe them for this.',
    'tech-leaves:close':    'You close the room. Everyone goes home whole, and the list does not.',

    'add-on:fit':     'You find room. The day was already full, and now it is fuller.',
    'add-on:decline': 'You hold the plan and book them properly for tomorrow.',
    'add-on:triage':  'You make it a clinical decision instead of a corridor decision.'
  };

  /* ==========================================================================
     2. DETERMINISTIC RNG
     ========================================================================== */

  function rngFrom(seed) {
    var a = seed >>> 0;
    function u() {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      unit: u,
      int: function (n) { return Math.floor(u() * n); },
      range: function (lo, hi) { return lo + u() * (hi - lo); },
      bool: function (p) { return u() < p; },
      normal: function () {
        var r = Math.sqrt(-2 * Math.log(1 - u()));
        return r * Math.cos(2 * Math.PI * u());
      },
      lognormal: function (median, sigma) {
        var r = Math.sqrt(-2 * Math.log(1 - u()));
        var z = r * Math.cos(2 * Math.PI * u());
        return median * Math.exp(sigma * z);
      },
      weighted: function (weights) {
        var keys = Object.keys(weights), total = 0, i;
        for (i = 0; i < keys.length; i++) total += weights[keys[i]];
        var x = u() * total;
        for (i = 0; i < keys.length; i++) { x -= weights[keys[i]]; if (x <= 0) return keys[i]; }
        return keys[keys.length - 1];
      },
      shuffle: function (arr) {
        var out = arr.slice();
        for (var i = out.length - 1; i > 0; i--) {
          var j = Math.floor(u() * (i + 1)), t = out[i]; out[i] = out[j]; out[j] = t;
        }
        return out;
      }
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[clamp(Math.floor(p * s.length), 0, s.length - 1)];
  }
  function sum(arr) { var t = 0; for (var i = 0; i < arr.length; i++) t += arr[i]; return t; }

  /* ==========================================================================
     3. EVENT QUEUE  (binary min-heap, insertion-ordered tie-break)
     Tie-breaking on insertion sequence is what keeps runs reproducible.
     ========================================================================== */

  function Queue() { this.h = []; this.n = 0; }
  Queue.prototype.size = function () { return this.h.length; };
  Queue.prototype.push = function (t, type, data) {
    var node = { t: t, seq: this.n++, type: type, data: data || {} };
    var h = this.h, i = h.length;
    h.push(node);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (h[p].t < h[i].t || (h[p].t === h[i].t && h[p].seq < h[i].seq)) break;
      var tmp = h[p]; h[p] = h[i]; h[i] = tmp; i = p;
    }
  };
  Queue.prototype.pop = function () {
    var h = this.h;
    if (!h.length) return null;
    var top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, s = i;
        if (l < h.length && (h[l].t < h[s].t || (h[l].t === h[s].t && h[l].seq < h[s].seq))) s = l;
        if (r < h.length && (h[r].t < h[s].t || (h[r].t === h[s].t && h[r].seq < h[s].seq))) s = r;
        if (s === i) break;
        var tmp = h[s]; h[s] = h[i]; h[i] = tmp; i = s;
      }
    }
    return top;
  };

  /* ==========================================================================
     4. WORLD CONSTRUCTION
     ========================================================================== */

  function buildWorld(config, rng) {
    var mix = config.mix || DEFAULT_MIX;
    var w = {
      config: config,
      rng: rng,
      clock: TIMING.dayStart,
      q: new Queue(),
      list: [],
      rooms: [],
      staff: [],
      beds: [],
      wardFree: WARD.bedsAtStart,
      wardBlocked: [],
      otUntil: TIMING.scheduledEnd,   // nothing starts that cannot finish by here
      crewShort: false,               // did we ever want a room we could not staff?
      extraCost: 0,
      extraCostLog: [],
      supplyCap: null,                // {type, remaining} once a shortage bites
      timeline: [],
      intervals: [],
      decisions: [],
      turnovers: [],
      complications: [],
      nextPatientId: 1
    };

    // ---- patients -----------------------------------------------------------
    var pool = rng.shuffle(PATIENT_NAMES);
    for (var i = 0; i < config.cases; i++) {
      var typeKey = rng.weighted(mix);
      var ct = CASE_TYPES[typeKey];
      w.list.push({
        id: w.nextPatientId++,
        name: pool[i % pool.length],
        type: typeKey,
        typeLabel: ct.label,
        planned: Math.round(ct.median),
        actual: Math.round(clamp(rng.lognormal(ct.median, ct.sigma), ct.median * 0.55, ct.median * 2.2)),
        recoveryMin: Math.round(clamp(rng.lognormal(ct.recovery, 0.22), ct.recovery * 0.5, ct.recovery * 2.5)),
        inpatient: rng.bool(ct.inpatientRate),
        acuity: 1 + rng.int(4),                       // 1 = most urgent
        daysWaiting: Math.round(rng.lognormal(180, 0.7)),
        addOn: false,
        substitute: false,
        status: 'booked',                              // booked|in-room|recovery|discharged|cancelled
        cancelReason: null,
        scheduledStart: 0, inRoomAt: null, outOfRoomAt: null, bedAt: null, dischargedAt: null,
        complication: null, room: null
      });
    }
    // Booking order: sickest first, then longest first — a real scheduling habit,
    // and something the player will be able to override later.
    w.list.sort(function (a, b) { return a.acuity - b.acuity || b.planned - a.planned; });

    // ---- rooms --------------------------------------------------------------
    for (var r = 0; r < config.rooms; r++) {
      w.rooms.push({
        id: r, label: 'EP lab ' + (r + 1),
        open: false, state: 'closed', since: TIMING.dayStart,
        patient: null, crew: null, firstCaseDone: false, firstCaseInRoomAt: null,
        backupImaging: false, downAfter: 0, closeAfterCase: false, blockedSince: null, lastPatient: null,
        min: { closed: 0, idle: 0, setup: 0, procedure: 0, turnover: 0, blocked: 0, down: 0 }
      });
    }

    // ---- staff --------------------------------------------------------------
    var nameIdx = 0;
    function addStaff(role, count) {
      for (var k = 0; k < count; k++) {
        w.staff.push({
          id: role + '-' + k,
          name: NAMES[nameIdx++ % NAMES.length],
          role: role,
          shiftEnd: TIMING.scheduledEnd,
          assign: null,               // room id | 'recovery' | 'float' | null
          present: true,
          leftAt: null,
          leaveWhenFree: false,
          missedBreaks: 0,
          nextBreak: TIMING.dayStart + TIMING.breakEvery,
          overtime: 0
        });
      }
    }
    addStaff('ep', config.phys);
    addStaff('nurse', config.nurses);
    addStaff('tech', config.techs);

    // ---- beds ---------------------------------------------------------------
    for (var b = 0; b < config.beds; b++) {
      w.beds.push({ id: b, patient: null, since: TIMING.dayStart, occupiedMin: 0, wardBlockedMin: 0 });
    }

    return w;
  }

  /* ==========================================================================
     5. STATE HELPERS
     ========================================================================== */

  function setRoomState(w, room, s) {
    room.min[room.state] += w.clock - room.since;
    // Interval log: the aggregate minutes answer "how much", this answers
    // "when" — which is what a room-lane board needs to draw.
    if (w.clock > room.since) {
      w.intervals.push({ room: room.id, state: room.state, from: room.since, to: w.clock,
                         patient: room.patient ? room.patient.id : room.lastPatient });
    }
    if (room.state === 'blocked' && room.blockedSince !== null) room.blockedSince = null;
    if (s === 'blocked') room.blockedSince = w.clock;
    room.state = s;
    room.since = w.clock;
  }

  function staffOf(w, role, assign) {
    return w.staff.filter(function (s) { return s.present && s.role === role && s.assign === assign; });
  }
  function freeStaff(w, role) {
    return w.staff.filter(function (s) { return s.present && s.role === role && s.assign === null; });
  }
  function recoveryNurses(w) { return staffOf(w, 'nurse', 'recovery').length; }

  /* Usable recovery beds — physical beds capped by the nurses watching them. */
  function usableBeds(w) {
    return Math.min(w.beds.length, recoveryNurses(w) * BEDS_PER_RECOVERY_NURSE);
  }
  function freeBed(w) {
    var usable = usableBeds(w);
    for (var i = 0; i < usable; i++) if (!w.beds[i].patient) return w.beds[i];
    return null;
  }

  /* Try to staff and open a room. Returns true if the room is now open. */
  function openRoom(w, room) {
    if (room.open) return true;
    var need = CREW_PER_ROOM, crew = { ep: [], nurse: [], tech: [] }, role;
    for (role in need) {
      var avail = freeStaff(w, role);
      if (avail.length < need[role]) {
        // Wanted the room, could not staff it. The waterfall needs to know.
        w.crewShort = true;
        return false;
      }
      crew[role] = avail.slice(0, need[role]);
    }
    for (role in crew) {
      crew[role].forEach(function (s) { s.assign = room.id; });
    }
    room.crew = crew;
    room.open = true;
    setRoomState(w, room, 'idle');
    return true;
  }

  /* redeploy: nurses freed by closing a room go to recovery rather than home,
     which is what actually happens — and it raises the usable bed count. */
  function closeRoom(w, room, redeploy) {
    if (!room.open) return;
    ['ep', 'nurse', 'tech'].forEach(function (role) {
      (room.crew[role] || []).forEach(function (s) {
        if (s.assign !== room.id) return;
        s.assign = (redeploy && s.role === 'nurse' && s.present) ? 'recovery' : null;
      });
    });
    room.crew = null;
    room.open = false;
    setRoomState(w, room, 'closed');
  }

  function roomCrewOk(w, room) {
    if (!room.open || !room.crew) return false;
    for (var role in CREW_PER_ROOM) {
      var alive = (room.crew[role] || []).filter(function (s) { return s.present; });
      if (alive.length < CREW_PER_ROOM[role]) return false;
    }
    return true;
  }

  function crewFatigue(w, room) {
    if (!room.crew) return 0;
    var all = [];
    ['ep', 'nurse', 'tech'].forEach(function (r) { all = all.concat(room.crew[r] || []); });
    if (!all.length) return 0;
    return sum(all.map(function (s) { return fatigueOf(w, s); })) / all.length;
  }

  /* Calibrated so a normal completed shift lands near 0.40 and a long overtime
     shift with missed breaks reaches 1.0. The earlier curve used a 9-hour
     denominator, so every full day saturated at 1.0 and fatigue stopped
     distinguishing a busy day from a brutal one. */
  function fatigueOf(w, s) {
    var end = s.leftAt || w.clock;
    var worked = Math.max(0, end - TIMING.dayStart);
    var ot = Math.max(0, end - s.shiftEnd);
    return clamp(worked / 600 * 0.30 + s.missedBreaks * 0.10 + ot / 180 * 0.40, 0, 1);
  }

  /* The next booked case that can still finish within the day's start window. */
  function nextStartablePatient(w, readyAt) {
    for (var i = 0; i < w.list.length; i++) {
      var p = w.list[i];
      if (p.status !== 'booked') continue;
      if (w.supplyCap && w.supplyCap.type === p.type && w.supplyCap.remaining <= 0) continue;
      if (readyAt + p.planned > w.otUntil) continue;
      return p;
    }
    return null;
  }

  function nextBookedPatient(w) {
    for (var i = 0; i < w.list.length; i++) {
      var p = w.list[i];
      if (p.status !== 'booked') continue;
      if (w.supplyCap && w.supplyCap.type === p.type && w.supplyCap.remaining <= 0) continue;
      return p;
    }
    return null;
  }

  function cancel(w, p, reason) {
    if (p.status !== 'booked') return false;
    p.status = 'cancelled';
    p.cancelReason = reason;
    log(w, 'cancel', p.typeLabel + ' cancelled (' + reason + ')', { patient: p.id });
    return true;
  }

  function log(w, kind, text, extra) {
    var e = { t: w.clock, kind: kind, text: text };
    if (extra) for (var k in extra) e[k] = extra[k];
    w.timeline.push(e);
  }

  function charge(w, amount, why) {
    w.extraCost += amount;
    w.extraCostLog.push({ amount: amount, why: why });
  }

  /* ==========================================================================
     6. DISPATCH  —  the only place cases ever start or move
     ========================================================================== */

  function dispatch(w) {
    var moved = true;
    while (moved) {
      moved = false;

      // (a) a blocked room can release its patient if a recovery bed opened up
      for (var i = 0; i < w.rooms.length; i++) {
        var room = w.rooms[i];
        if (room.state !== 'blocked') continue;
        var bed = freeBed(w);
        if (!bed) continue;
        placeInRecovery(w, room.patient, bed);
        room.patient = null;
        beginTurnover(w, room);
        moved = true;
      }

      // (b) an idle, staffed, working room can start the next case
      for (var j = 0; j < w.rooms.length; j++) {
        var rm = w.rooms[j];
        if (rm.state !== 'idle' || !roomCrewOk(w, rm)) continue;
        if (!nextBookedPatient(w)) continue;              // nothing left on the list at all
        var setupTime = TIMING.setup + (rm.firstCaseDone ? 0 : Math.round(
          clamp(w.rng.lognormal(TIMING.firstCaseDelayMedian, TIMING.firstCaseDelaySigma), 0, 90)));
        /* Labs decide with the BOOKED duration, not the one reality will hand
           them — and when the next case on the list will not fit the time left,
           they do not close the room and go home. They pull the next one that
           does fit. Taking only the head of the list meant one oversized case
           stalled the room for the rest of the day. */
        var p = nextStartablePatient(w, w.clock + setupTime);
        if (!p) continue;
        p.status = 'in-room';
        p.room = rm.id;
        rm.patient = p;
        rm.lastPatient = p.id;
        if (w.supplyCap && w.supplyCap.type === p.type) w.supplyCap.remaining--;
        setRoomState(w, rm, 'setup');
        w.q.push(w.clock + setupTime, 'SETUP_DONE', { room: rm.id });
        moved = true;
      }
    }
    releaseRecoveryStaff(w);
  }

  function placeInRecovery(w, p, bed) {
    bed.patient = p;
    bed.since = w.clock;
    p.status = 'recovery';
    p.bedAt = w.clock;
    p.bedId = bed.id;
    w.q.push(w.clock + p.recoveryMin, 'BED_READY', { bed: bed.id, patient: p.id });
  }

  function beginTurnover(w, room) {
    var extra = Math.round(TIMING.turnoverFatiguePenalty * crewFatigue(w, room));
    var dur = TIMING.turnover + extra;
    w.turnovers.push(dur);
    setRoomState(w, room, 'turnover');
    w.q.push(w.clock + dur, 'TURNOVER_DONE', { room: room.id });
  }

  /* ==========================================================================
     7. EVENT HANDLERS
     ========================================================================== */

  function handle(w, ev) {
    var room, p, bed, s;

    switch (ev.type) {

      case 'SETUP_DONE':
        room = w.rooms[ev.data.room];
        p = room.patient;
        if (!p) break;
        p.inRoomAt = w.clock;
        if (!room.firstCaseDone) { room.firstCaseDone = true; room.firstCaseInRoomAt = w.clock; }
        setRoomState(w, room, 'procedure');
        var dur = p.actual * (room.backupImaging ? TIMING.backupImagingFactor : 1);
        w.q.push(w.clock + Math.round(dur), 'CASE_END', { room: room.id });
        log(w, 'start', p.typeLabel + ' started in ' + room.label, { patient: p.id, room: room.id });
        break;

      case 'CASE_END':
        room = w.rooms[ev.data.room];
        p = room.patient;
        if (!p) break;
        rollComplication(w, room, p);
        p.outOfRoomAt = w.clock;
        bed = freeBed(w);
        if (bed) {
          placeInRecovery(w, p, bed);
          room.patient = null;
          beginTurnover(w, room);
        } else {
          // No recovery bed. The patient cannot leave, so the room cannot turn
          // over. This is where lost throughput actually comes from.
          setRoomState(w, room, 'blocked');
          log(w, 'block', room.label + ' blocked — no recovery bed', { room: room.id });
        }
        break;

      case 'TURNOVER_DONE':
        room = w.rooms[ev.data.room];
        if (room.closeAfterCase) {
          room.closeAfterCase = false;
          releaseLeavers(w, room);
          closeRoom(w, room, true);
        } else if (room.downAfter > 0) {
          var d = room.downAfter; room.downAfter = 0;
          setRoomState(w, room, 'down');
          w.q.push(w.clock + d, 'ROOM_UP', { room: room.id });
        } else {
          setRoomState(w, room, 'idle');
          releaseLeavers(w, room);
        }
        break;

      case 'ROOM_UP':
        room = w.rooms[ev.data.room];
        if (room.state === 'down') { setRoomState(w, room, 'idle'); releaseLeavers(w, room); }
        break;

      case 'BED_READY':
        bed = w.beds[ev.data.bed];
        p = bed.patient;
        if (!p) break;
        if (p.inpatient && w.wardFree <= 0) {
          if (w.wardBlocked.indexOf(p.id) < 0) {
            w.wardBlocked.push(p.id);
            p.wardWaitFrom = w.clock;
            log(w, 'ward', 'Inpatient holding a recovery bed — ward full', { patient: p.id });
          }
        } else {
          if (p.inpatient) w.wardFree--;
          dischargeFromBed(w, bed);
        }
        break;

      case 'WARD_FREE':
        w.wardFree++;
        releaseWardBlocked(w);
        var nextWard = w.clock + WARD.releaseEvery +
                       Math.round(w.rng.range(-WARD.releaseJitter, WARD.releaseJitter));
        if (nextWard < TIMING.hardStop) w.q.push(nextWard, 'WARD_FREE', {});
        break;

      case 'BREAK_DUE':
        s = staffById(w, ev.data.staff);
        if (!s || !s.present) break;
        if (typeof s.assign === 'number' && w.rooms[s.assign] &&
            (w.rooms[s.assign].state === 'procedure' || w.rooms[s.assign].state === 'setup')) {
          s.missedBreaks++;
          log(w, 'break', s.name + ' missed a break', { staff: s.id });
        }
        s.nextBreak = w.clock + TIMING.breakEvery;
        if (s.nextBreak < TIMING.hardStop) w.q.push(s.nextBreak, 'BREAK_DUE', { staff: s.id });
        break;

      case 'SHIFT_END':
        s = staffById(w, ev.data.staff);
        if (!s || !s.present) break;
        if (w.otUntil > w.clock) {                       // overtime authorised
          w.q.push(w.otUntil, 'SHIFT_END', { staff: s.id });
          break;
        }
        departIfFree(w, s);
        break;

      case 'END_OF_DAY':
        sweepUnstarted(w);
        break;
    }
  }

  function anythingActive(w) {
    for (var i = 0; i < w.rooms.length; i++) {
      var s = w.rooms[i].state;
      if (s === 'setup' || s === 'procedure' || s === 'turnover' || s === 'blocked' || s === 'down') return true;
    }
    for (var j = 0; j < w.beds.length; j++) if (w.beds[j].patient) return true;
    return false;
  }

  function staffById(w, id) {
    for (var i = 0; i < w.staff.length; i++) if (w.staff[i].id === id) return w.staff[i];
    return null;
  }

  function dischargeFromBed(w, bed) {
    var p = bed.patient;
    bed.occupiedMin += w.clock - bed.since;
    if (p.wardWaitFrom) bed.wardBlockedMin += w.clock - p.wardWaitFrom;
    p.status = 'discharged';
    p.dischargedAt = w.clock;
    bed.patient = null;
    bed.since = w.clock;
    var idx = w.wardBlocked.indexOf(p.id);
    if (idx >= 0) w.wardBlocked.splice(idx, 1);
    log(w, 'discharge', p.typeLabel + ' discharged from recovery', { patient: p.id });
  }

  function releaseWardBlocked(w) {
    while (w.wardFree > 0 && w.wardBlocked.length) {
      var pid = w.wardBlocked[0], bed = null;
      for (var i = 0; i < w.beds.length; i++) if (w.beds[i].patient && w.beds[i].patient.id === pid) bed = w.beds[i];
      if (!bed) { w.wardBlocked.shift(); continue; }
      w.wardFree--;
      dischargeFromBed(w, bed);
    }
  }

  /* A staff member whose shift ended leaves as soon as their room is not
     mid-case. Until then they stay and accrue overtime — nobody walks out of a
     running procedure. */
  function departIfFree(w, s) {
    // Recovery cannot be left unattended. Whoever is watching the bays stays
    // until the last patient is out, and that time is overtime.
    if (s.assign === 'recovery') {
      if (anythingActive(w)) { s.leaveWhenFree = true; return; }
      depart(w, s);
      return;
    }
    var room = (typeof s.assign === 'number') ? w.rooms[s.assign] : null;
    if (room && (room.state === 'setup' || room.state === 'procedure' || room.state === 'blocked')) {
      s.leaveWhenFree = true;
      return;
    }
    depart(w, s);
  }

  function releaseRecoveryStaff(w) {
    if (anythingActive(w)) return;
    w.staff.filter(function (s) { return s.present && s.leaveWhenFree && s.assign === 'recovery'; })
           .forEach(function (s) { depart(w, s); });
  }

  function depart(w, s) {
    s.present = false;
    s.leftAt = w.clock;
    s.overtime = Math.max(0, w.clock - s.shiftEnd);
    var room = (typeof s.assign === 'number') ? w.rooms[s.assign] : null;
    s.assign = null;
    log(w, 'staff', s.name + ' (' + s.role + ') left', { staff: s.id });
    if (room && !roomCrewOk(w, room)) {
      // The room is closing because the people ran out, not because anyone
      // chose to close it. The waterfall should say so.
      if (w.clock < TIMING.scheduledEnd) w.crewShort = true;
      closeRoom(w, room, true);
    }
  }

  function releaseLeavers(w, room) {
    if (!room.crew) return;
    var pending = [];
    ['ep', 'nurse', 'tech'].forEach(function (r) {
      (room.crew[r] || []).forEach(function (s) { if (s.present && s.leaveWhenFree) pending.push(s); });
    });
    pending.forEach(function (s) { depart(w, s); });
  }

  /* At the end of the day, anything still booked is a case that did not happen.
     The reason is attributed from where this room actually lost its time. */
  function sweepUnstarted(w) {
    var blocked = 0, down = 0, closed = 0;
    w.rooms.forEach(function (r) {
      blocked += r.min.blocked + (r.state === 'blocked' ? w.clock - r.since : 0);
      down += r.min.down + (r.state === 'down' ? w.clock - r.since : 0);
      closed += r.min.closed + (r.state === 'closed' ? w.clock - r.since : 0);
    });
    /* Attribute to whichever cause actually consumed the most room time.
       An earlier version short-circuited on crewShort, so a day that lost 800
       idle minutes because nothing could be started before the list closed
       still blamed "no crew" on the strength of 180 closed minutes. Weigh them
       all against each other, idle included. */
    var idle = 0;
    w.rooms.forEach(function (r) {
      idle += r.min.idle + (r.state === 'idle' ? w.clock - r.since : 0);
    });
    var causes = [
      { reason: 'no time',         weight: idle },
      { reason: 'no recovery bed', weight: blocked },
      { reason: 'equipment down',  weight: down },
      { reason: w.crewShort ? 'no crew' : 'no room open', weight: closed }
    ];
    var top = causes[0];
    causes.forEach(function (c) { if (c.weight > top.weight) top = c; });
    var reason = top.weight > 0 ? top.reason : 'no time';

    w.list.forEach(function (p) {
      if (p.status !== 'booked') return;
      if (w.supplyCap && w.supplyCap.type === p.type && w.supplyCap.remaining <= 0) cancel(w, p, 'no supply');
      else cancel(w, p, reason);
    });
  }

  function rollComplication(w, room, p) {
    var ct = CASE_TYPES[p.type];
    var f = crewFatigue(w, room);
    var risk = ct.baseRisk * (1 + RISK.fatigueGain * f) * (p.substitute ? (1 + RISK.substituteGain) : 1);
    if (!w.rng.bool(clamp(risk, 0, 0.9))) return;
    var escalated = w.rng.bool(RISK.escalationChance);
    p.complication = { escalated: escalated, fatigue: Math.round(f * 100) / 100 };
    p.recoveryMin += Math.round(w.rng.range(RISK.extraRecoveryMinutes[0], RISK.extraRecoveryMinutes[1]));
    if (escalated) p.inpatient = true;
    w.complications.push({ patient: p.id, type: p.type, escalated: escalated, at: w.clock });
    log(w, 'complication', p.typeLabel + ' complication' + (escalated ? ' — unplanned escalation' : ''),
        { patient: p.id });
  }

  /* ==========================================================================
     8. DECISIONS  —  options change the lab, never the KPIs
     ========================================================================== */

  var OPENING = {
    id: 'opening',
    tag: 'Staffing',
    title: 'Open the day',
    prompt: 'How do you staff the board?',
    options: [
      { id: 'full', label: 'Open every room, everyone on procedures',
        hint: 'Maximum room capacity, minimum recovery cover.',
        apply: function (w) {
          w.rooms.forEach(function (r) { openRoom(w, r); });
          freeStaff(w, 'nurse').forEach(function (s) { s.assign = 'recovery'; });
        } },
      { id: 'float', label: 'Hold a nurse back as a float',
        hint: 'One nurse spare to plug whatever breaks.',
        apply: function (w) {
          var spare = freeStaff(w, 'nurse')[0];
          if (spare) spare.assign = 'float';
          w.rooms.forEach(function (r) { openRoom(w, r); });
          freeStaff(w, 'nurse').forEach(function (s) { s.assign = 'recovery'; });
        } },
      { id: 'deep', label: 'Run one room, staff recovery deeply',
        hint: 'Fewer cases in flight, nothing gets stuck behind a bed.',
        apply: function (w) {
          openRoom(w, w.rooms[0]);
          freeStaff(w, 'nurse').forEach(function (s) { s.assign = 'recovery'; });
        } }
    ]
  };

  /* Note what is NOT in this deck: "recovery gridlock". Bed crunch is not an
     event any more — it is something the simulation does to you when your
     nurses, beds and ward cannot keep up. */
  var SHOCKS = [
    {
      id: 'sick-call', tag: 'Sick call', title: 'A recovery nurse calls in',
      window: [430, 470],
      arrive: function (w) {
        var pool = staffOf(w, 'nurse', 'recovery').concat(freeStaff(w, 'nurse'));
        var victim = pool[0] || w.staff.filter(function (s) { return s.role === 'nurse' && s.present; })[0];
        w._sick = victim || null;
        if (victim) { victim.present = false; victim.leftAt = w.clock; victim.assign = null; }
      },
      prompt: 'You are a nurse down with a full afternoon ahead.',
      options: [
        { id: 'float', label: 'Move the float into recovery',
          hint: 'Free if you kept one back. Costs you a room if you did not.',
          apply: function (w) {
            var f = staffOf(w, 'nurse', 'float')[0];
            if (f) { f.assign = 'recovery'; return; }
            // No float held back: the nurse has to come off a room, and the
            // room goes with them.
            var open = w.rooms.filter(function (r) { return r.open; });
            if (open.length > 1) { w.crewShort = true; closeRoom(w, open[open.length - 1], true); }
            else freeStaff(w, 'nurse').slice(0, 1).forEach(function (s) { s.assign = 'recovery'; });
          } },
        { id: 'agency', label: 'Call in an agency nurse',
          hint: 'Covered in about an hour, at a premium.',
          apply: function (w) {
            charge(w, 1400, 'agency nurse');
            var s = { id: 'nurse-agency', name: 'Agency', role: 'nurse', shiftEnd: TIMING.scheduledEnd,
                      assign: 'recovery', present: false, leftAt: null, leaveWhenFree: false,
                      missedBreaks: 0, nextBreak: 1e9, overtime: 0 };
            w.staff.push(s);
            w.q.push(w.clock + 60, 'AGENCY_ARRIVES', { staff: s.id });
          } },
        { id: 'short', label: 'Run recovery short',
          hint: 'Fewer beds you can actually use.',
          apply: function () { /* no mitigation — fewer nurses means fewer usable beds */ } }
      ]
    },
    {
      id: 'ward-block', tag: 'Ward', title: 'The ward has no beds',
      window: [560, 640],
      arrive: function (w) { w.wardFree = 0; },
      prompt: 'Inpatients coming out of your cases have nowhere to go.',
      options: [
        { id: 'hold', label: 'Hold them in recovery',
          hint: 'Clinically safe. Your beds stop turning over.',
          apply: function () { /* nothing — the block is the consequence */ } },
        { id: 'escalate', label: 'Escalate to bed management',
          hint: 'Beds start freeing sooner, at some cost.',
          apply: function (w) {
            charge(w, 700, 'bed management escalation');
            w.q.push(w.clock + 30, 'WARD_FREE', {});
            w.q.push(w.clock + 60, 'WARD_FREE', {});
          } },
        { id: 'divert', label: 'Send stable inpatients home same-day',
          hint: 'Frees beds now. Not every one of them should be going.',
          apply: function (w) {
            w.list.forEach(function (p) { if (p.inpatient && p.status !== 'discharged') p.inpatient = false; });
            w.list.forEach(function (p) {
              if (p.status === 'booked' && CASE_TYPES[p.type].baseRisk > 0.03) p.substitute = true;
            });
            releaseWardBlocked(w);
          } }
      ]
    },
    {
      id: 'emergency', tag: 'Emergency', title: 'Urgent inpatient ablation',
      window: [520, 620],
      arrive: function (w) {
        var ct = CASE_TYPES.vt;
        var p = {
          id: w.nextPatientId++, name: PATIENT_NAMES[w.rng.int(PATIENT_NAMES.length)],
          type: 'vt', typeLabel: ct.label + ' (urgent)',
          planned: ct.median, actual: Math.round(w.rng.lognormal(ct.median, ct.sigma)),
          recoveryMin: Math.round(w.rng.lognormal(ct.recovery, 0.22)),
          inpatient: true, acuity: 0, daysWaiting: 0, addOn: true, substitute: false,
          status: 'held', cancelReason: null, scheduledStart: w.clock,
          inRoomAt: null, outOfRoomAt: null, bedAt: null, dischargedAt: null,
          complication: null, room: null
        };
        w._urgent = p;
      },
      prompt: 'It has to happen today, or it has to happen somewhere else.',
      options: [
        { id: 'bump', label: 'Bump the next elective, take it now',
          hint: 'Right call clinically. Someone waiting a year goes back on the list.',
          apply: function (w) {
            var victim = null;
            for (var i = w.list.length - 1; i >= 0; i--) if (w.list[i].status === 'booked') { victim = w.list[i]; break; }
            if (victim) cancel(w, victim, 'bumped for emergency');
            w._urgent.status = 'booked';
            w.list.unshift(w._urgent);
          } },
        { id: 'append', label: 'Add it to the end of the list',
          hint: 'Everyone stays. Everyone stays late.',
          apply: function (w) {
            w._urgent.status = 'booked';
            w.list.push(w._urgent);
            w.otUntil = Math.max(w.otUntil, TIMING.scheduledEnd + 150);
          } },
        { id: 'divert', label: 'Divert to a partner site',
          hint: 'Your day stays intact. The handoff is the risk.',
          apply: function (w) {
            charge(w, 900, 'transfer to partner site');
            w._urgent.status = 'cancelled';
            w._urgent.cancelReason = 'diverted';
            w.list.push(w._urgent);
          } }
      ]
    },
    {
      id: 'equipment', tag: 'Equipment', title: 'Mapping system fault',
      window: [500, 600],
      arrive: function (w) {
        var open = w.rooms.filter(function (r) { return r.open; });
        w._faultRoom = open.length ? open[w.rng.int(open.length)] : w.rooms[0];
      },
      prompt: 'The 3D mapping system in ' + '{room}' + ' has thrown an error.',
      options: [
        { id: 'backup', label: 'Continue on backup imaging',
          hint: 'Keeps running. Every case in that room gets slower.',
          apply: function (w) { if (w._faultRoom) w._faultRoom.backupImaging = true; } },
        { id: 'biomed', label: 'Stand the room down for biomed',
          hint: 'Properly fixed, at the cost of the room.',
          apply: function (w) {
            var r = w._faultRoom;
            if (!r) return;
            var down = 30 + Math.round(w.rng.range(0, 30));
            if (r.state === 'idle' || r.state === 'closed') {
              setRoomState(w, r, 'down');
              w.q.push(w.clock + down, 'ROOM_UP', { room: r.id });
            } else {
              r.downAfter = down;
            }
          } },
        { id: 'shift', label: 'Move the list to the other room',
          hint: 'Only helps if there is another room to move to.',
          apply: function (w) {
            var r = w._faultRoom;
            if (!r) return;
            var others = w.rooms.filter(function (x) { return x.id !== r.id && x.open; });
            if (!others.length) { r.backupImaging = true; return; }   // nowhere to move it
            charge(w, 350, 'room changeover');
            if (r.state === 'idle' || r.state === 'closed') closeRoom(w, r, true);
            else r.closeAfterCase = true;
          } }
      ]
    },
    {
      id: 'supply', tag: 'Supply', title: 'Low on ablation catheters',
      window: [480, 580],
      arrive: function (w) { w.supplyCap = { type: 'af', remaining: 2 }; },
      prompt: 'Enough stock for about two more AF cases before the resupply.',
      options: [
        { id: 'ration', label: 'Ration to the highest-acuity patients',
          hint: 'The rest wait for the resupply.',
          apply: function (w) {
            var af = w.list.filter(function (p) { return p.status === 'booked' && p.type === 'af'; });
            af.sort(function (a, b) { return a.acuity - b.acuity; });
            af.slice(2).forEach(function (p) { cancel(w, p, 'no supply'); });
            w.supplyCap = null;
          } },
        { id: 'courier', label: 'Courier stock from another site',
          hint: 'Flow holds. It is not cheap.',
          apply: function (w) { charge(w, 1100, 'courier resupply'); w.supplyCap = null; } },
        { id: 'substitute', label: 'Switch to a substitute catheter',
          hint: 'Keeps every case on the board. Not the team\'s first choice.',
          apply: function (w) {
            w.list.forEach(function (p) { if (p.status === 'booked' && p.type === 'af') p.substitute = true; });
            w.supplyCap = null;
          } }
      ]
    },
    {
      id: 'tech-leaves', tag: 'Staff gap', title: 'A technologist has to leave',
      window: [600, 700],
      arrive: function (w) {
        var techs = w.staff.filter(function (s) { return s.role === 'tech' && s.present; });
        w._leaver = techs.length ? techs[techs.length - 1] : null;
      },
      prompt: 'Family emergency. They are asking to go after the current case.',
      options: [
        { id: 'go', label: 'Send them home now',
          hint: 'Right thing to do. The room may not survive it.',
          apply: function (w) { if (w._leaver) departIfFree(w, w._leaver); } },
        { id: 'one-more', label: 'Ask for one more case',
          hint: 'One more case, and a debt you will pay later.',
          apply: function (w) {
            if (!w._leaver) return;
            w._leaver.missedBreaks += 1;
            w.q.push(w.clock + 120, 'STAFF_LEAVE', { staff: w._leaver.id });
          } },
        { id: 'close', label: 'Close that room for the afternoon',
          hint: 'Everyone goes home whole. The list does not.',
          apply: function (w) {
            if (!w._leaver) return;
            var room = (typeof w._leaver.assign === 'number') ? w.rooms[w._leaver.assign] : null;
            departIfFree(w, w._leaver);
            if (!room || !room.open) return;
            w.crewShort = true;
            if (room.state === 'idle' || room.state === 'closed') closeRoom(w, room, true);
            else room.closeAfterCase = true;
          } }
      ]
    },
    {
      id: 'add-on', tag: 'Add-on', title: 'A "quick" add-on',
      window: [470, 560],
      arrive: function (w) {
        var ct = CASE_TYPES.svt;
        w._addon = {
          id: w.nextPatientId++, name: PATIENT_NAMES[w.rng.int(PATIENT_NAMES.length)],
          type: 'svt', typeLabel: ct.label + ' (add-on)',
          planned: ct.median, actual: Math.round(w.rng.lognormal(ct.median, ct.sigma)),
          recoveryMin: Math.round(w.rng.lognormal(ct.recovery, 0.22)),
          inpatient: false, acuity: 2 + w.rng.int(3), daysWaiting: 40, addOn: true, substitute: false,
          status: 'held', cancelReason: null, scheduledStart: w.clock,
          inRoomAt: null, outOfRoomAt: null, bedAt: null, dischargedAt: null,
          complication: null, room: null
        };
      },
      prompt: 'A staff cardiologist wants their patient squeezed in today.',
      options: [
        { id: 'fit', label: 'Fit it in',
          hint: 'Say yes and find out whether the day had room.',
          apply: function (w) { w._addon.status = 'booked'; w.list.push(w._addon); } },
        { id: 'decline', label: 'Offer them tomorrow',
          hint: 'Protect the plan you already made.',
          apply: function () { /* the add-on simply never enters the list */ } },
        { id: 'triage', label: 'Take it only if it is urgent',
          hint: 'Let acuity decide instead of the corridor.',
          apply: function (w) { if (w._addon.acuity <= 2) { w._addon.status = 'booked'; w.list.push(w._addon); } } }
      ]
    }
  ];

  /* ==========================================================================
     9. THE RUN
     ========================================================================== */

  function runDay(opts) {
    opts = opts || {};
    var config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    var seed = (opts.seed >>> 0) || 1;
    var rng = rngFrom(seed);
    var w = buildWorld(config, rng);
    var policy = opts.policy || function () { return undefined; };

    // Draw the day's shocks and place them on the clock.
    var drawn = rng.shuffle(SHOCKS).slice(0, clamp(config.shockCount, 0, SHOCKS.length));
    drawn.sort(function (a, b) { return a.window[0] - b.window[0]; });

    var agenda = [{ kind: 'opening', def: OPENING, t: TIMING.dayStart }];
    drawn.forEach(function (sh) {
      agenda.push({ kind: 'shock', def: sh, t: Math.round(rng.range(sh.window[0], sh.window[1])) });
    });
    /* Shock times are drawn inside overlapping windows, so the order the
       agenda was built in is NOT the order the decisions reach the player.
       Sort by the time actually drawn before registering them. */
    agenda.sort(function (x, y) { return x.t - y.t; });
    agenda.forEach(function (a, i) { w.q.push(a.t, 'DECISION', { index: i }); });

    /* Player-initiated actions. The scripted decisions are things the day does
       TO you; these are things you do to the day, at a moment you choose. They
       are timestamped and replayed, so the run stays a pure function of
       (config, seed, decisions, actions) and "play the same day again" is exact. */
    w.actions = (opts.actions || []).slice().sort(function (x, y) { return x.t - y.t; });
    w.actions.forEach(function (a, i) { w.q.push(a.t, 'ACTION', { i: i }); });

    // Standing events.
    w.q.push(TIMING.dayStart + WARD.releaseEvery, 'WARD_FREE', {});
    w.q.push(TIMING.hardStop, 'END_OF_DAY', {});
    w.staff.forEach(function (s) {
      w.q.push(s.nextBreak, 'BREAK_DUE', { staff: s.id });
      w.q.push(s.shiftEnd, 'SHIFT_END', { staff: s.id });
    });

    var pending = null, guard = 0;

    while (w.q.size()) {
      if (++guard > 50000) throw new Error('sim did not terminate — runaway event at ' + w.clock);
      var ev = w.q.pop();
      w.clock = Math.max(w.clock, ev.t);

      if (ev.type === 'DECISION') {
        var a = agenda[ev.data.index];
        if (a.def.arrive) a.def.arrive(w);
        /* The index a policy sees is the decision's position in the sequence it
           is actually asked in — not its slot in the agenda. replay(), the
           solver and the coach all address choices positionally, so anything
           else silently answers one decision with another's choice. */
        var ctx = context(w, a, w.decisions.length);
        var choice = policy(ctx);
        if (choice === undefined || choice === null) { pending = ctx; break; }
        var opt = resolveOption(a.def, choice);
        if (!opt) throw new Error('unknown option "' + choice + '" for decision ' + a.def.id);
        opt.apply(w);
        w.decisions.push({ decision: a.def.id, option: opt.id, label: opt.label, t: w.clock });
        log(w, 'decision', a.def.title + ' — ' + opt.label);
      } else if (ev.type === 'ACTION') {
        applyAction(w, w.actions[ev.data.i]);
      } else if (ev.type === 'AGENCY_ARRIVES') {
        var ag = staffById(w, ev.data.staff);
        if (ag) { ag.present = true; log(w, 'staff', 'Agency nurse arrived'); }
      } else if (ev.type === 'STAFF_LEAVE') {
        var sl = staffById(w, ev.data.staff);
        if (sl && sl.present) departIfFree(w, sl);
      } else {
        handle(w, ev);
      }

      dispatch(w);

      // The day is over when the clock is past the hard stop and there is
      // nothing left in a room or a bed. Anything still 'booked' was swept by
      // END_OF_DAY; anything still in flight is counted as unfinished.
      if (w.clock >= TIMING.hardStop && !anythingActive(w)) break;
    }

    if (!pending) finalize(w);
    else {
      /* Halted mid-day for a decision. Intervals are only written when a room
         CHANGES state, so whatever each room is doing right now has not been
         recorded yet — which means a live board would draw everything except
         the case actually in progress. Emit the open intervals; `to: Infinity`
         lets the board clamp them to wherever its clock has reached. */
      w.rooms.forEach(function (r) {
        w.intervals.push({ room: r.id, state: r.state, from: r.since, to: Infinity, open: true,
                           patient: r.patient ? r.patient.id : r.lastPatient });
      });
    }

    return {
      pending: pending,
      done: !pending,
      clock: w.clock,
      decisions: w.decisions,
      patients: w.list,
      timeline: w.timeline,
      intervals: w.intervals,
      metrics: collect(w),
      world: w
    };
  }

  /* ---- player actions ------------------------------------------------------
     Each one changes the lab and nothing else. None of them touch a KPI. What
     they cost you shows up because the day then runs differently. */
  var ACTIONS = {
    'overtime': {
      label: 'Authorise overtime', hint: 'Keep starting cases 90 min past 17:00.',
      icon: 'ti-clock-plus',
      can: function (w) { return w.otUntil < TIMING.scheduledEnd + 90; },
      apply: function (w) {
        w.otUntil = Math.max(w.otUntil, TIMING.scheduledEnd + 90);
        log(w, 'action', 'Overtime authorised to ' + hhmm(w.otUntil));
      }
    },
    'open-room': {
      label: 'Open another room', hint: 'Only works if you have the crew standing free.',
      icon: 'ti-door-enter',
      can: function (w) {
        return w.rooms.some(function (r) { return !r.open; }) &&
               freeStaff(w, 'ep').length >= CREW_PER_ROOM.ep &&
               freeStaff(w, 'nurse').length >= CREW_PER_ROOM.nurse &&
               freeStaff(w, 'tech').length >= CREW_PER_ROOM.tech;
      },
      apply: function (w) {
        for (var i = 0; i < w.rooms.length; i++) {
          if (!w.rooms[i].open && openRoom(w, w.rooms[i])) {
            log(w, 'action', w.rooms[i].label + ' opened'); return;
          }
        }
        log(w, 'action', 'No room could be staffed');
      }
    },
    'agency-nurse': {
      label: 'Call an agency nurse', hint: 'Arrives in an hour. $1,400.',
      icon: 'ti-phone-call',
      can: function () { return true; },
      apply: function (w) {
        charge(w, 1400, 'agency nurse');
        var s = { id: 'nurse-agency-' + w.staff.length, name: 'Agency', role: 'nurse',
                  shiftEnd: TIMING.scheduledEnd, assign: 'recovery', present: false, leftAt: null,
                  leaveWhenFree: false, missedBreaks: 0, nextBreak: 1e9, overtime: 0 };
        w.staff.push(s);
        w.q.push(w.clock + 60, 'AGENCY_ARRIVES', { staff: s.id });
        log(w, 'action', 'Agency nurse called — arrives ' + hhmm(w.clock + 60));
      }
    },
    'cancel-last': {
      label: 'Cancel the last case', hint: 'Protect the rest of the day. Someone goes back on the list.',
      icon: 'ti-calendar-x',
      can: function (w) { return w.list.some(function (p) { return p.status === 'booked'; }); },
      apply: function (w) {
        for (var i = w.list.length - 1; i >= 0; i--) {
          if (w.list[i].status === 'booked') { cancel(w, w.list[i], 'cancelled by you'); return; }
        }
      }
    }
  };

  function applyAction(w, a) {
    if (!a) return;
    var def = ACTIONS[a.type];
    if (!def) throw new Error('unknown action "' + a.type + '"');
    if (!def.can(w)) { log(w, 'action', def.label + ' — no longer possible'); return; }
    def.apply(w);
  }

  /* What the player can do right now, for the action bar. */
  function availableActions(w) {
    return Object.keys(ACTIONS).map(function (k) {
      return { type: k, label: ACTIONS[k].label, hint: ACTIONS[k].hint,
               icon: ACTIONS[k].icon, enabled: ACTIONS[k].can(w) };
    });
  }

  function resolveOption(def, choice) {
    if (typeof choice === 'number') return def.options[choice] || null;
    for (var i = 0; i < def.options.length; i++) if (def.options[i].id === choice) return def.options[i];
    return null;
  }

  function context(w, a, index) {
    var prompt = a.def.prompt;
    if (a.def.id === 'equipment' && w._faultRoom) prompt = prompt.replace('{room}', w._faultRoom.label);
    return {
      index: index,
      id: a.def.id,
      tag: a.def.tag,
      title: a.def.title,
      prompt: prompt,
      time: w.clock,
      options: a.def.options.map(function (o, i) { return { index: i, id: o.id, label: o.label, hint: o.hint }; }),
      snapshot: snapshot(w)
    };
  }

  /* What the dashboard renders mid-day. Read-only. */
  function snapshot(w) {
    return {
      clock: w.clock,
      rooms: w.rooms.map(function (r) {
        return { id: r.id, label: r.label, state: r.state, open: r.open,
                 patient: r.patient ? { id: r.patient.id, label: r.patient.typeLabel } : null };
      }),
      beds: { total: w.beds.length, usable: usableBeds(w),
              occupied: w.beds.filter(function (b) { return b.patient; }).length,
              wardBlocked: w.wardBlocked.length },
      ward: { free: w.wardFree },
      staff: w.staff.filter(function (s) { return s.present; }).map(function (s) {
        return { id: s.id, name: s.name, role: s.role, assign: s.assign,
                 fatigue: Math.round(fatigueOf(w, s) * 100) / 100, missedBreaks: s.missedBreaks };
      }),
      list: {
        booked: w.list.filter(function (p) { return p.status === 'booked'; }).length,
        inRoom: w.list.filter(function (p) { return p.status === 'in-room'; }).length,
        recovery: w.list.filter(function (p) { return p.status === 'recovery'; }).length,
        discharged: w.list.filter(function (p) { return p.status === 'discharged'; }).length,
        cancelled: w.list.filter(function (p) { return p.status === 'cancelled'; }).length
      }
    };
  }

  function finalize(w) {
    w.rooms.forEach(function (r) {
      r.min[r.state] += w.clock - r.since;
      if (w.clock > r.since) {
        w.intervals.push({ room: r.id, state: r.state, from: r.since, to: w.clock,
                           patient: r.patient ? r.patient.id : r.lastPatient });
      }
      r.since = w.clock;
    });
    w.beds.forEach(function (b) {
      if (b.patient) {
        b.occupiedMin += w.clock - b.since;
        if (b.patient.wardWaitFrom) b.wardBlockedMin += w.clock - b.patient.wardWaitFrom;
      }
      b.since = w.clock;
    });
    w.staff.forEach(function (s) {
      if (s.present) { s.leftAt = w.clock; s.overtime = Math.max(0, w.clock - s.shiftEnd); s.present = false; }
    });
  }

  /* ==========================================================================
     10. METRICS  —  everything below is derived, nothing is authored
     ========================================================================== */

  function collect(w) {
    var list = w.list;
    var completed = list.filter(function (p) { return p.status === 'discharged'; });
    var cancelled = list.filter(function (p) { return p.status === 'cancelled'; });
    var inFlight = list.filter(function (p) { return p.status === 'in-room' || p.status === 'recovery'; });
    var booked = list.filter(function (p) { return !p.addOn; }).length;
    var addOns = list.filter(function (p) { return p.addOn; }).length;

    // ---- room time ----------------------------------------------------------
    var roomMin = { closed: 0, idle: 0, setup: 0, procedure: 0, turnover: 0, blocked: 0, down: 0 };
    w.rooms.forEach(function (r) { for (var k in roomMin) roomMin[k] += r.min[k]; });
    var openMin = roomMin.idle + roomMin.setup + roomMin.procedure + roomMin.turnover + roomMin.blocked + roomMin.down;
    var primeTime = w.rooms.length * (TIMING.scheduledEnd - TIMING.dayStart);

    // ---- delay & access -----------------------------------------------------
    var delays = completed.filter(function (p) { return p.inRoomAt !== null; })
                          .map(function (p) { return Math.max(0, p.inRoomAt - Math.max(p.scheduledStart, TIMING.dayStart)); });
    var fcots = w.rooms.filter(function (r) { return r.firstCaseInRoomAt !== null; });
    var fcotsOnTime = fcots.filter(function (r) { return r.firstCaseInRoomAt <= TIMING.firstCaseTarget; }).length;

    // ---- staff --------------------------------------------------------------
    var overtimeMinutes = sum(w.staff.map(function (s) { return s.overtime || 0; }));
    var missedBreaks = sum(w.staff.map(function (s) { return s.missedBreaks; }));
    var fatigues = w.staff.map(function (s) { return fatigueOf(w, s); });

    // ---- cost ---------------------------------------------------------------
    var staffCost = 0;
    w.staff.forEach(function (s) {
      var end = s.leftAt || w.clock;
      var regular = Math.max(0, Math.min(end, s.shiftEnd) - TIMING.dayStart) / 60;
      var over = Math.max(0, end - s.shiftEnd) / 60;
      var rate = COSTS.hourly[s.role] || 0;
      staffCost += regular * rate + over * rate * COSTS.overtimeMultiplier;
    });
    var roomCost = (openMin / 60) * COSTS.roomHour;
    var bedCost = sum(w.beds.map(function (b) { return b.occupiedMin; })) / 60 * COSTS.bedHour;
    var supplyCost = sum(completed.map(function (p) { return CASE_TYPES[p.type].supply; }));
    var totalCost = staffCost + roomCost + bedCost + supplyCost + w.extraCost;
    var funding = sum(completed.map(function (p) { return CASE_TYPES[p.type].funding; }));

    // ---- cancellations by reason -------------------------------------------
    var byReason = {};
    cancelled.forEach(function (p) { byReason[p.cancelReason] = (byReason[p.cancelReason] || 0) + 1; });

    var m = {
      // throughput
      booked: booked,
      addOns: addOns,
      scheduled: list.length,
      completed: completed.length,
      cancelled: cancelled.length,
      unfinished: inFlight.length,
      cancelledByReason: byReason,
      caseMix: countBy(completed, 'type'),

      // flow
      firstCaseOnTime: fcotsOnTime,
      firstCaseRooms: fcots.length,
      firstCaseOnTimePct: fcots.length ? fcotsOnTime / fcots.length : 0,
      medianTurnover: Math.round(median(w.turnovers)),
      meanDelayMin: delays.length ? Math.round(sum(delays) / delays.length) : 0,
      p90DelayMin: Math.round(percentile(delays, 0.9)),
      roomMinutes: roomMin,
      roomOpenMinutes: openMin,
      utilisation: openMin ? roomMin.procedure / openMin : 0,
      primeTimeUtilisation: primeTime ? roomMin.procedure / primeTime : 0,
      blockedMinutes: roomMin.blocked,
      wardBlockedBedMinutes: sum(w.beds.map(function (b) { return b.wardBlockedMin; })),

      // access
      medianDaysWaitedCompleted: Math.round(median(completed.map(function (p) { return p.daysWaiting; }))),
      medianDaysWaitedCancelled: Math.round(median(cancelled.map(function (p) { return p.daysWaiting; }))),
      longestWaiterCancelled: cancelled.length ? Math.max.apply(null, cancelled.map(function (p) { return p.daysWaiting; })) : 0,
      /* Share of the list sent away, weighted by how long those particular
         patients had already been waiting. Cancelling the person who has waited
         14 months is not the same as cancelling the one booked last week — so
         WHICH case you cancel matters, not just how many. */
      deferredHarm: (booked + addOns) ? clamp(
        cancelled.length / (booked + addOns) *
        (cancelled.length ? sum(cancelled.map(function (p) {
          return clamp(p.daysWaiting / SCALE.deferredHarmAtOneYear, 0, 1);
        })) / cancelled.length : 0), 0, 1) : 0,

      // staff
      staffCount: w.staff.length,
      overtimeMinutes: Math.round(overtimeMinutes),
      overtimePerHead: Math.round(overtimeMinutes / Math.max(1, w.staff.length)),
      missedBreaks: missedBreaks,
      meanFatigue: fatigues.length ? Math.round(sum(fatigues) / fatigues.length * 100) / 100 : 0,
      maxFatigue: fatigues.length ? Math.round(Math.max.apply(null, fatigues) * 100) / 100 : 0,
      finishedAt: Math.round(lastActivity(w)),          // last patient out of the department
      lastCaseOutAt: Math.round(lastOutOfRoom(w)),      // last patient out of a procedure room
      ranLateMinutes: Math.round(Math.max(0, lastOutOfRoom(w) - TIMING.scheduledEnd)),

      // quality
      complications: w.complications.length,
      escalations: w.complications.filter(function (c) { return c.escalated; }).length,
      complicationRate: completed.length ? w.complications.length / completed.length : 0,

      // finance
      staffCost: Math.round(staffCost),
      roomCost: Math.round(roomCost),
      bedCost: Math.round(bedCost),
      supplyCost: Math.round(supplyCost),
      decisionCost: Math.round(w.extraCost),
      decisionCostLog: w.extraCostLog,
      totalCost: Math.round(totalCost),
      costPerCase: completed.length ? Math.round(totalCost / completed.length) : Math.round(totalCost),
      funding: Math.round(funding),
      margin: Math.round(funding - totalCost)
    };

    m.waterfall = waterfall(m, roomMin);
    m.lostTime = lostTime(roomMin, completed);
    m.kpis = kpis(m);
    return m;
  }

  /* When the lab actually stopped working — the last patient out of a room or
     out of recovery, not when the event queue happened to drain. */
  function lastActivity(w) {
    var t = TIMING.dayStart;
    w.list.forEach(function (p) {
      if (p.outOfRoomAt) t = Math.max(t, p.outOfRoomAt);
      if (p.dischargedAt) t = Math.max(t, p.dischargedAt);
    });
    return t;
  }

  function lastOutOfRoom(w) {
    var t = TIMING.dayStart;
    w.list.forEach(function (p) { if (p.outOfRoomAt) t = Math.max(t, p.outOfRoomAt); });
    return t;
  }

  function countBy(arr, key) {
    var out = {};
    arr.forEach(function (x) { out[x[key]] = (out[x[key]] || 0) + 1; });
    return out;
  }

  /* The headline panel: every case that did not happen, attributed to a cause. */
  function waterfall(m, roomMin) {
    var rows = [{ kind: 'start', label: 'Booked', cases: m.booked }];
    if (m.addOns) rows.push({ kind: 'gain', label: 'Add-ons accepted', cases: m.addOns });
    var order = ['bumped for emergency', 'no recovery bed', 'no crew', 'no room open',
                 'equipment down', 'no supply', 'no time', 'diverted'];
    var seen = {};
    order.forEach(function (r) {
      if (m.cancelledByReason[r]) { rows.push({ kind: 'loss', label: r, cases: -m.cancelledByReason[r] }); seen[r] = 1; }
    });
    Object.keys(m.cancelledByReason).forEach(function (r) {
      if (!seen[r]) rows.push({ kind: 'loss', label: r, cases: -m.cancelledByReason[r] });
    });
    if (m.unfinished) rows.push({ kind: 'loss', label: 'still in the lab at close', cases: -m.unfinished });
    rows.push({ kind: 'end', label: 'Completed', cases: m.completed });
    return rows;
  }

  /* Room time that produced nothing, in cases-equivalent. */
  function lostTime(roomMin, completed) {
    var meanCase = completed.length
      ? sum(completed.map(function (p) { return (p.outOfRoomAt - p.inRoomAt) || CASE_TYPES[p.type].median; })) / completed.length
      : 120;
    function row(label, minutes) {
      return { label: label, minutes: Math.round(minutes), casesEquivalent: Math.round(minutes / meanCase * 10) / 10 };
    }
    return [
      row('blocked — no recovery bed', roomMin.blocked),
      row('equipment down', roomMin.down),
      row('turnover', roomMin.turnover),
      row('setup', roomMin.setup),
      row('idle — nothing to run', roomMin.idle),
      row('closed — no crew', roomMin.closed)
    ];
  }

  /* ==========================================================================
     11. SCORING  —  same four components as v7, now built from real metrics
     ========================================================================== */

  function kpis(m) {
    var heads = Math.max(1, m.staffCount);
    var otPerHead = m.overtimeMinutes / heads;
    var breaksPerHead = m.missedBreaks / heads;
    /* Safety is risk exposure, not just realised harm. A day with no
       complication that was run by an exhausted team was not a safe day — it
       was a lucky one, and the model should not reward luck. And a patient
       sent back to the waiting list has been harmed too. */
    var mix = SCALE.safetyMix;
    return {
      through: (m.booked + m.addOns) ? clamp(m.completed / (m.booked + m.addOns), 0, 1) : 1,
      safety: clamp(mix.harm * clamp(1 - m.complicationRate / SCALE.complicationRateAtZero, 0, 1)
                  + mix.fatigue * (1 - m.maxFatigue)
                  + mix.deferred * (1 - m.deferredHarm), 0, 1),
      staff: clamp(1 - (otPerHead / SCALE.overtimeMinutesPerHead * 0.6
                      + breaksPerHead / SCALE.missedBreaksPerHead * 0.4), 0, 1),
      cost: clamp(1 - m.costPerCase / SCALE.costPerCaseAtZero, 0, 1)
    };
  }

  function score(metrics, weights) {
    var w = weights || PROFILES.balanced.w, k = metrics.kpis || kpis(metrics);
    return w.safety * k.safety + w.through * k.through + w.staff * k.staff + w.cost * k.cost;
  }

  /* ==========================================================================
     12. SOLVER  —  the v5/v6/v7 machinery, unchanged in spirit
     Same seed for every path (common random numbers), so differences between
     paths are the decisions, not the luck.
     ========================================================================== */

  function enumerate(config, seed, weights) {
    var w = weights || PROFILES.balanced.w;

    // How many decisions, and how many options each — discovered by walking the
     // day once, not assumed to be 3^4. Add a fourth shock or a fifth option and
     // the solver picks it up with no change here.
    var widths = [], path = [];
    while (true) {
      var r = runDay({ config: config, seed: seed, policy: replay(path) });
      if (!r.pending) break;
      widths.push(r.pending.options.length);
      path.push(0);
    }

    var results = [];
    var total = widths.reduce(function (a, b) { return a * b; }, 1);
    for (var n = 0; n < total; n++) {
      var v = [], x = n;
      for (var i = widths.length - 1; i >= 0; i--) { v[i] = x % widths[i]; x = Math.floor(x / widths[i]); }
      var run = runDay({ config: config, seed: seed, policy: replay(v) });
      results.push({ path: v, score: score(run.metrics, w), metrics: run.metrics });
    }

    results.sort(function (a, b) { return a.score - b.score; });
    var dist = results.map(function (r) { return r.score; });
    return {
      paths: results,
      dist: dist,
      widths: widths,
      best: results[results.length - 1],
      worst: results[0],
      average: sum(dist) / dist.length,
      percentileOf: function (s) {
        var n = 0;
        for (var i = 0; i < dist.length; i++) if (dist[i] <= s + 1e-9) n++;
        return n / dist.length;
      }
    };
  }

  /* A policy that plays a fixed list of choices and then stops. */
  function replay(choices) {
    return function (ctx) { return ctx.index < choices.length ? choices[ctx.index] : undefined; };
  }

  /* Best score reachable from a partial line of play, assuming you keep playing
     well afterwards. Re-runs the day from scratch at each node — wasteful on
     paper, ~0.07 ms a run in practice. */
  function bestFrom(config, seed, path, w) {
    var r = runDay({ config: config, seed: seed, policy: replay(path) });
    if (!r.pending) return { score: score(r.metrics, w), metrics: r.metrics, path: path, run: r };
    var best = null;
    for (var i = 0; i < r.pending.options.length; i++) {
      var cand = bestFrom(config, seed, path.concat([i]), w);
      if (!best || cand.score > best.score) best = cand;
    }
    return best;
  }

  /* The counterfactual coach.
     v7 could only ever tell you a choice's authored KPI delta. Because a day is
     deterministic given its seed, this can do something better and true: replay
     the SAME day under each option you did not take and report what actually
     would have happened. "Yours ends at 5 cases; holding the room reaches 6 but
     costs 95 minutes of overtime" is measured, not written. */
  function evaluateOptions(config, seed, prior, weights) {
    var w = weights || PROFILES.balanced.w;
    var probe = runDay({ config: config, seed: seed, policy: replay(prior || []) });
    if (!probe.pending) return null;
    var base = prior || [];
    return {
      context: probe.pending,
      options: probe.pending.options.map(function (o, i) {
        var b = bestFrom(config, seed, base.concat([i]), w);
        return { index: i, id: o.id, label: o.label, hint: o.hint,
                 score: b.score, metrics: b.metrics, bestPath: b.path };
      })
    };
  }

  /* ==========================================================================
     13. SELF-TEST
     ========================================================================== */

  function selfTest(verbose) {
    var fails = [];
    function check(name, ok, detail) {
      if (!ok) fails.push(name + (detail ? ' — ' + detail : ''));
      if (verbose) console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
    }

    /* A demand the lab can genuinely contest. Book 12 into two rooms and the
       throughput KPI caps around 0.4 for every path, which makes it a dead
       lever and hides whether the weights do anything. */
    var cfg = { cases: 7, rooms: 2, phys: 2, nurses: 5, techs: 4, beds: 4 };

    // determinism
    var a = runDay({ config: cfg, seed: 42, policy: replay([0, 0, 0, 0]) });
    var b = runDay({ config: cfg, seed: 42, policy: replay([0, 0, 0, 0]) });
    check('deterministic for a fixed seed',
      JSON.stringify(a.metrics) === JSON.stringify(b.metrics));

    var c = runDay({ config: cfg, seed: 43, policy: replay([0, 0, 0, 0]) });
    check('different seeds give different days',
      JSON.stringify(a.metrics) !== JSON.stringify(c.metrics));

    // conservation — every patient is accounted for exactly once
    var seeds = [1, 7, 19, 55, 101, 404, 900, 1234];
    var conserved = true, negative = false, overBeds = false, detail = '';
    seeds.forEach(function (s) {
      for (var p0 = 0; p0 < 3; p0++) {
        var r = runDay({ config: cfg, seed: s, policy: replay([p0, p0, p0, p0]) });
        var m = r.metrics;
        if (m.completed + m.cancelled + m.unfinished !== m.scheduled) {
          conserved = false;
          detail = 'seed ' + s + ': ' + m.completed + '+' + m.cancelled + '+' + m.unfinished + ' != ' + m.scheduled;
        }
        for (var k in m.roomMinutes) if (m.roomMinutes[k] < -1e-9) negative = true;
        var occ = r.world.beds.filter(function (bd) { return bd.patient; }).length;
        if (occ > cfg.beds) overBeds = true;
      }
    });
    check('patients conserved (completed + cancelled + in-flight = scheduled)', conserved, detail);
    check('no negative room minutes', !negative);
    check('recovery beds never over capacity', !overBeds);

    // THE test: the lab configuration constrains throughput.
    // In v7 this was false — cases done was independent of the lab.
    var small = 0, large = 0;
    seeds.forEach(function (s) {
      small += runDay({ config: { cases: 14, rooms: 1, phys: 1, nurses: 3, techs: 2, beds: 2 },
                        seed: s, policy: replay([0, 0, 0, 0]) }).metrics.completed;
      large += runDay({ config: { cases: 14, rooms: 3, phys: 3, nurses: 8, techs: 6, beds: 8 },
                        seed: s, policy: replay([0, 0, 0, 0]) }).metrics.completed;
    });
    check('a bigger lab completes more cases', large > small,
      'small ' + small + ' vs large ' + large + ' over ' + seeds.length + ' seeds');

    // decisions must move throughput too
    var spread = {};
    var e = enumerate(cfg, 42, PROFILES.balanced.w);
    e.paths.forEach(function (p) { spread[p.metrics.completed] = 1; });
    check('decisions change how many cases get done', Object.keys(spread).length > 1,
      'distinct completed counts: ' + Object.keys(spread).sort().join(','));
    check('enumeration covers every path', e.paths.length === e.widths.reduce(function (x, y) { return x * y; }, 1),
      e.paths.length + ' paths, widths ' + e.widths.join('x'));

    /* The v7 design principle, as a test: "best" has to move with the value
       system, or the priority selector is decoration.

       Asserted ACROSS seeds, not on one. Profiles genuinely agree on a good
       share of days — that is the model being honest, not broken — so a
       single-seed assertion is a coin flip that fails at random, which is
       exactly what it did. The real property is that priorities change the
       answer on a meaningful fraction of days. */
    var probeSeeds = [3, 11, 29, 47, 61, 83, 97, 113, 131, 149, 167, 181];
    var diverged = 0, sample = '';
    probeSeeds.forEach(function (s) {
      var seen = {}, paths = {};
      Object.keys(PROFILES).forEach(function (k) {
        paths[k] = enumerate(cfg, s, PROFILES[k].w).best.path.join('');
        seen[paths[k]] = 1;
      });
      if (Object.keys(seen).length > 1) {
        diverged++;
        if (!sample) sample = 'e.g. seed ' + s + ' ' +
          Object.keys(PROFILES).map(function (k) { return k.slice(0, 4) + ':' + paths[k]; }).join(' ');
      }
    });
    check('priorities change the best line on a real share of days',
      diverged >= 3, diverged + '/' + probeSeeds.length + ' days diverge · ' + (sample || 'none diverged'));

    // cancellations are attributed
    var attributed = true;
    e.paths.forEach(function (p) {
      var total = 0;
      for (var k in p.metrics.cancelledByReason) total += p.metrics.cancelledByReason[k];
      if (total !== p.metrics.cancelled) attributed = false;
    });
    check('every cancelled case has a reason', attributed);

    // the waterfall must actually balance
    var balances = true, wf = null;
    e.paths.forEach(function (p) {
      var t = 0;
      p.metrics.waterfall.forEach(function (row) { if (row.kind !== 'end') t += row.cases; });
      var end = p.metrics.waterfall[p.metrics.waterfall.length - 1].cases;
      if (t !== end) { balances = false; wf = JSON.stringify(p.metrics.waterfall); }
    });
    check('waterfall balances to cases completed', balances, wf || '');

    // The lab has to stop at a plausible hour. Worst reachable case is an
    // urgent VT appended under authorised overtime that then overruns:
    // otUntil(19:30) + (2.2 - 1) x 300 planned = 25:30.
    var latest = 0;
    seeds.forEach(function (s) {
      for (var p1 = 0; p1 < 3; p1++) {
        latest = Math.max(latest, runDay({ config: cfg, seed: s, policy: replay([p1, p1, p1, p1]) }).metrics.lastCaseOutAt);
      }
    });
    check('the lab stops at a plausible hour', latest <= TIMING.hardStop + 420, 'last case out ' + hhmm(latest));

    // The blocking cascade must actually be reachable: starve the beds and the
    // rooms should stall waiting for recovery.
    var blockedSeen = 0;
    seeds.forEach(function (s) {
      var r = runDay({ config: { cases: 12, rooms: 3, phys: 3, nurses: 8, techs: 6, beds: 1 },
                       seed: s, policy: replay([0, 0, 0, 0]) });
      if (r.metrics.blockedMinutes > 0) blockedSeen++;
    });
    check('bed shortage blocks rooms', blockedSeen > 0, blockedSeen + '/' + seeds.length + ' seeds blocked');

    // nobody finishes before they start
    var sane = true;
    a.patients.forEach(function (p) {
      if (p.inRoomAt !== null && p.outOfRoomAt !== null && p.outOfRoomAt < p.inRoomAt) sane = false;
      if (p.bedAt !== null && p.dischargedAt !== null && p.dischargedAt < p.bedAt) sane = false;
    });
    check('patient timestamps are ordered', sane);

    if (verbose) {
      console.log('\n--- sample day (seed 42, all first options) ---');
      console.log(summary(a));
    }
    return { pass: fails.length === 0, failures: fails };
  }

  /* Days can end after midnight. Rendering minute 1529 as "1:29 PM" is the kind
     of thing that goes unnoticed until it is on a screen in front of a clinician. */
  function hhmm(mins) {
    var day = Math.floor(mins / 1440);
    var t = ((mins % 1440) + 1440) % 1440;
    var h = Math.floor(t / 60), m = Math.round(t % 60);
    var ap = h >= 12 ? 'PM' : 'AM', hh = (h % 12 === 0) ? 12 : h % 12;
    return hh + ':' + (m < 10 ? '0' : '') + m + ' ' + ap + (day > 0 ? ' (+' + day + 'd)' : '');
  }

  function summary(run) {
    var m = run.metrics, out = [];
    out.push('completed        ' + m.completed + ' / ' + m.scheduled + '  (' + m.cancelled + ' cancelled)');
    out.push('last case out    ' + hhmm(m.lastCaseOutAt) + '   (ran ' + m.ranLateMinutes + ' min late)');
    out.push('department clear ' + hhmm(m.finishedAt));
    out.push('utilisation      ' + Math.round(m.utilisation * 100) + '%  (prime time ' + Math.round(m.primeTimeUtilisation * 100) + '%)');
    out.push('first case ontime ' + m.firstCaseOnTime + ' / ' + m.firstCaseRooms);
    out.push('median turnover  ' + m.medianTurnover + ' min');
    out.push('blocked minutes  ' + m.blockedMinutes + '  (ward-blocked bed-min ' + m.wardBlockedBedMinutes + ')');
    out.push('overtime         ' + m.overtimeMinutes + ' min, ' + m.missedBreaks + ' missed breaks');
    out.push('complications    ' + m.complications + ' (' + m.escalations + ' escalated)');
    out.push('cost / case      $' + m.costPerCase + '   margin $' + m.margin);
    out.push('waterfall        ' + m.waterfall.map(function (r) { return r.label + ' ' + r.cases; }).join('  |  '));
    out.push('lost time        ' + m.lostTime.filter(function (r) { return r.minutes > 0; })
                                     .map(function (r) { return r.label + ' ' + r.minutes + 'm (' + r.casesEquivalent + ' cases)'; }).join('  |  '));
    return out.join('\n');
  }

  /* ==========================================================================
     14. EXPORTS
     ========================================================================== */

  var EPSim = {
    runDay: runDay,
    enumerate: enumerate,
    replay: replay,
    availableActions: availableActions,
    ACTIONS: ACTIONS,
    evaluateOptions: evaluateOptions,
    bestFrom: bestFrom,
    OUTCOMES: OUTCOMES,
    score: score,
    kpis: kpis,
    selfTest: selfTest,
    summary: summary,
    hhmm: hhmm,
    PROFILES: PROFILES,
    CASE_TYPES: CASE_TYPES,
    CREW_PER_ROOM: CREW_PER_ROOM,
    BEDS_PER_RECOVERY_NURSE: BEDS_PER_RECOVERY_NURSE,
    TIMING: TIMING,
    WARD: WARD,
    COSTS: COSTS,
    RISK: RISK,
    SCALE: SCALE,
    SHOCKS: SHOCKS,
    OPENING: OPENING,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };

  root.EPSim = EPSim;
  if (typeof module !== 'undefined' && module.exports) module.exports = EPSim;

})(typeof globalThis !== 'undefined' ? globalThis : this);
