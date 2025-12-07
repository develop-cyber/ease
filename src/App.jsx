// src/App.jsx
import { useEffect, useState } from "react";
import { toLocalInput, fromLocalInput } from "./lib/time";
import { canLateChange, consumeGraceToken, LATE_MIN } from "./utils/grace";

/* ---------- small helpers / UI atoms ---------- */
const fmt = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const trafficColor = (lvl) =>
  lvl === "HIGH" ? "bg-red-600" : lvl === "MEDIUM" ? "bg-amber-500" : "bg-green-600";

const Badge = ({ children }) => (
  <span className="px-2 py-0.5 text-xs rounded-full border border-slate-300 bg-white/90 text-slate-900">
    {children}
  </span>
);

const Section = ({ title, children, actions }) => (
  <div className="w-full rounded-2xl border border-white/20 bg-white/10 backdrop-blur p-6 shadow-sm">
    <div className="flex items-start justify-between mb-4">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
    <div>{children}</div>
  </div>
);

/* ---------- lane heuristic ---------- */
function laneFromMiles(mi) {
  const n = Number(mi || 0);
  if (n < 10) return "RIGHT/SHORT";
  if (n < 25) return "MIDDLE/MIXED";
  return "LEFT/LONG";
}

// simple local traffic heuristic
function estimateTraffic({ date, miles }) {
  const d = new Date(date);
  const dow = d.getDay();
  const hour = d.getHours();
  const month = d.getMonth();
  let density = 0.2;

  // weekday rush hours
  if (dow >= 1 && dow <= 5) {
    const am = Math.max(0, 1 - Math.abs(hour - 8) / 2);
    const pm = Math.max(0, 1 - Math.abs(hour - 17) / 2);
    density += 0.5 * Math.max(am, pm);
  }
  // weekend middays
  if ((dow === 0 || dow === 6) && hour >= 12 && hour <= 18) density += 0.15;
  // winter bump
  if (month >= 7 || month <= 1) density += 0.1;

  density = Math.max(0, Math.min(1, density));
  const level = density > 0.66 ? "HIGH" : density > 0.33 ? "MEDIUM" : "LOW";
  return { density, level };
}

/* ----------------------------- APP ----------------------------- */

export default function App() {
  const [page, setPage] = useState("plan"); // plan | offers | reserve | trip
  const [offers, setOffers] = useState(null);
  const [selected, setSelected] = useState(null);

  const [form, setForm] = useState({
    origin: "",
    dest: "",
    desiredArrival: (() => {
      const d = new Date();
      d.setHours(8, 30, 0, 0);
      return toLocalInput(d);
    })(),
    tripMiles: 0, // start at 0; auto-fill from OSM estimate
    flex: { on: true, minShift: 15, maxShift: 60 },
    evalHorizon: "", // NONE selected by default
  });

  const [errors, setErrors] = useState({});
  const [useAI, setUseAI] = useState(true);
  const [autoMiles, setAutoMiles] = useState(null);
  const [autoLane, setAutoLane] = useState(null);

  /* -------- basic validation -------- */
  function validate() {
    const next = {};
    if (!form.origin.trim()) next.origin = "Origin is required.";
    if (!form.dest.trim()) next.dest = "Destination is required.";

    const dt = fromLocalInput(form.desiredArrival);
    if (Number.isNaN(dt.getTime())) next.desiredArrival = "Please enter a valid date/time.";
    else if (dt < new Date()) next.desiredArrival = "Arrival must be in the future.";

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /* -------- auto-approx miles via OpenStreetMap (straight line) -------- */
  useEffect(() => {
    if (!form.origin.trim() || !form.dest.trim()) {
      setAutoMiles(null);
      setAutoLane(null);
      return;
    }

    const t = setTimeout(async () => {
      try {
        const u = (q) =>
          `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
            q,
          )}`;
        const [goResp, gdResp] = await Promise.all([fetch(u(form.origin)), fetch(u(form.dest))]);
        const [go, gd] = await Promise.all([goResp.json(), gdResp.json()]);
        if (!go[0] || !gd[0]) return;

        const o = { lat: +go[0].lat, lon: +go[0].lon };
        const de = { lat: +gd[0].lat, lon: +gd[0].lon };

        const R = 6371e3;
        const toRad = (x) => (x * Math.PI) / 180;
        const φ1 = toRad(o.lat);
        const φ2 = toRad(de.lat);
        const Δφ = toRad(de.lat - o.lat);
        const Δλ = toRad(de.lon - o.lon);
        const a =
          Math.sin(Δφ / 2) ** 2 +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const miles = (R * c) / 1609.344;

        const approx = +miles.toFixed(1);
        setAutoMiles(approx);
        setAutoLane(laneFromMiles(approx));
        setForm((f) => ({
          ...f,
          tripMiles: Math.round(approx) || f.tripMiles,
        }));
      } catch {
        // ignore; leave tripMiles as whatever user typed
      }
    }, 600);

    return () => clearTimeout(t);
  }, [form.origin, form.dest]);

  /* -------- local offers with horizon search -------- */
  function computeOffersLocal() {
    const userDesiredDt = fromLocalInput(form.desiredArrival);
    const now = new Date();
    const miles = form.tripMiles;

    // if parsing failed, base on "now + 1h"
    let baseDt =
      Number.isNaN(userDesiredDt.getTime()) || userDesiredDt < now
        ? new Date(now.getTime() + 60 * 60000)
        : userDesiredDt;

    let recommendation = null;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const creditsFromHeadroom = (h) => ({
      credits: h > 0.7 ? 3 : h > 0.5 ? 2 : h > 0.3 ? 1 : 0,
    });

    // ---- Planning horizon search ----
    if (form.evalHorizon === "HOURS") {
      // next 5 hours, every 15 minutes
      const horizonMs = 5 * 60 * 60 * 1000;
      const stepMs = 15 * 60 * 1000;
      let bestTime = null;
      let bestDensity = Infinity;

      for (let t = now.getTime(); t <= now.getTime() + horizonMs; t += stepMs) {
        const d = new Date(t);
        const { density } = estimateTraffic({ date: d.toISOString(), miles });
        if (density < bestDensity) {
          bestDensity = density;
          bestTime = d;
        }
      }

      if (bestTime) {
        baseDt = bestTime;
        recommendation = {
          mode: "HOURS",
          bestAt: bestTime.toISOString(),
          density: bestDensity,
        };
      }
    } else if (form.evalHorizon === "DAY") {
      // rest of today, every 30 minutes
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 0, 0, 0);

      if (endOfDay > now) {
        const stepMs = 30 * 60 * 1000;
        let bestTime = null;
        let bestDensity = Infinity;

        for (let t = now.getTime(); t <= endOfDay.getTime(); t += stepMs) {
          const d = new Date(t);
          const { density } = estimateTraffic({ date: d.toISOString(), miles });
          if (density < bestDensity) {
            bestDensity = density;
            bestTime = d;
          }
        }

        if (bestTime) {
          baseDt = bestTime;
          recommendation = {
            mode: "DAY",
            bestAt: bestTime.toISOString(),
            density: bestDensity,
          };
        }
      }
    } else if (form.evalHorizon === "WEEK") {
      // next 7 days, sample 4 times per day
      const candidates = [
        { h: 7, m: 30 },
        { h: 11, m: 30 },
        { h: 15, m: 30 },
        { h: 19, m: 0 },
      ];
      let bestTime = null;
      let bestDensity = Infinity;

      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const day = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        for (const { h, m } of candidates) {
          const d = new Date(day);
          d.setHours(h, m, 0, 0);
          if (d < now) continue;
          const { density } = estimateTraffic({ date: d.toISOString(), miles });
          if (density < bestDensity) {
            bestDensity = density;
            bestTime = d;
          }
        }
      }

      if (bestTime) {
        baseDt = bestTime;
        recommendation = {
          mode: "WEEK",
          bestAt: bestTime.toISOString(),
          density: bestDensity,
        };
      }
    } else if (form.evalHorizon === "MONTH") {
      // next 30 days, keep same time-of-day as desiredArrival
      const baseHour = userDesiredDt.getHours();
      const baseMinute = userDesiredDt.getMinutes();
      let bestTime = null;
      let bestDensity = Infinity;

      for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
        const d = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        d.setHours(baseHour, baseMinute, 0, 0);
        if (d < now) continue;
        const { density } = estimateTraffic({ date: d.toISOString(), miles });
        if (density < bestDensity) {
          bestDensity = density;
          bestTime = d;
        }
      }

      if (bestTime) {
        baseDt = bestTime;
        recommendation = {
          mode: "MONTH",
          bestAt: bestTime.toISOString(),
          density: bestDensity,
        };
      }
    }
    // if evalHorizon is "", we keep baseDt = userDesiredDt (normal behavior)

    const baseIso = baseDt.toISOString();

    const win = (shiftMins) => {
      const base = baseDt.getTime();
      return {
        start: new Date(base + (shiftMins - 7.5) * 60000).toISOString(),
        end: new Date(base + (shiftMins + 7.5) * 60000).toISOString(),
      };
    };

    const mk = ({ minutes, reliability, headroom }, dir) => {
      const w = win(minutes);
      return {
        id: Math.random().toString(36).slice(2, 9),
        windowStart: w.start,
        windowEnd: w.end,
        reliability,
        headroom,
        laneFamily: laneFromMiles(form.tripMiles),
        shift: { direction: dir, minutes },
        incentives: creditsFromHeadroom(headroom),
      };
    };

    const traffic = estimateTraffic({
      date: baseIso,
      miles: form.tripMiles,
    });
    const parentRel = clamp(1 - traffic.density * 0.4, 0.55, 0.98);
    const parentHead = clamp(1 - traffic.density * 0.6, 0.15, 0.85);
    const parent = mk(
      { minutes: 0, reliability: parentRel, headroom: parentHead },
      "ONTIME",
    );

    // ---- Planning horizon affects offsets around baseDt ----
    let offsets;
    switch (form.evalHorizon) {
      case "HOURS":
        offsets = [15, 30];
        break;
      case "DAY":
        offsets = [30, 60];
        break;
      case "WEEK":
        offsets = [45, 90];
        break;
      case "MONTH":
        offsets = [60, 120];
        break;
      default:
        // no horizon selected → basic nearby options
        offsets = [15, 30];
    }

    const minShift = form.flex?.minShift ?? 15;
    const maxShift = form.flex?.maxShift ?? 60;

    offsets = offsets
      .map((o) => Math.min(Math.max(o, minShift), maxShift))
      .filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

    if (!offsets.length) offsets = [minShift];

    const earlier = offsets.map((delta) => {
      const d = new Date(baseDt.getTime() - delta * 60000);
      const t = estimateTraffic({
        date: d.toISOString(),
        miles: form.tripMiles,
      });
      return mk(
        {
          minutes: -delta,
          reliability: Math.max(0.55, 1 - t.density * 0.35),
          headroom: Math.max(0.15, 1 - t.density * 0.55),
        },
        "EARLY",
      );
    });

    const later = offsets.map((delta) => {
      const d = new Date(baseDt.getTime() + delta * 60000);
      const t = estimateTraffic({
        date: d.toISOString(),
        miles: form.tripMiles,
      });
      return mk(
        {
          minutes: +delta,
          reliability: Math.max(0.5, 1 - t.density * 0.45),
          headroom: Math.max(0.1, 1 - t.density * 0.65),
        },
        "LATE",
      );
    });

    setOffers({
      traffic,
      parent,
      earlier,
      later,
      laneAdvice: laneFromMiles(form.tripMiles),
      recommendation,
    });
  }

  /* -------- optional AI route (falls back to local) -------- */
  async function computeOffersAI() {
    try {
      const res = await fetch("/api/traffic-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: form.origin,
          dest: form.dest,
          desiredArrival: fromLocalInput(form.desiredArrival).toISOString(),
          tripMiles: form.tripMiles,
          flex: form.flex,
          horizon: form.evalHorizon,
        }),
      });

      if (!res.ok) {
        if (res.status === 404) {
          computeOffersLocal();
          return;
        }
        throw new Error(`AI_HTTP_${res.status}`);
      }
      setOffers(await res.json());
    } catch {
      computeOffersLocal();
    }
  }

  useEffect(() => {
    if (page !== "offers") return;
    setOffers(null);
    if (useAI) computeOffersAI();
    else computeOffersLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, useAI]);

  /* -------- reservation / trip actions -------- */
  function reserve(offer) {
    setSelected(offer);
    setPage("reserve");
  }

  function changeSlot() {
    if (!selected) return;
    const chk = canLateChange(selected.windowStart);
    if (!chk.allowed) {
      alert(`No grace changes left. Late changes (< ${LATE_MIN} min) need credits.`);
      return;
    }
    if (chk.late) {
      if (
        !window.confirm(
          `This change is within ${LATE_MIN} minutes. It will consume a grace credit. Proceed?`,
        )
      )
        return;
      consumeGraceToken();
    }
    setPage("offers");
  }

  function startTrip() {
    setPage("trip");
  }

  function openInMaps() {
    if (!form.origin || !form.dest) return;
    const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      form.origin,
    )}&destination=${encodeURIComponent(form.dest)}&travelmode=driving`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const trafficPreview = (() => {
    if (!form.desiredArrival) return null;
    // If offers already computed, show traffic at the base time used for offers
    if (offers?.traffic) {
      const anyOffer = offers.parent;
      const baseDate = anyOffer ? anyOffer.windowStart : null;
      if (baseDate) {
        const t = offers.traffic;
        return { ...t, at: new Date(baseDate) };
      }
    }
    const iso = fromLocalInput(form.desiredArrival).toISOString();
    const t = estimateTraffic({ date: iso, miles: form.tripMiles });
    return { ...t, at: new Date(iso) };
  })();

  const bestWorst = offers
    ? (() => {
        const all = [offers.parent, ...(offers.earlier || []), ...(offers.later || [])].filter(
          Boolean,
        );
        if (!all.length) return { bestId: null, worstId: null };
        const score = (o) => o.reliability * 0.7 + o.headroom * 0.3;
        let best = all[0];
        let worst = all[0];
        for (const o of all) {
          if (score(o) > score(best)) best = o;
          if (score(o) < score(worst)) worst = o;
        }
        return { bestId: best.id, worstId: worst.id };
      })()
    : { bestId: null, worstId: null };

  /* ----------------------------- UI ----------------------------- */
  return (
    <div className="relative min-h-screen overflow-hidden text-slate-900">
      {/* blue gradient base */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-800 via-blue-300 to-blue-100 -z-20" />
      {/* slow moving “clouds” overlay */}
      <div className="clouds-animation absolute inset-0 -z-10 pointer-events-none" />

      <header className="bg-transparent">
        <div className="max-w-3xl mx-auto px-4 pt-6 pb-2 flex flex-col items-center gap-3 text-white">
          <img src="/car.png" alt="Car" className="w-24 h-auto rounded-xl shadow-lg" />
          <div className="font-semibold text-lg text-center">
            travelEase – Early/Late Adaptive Scheduling Engine
          </div>
        </div>
      </header>

      <main className="w-full max-w-3xl mx-auto px-4 py-8 grid place-items-center">
        {/* PLAN */}
        {page === "plan" && (
          <>
            <div className="mb-4">
              <h1 className="text-5xl font-extrabold tracking-tight text-white text-center">
                Plan your trip
              </h1>
              <p className="text-white/90 mt-2 text-center">
                We’ll evaluate traffic at your exact time and offer earlier/later options.
              </p>
            </div>

            <div className="grid lg:grid-cols-2 gap-6 w-full">
              <Section
                title="Trip details"
                actions={
                  <div className="flex items-center gap-3">
                    <span className="text-white/80 text-xs">Use AI</span>
                    <label className="inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={useAI}
                        onChange={(e) => setUseAI(e.target.checked)}
                      />
                      <div className="w-11 h-6 bg-slate-200 rounded-full peer-checked:bg-slate-900 relative transition-colors">
                        <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
                      </div>
                    </label>
                  </div>
                }
              >
                <div className="grid md:grid-cols-2 gap-4 text-slate-900">
                  <div className="md:col-span-2">
                    <label className="text-sm text-slate-800">Origin</label>
                    <input
                      className={`mt-1 w-full rounded-xl border p-2 ${
                        errors.origin ? "border-red-500" : "border-slate-300"
                      }`}
                      placeholder="Enter origin address"
                      value={form.origin}
                      onChange={(e) => setForm({ ...form, origin: e.target.value })}
                    />
                    {errors.origin && (
                      <div className="text-xs text-red-600 mt-1">{errors.origin}</div>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-sm text-slate-800">Destination</label>
                    <input
                      className={`mt-1 w-full rounded-xl border p-2 ${
                        errors.dest ? "border-red-500" : "border-slate-300"
                      }`}
                      placeholder="Enter destination address"
                      value={form.dest}
                      onChange={(e) => setForm({ ...form, dest: e.target.value })}
                    />
                    {errors.dest && (
                      <div className="text-xs text-red-600 mt-1">{errors.dest}</div>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-sm text-slate-800">Desired arrival</label>
                    <input
                      type="datetime-local"
                      step="60"
                      className={`mt-1 w-full rounded-xl border ${
                        errors.desiredArrival ? "border-red-500" : "border-slate-300"
                      }`}
                      value={form.desiredArrival}
                      onChange={(e) => setForm({ ...form, desiredArrival: e.target.value })}
                    />
                    {errors.desiredArrival && (
                      <div className="text-xs text-red-600 mt-1">
                        {errors.desiredArrival}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-sm text-slate-800">Trip length (miles)</label>
                    <input
                      type="number"
                      min="0"
                      max="200"
                      className="mt-1 w-full rounded-xl border border-slate-300 p-2"
                      value={form.tripMiles}
                      onChange={(e) =>
                        setForm({ ...form, tripMiles: Number(e.target.value) || 0 })
                      }
                    />
                  </div>

                  {autoMiles != null && (
                    <div className="md:col-span-2 text-sm text-slate-900 mt-1">
                      ≈ {autoMiles} mi (straight-line estimate). Lane advice: <b>{autoLane}</b>
                    </div>
                  )}

                  {trafficPreview && (
                    <div className="md:col-span-2 mt-2 inline-flex items-center gap-2">
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-full ${trafficColor(
                          trafficPreview.level,
                        )}`}
                      />
                      <span className="text-slate-900 text-sm">
                        Traffic at{" "}
                        {trafficPreview.at.toLocaleString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          weekday: "short",
                        })}
                        :{" "}
                        <b>
                          {trafficPreview.level} ({Math.round(trafficPreview.density * 100)}%)
                        </b>
                      </span>
                    </div>
                  )}
                </div>
              </Section>

              <Section
                title="Flexibility (optional)"
                actions={<Badge>{form.flex.on ? "ON" : "OFF"}</Badge>}
              >
                <div className="space-y-4 text-slate-900">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">Show earlier/later options</div>
                      <div className="text-sm text-slate-700">
                        Helps you reserve an alternative window.
                      </div>
                    </div>
                    <label className="inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={form.flex.on}
                        onChange={(e) =>
                          setForm({ ...form, flex: { ...form.flex, on: e.target.checked } })
                        }
                      />
                      <div className="w-11 h-6 bg-slate-200 rounded-full peer-checked:bg-slate-900 relative transition-colors">
                        <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
                      </div>
                    </label>
                  </div>

                  <div className="border-t border-white/20 pt-4 mt-1">
                    <div className="mb-2">
                      <div className="font-medium">Planning horizon</div>
                      <div className="text-sm text-slate-700">
                        Choose how far ahead travelEase should look when evaluating the best time
                        to travel.
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { id: "HOURS", label: "Next few hours" },
                        { id: "DAY", label: "Today" },
                        { id: "WEEK", label: "This week" },
                        { id: "MONTH", label: "Next 30 days" },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() =>
                            setForm((prev) => ({ ...prev, evalHorizon: opt.id }))
                          }
                          className={`px-3 py-1.5 rounded-full text-sm border ${
                            form.evalHorizon === opt.id
                              ? "bg-slate-900 text-white border-slate-900"
                              : "bg-white/80 text-slate-900 border-slate-300"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Section>
            </div>

            <div className="w-full flex justify-end">
              <button
                onClick={() => {
                  if (!validate()) return;
                  setPage("offers");
                }}
                className="px-5 py-2.5 rounded-2xl bg-slate-900 text-white font-medium hover:bg-slate-800"
              >
                Get offers
              </button>
            </div>
          </>
        )}

        {/* OFFERS */}
        {page === "offers" && (
          <>
            <button
              onClick={() => setPage("plan")}
              className="text-white/90 hover:text-white mb-2"
            >
              ← Back
            </button>
            <h2 className="text-2xl font-bold mb-2 text-white">Offers for your arrival</h2>

            {!offers && (
              <Section title="Evaluating…">
                <div className="text-slate-900">Checking traffic and building options…</div>
              </Section>
            )}

            {offers && (
              <>
                <div className="mb-2 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${trafficColor(
                        offers.traffic.level,
                      )}`}
                    />
                    <span className="px-2 py-1 text-xs rounded-full border border-slate-300 bg-white/90 text-slate-900">
                      Traffic: {offers.traffic.level} (
                      {Math.round(offers.traffic.density * 100)}%)
                    </span>
                  </div>

                  {offers.recommendation && (
                    <div className="text-sm text-white">
                      {(() => {
                        const rec = offers.recommendation;
                        const dt = new Date(rec.bestAt);
                        const labelMap = {
                          HOURS: "in the next few hours",
                          DAY: "today",
                          WEEK: "in the next 7 days",
                          MONTH: "in the next 30 days",
                        };
                        const label = labelMap[rec.mode] || "in this horizon";
                        const when = dt.toLocaleString([], {
                          weekday: "long",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                        const pct = Math.round(rec.density * 100);
                        return (
                          <>
                            Best time {label}:{" "}
                            <span className="font-semibold">{when}</span>{" "}
                            <span className="text-sm">
                              (lowest estimated traffic {pct}%)
                            </span>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>

                <Section title="On-time (parent)">
                  <OfferCard
                    offer={offers.parent}
                    isBest={bestWorst.bestId === offers.parent.id}
                    isWorst={bestWorst.worstId === offers.parent.id}
                    onSelect={() => reserve(offers.parent)}
                  />
                </Section>

                {form.flex.on && (
                  <div className="grid lg:grid-cols-2 gap-6 w-full">
                    <Section title="Earlier (children)">
                      <div className="grid gap-3">
                        {offers.earlier.length === 0 && (
                          <div className="text-sm text-slate-900">No earlier headroom.</div>
                        )}
                        {offers.earlier.map((o) => (
                          <OfferCard
                            key={o.id}
                            offer={o}
                            isBest={bestWorst.bestId === o.id}
                            isWorst={bestWorst.worstId === o.id}
                            onSelect={() => reserve(o)}
                          />
                        ))}
                      </div>
                    </Section>
                    <Section title="Later (children)">
                      <div className="grid gap-3">
                        {offers.later.length === 0 && (
                          <div className="text-sm text-slate-900">No later headroom.</div>
                        )}
                        {offers.later.map((o) => (
                          <OfferCard
                            key={o.id}
                            offer={o}
                            isBest={bestWorst.bestId === o.id}
                            isWorst={bestWorst.worstId === o.id}
                            onSelect={() => reserve(o)}
                          />
                        ))}
                      </div>
                    </Section>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* RESERVE */}
        {page === "reserve" && selected && (
          <>
            <button
              onClick={() => setPage("offers")}
              className="text-white/90 hover:text-white mb-2"
            >
              ← Back
            </button>
            <h2 className="text-2xl font-bold mb-4 text-white">Reservation confirmed</h2>
            <div className="grid lg:grid-cols-3 gap-6 w-full">
              <Section
                title="Details"
                actions={<Badge>Reliability {Math.round(selected.reliability * 100)}%</Badge>}
              >
                <div className="space-y-2 text-slate-900">
                  <div>
                    <div className="text-sm text-slate-700">Reservation window</div>
                    <div className="font-semibold">
                      {fmt(selected.windowStart)}–{fmt(selected.windowEnd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-700">Lane family</div>
                    <div className="font-semibold">{selected.laneFamily}</div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-700">Shift vs desired</div>
                    <div className="font-semibold">
                      {selected.shift.direction === "ONTIME"
                        ? "On-time"
                        : selected.shift.direction === "EARLY"
                        ? `Earlier by ${Math.abs(selected.shift.minutes)} minutes`
                        : `Later by ${selected.shift.minutes} minutes`}
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="Incentives">
                <div className="space-y-2 text-slate-900">
                  <div>
                    <div className="text-sm text-slate-700">Credits</div>
                    <div className="font-semibold">+{selected.incentives.credits}</div>
                  </div>
                  <div className="text-xs text-slate-700">
                    Credits reward choosing options that create more slack in the system.
                  </div>
                </div>
              </Section>

              <Section title="Next steps">
                <div className="space-y-2 text-slate-900">
                  <button
                    className="w-full px-4 py-2 rounded-xl bg-slate-900 text-white text-sm hover:bg-slate-800"
                    onClick={startTrip}
                  >
                    Start trip coaching
                  </button>
                  <button
                    className="w-full px-4 py-2 rounded-xl bg-white/90 text-slate-900 text-sm border border-slate-300 hover:bg-white"
                    onClick={openInMaps}
                  >
                    Open in Google Maps
                  </button>
                  <button
                    className="w-full px-4 py-2 rounded-xl bg-white/80 text-slate-500 text-sm border border-slate-200 hover:bg-white"
                    onClick={changeSlot}
                  >
                    Change slot (within grace)
                  </button>
                </div>
              </Section>
            </div>
          </>
        )}

        {/* TRIP */}
        {page === "trip" && selected && (
          <>
            <button
              onClick={() => setPage("reserve")}
              className="text-white/90 hover:text-white mb-2"
            >
              ← Back
            </button>
            <h2 className="text-2xl font-bold mb-4 text-white">Trip coaching</h2>
            <Section title="Live guidance">
              <div className="space-y-3 text-slate-900">
                <p>
                  This is where live trip coaching would appear – reminders to leave, lane
                  suggestions, and early/late adjustments.
                </p>
                <p className="text-sm text-slate-700">
                  For the prototype, this stays simple. Imagine notifications nudging you if you’re
                  trending early or late.
                </p>
              </div>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- Offer card ---------- */

function OfferCard({ offer, onSelect, isBest = false, isWorst = false }) {
  const rel = Math.round(offer.reliability * 100);
  const head = Math.round(offer.headroom * 100);
  const title =
    offer.shift.direction === "ONTIME"
      ? "On-time"
      : offer.shift.direction === "EARLY"
      ? `Earlier ${Math.abs(offer.shift.minutes)}m`
      : `Later +${offer.shift.minutes}m`;
  const lane = offer.laneFamily;

  const borderHighlight =
    isBest ? "border-emerald-400" : isWorst ? "border-red-400" : "border-white/20";

  return (
    <div
      className={`rounded-2xl border ${borderHighlight} bg-white/90 backdrop-blur p-4 shadow-sm text-slate-900`}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="text-sm font-medium">{title}</div>
            {isBest && (
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500 text-xs font-bold text-white"
                aria-label="Best option"
              >
                ✓
              </span>
            )}
            {isWorst && !isBest && (
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500 text-xs font-bold text-white"
                aria-label="Least recommended option"
              >
                ✕
              </span>
            )}
          </div>
          <div className="text-2xl font-bold text-slate-950">
            {fmt(offer.windowStart)}–{fmt(offer.windowEnd)}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge>Reliability {rel}%</Badge>
            <Badge>Headroom {head}%</Badge>
            <Badge>Lane {lane}</Badge>
            {offer.incentives.credits > 0 && <Badge>Credits +{offer.incentives.credits}</Badge>}
          </div>
        </div>
        <button
          className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm hover:bg-slate-800"
          onClick={onSelect}
        >
          Reserve
        </button>
      </div>
    </div>
  );
}
