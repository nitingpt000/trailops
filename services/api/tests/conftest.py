"""Integration fixtures against real PostgreSQL (spec §27: SQLite cannot validate locks/partial indexes).

Tokens are signed by a throwaway RSA key whose JWKS is injected into the validator, so the real
signature/issuer/audience/expiry checks run on every request.
"""

import base64
import hashlib
import io
import os
import time
import uuid
from datetime import date, timedelta

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://trailops:trailops@localhost:55432/trailops_test")
os.environ["STORAGE_BACKEND"] = "local"

import httpx  # noqa: E402
import jwt  # noqa: E402
import pytest  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.settings import get_settings  # noqa: E402

get_settings.cache_clear()

from app.core import db as dbmod  # noqa: E402
from app.core.auth import jwks_cache  # noqa: E402
from app.demo import seed  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.attachments import service as attachments  # noqa: E402

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "test-key"
_pub = jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True)
_pub.update({"kid": KID, "use": "sig", "alg": "RS256"})
jwks_cache.static_jwks = {"keys": [_pub]}
sid = seed.sid
TODAY = seed.TODAY


def make_token(
    subject: str,
    *,
    aud: str | None = None,
    iss: str | None = None,
    exp_in: int = 600,
    key=KEY,
    typ: str = "Bearer",
) -> str:
    s = get_settings()
    now = int(time.time())
    return jwt.encode(
        {
            "sub": subject,
            "iss": iss or s.oidc_issuer,
            "aud": aud or s.oidc_audience,
            "iat": now,
            "exp": now + exp_in,
            "typ": typ,
        },
        key,
        algorithm="RS256",
        headers={"kid": KID},
    )


@pytest.fixture(scope="session", autouse=True)
def migrate():
    from alembic.config import Config

    from alembic import command

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


@pytest.fixture(autouse=True)
async def fresh_db(tmp_path):
    dbmod.reset_engine(os.environ["DATABASE_URL"])
    attachments.set_storage(attachments.LocalStorage(str(tmp_path / "objects")))
    async with dbmod.get_engine().connect() as conn:
        # A previous test's abandoned connection must not deadlock this test's TRUNCATE.
        await conn.execute(text(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid()"
        ))
        await conn.commit()
    await seed.main(True)
    yield
    await dbmod.get_engine().dispose()


class Api:
    def __init__(self, client: httpx.AsyncClient):
        self.c = client
        self.devices: dict[str, str] = {}

    def headers(self, user: str, device: bool = False) -> dict:
        h = {"Authorization": f"Bearer {make_token(str(sid(f'user:{user}')))}"}
        if device and user in self.devices:
            h["X-Device-Id"] = self.devices[user]
        return h

    async def device(self, user: str, install: str | None = None) -> str:
        r = await self.c.post(
            "/v1/devices",
            headers=self.headers(user),
            json={"installation_id": install or f"install-{user}-0001", "platform": "android"},
        )
        assert r.status_code == 200, r.text
        self.devices[user] = r.json()["device_id"]
        return self.devices[user]

    async def push(self, user: str, *ops: dict) -> list[dict]:
        if user not in self.devices:
            await self.device(user)
        r = await self.c.post(
            "/v1/sync/commands",
            headers=self.headers(user, True),
            json={"protocol_version": 1, "device_id": self.devices[user], "operations": list(ops)},
        )
        assert r.status_code == 200, r.text
        return r.json()["results"]

    async def cmd(self, user: str, type_: str, aggregate, payload: dict, **extra) -> dict:
        body = {
            "operation_id": str(extra.pop("operation_id", uuid.uuid4())),
            "type": type_,
            "aggregate_id": str(aggregate) if aggregate else None,
            "payload": payload,
            **extra,
        }
        r = await self.c.post("/v1/commands", headers=self.headers(user), json=body)
        return r.json()

    async def get(self, user: str, path: str, **params):
        return await self.c.get(path, headers=self.headers(user, True), params=params)


@pytest.fixture
async def api():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Api(client)


def issue_op(
    tag: str,
    trekker: str = "Priya Nair",
    batch: str = "BRT-1012",
    op_id=None,
    alloc=None,
    expected_version: int | None = None,
) -> dict:
    return {
        "operation_id": str(op_id or uuid.uuid4()),
        "type": "ISSUE_GEAR",
        "aggregate_id": str(sid(f"item:{tag}")),
        "expected_version": expected_version,
        "client_recorded_at": "2026-10-13T09:42:00+05:30",
        "payload": {
            "allocation_id": str(alloc or uuid.uuid4()),
            "trekker_id": str(sid(f"trekker:{trekker}")),
            "batch_id": str(sid(f"batch:{batch}")),
            "due_date": (TODAY + timedelta(days=4)).isoformat(),
        },
    }


def jpeg_bytes(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buf, format="JPEG")
    return buf.getvalue()


def descriptor(data: bytes, mime: str = "image/jpeg", att_id=None) -> dict:
    return {
        "attachment_id": str(att_id or uuid.uuid4()),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime": mime,
        "bytes": len(data),
    }


def return_op(
    tag: str,
    alloc_id,
    condition="GOOD",
    photos: list[dict] | None = None,
    issue_type=None,
    form_version=3,
    op_id=None,
    depends_on=None,
    preconditions=None,
    inspection_id=None,
) -> dict:
    answers: dict = {"equipment": str(sid(f"item:{tag}")), "condition": condition}
    if issue_type:
        answers["issue_type"] = issue_type
    if photos:
        answers["photos"] = [p["attachment_id"] for p in photos]
    return {
        "operation_id": str(op_id or uuid.uuid4()),
        "type": "SUBMIT_RETURN",
        "aggregate_id": str(sid(f"item:{tag}")),
        "depends_on": [str(d) for d in (depends_on or [])],
        "preconditions": preconditions or [],
        "payload": {
            "inspection_id": str(inspection_id or uuid.uuid4()),
            "allocation_id": str(alloc_id),
            "form_version_id": str(sid(f"form:return-inspection:v{form_version}")),
            "answers": answers,
            "attachments": photos or [],
        },
    }


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


__all__ = ["date"]
