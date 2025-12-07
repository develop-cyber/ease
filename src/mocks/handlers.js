import { http, HttpResponse } from "msw";

function offer(id, startISO, minutes, direction, laneFamily, credits = 0) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  return {
    id,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    reliability: 0.92 + Math.random() * 0.06,
    headroom: 0.2 + Math.random() * 0.6,
    shift: { direction, minutes },
    laneFamily,
    incentives: { credits },
  };
}

export const handlers = [
  // OFFERS (MVP expects POST)
  http.post("/offers", async ({ request }) => {
    const body = await request.json().catch(() => ({}));
    const base = new Date(body?.desiredArrival || Date.now());

    const parent = offer("w_parent", base.toISOString(), 0, "ONTIME",
      (body?.tripMiles ?? 30) > 30 ? "LEFT_LONG" : "RIGHT_SHORT", 3);

    const earlier = [
      offer("w_e1", new Date(base.getTime() - 30 * 60000).toISOString(), -30, "EARLY", "LEFT_LONG", 2),
      offer("w_e2", new Date(base.getTime() - 15 * 60000).toISOString(), -15, "EARLY", "LEFT_LONG", 1),
    ];
    const later = [
      offer("w_l1", new Date(base.getTime() + 15 * 60000).toISOString(), 15, "LATE", "RIGHT_SHORT", 0),
      offer("w_l2", new Date(base.getTime() + 30 * 60000).toISOString(), 30, "LATE", "RIGHT_SHORT", 0),
    ];

    return HttpResponse.json({ parent, earlier, later });
  }),

  // RESERVE
  http.post("/reserve", async ({ request }) => {
    const { offerId } = await request.json().catch(() => ({}));
    return HttpResponse.json({
      ok: true,
      reservationId: "r_" + Math.random().toString(36).slice(2, 8),
      offerId: offerId ?? null,
    });
  }),
];
