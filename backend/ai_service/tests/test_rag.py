from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ai_service.app import main


def _copy_repo_pdfs(target_pdf_dir: Path) -> list[Path]:
    repo_pdf_dir = main.ROOT / "rag" / "pdf"
    pdfs = sorted(path for path in repo_pdf_dir.glob("*.pdf"))
    if not pdfs:
        pytest.skip("No PDFs found in rag/pdf to run RAG integration tests.")

    target_pdf_dir.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    for pdf in pdfs:
        destination = target_pdf_dir / pdf.name
        shutil.copy2(pdf, destination)
        copied.append(destination)
    return copied


@pytest.fixture()
def isolated_rag_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path
    rag_dir = root / "rag"
    pdf_dir = rag_dir / "pdf"
    index_dir = rag_dir / "index"
    _copy_repo_pdfs(pdf_dir)

    monkeypatch.setattr(main, "ROOT", root)
    monkeypatch.setattr(main, "RAG_DIR", rag_dir)
    monkeypatch.setattr(main, "PDF_DIR", pdf_dir)
    monkeypatch.setattr(main, "INDEX_DIR", index_dir)
    monkeypatch.setattr(main, "CHUNKS_FILE", index_dir / "chunks.json")
    monkeypatch.setattr(main, "VECTORS_FILE", index_dir / "vectors.json")
    return root


def test_build_rag_index_from_project_pdfs(isolated_rag_workspace: Path) -> None:
    result = main.build_rag_index()
    pdf_count = len(list((isolated_rag_workspace / "rag" / "pdf").glob("*.pdf")))

    assert result["sourceCount"] == pdf_count
    assert main.CHUNKS_FILE.exists()
    assert main.VECTORS_FILE.exists()

    chunks_payload = json.loads(main.CHUNKS_FILE.read_text(encoding="utf-8"))
    vectors_payload = json.loads(main.VECTORS_FILE.read_text(encoding="utf-8"))

    assert chunks_payload["sourceCount"] == pdf_count
    assert chunks_payload["chunkCount"] == len(chunks_payload["chunks"])
    assert len(vectors_payload["vectors"]) == chunks_payload["chunkCount"]


def test_search_rag_returns_ranked_results(isolated_rag_workspace: Path) -> None:
    main.build_rag_index()
    results = main.search_rag("osiguranje", top_k=6)

    assert len(results) <= 6
    if not results:
        pytest.skip("Current PDFs produced zero text chunks, skipping ranking assertions.")

    scores = [item["score"] for item in results]
    assert scores == sorted(scores, reverse=True)
    for item in results:
        assert item["source"].lower().endswith(".pdf")
        assert "content" in item


def test_upload_endpoint_auto_reindexes(isolated_rag_workspace: Path) -> None:
    client = TestClient(main.app)
    sample_pdf = next((isolated_rag_workspace / "rag" / "pdf").glob("*.pdf"))
    pdf_bytes = sample_pdf.read_bytes()

    response = client.post(
        "/admin/rag/upload",
        files=[("pdfs", (sample_pdf.name, pdf_bytes, "application/pdf"))],
    )

    assert response.status_code == 200
    payload = response.json()
    assert sample_pdf.name in payload["uploaded"]
    assert "index" in payload
    assert payload["index"]["sourceCount"] >= 1
    assert main.CHUNKS_FILE.exists()
    assert main.VECTORS_FILE.exists()
