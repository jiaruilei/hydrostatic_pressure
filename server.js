import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const STUDY_COOKIE = "ce2134_study_assignment";
const STUDY_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;
const studySecret = process.env.STUDY_SECRET || "";
const studyCodes = {
  A: process.env.STUDY_A_CODE || "",
  B: process.env.STUDY_B_CODE || "",
};

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

const rateBuckets = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = Number(process.env.COACH_RATE_LIMIT) || 30;

function coachRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }

  if (bucket.count >= RATE_LIMIT) {
    return res.status(429).json({
      error: "Too many coach questions. Please try again in a few minutes.",
    });
  }

  bucket.count += 1;
  return next();
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-8)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: cleanText(message?.content, 1000),
    }))
    .filter((message) => message.content);
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  const cookies = {};
  for (const entry of String(req.headers.cookie || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function createStudyToken(condition) {
  const signature = crypto
    .createHmac("sha256", studySecret)
    .update(condition)
    .digest("hex");
  return `${condition}.${signature}`;
}

function getStudyCondition(req) {
  if (!studySecret) return null;
  const token = parseCookies(req)[STUDY_COOKIE] || "";
  const [condition, signature, extra] = token.split(".");
  if (extra || !["A", "B"].includes(condition) || !signature) return null;
  const expected = createStudyToken(condition).slice(2);
  return timingSafeTextEqual(signature, expected) ? condition : null;
}

function studyConfigurationReady() {
  return Boolean(studySecret && studyCodes.A && studyCodes.B);
}

function finiteNumber(value, min, max, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function getPressureContext(context = {}) {
  const gravity = 9.81;
  const topLayerEnabled = Boolean(context.topLayerEnabled);
  const bottomDensity = finiteNumber(context.bottomDensity, 100, 14000, 1000);
  const topDensity = topLayerEnabled
    ? finiteNumber(context.topDensity, 100, 14000, 800)
    : null;
  const bottomLayerDepth = finiteNumber(context.bottomLayerDepth, 0.1, 10, 3);
  const topLayerDepth = topLayerEnabled
    ? finiteNumber(context.topLayerDepth, 0.1, 10, 1)
    : 0;
  const totalDepth = bottomLayerDepth + topLayerDepth;
  const sensorDepth = finiteNumber(context.sensorDepth, 0, totalDepth, 0);
  const topDepthAboveSensor = topLayerEnabled
    ? Math.min(sensorDepth, topLayerDepth)
    : 0;
  const bottomDepthAboveSensor = topLayerEnabled
    ? Math.max(0, sensorDepth - topLayerDepth)
    : sensorDepth;
  const gagePressure = (
    (topLayerEnabled ? topDensity * gravity * topDepthAboveSensor : 0)
    + bottomDensity * gravity * bottomDepthAboveSensor
  ) / 1000;
  const pressureReference = cleanText(context.pressureReference, 20).toLowerCase()
    === "absolute" ? "absolute" : "gage";
  const atmosphericPressure = finiteNumber(
    context.atmosphericPressure,
    50,
    120,
    101.3,
  );
  const expectedPressure = pressureReference === "absolute"
    ? gagePressure + atmosphericPressure
    : gagePressure;
  const prediction = finiteNumber(context.prediction, -100000, 100000);

  return {
    mode: cleanText(context.mode, 20) === "challenge" ? "challenge" : "explore",
    pressureReference,
    atmosphericPressure,
    topLayerEnabled,
    topFluid: topLayerEnabled
      ? cleanText(context.topFluid, 80) || "top fluid"
      : "not present",
    topDensity,
    topLayerDepth,
    bottomFluid: cleanText(context.bottomFluid, 80) || "bottom fluid",
    bottomDensity,
    bottomLayerDepth,
    sensorDepth,
    sensorLayer: cleanText(context.sensorLayer, 80) || "unknown",
    topDepthAboveSensor,
    bottomDepthAboveSensor,
    gagePressure,
    expectedPressure,
    prediction,
    predictionError: prediction == null ? null : prediction - expectedPressure,
    attempts: finiteNumber(context.attempts, 0, 100, 0),
    hintsUsed: finiteNumber(context.hintsUsed, 0, 100, 0),
    answerRevealed: Boolean(context.answerRevealed),
  };
}

function formatPressureContext(context = {}) {
  const pressure = getPressureContext(context);
  const fields = [
    ["Learning mode", pressure.mode],
    ["Pressure reference", pressure.pressureReference],
    ["Atmospheric pressure", `${pressure.atmosphericPressure.toFixed(1)} kPa`],
    ["Top layer enabled", pressure.topLayerEnabled ? "yes" : "no"],
    ["Top fluid", pressure.topFluid],
    ["Top fluid density", pressure.topLayerEnabled ? `${pressure.topDensity} kg/m³` : "not applicable"],
    ["Top layer total depth", pressure.topLayerEnabled ? `${pressure.topLayerDepth} m` : "not applicable"],
    ["Bottom fluid", pressure.bottomFluid],
    ["Bottom fluid density", `${pressure.bottomDensity} kg/m³`],
    ["Bottom layer total depth", `${pressure.bottomLayerDepth} m`],
    ["Sensor depth below free surface", `${pressure.sensorDepth.toFixed(3)} m`],
    ["Sensor layer", pressure.sensorLayer],
    ["Top-fluid depth above sensor", `${pressure.topDepthAboveSensor.toFixed(3)} m`],
    ["Bottom-fluid depth above sensor", `${pressure.bottomDepthAboveSensor.toFixed(3)} m`],
    ["Server-verified gage pressure", `${pressure.gagePressure.toFixed(3)} kPa`],
    ["Server-verified requested pressure", `${pressure.expectedPressure.toFixed(3)} kPa`],
    ["Student prediction", pressure.prediction == null ? "none" : `${pressure.prediction} kPa`],
    ["Server-verified prediction error", pressure.predictionError == null
      ? "not applicable"
      : `${pressure.predictionError.toFixed(3)} kPa`],
    ["Attempts", String(pressure.attempts)],
    ["Hints used", String(pressure.hintsUsed)],
    ["Answer revealed", pressure.answerRevealed ? "yes" : "no"],
  ];

  return fields.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function readableNumber(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function ruleBasedCoachReply(question, pressure) {
  const q = question.toLowerCase();

  if (q.includes("hint")) {
    if (
      pressure.topLayerEnabled
      && pressure.sensorDepth > pressure.topLayerDepth
    ) {
      return `Split the column at the interface. Calculate ρgh for ${readableNumber(pressure.topDepthAboveSensor)} m of ${pressure.topFluid}, then for ${readableNumber(pressure.bottomDepthAboveSensor)} m of ${pressure.bottomFluid}, and add them.${pressure.pressureReference === "absolute" ? " Add atmospheric pressure last." : ""}`;
    }
    return `Use the density of ${pressure.sensorLayer} and the vertical depth ${readableNumber(pressure.sensorDepth)} m in p = ρgh.${pressure.pressureReference === "absolute" ? " Then add atmospheric pressure." : " Convert Pa to kPa by dividing by 1000."}`;
  }

  if (q.includes("gage") || q.includes("absolute") || q.includes("atmos")) {
    return `Gage pressure is measured relative to local atmospheric pressure. Absolute pressure is measured relative to a perfect vacuum: p_abs = p_atm + p_g. At the open free surface, gage pressure is 0 kPa while absolute pressure is ${readableNumber(pressure.atmosphericPressure, 1)} kPa.`;
  }

  if (q.includes("slope") || q.includes("graph")) {
    return "The pressure-depth slope is dp/dh = ρg. A denser fluid makes the graph steeper. With two layers, the change in slope marks the fluid interface; pressure itself remains continuous there.";
  }

  if (q.includes("layer") || q.includes("add")) {
    return "Each layer adds the weight per unit area of fluid above the sensor. For two layers, p_g = ρ₁gh₁ + ρ₂gh₂. Use each density only with its own vertical depth.";
  }

  if (q.includes("unit") || q.includes("kpa") || q.includes("pa")) {
    return "Using density in kg/m³, g in m/s², and depth in m gives pressure in pascals. Divide by 1000 to report kilopascals.";
  }

  if (pressure.mode === "challenge" && !pressure.answerRevealed) {
    return "Start with the fluid directly below the free surface and account for every layer above the sensor. I will keep the numerical answer hidden while the challenge is active.";
  }

  return `At ${readableNumber(pressure.sensorDepth)} m, the gage pressure is ${readableNumber(pressure.gagePressure)} kPa. ${pressure.pressureReference === "absolute" ? `Adding ${readableNumber(pressure.atmosphericPressure, 1)} kPa gives ${readableNumber(pressure.expectedPressure)} kPa absolute.` : "Pressure rises with depth because more fluid weight is supported above the sensor."}`;
}

function coachInstructions() {
  return [
    "You are Prof. Gary's AI Proxy, the learning coach for a CE2134 hydrostatic-pressure column lab.",
    "Teach p = rho g h, additive pressure contributions across fluid layers, pressure-depth graphs, and gage versus absolute pressure.",
    "Use the supplied live game state and its server-verified numbers; do not invent measurements.",
    "When Challenge mode is active and Answer revealed is no, scaffold the next step without stating the final numerical answer unless the student explicitly asks to reveal it.",
    "Lead the student with one or two short reasoning steps before giving a conclusion.",
    "Correct misconceptions gently and keep replies classroom-friendly and under 140 words.",
    "Use plain text and readable equations; do not use markdown tables.",
  ].join(" ");
}

function extractReply(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

app.get("/api/health", (req, res) => {
  const condition = getStudyCondition(req);
  res.json({
    ok: true,
    coachReady: condition === "B" || Boolean(process.env.OPENAI_API_KEY),
    studyAssigned: Boolean(condition),
    studyConfigurationReady: studyConfigurationReady(),
    model,
  });
});

app.get("/study/:condition/:code", (req, res) => {
  const condition = cleanText(req.params.condition, 1).toUpperCase();
  const code = cleanText(req.params.code, 200);

  if (!studyConfigurationReady()) {
    return res.status(503).send("Study links are not configured yet.");
  }

  if (!["A", "B"].includes(condition)) {
    return res.status(404).send("Invalid study link.");
  }

  if (!timingSafeTextEqual(code, studyCodes[condition])) {
    return res.status(404).send("Invalid study link.");
  }

  const token = encodeURIComponent(createStudyToken(condition));
  res.setHeader(
    "Set-Cookie",
    `${STUDY_COOKIE}=${token}; Path=/; Max-Age=${STUDY_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
  return res.redirect(302, "/");
});

app.post("/api/chat", coachRateLimit, async (req, res) => {
  const question = cleanText(req.body?.question, 800);
  if (!question) {
    return res.status(400).json({ error: "Please enter a question." });
  }

  const history = cleanHistory(req.body?.history);
  const pressure = getPressureContext(req.body?.context);
  const gameContext = formatPressureContext(req.body?.context);
  const sessionSource = cleanText(req.body?.sessionId, 160)
    || req.ip
    || "anonymous";
  const safetyIdentifier = crypto
    .createHash("sha256")
    .update(sessionSource)
    .digest("hex")
    .slice(0, 64);
  const assignedCondition = getStudyCondition(req);
  const condition = assignedCondition || "A";

  function sendCoachReply(reply, source) {
    console.log(JSON.stringify({
      event: "coach_reply",
      source,
      assignedCondition: assignedCondition || "unassigned",
      session: safetyIdentifier.slice(0, 12),
      time: new Date().toISOString(),
    }));
    return res.json({ reply, source });
  }

  if (condition === "B") {
    return sendCoachReply(
      ruleBasedCoachReply(question, pressure),
      "rule_based",
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendCoachReply(
      ruleBasedCoachReply(question, pressure),
      "api_fallback",
    );
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: coachInstructions(),
        input: [
          ...history,
          {
            role: "user",
            content: `${question}\n\nCurrent pressure-column state:\n${gameContext}`,
          },
        ],
        reasoning: { effort: "low" },
        max_output_tokens: 350,
        safety_identifier: safetyIdentifier,
      }),
    });

    if (!upstream.ok) {
      const details = (await upstream.text()).slice(0, 800);
      console.error(`OpenAI request failed (${upstream.status}): ${details}`);
      return sendCoachReply(
        ruleBasedCoachReply(question, pressure),
        "api_fallback",
      );
    }

    const data = await upstream.json();
    const reply = extractReply(data);
    if (!reply) throw new Error("OpenAI returned an empty reply");

    return sendCoachReply(reply, "llm");
  } catch (error) {
    console.error("AI Proxy error:", error);
    return sendCoachReply(
      ruleBasedCoachReply(question, pressure),
      "api_fallback",
    );
  }
});

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  return res.status(500).json({ error: "Server error" });
});

app.listen(port, () => {
  console.log(`Hydrostatic-pressure lab listening on http://localhost:${port}`);
  console.log(`AI Proxy model: ${model}`);
});
