"""jobspy sidecar: a thin HTTP wrapper around python-jobspy (LinkedIn guest, Indeed, Google Jobs).

`POST /search` runs one scrape and returns JSON-safe records. python-jobspy (>= 1.4) does not raise for
upstream failures: a scraper records the error and returns no jobs, and `scrape_jobs` reports them on the
returned frame as `frame.attrs["errors"]` (site -> message) and `frame.attrs["warnings"]` (site -> messages).
The endpoint maps those, together with any exception, to a structured error (`{"code", "message"}` with HTTP
429 for `rate_limited`, 502 for `blocked` / `upstream_error`) so the TypeScript channels can feed the circuit
breaker. It reads `attrs` rather than jobspy's loggers: the logger names changed between releases, which
silently turned blocked searches into empty results (tests/test_search.py pins the real `scrape_jobs`).

C5: e-mail addresses and phone fields are dropped before anything leaves this process.
Proxy URLs may carry credentials: they are never logged and are scrubbed from error messages.
"""

from __future__ import annotations

import datetime as dt
import enum
import math
import re
import threading
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from jobspy import scrape_jobs
from jobspy.model import Country
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

app = FastAPI(title="job-radar-jobspy", docs_url=None, redoc_url=None, openapi_url=None)

Site = Literal["linkedin", "indeed", "google"]
ErrorCode = Literal["rate_limited", "blocked", "upstream_error"]

# Result columns that are never returned (C5): e-mail addresses and anything phone-like.
_DROPPED_EXACT = frozenset({"emails", "email"})
_DROPPED_SUBSTRINGS = ("phone",)

_MAX_MESSAGE_CHARS = 300

_RATE_LIMITED = re.compile(r"\b429\b|too many requests|rate.?limit", re.IGNORECASE)
_BLOCKED = re.compile(r"\b(?:401|403|999)\b|forbidden|captcha|blocked|access denied|unauthori[sz]ed|authwall", re.IGNORECASE)

# jobspy keeps global state per scraper module: one scrape at a time keeps concurrent requests from interfering.
_scrape_lock = threading.Lock()


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    site: Site
    search_term: str = Field(min_length=1, max_length=300)
    location: str | None = Field(default=None, max_length=200)
    hours_old: int | None = Field(default=None, ge=1, le=24 * 365)
    results_wanted: int = Field(default=15, ge=1, le=1000)
    is_remote: bool = False
    # The Indeed country of the market (no German default). Indeed searches need it; LinkedIn and Google ignore it, so a market
    # without an Indeed site can still use them.
    country_indeed: str | None = Field(default=None, min_length=2, max_length=60)
    linkedin_fetch_description: bool = False
    proxies: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("search_term")
    @classmethod
    def _search_term_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("search_term must not be blank")
        return stripped

    @field_validator("country_indeed")
    @classmethod
    def _known_country(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            Country(value)
        except ValueError as exc:
            raise ValueError("country_indeed is not a country jobspy knows") from exc
        return value.strip().lower()

    @model_validator(mode="after")
    def _indeed_needs_a_country(self) -> "SearchRequest":
        if self.site == "indeed" and self.country_indeed is None:
            raise ValueError("country_indeed is required for site indeed")
        return self

    @field_validator("proxies")
    @classmethod
    def _proxies_not_blank(cls, value: list[str]) -> list[str]:
        cleaned = [p.strip() for p in value]
        if any(not p for p in cleaned):
            raise ValueError("proxies must not contain blank entries")
        return cleaned


class SearchResponse(BaseModel):
    site: Site
    count: int
    jobs: list[dict[str, Any]]
    # Errors and warnings jobspy reported although some jobs came back (a later page failed, for example).
    warnings: list[str] = Field(default_factory=list)


class SidecarError(Exception):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ------------------------------------------------------------------ error mapping


def scrub(text: str, proxies: list[str]) -> str:
    """Remove proxy strings and URL credentials from a message and cap its length."""
    for proxy in proxies:
        if proxy:
            text = text.replace(proxy, "<proxy>")
    text = re.sub(r"://[^/\s@]+@", "://<redacted>@", text)
    text = " ".join(text.split())
    return text[:_MAX_MESSAGE_CHARS]


def classify(messages: list[str]) -> ErrorCode:
    """rate_limited beats blocked beats upstream_error."""
    joined = "\n".join(messages)
    if _RATE_LIMITED.search(joined):
        return "rate_limited"
    if _BLOCKED.search(joined):
        return "blocked"
    return "upstream_error"


# ------------------------------------------------------------------ result conversion


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return math.isnan(value) or math.isinf(value)
    # pandas.NA / NaT and numpy NaN scalars
    if type(value).__name__ in {"NAType", "NaTType"}:
        return True
    return False


def json_safe(value: Any) -> Any:
    """Convert a DataFrame cell to something `json.dumps` accepts: NaN/NaT -> None, dates -> ISO strings."""
    if _is_missing(value):
        return None
    if isinstance(value, enum.Enum):
        return json_safe(value.value)
    if isinstance(value, (dt.datetime, dt.date)):  # pandas.Timestamp is a datetime
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    item = getattr(value, "item", None)  # numpy scalars
    if callable(item) and not isinstance(value, (str, bytes)):
        try:
            return json_safe(item())
        except (TypeError, ValueError):
            pass
    if isinstance(value, (str, bool, int, float)):
        return value
    return str(value)


def _keep_column(name: str) -> bool:
    lowered = name.lower()
    return lowered not in _DROPPED_EXACT and not any(s in lowered for s in _DROPPED_SUBSTRINGS)


def records_from_frame(frame: Any) -> list[dict[str, Any]]:
    """DataFrame -> list of JSON-safe dicts without e-mail / phone columns."""
    if frame is None or len(frame) == 0:
        return []
    columns = [str(c) for c in frame.columns if _keep_column(str(c))]
    records: list[dict[str, Any]] = []
    for raw in frame.to_dict(orient="records"):
        records.append({c: json_safe(raw.get(c)) for c in columns})
    return records


# ------------------------------------------------------------------ search


def _report_messages(frame: Any) -> tuple[list[str], list[str]]:
    """The (errors, warnings) jobspy attached to the frame: site -> message(s), flattened."""
    attrs = getattr(frame, "attrs", None) or {}
    errors_by_site = attrs.get("errors") or {}
    warnings_by_site = attrs.get("warnings") or {}
    errors = [str(message) for message in errors_by_site.values() if message]
    warnings: list[str] = []
    for messages in warnings_by_site.values():
        warnings.extend(str(message) for message in ([messages] if isinstance(messages, str) else messages) if message)
    return errors, warnings


def run_search(request: SearchRequest) -> tuple[list[dict[str, Any]], list[str]]:
    """Run jobspy once. Returns (records, warnings) or raises SidecarError."""
    kwargs: dict[str, Any] = {
        "site_name": [request.site],
        "search_term": request.search_term,
        "location": request.location,
        "results_wanted": request.results_wanted,
        "is_remote": request.is_remote,
        "fetch_description": request.linkedin_fetch_description,
        "hours_old": request.hours_old,
        "proxies": request.proxies or None,
        "description_format": "markdown",
        "verbose": 0,
    }
    if request.country_indeed is not None:
        kwargs["country_indeed"] = request.country_indeed
    with _scrape_lock:
        try:
            frame = scrape_jobs(**kwargs)
        except Exception as exc:  # noqa: BLE001 - every failure is mapped to a structured error
            message = scrub(f"{type(exc).__name__}: {exc}", request.proxies)
            raise SidecarError(classify([str(exc), message]), message) from None

    raw_errors, raw_warnings = _report_messages(frame)
    errors = [scrub(m, request.proxies) for m in raw_errors]
    warnings = [scrub(m, request.proxies) for m in raw_warnings]
    records = records_from_frame(frame)
    if not records and errors:
        raise SidecarError(classify(raw_errors), errors[0])  # classify the full text: scrub() caps the length
    return records, errors + warnings


_STATUS_BY_CODE: dict[str, int] = {"rate_limited": 429, "blocked": 502, "upstream_error": 502}


@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest) -> Any:
    try:
        jobs, warnings = run_search(request)
    except SidecarError as error:
        return JSONResponse(status_code=_STATUS_BY_CODE[error.code], content={"code": error.code, "message": error.message})
    return SearchResponse(site=request.site, count=len(jobs), jobs=jobs, warnings=warnings)


@app.exception_handler(RequestValidationError)
def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Field paths and messages only: the default handler echoes the submitted values, which can include proxy credentials.
    problems = [f"{'.'.join(str(p) for p in e['loc'] if p != 'body') or 'body'}: {e['msg']}" for e in exc.errors()]
    return JSONResponse(status_code=422, content={"code": "invalid_request", "message": "; ".join(problems)[:_MAX_MESSAGE_CHARS * 3]})
