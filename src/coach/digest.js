/* =============================================================
   AI coach — rules-only digests for /api/ai/coach/brief and /body.

   Copied from the app's src/js/coach-data.js (buildBriefDigest,
   buildBodyFacts and the helpers they use). The phone runs the same
   functions offline to show the rules version of the Home brief and
   the Body tab takeaways; the server runs them on the posted data
   pack and has Claude only reword the result, so the AI can't cite
   numbers that aren't here. Keep the two copies in sync.
   ============================================================= */

'use strict';

const arr = v => (Array.isArray(v) ? v : []);
const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function isoDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// ── today's brief ────────────────────────────────────────────────
// A rules-only read of the data pack: readiness, the few facts worth
// mentioning this morning, and one thing that needs attention. The
// Home card shows this as-is offline; the server hands the same digest
// to Claude to word the brief, so the AI can't cite numbers not in it.

const DAY = 86400000;
const r1 = n => Math.round(n * 10) / 10;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function phaseDirection(phase) {
  const p = String(phase || '').toLowerCase();
  if (/cut|shred|diet|prep|lose|loss/.test(p)) return { dir: -1, word: 'cut' };
  if (/bulk|gain|build|improvement|off.?season/.test(p)) return { dir: 1, word: 'bulk' };
  if (/maint/.test(p)) return { dir: 0, word: 'maintenance phase' };
  return null;
}

function bestE1rm(sets) {
  let best = null;
  let top = 0;
  arr(sets).forEach(s => {
    const w = num(s.w) || 0;
    const r = num(s.r) || 0;
    if (w > top) top = w;
    if (w > 0 && r > 0 && r <= 12) {
      const e = r === 1 ? w : w * (1 + r / 30);
      if (best === null || e > best) best = e;
    }
  });
  return { e1rm: best, top };
}

// Exercises whose best estimated 1RM hasn't moved (within 1%) for 2+ weeks
// across 3+ sessions — returns the most-trained one, or null.
function findStall(workouts, now) {
  const byName = {};
  arr(workouts).forEach(w => {
    const t = Date.parse(w.date);
    if (!Number.isFinite(t) || now - t > 56 * DAY) return;
    arr(w.exercises).forEach(ex => {
      const { e1rm, top } = bestE1rm(ex.sets);
      if (!e1rm) return;
      const key = norm(ex.name);
      (byName[key] = byName[key] || { name: ex.name, sessions: [] }).sessions.push({ t, e1rm, top });
    });
  });
  let found = null;
  Object.values(byName).forEach(({ name, sessions }) => {
    sessions.sort((a, b) => a.t - b.t);
    if (sessions.length < 3) return;
    const latest = sessions[sessions.length - 1];
    if (now - latest.t > 14 * DAY) return; // not trained lately — not a live stall
    const peak = Math.max(...sessions.map(s => s.e1rm));
    if (latest.e1rm < peak * 0.99 && sessions.length > 3) return; // dropping, not flat — different problem
    let i = sessions.length - 1;
    while (i > 0 && sessions[i - 1].e1rm >= latest.e1rm * 0.99 && sessions[i - 1].e1rm <= latest.e1rm * 1.01) i--;
    const flat = sessions.slice(i);
    const weeks = Math.floor((latest.t - flat[0].t) / (7 * DAY));
    if (flat.length < 3 || weeks < 2) return;
    if (!found || flat.length > found.sessions) {
      found = { exercise: name, weeks, sessions: flat.length, topWeight: latest.top, e1rm: r1(latest.e1rm) };
    }
  });
  return found;
}

/**
 * @param pack   buildCoachDataPack() output
 * @param today  { session: "Push B" | null, restDay: bool }
 */
function buildBriefDigest(pack, today) {
  const p = pack || {};
  const t = today || {};
  const now = Date.parse(p.generatedAt) || Date.now();
  const unit = (p.profile && p.profile.unit) || 'kg';
  const signals = []; // { key, text, tone: good|watch|info, weight }
  let score = 70;
  let inputs = 0;

  // Sleep: last night against the two weeks before it.
  const nights = arr(p.sleep).filter(n => num(n.hours)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const last = nights[nights.length - 1];
  // "Last night" by calendar date (logged under today or yesterday), not a
  // rolling window — date-only strings parse as UTC midnight, so hour maths
  // drops yesterday's entry by evening in timezones behind UTC.
  const lastNight = last && (last.date === isoDay(new Date(now)) || last.date === isoDay(new Date(now - DAY)));
  if (lastNight) {
    inputs++;
    const prior = nights.slice(0, -1).filter(n => now - Date.parse(n.date) <= 15 * DAY).map(n => n.hours);
    const avg = prior.length >= 3 ? mean(prior) : null;
    const diff = avg === null ? 0 : last.hours - avg;
    if (last.hours < 6) score -= 12;
    else if (diff < -0.75) score -= 8;
    else if (last.hours >= 7.5) score += 6;
    const short = last.hours < 6.5 || diff < -0.75;
    signals.push({
      key: 'sleep',
      text: `Sleep ${r1(last.hours)} h` + (avg !== null ? `, ${diff < 0 ? 'under' : 'over'} your ${r1(avg)} h average` : ''),
      tone: short ? 'watch' : 'good',
      weight: short ? 3 : 1,
    });
  }

  // Latest check-in within a week.
  const checkIn = arr(p.checkIns).filter(c => now - Date.parse(c.date) <= 8 * DAY).slice(-1)[0];
  if (checkIn && (num(checkIn.energy) || num(checkIn.stress))) {
    inputs++;
    const energy = num(checkIn.energy);
    const stress = num(checkIn.stress);
    if (energy) score += (energy - 6) * 3;
    if (stress && stress > 6) score -= (stress - 6) * 3;
    if (energy !== null && energy <= 4) signals.push({ key: 'energy', text: `Energy ${energy}/10 on your last check-in`, tone: 'watch', weight: 2 });
    if (stress !== null && stress >= 7) signals.push({ key: 'stress', text: `Stress ${stress}/10 on your last check-in`, tone: 'watch', weight: 2 });
  }

  // Training load: last 7 days against the four weeks before.
  const sessions = arr(p.workouts).map(w => Date.parse(w.date)).filter(Number.isFinite);
  if (sessions.length) {
    inputs++;
    const last7 = sessions.filter(x => now - x < 7 * DAY).length;
    const before = sessions.filter(x => now - x >= 7 * DAY && now - x < 35 * DAY).length / 4;
    const daysSince = Math.floor((now - Math.max(...sessions)) / DAY);
    if (before > 0 && last7 > before + 1.5) {
      score -= 6;
      signals.push({ key: 'load', text: `${last7} sessions in 7 days, above your usual ${r1(before)}`, tone: 'watch', weight: 2 });
    } else if (daysSince >= 5) {
      signals.push({ key: 'gap', text: `Last session ${daysSince} days ago`, tone: 'watch', weight: 1 });
    } else if (last7 > 0) {
      signals.push({ key: 'load', text: `${last7} session${last7 === 1 ? '' : 's'} in the last 7 days`, tone: 'good', weight: 0 });
    }
    if (daysSince >= 2 && daysSince < 5) score += 4;
  }

  // Bodyweight trend against the phase goal.
  const bw = arr(p.bodyweight).filter(e => num(e.kg)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .filter(e => now - Date.parse(e.date) <= 28 * DAY);
  if (bw.length >= 4 && Date.parse(bw[bw.length - 1].date) - Date.parse(bw[0].date) >= 10 * DAY) {
    const half = Math.floor(bw.length / 2);
    const a = mean(bw.slice(0, half).map(e => e.kg));
    const b = mean(bw.slice(half).map(e => e.kg));
    const span = (mean(bw.slice(half).map(e => Date.parse(e.date))) - mean(bw.slice(0, half).map(e => Date.parse(e.date)))) / (7 * DAY);
    const rate = span > 0 ? Math.round(((b - a) / span) * 100) / 100 : 0;
    const phase = phaseDirection(p.profile && p.profile.phase);
    let tone = 'info';
    let tail = '';
    if (phase && phase.dir !== 0) {
      const onTrack = Math.sign(rate) === phase.dir && Math.abs(rate) >= 0.1;
      tone = onTrack ? 'good' : 'watch';
      tail = onTrack ? `, on track for your ${phase.word}` : `, not moving the way a ${phase.word} should`;
    } else if (phase && phase.dir === 0) {
      tone = Math.abs(rate) <= 0.25 ? 'good' : 'watch';
      tail = tone === 'good' ? ', steady for maintenance' : '';
    }
    signals.push({ key: 'weight', text: `Weight trend ${rate > 0 ? '+' : ''}${rate} kg/wk${tail}`, tone, weight: tone === 'watch' ? 2 : 1 });
  }

  const stall = findStall(p.workouts, now);
  const flag = stall ? {
    text: `${stall.exercise} stuck at ${stall.topWeight} ${unit} for ${stall.weeks} weeks`,
    question: `Why has my ${stall.exercise.toLowerCase()} stalled?`,
    stall,
  } : null;

  score = Math.max(20, Math.min(95, Math.round(score)));
  const readiness = inputs ? {
    score,
    label: score >= 75 ? 'Ready to push' : score >= 55 ? 'Train as planned' : 'Take it easier',
    short: score >= 75 ? 'Ready' : score >= 55 ? 'Steady' : 'Easy',
  } : null;

  const session = t.session || null;
  let headline;
  if (session) {
    headline = !readiness ? `${session} is on the plan today.`
      : readiness.score >= 75 ? `${readiness.label}. ${session} is on the plan.`
      : readiness.score >= 55 ? `${session} is on the plan. Train it as written.`
      : `${session} is on the plan, but keep the top sets a notch lighter today.`;
  } else if (t.restDay) {
    headline = readiness && readiness.score < 55 ? 'Rest day. Recovery is the priority today.' : 'Rest day. A walk and some mobility will help.';
  } else {
    headline = readiness ? `${readiness.label} today.` : 'Log a session or a check-in and your coach will brief you here each morning.';
  }

  const bullets = signals.slice()
    .sort((x, y) => (y.tone === 'watch') - (x.tone === 'watch') || y.weight - x.weight)
    .slice(0, 3)
    .map(s => ({ text: s.text, tone: s.tone }));

  return {
    date: isoDay(new Date(now)),
    session,
    restDay: Boolean(t.restDay),
    readiness,
    headline,
    bullets,
    flag,
    signals: signals.map(s => ({ text: s.text, tone: s.tone })),
    hasData: inputs > 0 || Boolean(flag),
  };
}

// ── Body tab takeaways ───────────────────────────────────────────
// Rules-only read of weight, nutrition, sleep and cardio for the Body
// tab's "Coach takeaways" box. Like the brief, the phone shows the rules
// version offline and POST /api/ai/coach/body has Claude reword the same
// facts, so the AI can't cite numbers that aren't here.

// Least-squares slope over [{t, v}] in units per week.
function weeklySlope(points) {
  if (points.length < 3) return null;
  const xs = points.map(p => p.t / (7 * DAY));
  const mx = mean(xs), my = mean(points.map(p => p.v));
  let nume = 0, den = 0;
  points.forEach((p, i) => { nume += (xs[i] - mx) * (p.v - my); den += (xs[i] - mx) ** 2; });
  return den ? nume / den : null;
}

const TONE_ORDER = { watch: 0, info: 1, good: 2 };

/**
 * @param pack  buildCoachDataPack() output. pack.macros.targets may be
 *              swapped for the adaptive targets the Macros tab shows.
 * @returns { facts, headline, takeaways: [{key, text, tone}], hasData }
 */
function buildBodyFacts(pack) {
  const p = pack || {};
  const now = Date.parse(p.generatedAt) || Date.now();
  const unit = (p.profile && p.profile.unit) === 'lb' ? 'lb' : 'kg';
  const toUnit = kg => (unit === 'lb' ? kg * 2.20462 : kg);
  const phase = phaseDirection(p.profile && p.profile.phase);
  const out = []; // { key, text, tone }
  const facts = { date: isoDay(new Date(now)), unit, phase: phase ? phase.word : null };

  // Weight: trend over the last 28 days against the phase goal.
  const weights = arr(p.bodyweight).filter(e => num(e.kg)).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (weights.length) {
    const latest = weights[weights.length - 1];
    const recent = weights.filter(e => now - Date.parse(e.date) <= 28 * DAY);
    const span = recent.length ? (Date.parse(recent[recent.length - 1].date) - Date.parse(recent[0].date)) / DAY : 0;
    const slope = span >= 7 ? weeklySlope(recent.map(e => ({ t: Date.parse(e.date), v: e.kg }))) : null;
    const pct = slope != null ? (slope / latest.kg) * 100 : null;
    const daysSince = Math.floor((now - Date.parse(latest.date)) / DAY);
    facts.weight = {
      latest: r1(toUnit(latest.kg)), daysSinceWeighIn: daysSince, weighIns28d: recent.length,
      ratePerWeek: slope != null ? r1(toUnit(slope)) : null, pctPerWeek: pct != null ? r1(pct) : null,
    };
    if (slope != null) {
      const speed = `${Math.abs(r1(toUnit(slope)))} ${unit}/wk`; // after "Losing" / "Gaining"
      const rate = `${slope > 0 ? '+' : slope < 0 ? '−' : ''}${speed}`;
      if (phase && phase.dir < 0) {
        if (pct > -0.1) out.push({ key: 'weight', tone: 'watch', text: `Weight is flat (${rate}) on your cut. Trim ~150 kcal a day or add a cardio session.` });
        else if (pct < -1) out.push({ key: 'weight', tone: 'watch', text: `Losing ${speed}, faster than ~1% a week. Add ~150 kcal back to protect muscle.` });
        else out.push({ key: 'weight', tone: 'good', text: `Losing ${speed}, a sustainable pace for a cut. Keep things as they are.` });
      } else if (phase && phase.dir > 0) {
        if (pct <= 0.05) out.push({ key: 'weight', tone: 'watch', text: `Weight isn't climbing (${rate}) on your bulk. Add ~150–200 kcal a day.` });
        else if (pct > 0.5) out.push({ key: 'weight', tone: 'watch', text: `Gaining ${speed}, quicker than ~0.5% a week. Ease off ~150 kcal to limit fat gain.` });
        else out.push({ key: 'weight', tone: 'good', text: `Gaining ${speed}, a lean rate for a bulk. Stay the course.` });
      } else if (phase && phase.dir === 0 && Math.abs(pct) > 0.3) {
        out.push({ key: 'weight', tone: 'watch', text: `Weight is drifting ${rate} during maintenance. Nudge calories ${slope > 0 ? 'down' : 'up'} ~100 kcal.` });
      } else {
        out.push({ key: 'weight', tone: 'info', text: `Weight trend is ${rate} over the last 4 weeks.` });
      }
    }
    if (daysSince >= 5) {
      out.push({ key: 'weighin', tone: 'info', text: `No weigh-in for ${daysSince} days. Weigh in tomorrow morning to keep the trend honest.` });
    } else if (slope == null) {
      out.push({ key: 'weighin', tone: 'info', text: 'Weigh in 3–4 mornings a week to unlock your weight trend.' });
    }
  }

  // Nutrition: the last 7 days of logged intake against the targets.
  const macros = p.macros || {};
  const targets = macros.targets || {};
  // Guard against placeholder targets (e.g. an unset profile) producing nonsense advice.
  const kcalTarget = num(targets.calories) >= 1000 ? num(targets.calories) : null;
  const proteinTarget = num(targets.protein) >= 40 ? num(targets.protein) : null;
  const week = arr(macros.intake).filter(d => now - Date.parse(d.date) < 7 * DAY && num(d.kcal));
  if (week.length || kcalTarget) {
    const avgKcal = mean(week.map(d => d.kcal));
    const avgProtein = mean(week.map(d => num(d.protein) || 0));
    facts.nutrition = {
      daysLogged7d: week.length,
      avgCalories: avgKcal != null ? Math.round(avgKcal) : null, calorieTarget: kcalTarget,
      avgProtein: avgProtein != null ? Math.round(avgProtein) : null, proteinTarget,
    };
    if (week.length < 3) {
      out.push({ key: 'logging', tone: 'info', text: `Only ${week.length} of the last 7 days have meals logged. Log a few more so your numbers mean something.` });
    } else {
      if (proteinTarget && avgProtein < proteinTarget * 0.9) {
        out.push({ key: 'protein', tone: 'watch', text: `Protein averages ${Math.round(avgProtein)}g vs your ${proteinTarget}g target. Add a ~30g serving to one meal.` });
      } else if (proteinTarget) {
        out.push({ key: 'protein', tone: 'good', text: `Protein is on point at ${Math.round(avgProtein)}g a day.` });
      }
      if (kcalTarget && Math.abs(avgKcal - kcalTarget) > kcalTarget * 0.1) {
        const over = avgKcal > kcalTarget;
        out.push({ key: 'calories', tone: 'watch', text: `Calories average ${Math.round(avgKcal).toLocaleString('en-US')}, ${over ? 'above' : 'below'} your ${kcalTarget.toLocaleString('en-US')} target. ${over ? 'Trim a snack or portion each day.' : 'Eat closer to target to keep training quality up.'}` });
      }
    }
  }

  // Sleep: last 7 nights.
  const nights = arr(p.sleep).filter(n => num(n.hours) && now - Date.parse(n.date) < 7 * DAY);
  if (nights.length) {
    const avg = mean(nights.map(n => n.hours));
    const short = nights.filter(n => n.hours < 6).length;
    const q = nights.filter(n => num(n.quality));
    facts.sleep = { nights7d: nights.length, avgHours: r1(avg), shortNights: short,
      avgQuality: q.length ? r1(mean(q.map(n => n.quality))) : null };
    if (avg < 7) out.push({ key: 'sleep', tone: 'watch', text: `Sleep averages ${r1(avg)}h this week${short ? ` with ${short} night${short === 1 ? '' : 's'} under 6h` : ''}. Aim for lights-out 30 min earlier.` });
    else out.push({ key: 'sleep', tone: 'good', text: `Sleep averages ${r1(avg)}h, solid for recovery.` });
  }

  // Cardio: last 7 days.
  const cardio = arr(p.cardio).filter(c => now - Date.parse(c.date) < 7 * DAY);
  if (arr(p.cardio).length) {
    const mins = Math.round(cardio.reduce((s, c) => s + (num(c.durationMin) || 0), 0));
    facts.cardio = { sessions7d: cardio.length, minutes7d: mins };
    if (mins >= 150) out.push({ key: 'cardio', tone: 'good', text: `${mins} min of cardio this week, above the 150 min guideline.` });
    else if (phase && phase.dir < 0) out.push({ key: 'cardio', tone: 'info', text: `${mins} min of cardio this week. A couple of 20–30 min walks would help the cut.` });
  }

  const hasData = Boolean(facts.weight || facts.nutrition || facts.sleep || facts.cardio);
  const takeaways = out
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.i - b.i)
    .slice(0, 3)
    .map(({ key, text, tone }) => ({ key, text, tone }));

  const watches = out.filter(x => x.tone === 'watch').length;
  const headline = !hasData
    ? 'Log your weight, meals or sleep and your coach will pull out what matters here.'
    : watches === 0
      ? 'Your body data is trending the right way. Keep doing what you are doing.'
      : watches === 1
        ? 'One thing to adjust this week. The rest is on track.'
        : `${watches} things worth adjusting this week, most important first.`;

  return { facts, headline, takeaways, hasData };
}

module.exports = { buildBriefDigest, buildBodyFacts };
