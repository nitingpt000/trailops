"""Evidence attachments (spec §20).

Binary content never travels in command JSON. A placeholder is created by SUBMIT_RETURN; the device
then initiates an upload slot, PUTs the bytes, and calls complete. Verification checks size, SHA-256,
content signature and decodability before evidence can satisfy any workflow rule.
"""

import base64
import hashlib
import hmac
import io
import json
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal
from app.core.errors import Conflict, Forbidden, InvalidInput, NotFound
from app.core.settings import get_settings
from app.core.tx import DomainTx, bump
from app.models import Attachment, Inspection

MAGIC = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG\r\n\x1a\n"}
MAX_DIMENSION = 8000


class Storage:
    def upload_url(self, key: str, attachment_id: uuid.UUID, mime: str) -> tuple[str, str]:
        raise NotImplementedError

    def read(self, key: str) -> bytes | None:
        raise NotImplementedError

    def write(self, key: str, data: bytes, mime: str) -> None:
        raise NotImplementedError

    def download_url(self, key: str, attachment_id: uuid.UUID) -> str:
        raise NotImplementedError


def slot_token(attachment_id: uuid.UUID, purpose: str, ttl: int) -> str:
    body = json.dumps({"a": str(attachment_id), "p": purpose, "x": int(time.time()) + ttl}).encode()
    mac = hmac.new(get_settings().signing_secret.encode(), body, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(body + b"." + mac).decode().rstrip("=")


def check_slot_token(token: str, attachment_id: uuid.UUID, purpose: str) -> None:
    try:
        blob = base64.urlsafe_b64decode((token + "=" * (-len(token) % 4)).encode())
        body, mac = blob[:-17], blob[-16:]  # fixed-size MAC; never split on a byte value
        expect = hmac.new(get_settings().signing_secret.encode(), body, hashlib.sha256).digest()[:16]
        data = json.loads(body)
    except Exception as exc:
        raise Forbidden("Upload slot is invalid.", "INVALID_SLOT") from exc
    if not hmac.compare_digest(mac, expect) or data["a"] != str(attachment_id) or data["p"] != purpose:
        raise Forbidden("Upload slot is invalid.", "INVALID_SLOT")
    if data["x"] < time.time():
        raise Forbidden("Upload slot expired. Request a new one.", "SLOT_EXPIRED")


class LocalStorage(Storage):
    """Filesystem storage served through the API with short-lived signed slots (demo/test)."""

    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise InvalidInput("INVALID_KEY", "Invalid object key.")
        return p

    def upload_url(self, key, attachment_id, mime):
        s = get_settings()
        token = slot_token(attachment_id, "upload", s.upload_url_ttl_seconds)
        return f"{s.public_api_base}/v1/attachments/{attachment_id}/content?token={token}", "PUT"

    def read(self, key):
        p = self._path(key)
        return p.read_bytes() if p.exists() else None

    def write(self, key, data, mime):
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def download_url(self, key, attachment_id):
        s = get_settings()
        token = slot_token(attachment_id, "download", 300)
        return f"{s.public_api_base}/v1/attachments/{attachment_id}/content?token={token}"


class S3Storage(Storage):
    def __init__(self):
        import boto3

        s = get_settings()
        self.bucket = s.storage_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=s.storage_endpoint,
            aws_access_key_id=s.storage_access_key,
            aws_secret_access_key=s.storage_secret_key,
            region_name="us-east-1",
        )
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except Exception:
            self.client.create_bucket(Bucket=self.bucket)

    def upload_url(self, key, attachment_id, mime):
        url = self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": mime},
            ExpiresIn=get_settings().upload_url_ttl_seconds,
        )
        return url, "PUT"

    def read(self, key):
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None

    def write(self, key, data, mime):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=mime)

    def download_url(self, key, attachment_id):
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=300
        )


_storage: Storage | None = None


def storage() -> Storage:
    global _storage
    if _storage is None:
        s = get_settings()
        _storage = S3Storage() if s.storage_backend == "s3" else LocalStorage(s.local_storage_dir)
    return _storage


def set_storage(st: Storage) -> None:
    global _storage
    _storage = st


async def _owned(session: AsyncSession, principal: Principal, attachment_id: uuid.UUID) -> Attachment:
    att = await session.get(Attachment, attachment_id)
    if att is None or att.org_id != principal.org_id:
        raise NotFound()
    if att.owner_user_id != principal.user_id:
        raise Forbidden("Only the submitting user can upload this evidence.")
    return att


async def initiate(session: AsyncSession, principal: Principal, attachment_id: uuid.UUID) -> dict:
    """Authorizes the upload of an existing placeholder. A rejected inspection never has one."""
    async with session.begin():
        att = await _owned(session, principal, attachment_id)
        if att.state in ("VERIFIED", "REJECTED"):
            return {"attachment_id": str(att.id), "state": att.state, "upload_url": None}
        url, method = storage().upload_url(att.object_key, att.id, att.mime)
        if att.state == "PENDING":
            att.state = "INITIATED"
        return {
            "attachment_id": str(att.id),
            "state": att.state,
            "upload_url": url,
            "method": method,
            "headers": {"Content-Type": att.mime},
            "max_bytes": att.bytes,
        }


async def put_content(session: AsyncSession, attachment_id: uuid.UUID, token: str, data: bytes) -> None:
    check_slot_token(token, attachment_id, "upload")
    att = await session.get(Attachment, attachment_id)
    if att is None:
        raise NotFound()
    if len(data) > get_settings().max_photo_bytes:
        raise InvalidInput("PHOTO_TOO_LARGE", "Upload exceeds the size limit.")
    if att.state in ("VERIFIED", "REJECTED"):
        return
    storage().write(att.object_key, data, att.mime)
    await session.rollback()


def inspect_content(
    att: Attachment, data: bytes | None
) -> tuple[str | None, bytes | None, tuple[int, int] | None]:
    """Return (rejection_reason, stripped_bytes, size)."""
    if data is None:
        return "NOT_UPLOADED", None, None
    if len(data) != att.bytes:
        return "SIZE_MISMATCH", None, None
    if hashlib.sha256(data).hexdigest() != att.content_hash:
        return "HASH_MISMATCH", None, None
    if not data.startswith(MAGIC[att.mime]):
        return "CONTENT_TYPE_MISMATCH", None, None
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                return "DIMENSIONS_TOO_LARGE", None, None
            # Re-encode without metadata: drops EXIF/GPS (spec §20).
            out = io.BytesIO()
            clean = img.convert("RGB") if att.mime == "image/jpeg" else img
            clean.save(out, format="JPEG" if att.mime == "image/jpeg" else "PNG", quality=90)
            return None, out.getvalue(), (img.width, img.height)
    except Exception:
        return "UNDECODABLE", None, None


async def complete(session: AsyncSession, principal: Principal, attachment_id: uuid.UUID) -> dict:
    """Idempotent verification. NOT_UPLOADED leaves the attachment retryable."""
    pre = await _owned(session, principal, attachment_id)
    if pre.state in ("VERIFIED", "REJECTED"):
        result = {"attachment_id": str(pre.id), "state": pre.state, "reason": pre.rejection_reason}
        await session.rollback()
        return result
    data = storage().read(pre.object_key)
    reason, clean, dims = inspect_content(pre, data)
    if reason == "NOT_UPLOADED":
        await session.rollback()
        raise Conflict("NOT_UPLOADED", "The file has not been uploaded yet.", retryable=True)
    await session.rollback()
    async with session.begin():
        tx = DomainTx(session, principal, command_type="ATTACHMENT_COMPLETE")
        await tx.lock_gate()
        att = await tx.lock_one(Attachment, attachment_id)
        if att.state in ("VERIFIED", "REJECTED"):
            return {"attachment_id": str(att.id), "state": att.state, "reason": att.rejection_reason}
        insp = await tx.lock_one(Inspection, att.inspection_id)
        if reason is None:
            storage().write(att.object_key, clean, att.mime)
            att.state = "VERIFIED"
            att.width, att.height = dims
            att.verified_at = datetime.now(UTC)
        else:
            att.state = "REJECTED"
            att.rejection_reason = reason
        bump(att)
        siblings = (
            (
                await session.execute(
                    select(Attachment.state).where(
                        Attachment.org_id == att.org_id,
                        Attachment.inspection_id == insp.id,
                        Attachment.id != att.id,
                    )
                )
            )
            .scalars()
            .all()
        )
        states = [att.state, *siblings]
        new_state = (
            "REJECTED"
            if "REJECTED" in states
            else "VERIFIED"
            if all(s == "VERIFIED" for s in states)
            else "PENDING"
        )
        if new_state != insp.evidence_state:
            insp.evidence_state = new_state
            bump(insp)
            await tx.emit("inspection", insp)
        await tx.emit("attachment", att)
        camp = (await tx.proj.item_camps_by_id(insp.item_id))[0]
        await tx.audit(
            "attachment",
            att.id,
            f"EVIDENCE_{att.state}",
            after={"reason": reason},
            version=att.version,
            camp_id=uuid.UUID(camp),
        )
        await tx.finish()
        return {
            "attachment_id": str(att.id),
            "state": att.state,
            "reason": att.rejection_reason,
            "inspection_evidence_state": insp.evidence_state,
        }


async def download(session: AsyncSession, principal: Principal, attachment_id: uuid.UUID) -> dict:
    from app.core.projections import ProjectionContext

    att = await session.get(Attachment, attachment_id)
    if att is None or att.org_id != principal.org_id:
        raise NotFound()
    insp = await session.get(Inspection, att.inspection_id)
    camps = await ProjectionContext(session).item_camps_by_id(insp.item_id)
    if not any(principal.can_access_camp(uuid.UUID(c)) for c in camps):
        raise NotFound()
    if att.state != "VERIFIED":
        raise Conflict("NOT_VERIFIED", "Evidence is not verified yet.")
    return {"url": storage().download_url(att.object_key, att.id), "expires_in": 300}
