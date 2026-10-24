"""Sidecar tests. python-jobspy is mocked (no network), except the contract tests that call the real `scrape_jobs`
through an unreachable proxy (no external request)."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app as sidecar

client = TestClient(sidecar.app)

BASE: dict[str, Any] = {"site": "indeed", "search_term": "AI Engineer", "location": "Berlin", "country_indeed": "germany"}


def frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def patch_scrape(
    monkeypatch: pytest.MonkeyPatch,
    result: Any = None,
    errors: dict[str, str] | None = None,
    warnings: dict[str, list[str]] | None = None,
    raises: Exception | None = None,
) -> list[dict[str, Any]]:
    """Replace `scrape_jobs`. Like jobspy >= 1.4 the fake reports upstream failures on `frame.attrs`."""
    calls: list[dict[str, Any]] = []

    def fake(**kwargs: Any) -> pd.DataFrame:
        calls.append(kwargs)
        if raises is not None:
            raise raises
        out = result if result is not None else pd.DataFrame()
        out.attrs = {"errors": errors or {}, "warnings": warnings or {}}
        return out

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


@pytest.mark.parametrize(
    ("given", "passed"),
    [("germany", "germany"), (" Germany ", "germany"), ("UK", "uk"), ("United Kingdom", "united kingdom"), ("turkey", "turkey"), ("USA", "usa"), ("czech republic", "czech republic")],
)
def test_known_countries_and_aliases_pass(monkeypatch: pytest.MonkeyPatch, given: str, passed: str) -> None:
    calls = patch_scrape(monkeypatch)
    assert client.post("/search", json={**BASE, "country_indeed": given}).status_code == 200
    assert calls[0]["country_indeed"] == passed


@pytest.mark.parametrize("given", ["atlantis", "slovakia", "croatia"])
def test_unknown_country_is_rejected_without_echo(monkeypatch: pytest.MonkeyPatch, given: str) -> None:
    calls = patch_scrape(monkeypatch)
    response = client.post("/search", json={**BASE, "country_indeed": given})
    assert response.status_code == 422
    assert "country_indeed is not a country jobspy knows" in response.json()["message"]
    assert given not in response.text
    assert calls == []


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


def test_http_429_in_errors_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, errors={"linkedin": "response status code 429"})
    response = client.post("/search", json={**BASE, "site": "linkedin"})
    assert response.status_code == 429
    body = response.json()
    assert body["code"] == "rate_limited"
    assert "429" in body["message"]


def test_jobspy_blocked_hint_with_429_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    # The wording jobspy 1.4 uses when a site blocks the request: it names both 429 and "blocked".
    patch_scrape(monkeypatch, errors={"indeed": "response status code 429 (blocked: use a proxy)"})
    response = client.post("/search", json=BASE)
    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


@pytest.mark.parametrize(
    "message",
    ["response status code 403", "response status code 403 (blocked: use a proxy)", "response status code 999", "captcha required"],
)
def test_forbidden_in_errors_is_blocked(monkeypatch: pytest.MonkeyPatch, message: str) -> None:
    patch_scrape(monkeypatch, errors={"indeed": message})
    response = client.post("/search", json=BASE)
    assert response.status_code == 502
    assert response.json()["code"] == "blocked"


def test_other_error_with_no_jobs_is_upstream_error(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, errors={"indeed": "[{'message': 'internal'}]"})
    response = client.post("/search", json=BASE)
    assert response.status_code == 502
    assert response.json()["code"] == "upstream_error"


def test_empty_result_without_errors_is_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch)
    response = client.post("/search", json=BASE)
    assert response.status_code == 200
    assert response.json()["count"] == 0


def test_empty_frame_with_columns_but_no_rows_is_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    # jobspy 1.4 returns "columns, no rows" for an empty result.
    patch_scrape(monkeypatch, pd.DataFrame(columns=["id", "title", "company"]))
    response = client.post("/search", json=BASE)
    assert response.status_code == 200
    assert response.json() == {"site": "indeed", "count": 0, "jobs": [], "warnings": []}


def test_error_with_some_jobs_is_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, frame([{"id": "x", "title": "T", "company": "C"}]), errors={"linkedin": "response status code 429"})
    response = client.post("/search", json={**BASE, "site": "linkedin"})
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["warnings"] == ["response status code 429"]


def test_jobspy_warnings_are_returned_and_do_not_fail_an_empty_search(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_scrape(monkeypatch, warnings={"indeed": ["hours_old ignored", "another note"]})
    response = client.post("/search", json=BASE)
    assert response.status_code == 200
    assert response.json() == {"site": "indeed", "count": 0, "jobs": [], "warnings": ["hours_old ignored", "another note"]}


def test_frame_without_attrs_is_tolerated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sidecar, "scrape_jobs", lambda **_kwargs: pd.DataFrame())
    assert client.post("/search", json=BASE).status_code == 200


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


def test_proxy_credentials_are_scrubbed_from_reported_errors_and_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    proxy = "http://user:topsecret@proxy.example:8080"
    patch_scrape(monkeypatch, errors={"indeed": f"ProxyError via {proxy}"})
    failed = client.post("/search", json={**BASE, "proxies": [proxy]})
    assert failed.status_code == 502
    assert "topsecret" not in failed.text and "<proxy>" in failed.json()["message"]

    patch_scrape(
        monkeypatch,
        frame([{"id": "x", "title": "T", "company": "C"}]),
        errors={"indeed": f"page 2 failed via {proxy}"},
        warnings={"indeed": ["retry through http://other:pw123@proxy.example:1"]},
    )
    partial = client.post("/search", json={**BASE, "proxies": [proxy]})
    assert partial.status_code == 200
    assert "topsecret" not in partial.text and "pw123" not in partial.text
    assert len(partial.json()["warnings"]) == 2


# ---------------------------------------------------------------- contract with the real jobspy


def test_real_scrape_jobs_reports_failures_on_frame_attrs() -> None:
    """Calls the real `scrape_jobs` with a proxy nothing listens on (no external request). If a jobspy release changes
    how failures are reported again (as the 1.4 logger rename did), this fails instead of searches silently coming back empty."""
    frame_ = sidecar.scrape_jobs(
        site_name=["indeed"],
        search_term="engineer",
        location="Berlin",
        country_indeed="germany",
        results_wanted=1,
        proxies=["http://127.0.0.1:1"],
        verbose=0,
    )
    assert len(frame_) == 0
    errors = frame_.attrs["errors"]
    assert errors.get("indeed"), frame_.attrs
    assert isinstance(frame_.attrs["warnings"], dict)


def test_real_scrape_jobs_failure_becomes_a_structured_error() -> None:
    response = client.post("/search", json={**BASE, "results_wanted": 1, "proxies": ["http://127.0.0.1:1"]})
    assert response.status_code == 502
    body = response.json()
    assert body["code"] == "upstream_error"
    assert body["message"]


# ---------------------------------------------------------------- the shipped geography table


def _indeed_values(path: Path) -> list[str]:
    # Plain text on purpose: the sidecar image has no YAML library. Entries are one-line flow mappings: `indeed: <value>,`.
    return [m.group(1).strip() for m in re.finditer(r"\bindeed:\s*([^,}]+)", path.read_text(encoding="utf-8"))]


GEOGRAPHY_FILES = [
    Path(__file__).resolve().parents[2] / "config" / "packs" / "generic" / "geography.yaml",
    Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "config" / "defaults" / "packs" / "generic" / "geography.yaml",
]


@pytest.mark.parametrize("path", GEOGRAPHY_FILES, ids=["config", "test-fixture"])
def test_every_indeed_country_of_the_geography_table_passes_validation(path: Path) -> None:
    if not path.exists():  # the sidecar's own Docker context does not contain the app's config
        pytest.skip(f"{path} not found")
    values = _indeed_values(path)
    assert len(values) > 20
    rejected = []
    for value in values:
        try:
            sidecar.SearchRequest(site="indeed", search_term="x", country_indeed=value)
        except ValueError:
            rejected.append(value)
    assert rejected == []
