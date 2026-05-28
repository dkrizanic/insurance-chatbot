import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
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
  typeLabel?: string;
  body?: string;
  [key: string]: unknown;
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

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const storageKey = "osiguranjebot.messages";
const demoUserKey = "osiguranjebot.demoUserId";
const adminPasswordKey = "osiguranjebot.adminPassword";
const maxStoredMessages = 40;
const starterMessage =
  "Bok. Opišite vrstu osiguranja, što se dogodilo, što je osiguratelj odgovorio i koje rokove ili dokumente imate. Ja ću složiti praktične korake i, po potrebi, otvoriti prigovor ili zahtjev za novu policu.";

function getDemoUserId() {
  let userId = localStorage.getItem(demoUserKey);
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem(demoUserKey, userId);
  }
  return userId;
}

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
    throw new ApiError(data.detail || data.error || "Request failed.", response.status);
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
  const [adminPassword, setAdminPassword] = useState(() => sessionStorage.getItem(adminPasswordKey) || "");
  const [adminDraft, setAdminDraft] = useState("");
  const chatRef = useRef<HTMLElement | null>(null);

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
  }, []);

  useEffect(() => {
    if (activeView === "admin" && adminPassword) {
      loadRagStats().catch(() => lockAdmin("Admin lozinka nije ispravna."));
    }
  }, [activeView, adminPassword]);

  useEffect(() => {
    if (activeView !== "chat") return;
    const chat = chatRef.current;
    if (!chat) return;
    requestAnimationFrame(() => {
      chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
    });
  }, [activeView, visibleMessages, loading]);

  async function loadCategories() {
    const data = await jsonFetch<{ categories: Category[] }>("/api/categories");
    setCategories(data.categories);
  }

  async function loadRecords() {
    setRecords(await jsonFetch<RecordsPayload>("/api/requests"));
  }

  function adminHeaders(password = adminPassword): HeadersInit {
    return { "X-Admin-Password": password };
  }

  async function loadRagStats(password = adminPassword) {
    if (!password) return;
    setRagStats(await jsonFetch<RagStats>("/api/admin/rag/stats", { headers: adminHeaders(password) }));
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
        headers: { "Content-Type": "application/json", "X-Demo-User-Id": getDemoUserId() },
        body: JSON.stringify({ messages: nextMessages }),
      });
      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
      await loadRecords();
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 429
          ? error.message
          : `Ne mogu trenutno dobiti odgovor. ${(error as Error).message}`;
      setMessages([
        ...nextMessages,
        { role: "assistant", content: message },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    setMessages([]);
    setDraft("");
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !loading) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
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
    setNotice("Učitavam PDF i gradim indeks...");
    try {
      const data = await jsonFetch<{ uploaded: string[] }>("/api/admin/rag/upload", {
        method: "POST",
        headers: adminHeaders(),
        body: new FormData(form),
      });
      form.reset();
      setRagResults([]);
      const indexed = (data as { index?: { sourceCount: number; chunkCount: number } }).index;
      setNotice(
        indexed
          ? `Uspješno: ${data.uploaded.join(", ")} je učitan i indeksiran. Ukupno ${indexed.sourceCount} PDF dokumenata i ${indexed.chunkCount} chunkova.`
          : `Uspješno učitano: ${data.uploaded.join(", ")}.`,
      );
      await loadRagStats();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function searchRag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("query") || "");
    const data = await jsonFetch<{ results: RagResult[] }>(`/api/admin/rag/search?q=${encodeURIComponent(query)}`, {
      headers: adminHeaders(),
    });
    setRagResults(data.results);
  }

  async function unlockAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = adminDraft.trim();
    try {
      await loadRagStats(password);
      sessionStorage.setItem(adminPasswordKey, password);
      setAdminPassword(password);
      setAdminDraft("");
      setNotice("");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  function lockAdmin(message = "") {
    sessionStorage.removeItem(adminPasswordKey);
    setAdminPassword("");
    setAdminDraft("");
    setRagStats(null);
    setRagResults([]);
    setNotice(message);
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
              <section className="chat" aria-live="polite" ref={chatRef}>
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
                  onKeyDown={submitOnEnter}
                  rows={3}
                  placeholder="Primjer: Croatia osiguranje odbilo mi je isplatu za prometnu štetu jer kažu da nedostaje dokaz..."
                  required
                />
                <div className="composer-actions">
                  <button type="button" className="secondary-button" onClick={clearChat} disabled={loading || (!messages.length && !draft)}>
                    Očisti chat
                  </button>
                  <button type="submit" disabled={loading}>
                    {loading ? (
                      <span className="thinking-dots" aria-label="Tražim odgovor">
                        <span></span>
                        <span></span>
                        <span></span>
                      </span>
                    ) : "Send"}
                  </button>
                </div>
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
              {!adminPassword ? (
                <form className="intake-form admin-login" onSubmit={unlockAdmin}>
                  <label>Admin lozinka<input type="password" value={adminDraft} onChange={(event) => setAdminDraft(event.target.value)} autoComplete="current-password" required /></label>
                  <button type="submit">Otključaj Admin</button>
                  <p className="form-result">{notice}</p>
                </form>
              ) : (
                <section className="admin-layout">
                  <form className="intake-form" onSubmit={uploadPdfs}>
                    <label>PDF dokumenti za RAG<input name="pdfs" type="file" accept="application/pdf,.pdf" multiple required /></label>
                    <button type="submit">Učitaj PDF</button>
                  </form>
                  <div className="admin-actions">
                    <button type="button" onClick={() => loadRagStats()}>Osvježi status</button>
                    <button type="button" className="secondary-button" onClick={() => lockAdmin()}>Zaključaj Admin</button>
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
              )}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = [
    ...records.complaints.map((record) => ({ ...record, typeLabel: "Prigovor", body: record.issue })),
    ...records.policyRequests.map((record) => ({ ...record, typeLabel: "Nova polica", body: record.coverageNeed })),
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const selectedRecord = rows.find((record) => record.id === selectedId) || null;

  useEffect(() => {
    if (selectedId && !selectedRecord) {
      setSelectedId(null);
    }
  }, [selectedId, selectedRecord]);

  if (!rows.length) return <p className="empty">Još nema spremljenih predmeta.</p>;
  return (
    <div className="records-layout">
      <div className="records-list">
        {rows.map((record) => (
          <article className="record-row" key={record.id}>
            <div>
              <strong>{record.typeLabel} · {record.category || "bez kategorije"}</strong>
              <p>{record.body}</p>
            </div>
            <div className="record-actions">
              <span>{record.status}</span>
              <button type="button" onClick={() => setSelectedId(record.id)}>
                Otvori
              </button>
            </div>
          </article>
        ))}
      </div>
      {selectedRecord && <RecordDetails record={selectedRecord} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function RecordDetails({ record, onClose }: { record: AppRecord; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const hiddenFields = new Set(["body", "typeLabel"]);
  const fields = Object.entries(record).filter(
    ([key, value]) => !hiddenFields.has(key) && value !== undefined && value !== null && String(value).trim() !== "",
  );

  async function copySummary() {
    await navigator.clipboard.writeText(formatRecordSummary(record));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadPdf() {
    const pdf = new jsPDF();
    const margin = 16;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const maxWidth = pageWidth - margin * 2;
    let y = 18;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("OsiguranjeBot predmet", margin, y);
    y += 10;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    formatRecordSummary(record).split("\n").forEach((line) => {
      const wrapped = pdf.splitTextToSize(line, maxWidth);
      wrapped.forEach((textLine: string) => {
        if (y > pageHeight - margin) {
          pdf.addPage();
          y = margin;
        }
        pdf.text(textLine, margin, y);
        y += 7;
      });
      y += 2;
    });

    pdf.save(`${record.id || "predmet"}.pdf`);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <article
        className="record-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-details-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="record-details-header">
          <div>
            <p className="eyebrow">{record.typeLabel || "Predmet"}</p>
            <h2 id="record-details-title">{record.category || "Bez kategorije"}</h2>
          </div>
          <div className="record-detail-actions">
            <button type="button" onClick={copySummary}>{copied ? "Kopirano" : "Kopiraj sažetak"}</button>
            <button type="button" onClick={downloadPdf}>Preuzmi PDF</button>
            <button type="button" onClick={onClose} aria-label="Zatvori detalje">Zatvori</button>
          </div>
        </div>
        <dl>
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt>{recordFieldLabel(key)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </article>
    </div>
  );
}

function formatRecordSummary(record: AppRecord) {
  const lines = [
    `${record.typeLabel || "Predmet"}: ${record.category || "bez kategorije"}`,
    `Status: ${record.status}`,
    `ID: ${record.id}`,
    record.createdAt ? `Kreirano: ${record.createdAt}` : "",
    record.insurer ? `Osiguratelj: ${record.insurer}` : "",
    record.policyNumber ? `Broj police ili štete: ${record.policyNumber}` : "",
    record.issue ? `Problem: ${record.issue}` : "",
    record.desiredOutcome ? `Željeni ishod: ${record.desiredOutcome}` : "",
    record.coverageNeed ? `Što želite osigurati: ${record.coverageNeed}` : "",
    record.startDate ? `Početak police: ${record.startDate}` : "",
    record.customerName ? `Ime i prezime: ${record.customerName}` : "",
    record.contact ? `Kontakt: ${record.contact}` : "",
    record.notes ? `Napomene: ${record.notes}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function recordFieldLabel(key: string) {
  const labels: Record<string, string> = {
    id: "ID",
    status: "Status",
    createdAt: "Kreirano",
    category: "Kategorija",
    insurer: "Osiguratelj",
    policyNumber: "Broj police ili štete",
    issue: "Problem",
    desiredOutcome: "Željeni ishod",
    coverageNeed: "Što želite osigurati",
    startDate: "Početak police",
    customerName: "Ime i prezime",
    contact: "Kontakt",
    notes: "Napomene",
  };
  return labels[key] || key;
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
