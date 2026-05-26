import { FormEvent, useEffect, useMemo, useState } from "react";
import "./styles.css";

type Role = "user" | "assistant";

type ChatMessage = {
  role: Role;
  content: string;
};

type Category = {
  id: string;
  name: string;
  examples: string[];
  documents: string[];
};

type RecordsPayload = {
  complaints: AppRecord[];
  policyRequests: AppRecord[];
};

type AppRecord = {
  id: string;
  status: string;
  createdAt: string;
  category?: string;
  issue?: string;
  coverageNeed?: string;
};

type RagStats = {
  pdfs: string[];
  sourceCount: number;
  chunkCount: number;
  generatedAt?: string;
  embedding?: { provider: string; dimensions: number };
};

type RagResult = {
  source: string;
  chunk: number;
  score: number;
  content: string;
};

const storageKey = "osiguranjebot.messages";
const maxStoredMessages = 40;
const starterMessage =
  "Bok. Opišite vrstu osiguranja, što se dogodilo, što je osiguratelj odgovorio i koje rokove ili dokumente imate. Ja ću složiti praktične korake i, po potrebi, otvoriti prigovor ili zahtjev za novu policu.";

function renderMarkdown(text: string) {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (value: string) =>
    escape(value)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>");

  const blocks: string[] = [];
  let listItems: string[] = [];
  let quoteLines: string[] = [];

  const flushList = () => {
    if (listItems.length) {
      blocks.push(`<ul>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      listItems = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      blocks.push(`<blockquote>${quoteLines.map(inline).join("<br>")}</blockquote>`);
      quoteLines = [];
    }
  };

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      flushQuote();
      return;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushList();
      flushQuote();
      blocks.push(`<h3>${inline(heading[1])}</h3>`);
      return;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushQuote();
      listItems.push((bullet || numbered)?.[1] || "");
      return;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushList();
      quoteLines.push(quote[1]);
      return;
    }
    flushList();
    flushQuote();
    blocks.push(`<p>${inline(line)}</p>`);
  });

  flushList();
  flushQuote();
  return blocks.join("");
}

async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed.");
  }
  return data;
}

export default function App() {
  const [activeView, setActiveView] = useState("chat");
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || "[]");
    } catch {
      return [];
    }
  });
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [records, setRecords] = useState<RecordsPayload>({ complaints: [], policyRequests: [] });
  const [ragStats, setRagStats] = useState<RagStats | null>(null);
  const [ragResults, setRagResults] = useState<RagResult[]>([]);
  const [notice, setNotice] = useState("");

  const visibleMessages = useMemo(
    () => [{ role: "assistant" as const, content: starterMessage }, ...messages],
    [messages],
  );

  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-maxStoredMessages)));
  }, [messages]);

  useEffect(() => {
    loadCategories();
    loadRecords();
    loadRagStats();
  }, []);

  async function loadCategories() {
    const data = await jsonFetch<{ categories: Category[] }>("/api/categories");
    setCategories(data.categories);
  }

  async function loadRecords() {
    setRecords(await jsonFetch<RecordsPayload>("/api/requests"));
  }

  async function loadRagStats() {
    setRagStats(await jsonFetch<RagStats>("/api/admin/rag/stats"));
  }

  async function submitChat(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setDraft("");
    setLoading(true);

    try {
      const data = await jsonFetch<{ reply: string }>("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
      await loadRecords();
    } catch (error) {
      setMessages([
        ...nextMessages,
        { role: "assistant", content: `Ne mogu trenutno dobiti odgovor. ${(error as Error).message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function submitIntake(event: FormEvent<HTMLFormElement>, url: string, success: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(
      [...new FormData(form).entries()].filter(([, value]) => String(value).trim()),
    );
    await jsonFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    form.reset();
    setNotice(success);
    await loadRecords();
  }

  async function uploadPdfs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = await jsonFetch<{ uploaded: string[] }>("/api/admin/rag/upload", {
      method: "POST",
      body: new FormData(form),
    });
    form.reset();
    setNotice(`Učitano: ${data.uploaded.join(", ")}`);
    const indexed = (data as { index?: { sourceCount: number; chunkCount: number } }).index;
    if (indexed) {
      setNotice(
        `Učitano: ${data.uploaded.join(", ")}. Indeksirano ${indexed.sourceCount} PDF dokumenata u ${indexed.chunkCount} chunkova.`,
      );
    }
    await loadRagStats();
  }

  async function reindexRag() {
    setNotice("Gradim vektorski indeks...");
    const data = await jsonFetch<{ sourceCount: number; chunkCount: number }>("/api/admin/rag/reindex", {
      method: "POST",
    });
    setNotice(`Indeksirano ${data.sourceCount} PDF dokumenata u ${data.chunkCount} chunkova.`);
    await loadRagStats();
  }

  async function searchRag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("query") || "");
    const data = await jsonFetch<{ results: RagResult[] }>(`/api/admin/rag/search?q=${encodeURIComponent(query)}`);
    setRagResults(data.results);
  }

  return (
    <main className="shell">
      <section className="panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Croatian insurance assistant</p>
            <h1>OsiguranjeBot</h1>
          </div>
        </header>

        <nav className="tabs" aria-label="Insurance workspace">
          {[
            ["chat", "Chat"],
            ["insurance", "Osiguranja"],
            ["complaint", "Prigovor"],
            ["policy", "Nova polica"],
            ["records", "Predmeti"],
            ["admin", "Admin"],
          ].map(([id, label]) => (
            <button key={id} type="button" className={activeView === id ? "active" : ""} onClick={() => setActiveView(id)}>
              {label}
            </button>
          ))}
        </nav>

        <section className="workspace">
          {activeView === "chat" && (
            <div className="view active" id="chat-view">
              <section className="chat" aria-live="polite">
                {visibleMessages.map((message, index) => (
                  <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                    <div
                      className="bubble"
                      dangerouslySetInnerHTML={
                        message.role === "assistant" ? { __html: renderMarkdown(message.content) } : undefined
                      }
                    >
                      {message.role === "user" ? message.content : null}
                    </div>
                  </article>
                ))}
              </section>
              <form className="composer" onSubmit={submitChat}>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={3}
                  placeholder="Primjer: Croatia osiguranje odbilo mi je isplatu za prometnu štetu jer kažu da nedostaje dokaz..."
                  required
                />
                <button type="submit" disabled={loading}>{loading ? "Thinking" : "Send"}</button>
              </form>
            </div>
          )}

          {activeView === "insurance" && (
            <div className="view active padded">
              <div className="category-grid">
                {categories.map((category) => (
                  <article className="category-card" key={category.id}>
                    <h2>{category.name}</h2>
                    <p>{category.examples.join(", ")}</p>
                    <h3>Dokumenti</h3>
                    <ul>{category.documents.map((document) => <li key={document}>{document}</li>)}</ul>
                  </article>
                ))}
              </div>
            </div>
          )}

          {activeView === "complaint" && (
            <div className="view active padded">
              <form className="intake-form" onSubmit={(event) => submitIntake(event, "/api/complaints", "Prigovor je spremljen.")}>
                <CategorySelect categories={categories} />
                <label>Osiguratelj<input name="insurer" placeholder="npr. Croatia osiguranje" /></label>
                <label>Broj police ili štete<input name="policyNumber" placeholder="ako ga imate" /></label>
                <label>Problem<textarea name="issue" rows={4} required /></label>
                <label>Željeni ishod<textarea name="desiredOutcome" rows={3} required /></label>
                <label>Ime i prezime<input name="customerName" /></label>
                <label>Kontakt<input name="contact" placeholder="email ili telefon" /></label>
                <button type="submit">Spremi prigovor</button>
                <p className="form-result">{notice}</p>
              </form>
            </div>
          )}

          {activeView === "policy" && (
            <div className="view active padded">
              <form className="intake-form" onSubmit={(event) => submitIntake(event, "/api/policies", "Zahtjev za policu je spremljen.")}>
                <CategorySelect categories={categories} />
                <label>Što želite osigurati?<textarea name="coverageNeed" rows={4} required /></label>
                <label>Početak police<input name="startDate" type="date" /></label>
                <label>Ime i prezime<input name="customerName" /></label>
                <label>Kontakt<input name="contact" placeholder="email ili telefon" /></label>
                <label>Napomene<textarea name="notes" rows={3} /></label>
                <button type="submit">Spremi zahtjev</button>
                <p className="form-result">{notice}</p>
              </form>
            </div>
          )}

          {activeView === "records" && (
            <div className="view active padded">
              <div className="records-toolbar"><button type="button" onClick={loadRecords}>Osvježi</button></div>
              <Records records={records} />
            </div>
          )}

          {activeView === "admin" && (
            <div className="view active padded">
              <section className="admin-layout">
                <form className="intake-form" onSubmit={uploadPdfs}>
                  <label>PDF dokumenti za RAG<input name="pdfs" type="file" accept="application/pdf,.pdf" multiple required /></label>
                  <button type="submit">Učitaj PDF</button>
                </form>
                <div className="admin-actions">
                  <button type="button" onClick={reindexRag}>Izgradi vektorski indeks</button>
                  <button type="button" onClick={loadRagStats}>Osvježi status</button>
                </div>
                <p className="form-result">{notice}</p>
                {ragStats && <RagStatsCard stats={ragStats} />}
                <form className="intake-form" onSubmit={searchRag}>
                  <label>Test pretraga dokumenata<input name="query" placeholder="npr. isključenja kod auto osiguranja" required /></label>
                  <button type="submit">Pretraži</button>
                </form>
                <div className="records-list">
                  {ragResults.map((result) => (
                    <article className="record-row rag-result" key={`${result.source}-${result.chunk}`}>
                      <div>
                        <strong>{result.source} · chunk {result.chunk}</strong>
                        <p>{result.content.slice(0, 420)}</p>
                      </div>
                      <span>{result.score.toFixed(2)}</span>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function CategorySelect({ categories }: { categories: Category[] }) {
  return (
    <label>Kategorija
      <select name="category" required>
        {categories.map((category) => (
          <option value={category.id} key={category.id}>{category.name}</option>
        ))}
      </select>
    </label>
  );
}

function Records({ records }: { records: RecordsPayload }) {
  const rows = [
    ...records.complaints.map((record) => ({ ...record, typeLabel: "Prigovor", body: record.issue })),
    ...records.policyRequests.map((record) => ({ ...record, typeLabel: "Nova polica", body: record.coverageNeed })),
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  if (!rows.length) return <p className="empty">Još nema spremljenih predmeta.</p>;
  return (
    <div className="records-list">
      {rows.map((record) => (
        <article className="record-row" key={record.id}>
          <div>
            <strong>{record.typeLabel} · {record.category || "bez kategorije"}</strong>
            <p>{record.body}</p>
          </div>
          <span>{record.status}</span>
        </article>
      ))}
    </div>
  );
}

function RagStatsCard({ stats }: { stats: RagStats }) {
  return (
    <article className="category-card rag-stats">
      <h2>RAG status</h2>
      <p>PDF dokumenti: {stats.pdfs?.length || 0}</p>
      <p>Izvori u indeksu: {stats.sourceCount || 0}</p>
      <p>Chunkovi: {stats.chunkCount || 0}</p>
      <p>Zadnja izgradnja: {stats.generatedAt || "nije izgrađeno"}</p>
      <h3>Dokumenti</h3>
      <ul>{(stats.pdfs || []).map((file) => <li key={file}>{file}</li>)}</ul>
    </article>
  );
}
