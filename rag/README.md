# RAG Documents

Use this folder for future retrieval-augmented generation documents.

Suggested layout:

- `pdf/` -- source PDF documents, such as policy terms, public guidance, forms, and internal knowledge.
- `index/` -- generated vector/search index files.
- `notes/` -- short manual notes about document source, date, and intended use.

Keep PDFs and generated indexes out of git unless they are explicitly safe to commit.

Run this after adding or changing PDFs:

```powershell
npm run rag:ingest
```

This generates:

- `rag/index/chunks.json` -- extracted text chunks.
- `rag/index/vectors.json` -- local vector database.

The current vector backend is Python-based local hashed embeddings. It is a searchable development index, and the embedding function can later be swapped for OpenAI embeddings or another embedding provider without changing the admin workflow.
