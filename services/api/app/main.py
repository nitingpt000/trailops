import json
import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.db import sessionmaker
from app.core.errors import DomainError, domain_error_handler, envelope, validation_error_handler
from app.core.settings import get_settings
from app.modules import reads
from app.modules.sync import routes as sync_routes


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = {"level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        for key in ("request_id", "path", "status", "latency_ms", "user_id", "device_id"):
            if hasattr(record, key):
                base[key] = getattr(record, key)
        return json.dumps(base)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger("trailops")
    root.handlers = [handler]
    root.setLevel(logging.INFO)


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()
    app = FastAPI(
        title="TrailOps API",
        version="0.1.0",
        description="Independent applicant POC. Not Indiahikes' production system.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type", "X-Device-Id", "X-Request-Id"],
    )
    log = logging.getLogger("trailops.http")

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id") or f"req-{uuid.uuid4().hex[:12]}"
        request.state.request_id = rid[:80]
        length = request.headers.get("content-length")
        if (
            length
            and length.isdigit()
            and int(length) > settings.max_request_bytes
            and not request.url.path.endswith("/content")
        ):
            return JSONResponse(
                envelope(request, "REQUEST_TOO_LARGE", "Request body too large.", False), status_code=413
            )
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        # Never log query strings: they can carry signed upload tokens (spec §20, §23).
        log.info(
            "request",
            extra={
                "request_id": request.state.request_id,
                "path": request.url.path,
                "status": response.status_code,
                "latency_ms": round((time.perf_counter() - start) * 1000, 1),
            },
        )
        return response

    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.include_router(reads.router)
    app.include_router(sync_routes.router)

    @app.get("/health/live")
    async def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready():
        try:
            async with sessionmaker()() as s:
                await s.execute(text("SELECT 1"))
        except Exception:
            return JSONResponse({"status": "unavailable", "dependency": "database"}, status_code=503)
        return {"status": "ok"}

    return app


app = create_app()
