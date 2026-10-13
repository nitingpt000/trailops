"""Access-token validation and principal resolution (spec §4).

Tokens are validated against the issuer's JWKS: signature, allowed algorithm, issuer, audience,
expiry. Keycloak roles are ignored for authorization; organization role, camp memberships and
grants are always read from PostgreSQL so revocation takes effect on the next request.
"""

import time
import uuid
from dataclasses import dataclass, field

import httpx
import jwt
from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import Forbidden, Unauthenticated
from app.core.permissions import permissions_for
from app.core.settings import get_settings
from app.models import Camp, CampMembership, Device, Membership, User

ALLOWED_ALGORITHMS = ["RS256"]


class JwksCache:
    def __init__(self) -> None:
        self._keys: dict[str, object] = {}
        self._fetched_at = 0.0
        self.static_jwks: dict | None = None  # tests inject a key set here

    def _load(self, jwks: dict) -> None:
        keys = {}
        for jwk in jwks.get("keys", []):
            if jwk.get("use", "sig") != "sig" or jwk.get("kty") != "RSA":
                continue
            keys[jwk["kid"]] = jwt.algorithms.RSAAlgorithm.from_jwk(jwk)
        self._keys = keys
        self._fetched_at = time.monotonic()

    async def refresh(self) -> None:
        if self.static_jwks is not None:
            self._load(self.static_jwks)
            return
        s = get_settings()
        url = s.oidc_jwks_url or f"{s.oidc_issuer}/protocol/openid-connect/certs"
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(url)
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            # Fail closed: unverifiable tokens are rejected (spec §24).
            raise Unauthenticated("Identity provider keys are unavailable.", "JWKS_UNAVAILABLE") from exc
        self._load(resp.json())

    async def key_for(self, kid: str):
        ttl = get_settings().jwks_cache_ttl
        if not self._keys or time.monotonic() - self._fetched_at > ttl:
            await self.refresh()
        if kid not in self._keys:
            # Possible key rotation: refresh once, then give up.
            await self.refresh()
        key = self._keys.get(kid)
        if key is None:
            raise Unauthenticated("Unknown signing key.", "INVALID_TOKEN")
        return key


jwks_cache = JwksCache()


async def decode_access_token(token: str) -> dict:
    s = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise Unauthenticated("Malformed token.", "INVALID_TOKEN") from exc
    if header.get("alg") not in ALLOWED_ALGORITHMS:
        raise Unauthenticated("Token algorithm not allowed.", "INVALID_TOKEN")
    key = await jwks_cache.key_for(header.get("kid", ""))
    try:
        claims = jwt.decode(
            token,
            key=key,
            algorithms=ALLOWED_ALGORITHMS,
            audience=s.oidc_audience,
            options={"require": ["exp", "iat", "sub", "iss"], "verify_iss": False},
            leeway=30,
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthenticated("Token expired.", "TOKEN_EXPIRED") from exc
    except jwt.PyJWTError as exc:
        raise Unauthenticated("Invalid token.", "INVALID_TOKEN") from exc
    if claims.get("iss") not in s.accepted_issuers:
        raise Unauthenticated("Unexpected token issuer.", "INVALID_TOKEN")
    # An ID token is not an API access token.
    if claims.get("typ") not in (None, "Bearer"):
        raise Unauthenticated("Not an access token.", "INVALID_TOKEN")
    return claims


@dataclass
class Principal:
    user_id: uuid.UUID
    display_name: str
    org_id: uuid.UUID
    role: str
    permissions: frozenset[str]
    org_wide: bool
    camp_ids: frozenset[uuid.UUID]
    scope_epoch: int
    device_id: uuid.UUID | None = None
    request_id: str | None = None
    camp_permissions: dict[uuid.UUID, frozenset[str]] = field(default_factory=dict)

    def has(self, permission: str, camp_id: uuid.UUID | None = None) -> bool:
        if permission not in self.permissions:
            extra = self.camp_permissions.get(camp_id) if camp_id else None
            if not extra or permission not in extra:
                return False
        if camp_id is not None and not self.can_access_camp(camp_id):
            return False
        return True

    def require(self, permission: str, camp_id: uuid.UUID | None = None) -> None:
        if not self.has(permission, camp_id):
            raise Forbidden(f"Missing permission {permission} for this scope.")

    def can_access_camp(self, camp_id: uuid.UUID) -> bool:
        return self.org_wide or camp_id in self.camp_ids

    def scope_strings(self) -> set[str]:
        return {str(c) for c in self.camp_ids}


async def resolve_principal(session: AsyncSession, subject: str, device_header: str | None) -> Principal:
    user = (await session.execute(select(User).where(User.keycloak_subject == subject))).scalar_one_or_none()
    if user is None or not user.enabled:
        raise Forbidden("This account is not enabled for TrailOps.", "ACCOUNT_DISABLED")
    membership = (
        await session.execute(select(Membership).where(Membership.user_id == user.id, Membership.enabled))
    ).scalar_one_or_none()
    if membership is None:
        raise Forbidden("This account has no organization membership.", "NO_MEMBERSHIP")
    camp_rows = (
        await session.execute(
            select(CampMembership).where(
                CampMembership.org_id == membership.org_id,
                CampMembership.user_id == user.id,
                CampMembership.enabled,
            )
        )
    ).scalars()
    camp_ids: set[uuid.UUID] = set()
    camp_perms: dict[uuid.UUID, frozenset[str]] = {}
    epoch = membership.scope_epoch
    for cm in camp_rows:
        camp_ids.add(cm.camp_id)
        camp_perms[cm.camp_id] = frozenset(cm.permissions or [])
        epoch += cm.access_epoch
    if membership.org_wide:
        all_camps = (await session.execute(select(Camp.id).where(Camp.org_id == membership.org_id))).scalars()
        camp_ids.update(all_camps)

    device_id = None
    if device_header:
        try:
            device_id = uuid.UUID(device_header)
        except ValueError as exc:
            raise Unauthenticated("Invalid device header.", "INVALID_DEVICE") from exc
        device = await session.get(Device, device_id)
        if device is None or device.user_id != user.id:
            raise Forbidden("Device is not registered to this account.", "DEVICE_UNKNOWN")
        if not device.enabled:
            raise Forbidden("This device has been disabled.", "DEVICE_DISABLED")

    perms = permissions_for(membership.role) | frozenset(membership.extra_permissions or [])
    return Principal(
        user_id=user.id,
        display_name=user.display_name,
        org_id=membership.org_id,
        role=membership.role,
        permissions=perms,
        org_wide=membership.org_wide,
        camp_ids=frozenset(camp_ids),
        scope_epoch=epoch,
        device_id=device_id,
        camp_permissions=camp_perms,
    )


async def current_claims(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthenticated()
    return await decode_access_token(authorization[7:].strip())


async def current_principal(
    request: Request,
    claims: dict = Depends(current_claims),
    x_device_id: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> Principal:
    principal = await resolve_principal(session, claims["sub"], x_device_id)
    principal.request_id = getattr(request.state, "request_id", None)
    # Release the read snapshot used for resolution; handlers open their own transactions.
    await session.rollback()
    return principal
