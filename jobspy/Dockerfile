# The base image is pinned by digest (the multi-platform index of the tag), so every build starts from the same Python;
# Dependabot (docker ecosystem) proposes the next digest.
FROM python:3.12-slim@sha256:6b25cbe6577518889d553cdd5a5da97d259348d8f6e45b527dd731caaba27a07

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
# requirements.txt is the lock file: every package, the indirect ones too, with their hashes (generated from
# requirements.in by pip-compile, see docs/development.md). The image holds exactly the versions CI tested, and pip
# refuses a file whose hash differs or a package the lock does not list.
COPY requirements.txt .
RUN pip install --require-hashes -r requirements.txt

COPY app.py .

RUN useradd --system --uid 10001 jobspy
USER jobspy

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
