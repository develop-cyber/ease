// Ease/api/traffic-ai.js
import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "NO_OPENAI_KEY" });
  }

  try {
    const { origin, dest, desiredArrival, tripMiles, flex } = req.body || {};
    if (!origin || !dest || !desiredArrival) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // Ask the model for structured traffic + offers
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const payload = {
      model: "gpt-4o-mini",
      instructions:
        "You are a traffic scheduling assistant. Given origin, destination, local arrival time and trip miles, " +
        "evaluate likely congestion (LOW/MEDIUM/HIGH) and suggest up to two earlier and two later windows " +
        "(expressed as minute offsets from the arrival time), with reliability (0.5–0.99) and headroom (0.1–0.9). " +
        "Also suggest a lane family: LEFT/LONG | MIDDLE/MIXED | RIGHT/SHORT. Respond as JSON matching the schema.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({ origin, dest, desiredArrival, tripMiles, flex }),
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "TrafficOfferPlan",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              traffic: {
                type: "object",
                properties: {
                  level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
                  density: { type: "number" },
                  reasoning: { type: "string" },
                },
                required: ["level", "density", "reasoning"],
              },
              laneFamily: {
                type: "string",
                enum: ["LEFT/LONG", "MIDDLE/MIXED", "RIGHT/SHORT"],
              },
              parent: {
                type: "object",
                properties: {
                  reliability: { type: "number" },
                  headroom: { type: "number" },
                },
                required: ["reliability", "headroom"],
              },
              earlier: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    minutes: { type: "integer" },
                    reliability: { type: "number" },
                    headroom: { type: "number" },
                  },
                  required: ["minutes", "reliability", "headroom"],
                },
              },
              later: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    minutes: { type: "integer" },
                    reliability: { type: "number" },
                    headroom: { type: "number" },
                  },
                  required: ["minutes", "reliability", "headroom"],
                },
              },
            },
            required: ["traffic", "laneFamily", "parent", "earlier", "later"],
          },
        },
      },
    };

    const r = await client.responses.create(payload);
    const outText =
      r.output_text ||
      (r.output && r.output[0] && r.output[0].content && r.output[0].content[0] && r.output[0].content[0].text) ||
      "{}";
    const ai = JSON.parse(outText);

    // Turn minutes offsets into 15-min windows centered at the offset
    const makeWin = (baseIso, shiftMinutes) => {
      const base = new Date(baseIso).getTime();
      const s = new Date(base + (shiftMinutes - 7.5) * 60000).toISOString();
      const e = new Date(base + (shiftMinutes + 7.5) * 60000).toISOString();
      return { start: s, end: e };
    };
    const mk = ({ minutes, reliability, headroom }, dir) => {
      const w = makeWin(desiredArrival, minutes);
      return {
        id: Math.random().toString(36).slice(2, 9),
        windowStart: w.start,
        windowEnd: w.end,
        reliability,
        headroom,
        laneFamily: ai.laneFamily,
        shift: { direction: dir, minutes },
        incentives: { credits: headroom > 0.7 ? 3 : headroom > 0.5 ? 2 : headroom > 0.3 ? 1 : 0 },
      };
    };

    const parent = mk({ minutes: 0, ...ai.parent }, "ONTIME");
    const earlier = (ai.earlier || []).slice(0, 2).map((e) => mk(e, "EARLY"));
    const later = (ai.later || []).slice(0, 2).map((e) => mk(e, "LATE"));

    return res.status(200).json({
      traffic: ai.traffic,
      parent,
      earlier,
      later,
      laneAdvice: ai.laneFamily,
    });
  } catch (e) {
    return res.status(500).json({ error: "AI_FAILED", details: String(e) });
  }
}
