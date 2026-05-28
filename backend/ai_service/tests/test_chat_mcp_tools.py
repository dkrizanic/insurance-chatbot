from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from backend.ai_service.app import main


def _response(content: str | None, tool_calls: list[Any] | None = None) -> Any:
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls or []))])


def _tool_call(name: str, args_json: str) -> Any:
    return SimpleNamespace(
        id="call-1",
        function=SimpleNamespace(name=name, arguments=args_json),
    )


class FakeChatCompletions:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeOpenAIClient:
    def __init__(self, responses: list[Any]) -> None:
        self.chat = SimpleNamespace(completions=FakeChatCompletions(responses))


def test_chat_mcp_like_tool_call_creates_complaint(monkeypatch) -> None:
    fake_client = FakeOpenAIClient(
        [
            _response("ALLOW"),
            _response(
                None,
                tool_calls=[
                    _tool_call(
                        "create_complaint",
                        '{"category":"auto","issue":"Osiguratelj je odbio štetu nakon sudara.","desiredOutcome":"Ponovna procjena i pisani odgovor","insurer":"Croatia osiguranje"}',
                    )
                ],
            ),
            _response("Otvorio sam prigovor i pripremio iduće korake."),
        ]
    )
    saved_payloads: list[dict[str, Any]] = []

    def fake_submit(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        saved_payloads.append({"kind": kind, "payload": payload})
        return {"id": "complaint-test-1"}

    monkeypatch.setattr(main, "client", fake_client)
    monkeypatch.setattr(main, "api_key", "test-key")
    monkeypatch.setattr(main, "submit_app_record", fake_submit)

    api = TestClient(main.app)
    response = api.post(
        "/chat",
        json={
            "messages": [
                {
                    "role": "user",
                    "content": "Imam auto štetu, odbili su zahtjev jer navodno nema dovoljno dokaza. Želim podnijeti prigovor.",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert "Otvorio sam prigovor" in response.json()["reply"]
    assert saved_payloads[0]["kind"] == "complaint"
    assert saved_payloads[0]["payload"]["category"] == "auto"


def test_chat_rejects_offtopic_realistic_user_message(monkeypatch) -> None:
    monkeypatch.setattr(main, "api_key", "test-key")
    monkeypatch.setattr(main, "is_allowed_conversation", lambda _messages: False)

    api = TestClient(main.app)
    response = api.post(
        "/chat",
        json={
            "messages": [
                {"role": "user", "content": "Tko će pobijediti večeras u Ligi prvaka i koji je rezultat?"}
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["reply"] == main.OUT_OF_SCOPE_REPLY


def test_chat_includes_rag_context_for_realistic_query(monkeypatch) -> None:
    fake_client = FakeOpenAIClient([_response("ALLOW"), _response("Evo odgovora uz reference.")])
    monkeypatch.setattr(main, "client", fake_client)
    monkeypatch.setattr(main, "api_key", "test-key")
    monkeypatch.setattr(
        main,
        "search_rag",
        lambda _query, _top_k: [
            {
                "source": "Auto osiguranje.pdf",
                "chunk": 2,
                "content": "Franšiza se primjenjuje na svaku prijavljenu štetu.",
                "score": 1.2,
            }
        ],
    )

    api = TestClient(main.app)
    response = api.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "Kako se računa franšiza kod auto osiguranja?"}]},
    )

    assert response.status_code == 200
    system_prompt = fake_client.chat.completions.calls[1]["messages"][0]["content"]
    assert "Auto osiguranje.pdf" in system_prompt
    assert "Relevant PDF excerpts" in system_prompt
    assert "chunk 2" not in system_prompt
    assert "never mention internal chunk numbers" in system_prompt


def test_chat_demo_usage_limit_blocks_extra_requests(monkeypatch) -> None:
    fake_client = FakeOpenAIClient([_response("ALLOW"), _response("Prvi odgovor.")])
    monkeypatch.setattr(main, "client", fake_client)
    monkeypatch.setattr(main, "api_key", "test-key")
    monkeypatch.setattr(main, "demo_chat_daily_limit", 1)
    main.chat_usage.clear()

    api = TestClient(main.app)
    payload = {"messages": [{"role": "user", "content": "Kako prijaviti stetu iz police?"}]}
    headers = {"X-Demo-User-Id": "demo-browser-1"}

    first_response = api.post("/chat", json=payload, headers=headers)
    second_response = api.post("/chat", json=payload, headers=headers)

    assert first_response.status_code == 200
    assert second_response.status_code == 429
    assert "Demo limit dosegnut" in second_response.json()["detail"]
