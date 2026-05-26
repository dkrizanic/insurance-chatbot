from __future__ import annotations

import json
import math
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ftfy import fix_text
from openai import OpenAI
from pydantic import BaseModel
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[3]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
RAG_DIR = ROOT / "rag"
PDF_DIR = RAG_DIR / "pdf"
INDEX_DIR = RAG_DIR / "index"
CHUNKS_FILE = INDEX_DIR / "chunks.json"
VECTORS_FILE = INDEX_DIR / "vectors.json"
REQUESTS_FILE = DATA_DIR / "requests.json"

CHUNK_SIZE = 1200
OVERLAP = 180
VECTOR_DIMENSIONS = 384

load_dotenv(ROOT / ".env")

api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENROUTER_API_KEY")
is_openrouter = bool(api_key and api_key.startswith("sk-or-"))
base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("OPENROUTER_BASE_URL") or (
    "https://openrouter.ai/api/v1" if is_openrouter else None
)
provider = "openrouter" if is_openrouter or (base_url and "openrouter.ai" in base_url) else "openai"
model = os.getenv("OPENAI_MODEL") or os.getenv("OPENROUTER_MODEL") or (
    "openai/gpt-5.4-mini" if provider == "openrouter" else "gpt-5.4-mini"
)

client = OpenAI(api_key=api_key, base_url=base_url)

app = FastAPI(title="OsiguranjeBot AI Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


class ComplaintRequest(BaseModel):
    category: str
    issue: str
    desiredOutcome: str
    insurer: str | None = None
    policyNumber: str | None = None
    customerName: str | None = None
    contact: str | None = None


class PolicyRequest(BaseModel):
    category: str
    coverageNeed: str
    customerName: str | None = None
    contact: str | None = None
    startDate: str | None = None
    notes: str | None = None


def read_text(relative_path: str) -> str:
    return (CONFIG_DIR / relative_path).read_text(encoding="utf-8").strip()


def read_json(relative_path: str) -> Any:
    return json.loads((CONFIG_DIR / relative_path).read_text(encoding="utf-8"))


SYSTEM_PROMPT = read_text("prompts/system.md")
SCOPE_CLASSIFIER_PROMPT = read_text("prompts/scope-classifier.md")
OUT_OF_SCOPE_REPLY = read_text("messages/out-of-scope.md")
INSURANCE_CATEGORIES = read_json("insurance-categories.json")
APP_TOOLS = read_json("app-tools.json")


def normalize_text(text: str) -> str:
    text = fix_text(text)
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text: str) -> list[str]:
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(text):
            break
        start = max(0, end - OVERLAP)
    return chunks


def tokenize(text: str) -> list[str]:
    text = text.lower()
    replacements = str.maketrans("čćđšž", "ccdsz")
    text = text.translate(replacements)
    return re.findall(r"[a-z0-9]{3,}", text)


def hash_token(token: str) -> int:
    value = 2166136261
    for char in token:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def embed_text(text: str) -> list[float]:
    vector = [0.0] * VECTOR_DIMENSIONS
    for token in tokenize(text):
        hashed = hash_token(token)
        vector[hashed % VECTOR_DIMENSIONS] += 1 if hashed % 2 == 0 else -1
    magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / magnitude for value in vector]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def keyword_score(query_tokens: list[str], text: str) -> float:
    if not query_tokens:
        return 0.0
    terms = set(tokenize(text))
    return sum(1 for token in query_tokens if token in terms) / len(query_tokens)


def build_rag_index() -> dict[str, Any]:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(PDF_DIR.glob("*.pdf"), key=lambda item: item.name.lower())
    chunks: list[dict[str, Any]] = []
    vectors: list[dict[str, Any]] = []

    for pdf in pdfs:
        reader = PdfReader(str(pdf))
        text = normalize_text("\n\n".join(page.extract_text() or "" for page in reader.pages))
        for index, content in enumerate(chunk_text(text), start=1):
            chunk = {
                "id": f"{pdf.stem}-{index}",
                "source": pdf.name,
                "chunk": index,
                "totalPages": len(reader.pages),
                "content": content,
            }
            chunks.append(chunk)
            vectors.append({"id": chunk["id"], "vector": embed_text(content), "metadata": chunk})

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "embedding": {"provider": "python-local-hashed", "dimensions": VECTOR_DIMENSIONS},
        "sourceCount": len(pdfs),
        "chunkCount": len(chunks),
        "chunks": chunks,
    }
    CHUNKS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    VECTORS_FILE.write_text(json.dumps({"vectors": vectors}, ensure_ascii=False), encoding="utf-8")

    return {
        "sourceCount": len(pdfs),
        "chunkCount": len(chunks),
        "chunksFile": str(CHUNKS_FILE.relative_to(ROOT)),
        "vectorFile": str(VECTORS_FILE.relative_to(ROOT)),
    }


def rag_stats() -> dict[str, Any]:
    pdfs = sorted([pdf.name for pdf in PDF_DIR.glob("*.pdf")])
    try:
        index = json.loads(CHUNKS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        index = {}
    return {
        "pdfs": pdfs,
        "sourceCount": index.get("sourceCount", 0),
        "chunkCount": index.get("chunkCount", 0),
        "generatedAt": index.get("generatedAt"),
        "embedding": index.get("embedding"),
    }


def search_rag(query: str, top_k: int = 4) -> list[dict[str, Any]]:
    try:
        vector_index = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))["vectors"]
    except FileNotFoundError:
        return []

    query_vector = embed_text(query)
    query_tokens = tokenize(query)
    ranked = []
    for item in vector_index:
        metadata = item["metadata"]
        vector_score = cosine(query_vector, item["vector"])
        key_score = keyword_score(query_tokens, f"{metadata['source']} {metadata['content']}")
        ranked.append({
            "score": round(vector_score + key_score, 4),
            "vectorScore": vector_score,
            "keywordScore": key_score,
            **metadata,
        })
    ranked.sort(key=lambda result: result["score"], reverse=True)
    return ranked[:top_k]


def format_rag_context(results: list[dict[str, Any]]) -> str:
    if not results:
        return ""
    parts = ["Relevant PDF excerpts. Use only when relevant and cite source filenames in the answer:"]
    for index, result in enumerate(results, start=1):
        parts.append(f"[{index}] Source: {result['source']}, chunk {result['chunk']}\n{result['content']}")
    return "\n\n".join(parts)


def read_requests() -> dict[str, list[dict[str, Any]]]:
    try:
        return json.loads(REQUESTS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"complaints": [], "policyRequests": []}


def save_requests(data: dict[str, list[dict[str, Any]]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REQUESTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def make_record(prefix: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"{prefix}-{int(time.time() * 1000):x}",
        "status": "new",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **payload,
    }


def create_complaint(payload: dict[str, Any]) -> dict[str, Any]:
    data = read_requests()
    record = make_record("complaint", payload)
    data["complaints"].append(record)
    save_requests(data)
    return record


def create_policy_request(payload: dict[str, Any]) -> dict[str, Any]:
    data = read_requests()
    record = make_record("policy", payload)
    data["policyRequests"].append(record)
    save_requests(data)
    return record


def sanitize_messages(messages: list[ChatMessage]) -> list[dict[str, str]]:
    return [
        {"role": message.role, "content": message.content[:4000]}
        for message in messages[-24:]
        if message.content
    ]


def is_allowed_conversation(messages: list[dict[str, str]]) -> bool:
    latest = next((message for message in reversed(messages) if message["role"] == "user"), None)
    if not latest:
        return False
    recent_user_messages = "\n---\n".join(
        message["content"] for message in messages if message["role"] == "user"
    )
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SCOPE_CLASSIFIER_PROMPT},
            {
                "role": "user",
                "content": f"Recent user messages:\n{recent_user_messages}\n\nLatest user message:\n{latest['content']}",
            },
        ],
        max_tokens=20,
    )
    return (response.choices[0].message.content or "").strip().upper().startswith("ALLOW")


def run_tool_call(tool_call: Any) -> dict[str, Any]:
    args = json.loads(tool_call.function.arguments or "{}")
    if tool_call.function.name == "create_complaint":
        record = create_complaint(args)
        return {"ok": True, "kind": "complaint", "id": record["id"]}
    if tool_call.function.name == "create_policy_request":
        record = create_policy_request(args)
        return {"ok": True, "kind": "policy_request", "id": record["id"]}
    return {"ok": False, "error": "Unknown tool."}


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "provider": provider, "model": model, "hasApiKey": bool(api_key)}


@app.get("/categories")
def categories() -> dict[str, Any]:
    return {"categories": INSURANCE_CATEGORIES}


@app.get("/requests")
def requests() -> dict[str, Any]:
    return read_requests()


@app.post("/complaints")
def complaints(payload: ComplaintRequest) -> dict[str, Any]:
    return {"complaint": create_complaint(payload.model_dump(exclude_none=True))}


@app.post("/policies")
def policies(payload: PolicyRequest) -> dict[str, Any]:
    return {"policyRequest": create_policy_request(payload.model_dump(exclude_none=True))}


@app.get("/admin/rag/stats")
def admin_rag_stats() -> dict[str, Any]:
    return rag_stats()


@app.post("/admin/rag/upload")
async def admin_rag_upload(pdfs: list[UploadFile] = File(...)) -> dict[str, Any]:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    uploaded = []
    for pdf in pdfs:
        if not pdf.filename or not pdf.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files are supported.")
        safe_name = re.sub(r'[<>:"/\\|?*]', "_", pdf.filename)
        with (PDF_DIR / safe_name).open("wb") as output:
            shutil.copyfileobj(pdf.file, output)
        uploaded.append(safe_name)
    index_result = build_rag_index()
    return {"uploaded": uploaded, "index": index_result}


@app.post("/admin/rag/reindex")
def admin_rag_reindex() -> dict[str, Any]:
    return build_rag_index()


@app.get("/admin/rag/search")
def admin_rag_search(q: str) -> dict[str, Any]:
    return {"results": search_rag(q, 6)}


@app.post("/chat")
def chat(payload: ChatRequest) -> dict[str, Any]:
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY or OPENROUTER_API_KEY is not configured.")

    messages = sanitize_messages(payload.messages)
    if not messages:
        raise HTTPException(status_code=400, detail="Send at least one message.")
    if not is_allowed_conversation(messages):
        return {"reply": OUT_OF_SCOPE_REPLY}

    latest = next((message for message in reversed(messages) if message["role"] == "user"), None)
    rag_context = format_rag_context(search_rag(latest["content"], 4)) if latest else ""
    system_prompt = f"{SYSTEM_PROMPT}\n\n{rag_context}" if rag_context else SYSTEM_PROMPT

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system_prompt}, *messages],
        tools=APP_TOOLS,
        tool_choice="auto",
        max_tokens=900,
    )
    message = response.choices[0].message
    reply = message.content

    if message.tool_calls:
        tool_messages = []
        for tool_call in message.tool_calls:
            tool_messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(run_tool_call(tool_call)),
            })
        final_response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                *messages,
                message,
                *tool_messages,
            ],
            max_tokens=500,
        )
        reply = final_response.choices[0].message.content

    return {"reply": (reply or "Nisam uspio sastaviti odgovor. Pokusajte ponovno s vise detalja.").strip()}
