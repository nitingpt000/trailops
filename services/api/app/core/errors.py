"""Error envelope (spec §8). Every handled failure becomes {"error": {...}}."""

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class DomainError(Exception):
    status_code = 409

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
        field_errors: dict[str, Any] | None = None,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        self.retryable = retryable
        self.field_errors = field_errors or {}
        self.details = details or {}


class InvalidInput(DomainError):
    status_code = 422


class Forbidden(DomainError):
    status_code = 403

    def __init__(self, message: str = "You do not have permission for this action.", code: str = "FORBIDDEN"):
        super().__init__(code, message)


class NotFound(DomainError):
    status_code = 404

    def __init__(self, message: str = "Not found or not accessible.", code: str = "NOT_FOUND"):
        super().__init__(code, message)


class Unauthenticated(DomainError):
    status_code = 401

    def __init__(self, message: str = "Authentication required.", code: str = "UNAUTHENTICATED"):
        super().__init__(code, message)


class Conflict(DomainError):
    """A state/version conflict. Persisted as a CONFLICT receipt when raised inside a command."""

    status_code = 409


def envelope(request: Request, code: str, message: str, retryable: bool, field_errors=None, details=None):
    body: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": retryable,
        "field_errors": field_errors or {},
        "request_id": getattr(request.state, "request_id", None),
    }
    if details:
        body["details"] = details
    return {"error": body}


async def domain_error_handler(request: Request, exc: DomainError):
    return JSONResponse(
        envelope(request, exc.code, exc.message, exc.retryable, exc.field_errors, exc.details),
        status_code=exc.status_code,
    )


async def validation_error_handler(request: Request, exc: RequestValidationError):
    fields: dict[str, str] = {}
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("body", "query", "path"))
        fields[loc or "_"] = err.get("msg", "invalid")
    return JSONResponse(
        envelope(request, "INVALID_INPUT", "The request is invalid.", False, fields), status_code=422
    )
