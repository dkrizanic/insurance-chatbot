import "dotenv/config";
import express from "express";
import path from "node:path";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const port = Number(process.env.PORT || 3000);
const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
const distDir = path.join(process.cwd(), "frontend", "dist");

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
