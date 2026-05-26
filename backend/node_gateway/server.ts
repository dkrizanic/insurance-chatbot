import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createProxyMiddleware } from "http-proxy-middleware";

type AppRecord = {
  id: string;
  status: "new";
  createdAt: string;
  [key: string]: unknown;
};

type RecordsPayload = {
  complaints: AppRecord[];
  policyRequests: AppRecord[];
};

const app = express();
const port = Number(process.env.PORT || 3000);
const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
const distDir = path.join(process.cwd(), "frontend", "dist");
const dataDir = path.join(process.cwd(), "data");
const requestsFile = path.join(dataDir, "requests.json");

app.use(express.json());

function makeRecord(prefix: "complaint" | "policy", payload: Record<string, unknown>): AppRecord {
  return {
    id: `${prefix}-${Date.now().toString(16)}`,
    status: "new",
    createdAt: new Date().toISOString(),
    ...payload,
  };
}

async function readRequests(): Promise<RecordsPayload> {
  try {
    const raw = await fs.readFile(requestsFile, "utf-8");
    const parsed = JSON.parse(raw) as RecordsPayload;
    return {
      complaints: Array.isArray(parsed.complaints) ? parsed.complaints : [],
      policyRequests: Array.isArray(parsed.policyRequests) ? parsed.policyRequests : [],
    };
  } catch {
    return { complaints: [], policyRequests: [] };
  }
}

async function saveRequests(data: RecordsPayload): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(requestsFile, JSON.stringify(data, null, 2), "utf-8");
}

app.get("/api/requests", async (_req, res) => {
  res.json(await readRequests());
});

app.post("/api/complaints", async (req, res) => {
  const payload = req.body as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Invalid complaint payload." });
  }
  if (!payload.category || !payload.issue || !payload.desiredOutcome) {
    return res.status(400).json({ error: "category, issue and desiredOutcome are required." });
  }
  const data = await readRequests();
  const complaint = makeRecord("complaint", payload);
  data.complaints.push(complaint);
  await saveRequests(data);
  res.status(201).json({ complaint });
});

app.post("/api/policies", async (req, res) => {
  const payload = req.body as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Invalid policy payload." });
  }
  if (!payload.category || !payload.coverageNeed) {
    return res.status(400).json({ error: "category and coverageNeed are required." });
  }
  const data = await readRequests();
  const policyRequest = makeRecord("policy", payload);
  data.policyRequests.push(policyRequest);
  await saveRequests(data);
  res.status(201).json({ policyRequest });
});

app.use(
  "/api",
  createProxyMiddleware({
    target: aiServiceUrl,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
  }),
);

app.use(express.static(distDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Node UI gateway running at http://localhost:${port}`);
  console.log(`Proxying /api to ${aiServiceUrl}`);
});
