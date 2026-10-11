"""Sidecar tests. python-jobspy is mocked: no network."""

from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app as sidecar

client = TestClient(sidecar.app)

BASE: dict[str, Any] = {"site": "indeed", "search_term": "AI Engineer", "location": "Berlin", "country_indeed": "germany"}


def frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def patch_scrape(monkeypatch: pytest.MonkeyPatch, result: Any = None, log_errors: list[str] | None = None, raises: Exception | None = None) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    jobspy_logger = logging.getLogger("JobSpy:Test")
    jobspy_logger.propagate = False

    def fake(**kwargs: Any) -> pd.DataFrame:
        calls.append(kwargs)
        for message in log_errors or []:
            jobspy_logger.error(message)
        if raises is not None:
            raise raises
        return result if result is not None else pd.DataFrame()

    monkeypatch.setattr(sidecar, "scrape_jobs", fake)
    return calls


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


# ---------------------------------------------------------------- validation


@pytest.mark.parametrize(
    "patch",
    [
        {"site": "glassdoor"},
        {"site": "zip_recruiter"},
        {"search_term": ""},
        {"search_term": "   "},
        {"results_wanted": 0},
        {"results_wanted": 5000},
        {"hours_old": 0},
        {"country_indeed": "atlantis"},
        {"proxies": ["  "]},
        {"unknown_field": 1},
    ],
)
def test_invalid_requests_are_rejected(monkeypatch: pytest.MonkeyPatch, patch: dict[str, Any]) -> None:
    calls = patch_scrape(monkeypatch)
    response = client.post("/search", json={**BASE, **patch})
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    assert calls == []


def test_missing_site_is_rejected() -> None:
    response = client.post("/search", json={"search_term": "x"})
    assert response.status_code == 422


def test_validation_error_does_not_echo_proxy_values(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch)
    response = client.post("/search", json={**BASE, "results_wanted": 0, "proxies": ["http://user:secret@proxy.example:8080"]})
    assert response.status_code == 422
    assert "secret" not in response.text


def test_defaults_and_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = patch_scrape(monkeypatch)
    response = client.post(
        "/search",
        json={**BASE, "hours_old": 24, "results_wanted": 7, "is_remote": True, "country_indeed": "Germany", "proxies": ["http://p:1"]},
    )
    assert response.status_code == 200
    assert response.json() == {"site": "indeed", "count": 0, "jobs": [], "warnings": []}
    (call,) = calls
    assert call["site_name"] == ["indeed"]
    assert call["search_term"] == "AI Engineer"
    assert call["location"] == "Berlin"
    assert call["hours_old"] == 24
    assert call["results_wanted"] == 7
    assert call["is_remote"] is True
    assert call["country_indeed"] == "germany"
    assert call["proxies"] == ["http://p:1"]


def test_empty_proxy_list_passes_none(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = patch_scrape(monkeypatch)
    client.post("/search", json=BASE)
    assert calls[0]["proxies"] is None
    assert calls[0]["country_indeed"] == "germany"


def test_country_indeed_is_required_for_indeed(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch)
    body = {key: value for key, value in BASE.items() if key != "country_indeed"}
    assert client.post("/search", json=body).status_code == 422


def test_linkedin_does_not_need_an_indeed_country(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = patch_scrape(monkeypatch)
    body = {key: value for key, value in BASE.items() if key != "country_indeed"}
    assert client.post("/search", json={**body, "site": "linkedin"}).status_code == 200
    assert "country_indeed" not in calls[0]


# ---------------------------------------------------------------- conversion


def test_nan_nat_and_dates_become_json_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {
            "id": "in-1",
            "site": "indeed",
            "title": "AI Engineer",
            "company": "Acme",
            "location": "Berlin, BE, DE",
            "date_posted": dt.date(2026, 10, 5),
            "min_amount": float("nan"),
            "max_amount": 90000.0,
            "currency": None,
            "is_remote": False,
            "description": "text",
        },
        {
            "id": "in-2",
            "site": "indeed",
            "title": "KI Engineer",
            "company": "Beta",
            "location": "München",
            "date_posted": None,
            "min_amount": 50000.0,
            "max_amount": float("nan"),
            "currency": "EUR",
            "is_remote": True,
            "description": float("nan"),
        },
    ]
    patch_scrape(monkeypatch, frame(rows))
    response = client.post("/search", json=BASE)
    assert response.status_code == 200
    # strict JSON: no NaN literals
    body = json.loads(response.text, parse_constant=lambda c: pytest.fail(f"non-JSON constant {c}"))
    first, second = body["jobs"]
    assert body["count"] == 2
    assert first["date_posted"] == "2026-10-05"
    assert first["min_amount"] is None
    assert first["max_amount"] == 90000.0
    assert second["date_posted"] is None
    assert second["max_amount"] is None
    assert second["description"] is None
    assert second["is_remote"] is True


def test_timestamps_and_nat_and_numpy_types() -> None:
    assert sidecar.json_safe(pd.Timestamp("2026-10-05 12:30:00")) == "2026-10-05T12:30:00"
    assert sidecar.json_safe(pd.NaT) is None
    assert sidecar.json_safe(pd.NA) is None
    assert sidecar.json_safe(float("inf")) is None
    assert sidecar.json_safe(pd.Series([1, 2]).iloc[0]) == 1
    assert sidecar.json_safe(["a", float("nan")]) == ["a", None]


def test_emails_and_phone_fields_are_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {
            "id": "li-1",
            "site": "linkedin",
            "title": "T",
            "company": "C",
            "emails": "hr@example.com",
            "phone": "+49 30 123456",
            "company_phone_number": "+49 30 999",
            "job_url": "https://www.linkedin.com/jobs/view/1",
        }
    ]
    patch_scrape(monkeypatch, frame(rows))
    response = client.post("/search", json={**BASE, "site": "linkedin"})
    (job,) = response.json()["jobs"]
    assert set(job) == {"id", "site", "title", "company", "job_url"}
    assert "example.com" not in response.text and "+49" not in response.text


# ---------------------------------------------------------------- error mapping


def test_http_429_in_logs_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, log_errors=["LinkedIn response status code 429"])
    response = client.post("/search", json={**BASE, "site": "linkedin"})
    assert response.status_code == 429
    body = response.json()
    assert body["code"] == "rate_limited"
    assert "429" in body["message"]


@pytest.mark.parametrize("message", ["Indeed response status code 403", "Google response status code 999", "Indeed: captcha required"])
def test_forbidden_in_logs_is_blocked(monkeypatch: pytest.MonkeyPatch, message: str) -> None:
    patch_scrape(monkeypatch, log_errors=[message])
    response = client.post("/search", json=BASE)
    assert response.status_code == 502
    assert response.json()["code"] == "blocked"


def test_other_logged_error_with_no_jobs_is_upstream_error(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, log_errors=["Indeed: [{'message': 'internal'}]"])
    response = client.post("/search", json=BASE)
    assert response.status_code == 502
    assert response.json()["code"] == "upstream_error"


def test_empty_result_without_errors_is_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch)
    response = client.post("/search", json=BASE)
    assert response.status_code == 200
    assert response.json()["count"] == 0


def test_logged_error_with_some_jobs_is_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, frame([{"id": "x", "title": "T", "company": "C"}]), log_errors=["LinkedIn response status code 429"])
    response = client.post("/search", json={**BASE, "site": "linkedin"})
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["warnings"] == ["LinkedIn response status code 429"]


def test_exception_with_429_text_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, raises=Exception("HTTPError: 429 Client Error: Too Many Requests"))
    response = client.post("/search", json=BASE)
    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


def test_generic_exception_is_upstream_error(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, raises=RuntimeError("boom"))
    response = client.post("/search", json=BASE)
    assert response.status_code == 502
    assert response.json() == {"code": "upstream_error", "message": "RuntimeError: boom"}


def test_proxy_credentials_never_appear_in_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    proxy = "http://user:topsecret@proxy.example:8080"
    patch_scrape(monkeypatch, raises=RuntimeError(f"cannot connect to {proxy}"))
    response = client.post("/search", json={**BASE, "proxies": [proxy]})
    assert response.status_code == 502
    assert "topsecret" not in response.text
    assert "<proxy>" in response.json()["message"]


def test_handler_is_removed_after_each_call(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, log_errors=["Indeed response status code 429"])
    client.post("/search", json=BASE)
    logger = logging.getLogger("JobSpy:Test")
    assert not any(isinstance(h, sidecar._ErrorCapture) for h in logger.handlers)
