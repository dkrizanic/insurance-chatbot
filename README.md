# OsiguranjeBot

A Croatian insurance assistant with a React UI, Node/TypeScript UI gateway, and Python/FastAPI AI service. API keys stay server-side; the browser talks to Node at `/api/*`, and Node proxies AI/RAG work to FastAPI.

## Architecture

- `frontend/` -- React/Vite application.
- `backend/node_gateway/` -- Node/TypeScript UI gateway, `/api` proxy, and record write/read APIs.
- `backend/ai_service/` -- FastAPI AI service: chat, tools, and RAG PDF upload/indexing.
- `config/` -- assistant prompts, scope classifier, tool schemas, and category data.
- `rag/pdf/` -- source PDFs.
- `rag/index/` -- generated chunk/vector index.

## Setup

```powershell
npm install
python -m pip install -r backend/ai_service/requirements.txt
Copy-Item .env.example .env
notepad .env
npm run build
npm run rag:ingest
npm run test:ai
npm run dev
```

Open:

- React dev UI: `http://localhost:5173`
- Node gateway: `http://localhost:3000`
- FastAPI service: `http://localhost:8000`

For a production-style local run after `npm run build`, start FastAPI with `npm run dev:ai` and Node with `npm run start`.

## Assistant Scope

For an OpenRouter key, set `OPENROUTER_API_KEY` in `.env`. For a direct OpenAI key, set `OPENAI_API_KEY`.

The assistant helps users reason through standard Croatian insurance problems: claim delays, rejected claims, missing documents, settlement offers, auto and property damage, travel insurance, policy cancellation, and complaint drafting.

It is intentionally constrained: it can explain steps and draft messages, but it must not make final legal, medical, claim-value, coverage, or fault determinations.

## Insurance Workspace

The app now has tabs for:

- `Chat` -- insurance assistant with recent conversation history.
- `Osiguranja` -- category overview and document checklists.
- `Prigovor` -- complaint intake form.
- `Nova polica` -- new policy request form across insurance categories.
- `Predmeti` -- locally saved complaint and policy records.

Records are stored locally in `data/requests.json`.

The chatbot can also create complaint and policy request records through model tool calls. FastAPI executes tools by calling Node app APIs, and Node stores records locally.

## Configuration

Business/domain content is kept outside application code:

- `config/prompts/system.md` -- main assistant behavior.
- `config/prompts/scope-classifier.md` -- allow/refuse routing prompt.
- `config/messages/out-of-scope.md` -- refusal message.
- `config/insurance-categories.json` -- insurance category cards and document lists.
- `config/app-tools.json` -- tool schemas available to the chatbot.

## RAG Admin

The `Admin` tab can upload more PDF files, rebuild the local vector index, inspect RAG stats, and run test searches. PDFs live in `rag/pdf/`; the generated local vector index lives in `rag/index/vectors.json`.

## Chat History

The browser keeps the current tab's chat history in `sessionStorage`, so refreshes keep the conversation context. Each request sends recent messages to FastAPI, which forwards the latest messages to the model.

## Demo Usage Limit

For demo runs, FastAPI applies a simple daily chat limit per browser demo ID. Configure it with `DEMO_CHAT_DAILY_LIMIT` in `.env`; the default is `50`, and `0` disables the guard. Counts are kept in memory, so restarting the AI service resets them.

The Admin tab is protected by `ADMIN_PASSWORD_HASH`. The demo default hash is for password `admin`.

## Current Reference Points

- HANFA consumer guidance says a written complaint to an insurer should receive a response within 15 days.
- HANFA also says it cannot decide whether a claim is founded or determine the amount of damages.
- Hrvatski ured za osiguranje (HUO) provides consumer-protection and mediation mechanisms for insurance disputes.
