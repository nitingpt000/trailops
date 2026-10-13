"""Form schema + answer validation (spec §17).

A tiny declarative renderer contract: no expressions, no code. Rules may only reference earlier
fields, which rules out cycles by construction. The TypeScript implementation in
packages/contracts/src/forms.ts follows the same rules and is checked against the same fixtures in
packages/contracts/fixtures/forms.
"""

import hashlib
import json
import re
from datetime import date
from typing import Any

FIELD_TYPES = {
    "text",
    "textarea",
    "integer",
    "decimal",
    "boolean",
    "select",
    "date",
    "photo",
    "equipment_ref",
}
OPERATORS = {"equals", "not_equals", "in"}
FIELD_ID = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_FIELDS = 40
MAX_RULE_DEPTH = 4
MAX_RULE_NODES = 20
MAX_OPTIONS = 30
MAX_TEXT = 2000

# Business-required fields per form key: a form edit can never remove them (spec §17).
BUSINESS_FIELDS: dict[str, dict[str, Any]] = {
    "return-inspection": {
        "condition": {"type": "select", "options": {"GOOD", "NEEDS_REPAIR", "UNUSABLE"}},
    },
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def schema_hash(schema: dict) -> str:
    return hashlib.sha256(canonical_json(schema).encode()).hexdigest()


def _rule_errors(rule: Any, fields_before: dict[str, dict], depth: int, counter: list[int]) -> list[str]:
    counter[0] += 1
    if counter[0] > MAX_RULE_NODES:
        return ["rule has too many conditions"]
    if depth > MAX_RULE_DEPTH:
        return ["rule nesting is too deep"]
    if not isinstance(rule, dict):
        return ["rule must be an object"]
    if set(rule) == {"and"} or set(rule) == {"or"}:
        items = next(iter(rule.values()))
        if not isinstance(items, list) or not (1 <= len(items) <= 10):
            return ["and/or must contain 1-10 conditions"]
        errs: list[str] = []
        for item in items:
            errs += _rule_errors(item, fields_before, depth + 1, counter)
        return errs
    if set(rule) != {"field", "operator", "value"}:
        return ["condition must have exactly field, operator and value"]
    ref, op, value = rule["field"], rule["operator"], rule["value"]
    if op not in OPERATORS:
        return [f"unsupported operator {op!r}"]
    if not isinstance(ref, str) or ref not in fields_before:
        return [f"condition references unknown or later field {ref!r}"]
    target = fields_before[ref]
    values = value if op == "in" else [value]
    if op == "in" and (not isinstance(value, list) or not value or len(value) > MAX_OPTIONS):
        return ["'in' requires a non-empty list"]
    for v in values:
        t = target["type"]
        if t == "select" and v not in target.get("options", []):
            return [f"value {v!r} is not an option of {ref!r}"]
        if t == "boolean" and not isinstance(v, bool):
            return [f"{ref!r} is boolean"]
        if t in ("integer", "decimal") and (isinstance(v, bool) or not isinstance(v, int | float)):
            return [f"{ref!r} is numeric"]
        if t in ("text", "textarea", "date") and not isinstance(v, str):
            return [f"{ref!r} is text"]
        if t in ("photo", "equipment_ref"):
            return [f"conditions cannot reference {t} fields"]
    return []


def validate_schema(schema: Any) -> dict[str, str]:
    """Return {path: message}; empty means publishable."""
    errors: dict[str, str] = {}
    if not isinstance(schema, dict):
        return {"_": "schema must be an object"}
    allowed_top = {"schema_version", "key", "version", "title", "fields"}
    for extra in set(schema) - allowed_top:
        errors[extra] = "unknown property"
    if schema.get("schema_version") != 1:
        errors["schema_version"] = "unsupported schema_version"
    key = schema.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,79}", key):
        errors["key"] = "invalid key"
    fields = schema.get("fields")
    if not isinstance(fields, list) or not fields:
        errors["fields"] = "at least one field is required"
        return errors
    if len(fields) > MAX_FIELDS:
        errors["fields"] = f"at most {MAX_FIELDS} fields"
        return errors
    seen: dict[str, dict] = {}
    allowed_field_keys = {
        "id",
        "type",
        "label",
        "help",
        "required",
        "options",
        "option_labels",
        "max_length",
        "min",
        "max",
        "max_count",
        "visible_when",
        "required_when",
        "placeholder",
    }
    for i, f in enumerate(fields):
        p = f"fields.{i}"
        if not isinstance(f, dict):
            errors[p] = "field must be an object"
            continue
        for extra in set(f) - allowed_field_keys:
            errors[f"{p}.{extra}"] = "unknown property"
        fid = f.get("id")
        if not isinstance(fid, str) or not FIELD_ID.fullmatch(fid):
            errors[f"{p}.id"] = "invalid field id"
            continue
        if fid in seen:
            errors[f"{p}.id"] = "duplicate field id"
            continue
        t = f.get("type")
        if t not in FIELD_TYPES:
            errors[f"{p}.type"] = f"unsupported field type {t!r}"
            continue
        if "label" in f and (not isinstance(f["label"], str) or len(f["label"]) > 120):
            errors[f"{p}.label"] = "label must be text up to 120 characters"
        if "required" in f and not isinstance(f["required"], bool):
            errors[f"{p}.required"] = "required must be boolean"
        if t == "select":
            opts = f.get("options")
            if (
                not isinstance(opts, list)
                or not (1 <= len(opts) <= MAX_OPTIONS)
                or not all(isinstance(o, str) and re.fullmatch(r"[A-Z0-9_]{1,40}", o) for o in opts)
                or len(set(opts)) != len(opts)
            ):
                errors[f"{p}.options"] = "options must be 1-30 unique UPPER_SNAKE codes"
        if t in ("text", "textarea") and "max_length" in f:
            ml = f["max_length"]
            if not isinstance(ml, int) or isinstance(ml, bool) or not (1 <= ml <= MAX_TEXT):
                errors[f"{p}.max_length"] = f"max_length must be 1-{MAX_TEXT}"
        if t == "photo":
            mc = f.get("max_count", 1)
            if not isinstance(mc, int) or isinstance(mc, bool) or not (1 <= mc <= 5):
                errors[f"{p}.max_count"] = "max_count must be 1-5"
        for rk in ("visible_when", "required_when"):
            if rk in f:
                rule_errs = _rule_errors(f[rk], seen, 1, [0])
                if rule_errs:
                    errors[f"{p}.{rk}"] = rule_errs[0]
        seen[fid] = f
    required = BUSINESS_FIELDS.get(schema.get("key", ""), {})
    for fid, spec in required.items():
        f = seen.get(fid)
        if f is None:
            errors[f"fields.{fid}"] = "business-required field cannot be removed"
        elif f.get("type") != spec["type"] or not f.get("required"):
            errors[f"fields.{fid}"] = "business-required field must stay a required select"
        elif "visible_when" in f:
            errors[f"fields.{fid}"] = "business-required field cannot be hidden"
        elif set(f.get("options", [])) != spec["options"]:
            errors[f"fields.{fid}.options"] = "business-required options cannot change"
    return errors


def eval_rule(rule: dict, answers: dict[str, Any]) -> bool:
    if "and" in rule:
        return all(eval_rule(r, answers) for r in rule["and"])
    if "or" in rule:
        return any(eval_rule(r, answers) for r in rule["or"])
    actual = answers.get(rule["field"])
    match rule["operator"]:
        case "equals":
            return actual == rule["value"]
        case "not_equals":
            return actual != rule["value"]
        case "in":
            return actual in rule["value"]
    return False


def visible_fields(schema: dict, answers: dict[str, Any]) -> list[dict]:
    """Visibility is evaluated in order; hidden fields are treated as unanswered for later rules."""
    effective: dict[str, Any] = {}
    out = []
    for f in schema["fields"]:
        if "visible_when" in f and not eval_rule(f["visible_when"], effective):
            continue
        out.append(f)
        if f["id"] in answers:
            effective[f["id"]] = answers[f["id"]]
    return out


def is_required(field: dict, answers: dict[str, Any]) -> bool:
    if field.get("required"):
        return True
    if "required_when" in field:
        return eval_rule(field["required_when"], answers)
    return False


def _empty(v: Any) -> bool:
    return v is None or v == "" or v == []


def validate_answers(schema: dict, answers: Any, *, attachment_ids: set[str] | None = None) -> dict[str, str]:
    """Server-authoritative answer validation. Unknown or hidden answers are rejected, not dropped."""
    if not isinstance(answers, dict):
        return {"_": "answers must be an object"}
    errors: dict[str, str] = {}
    known = {f["id"] for f in schema["fields"]}
    for k in answers:
        if k not in known:
            errors[k] = "unknown field"
    vis = visible_fields(schema, answers)
    vis_ids = {f["id"] for f in vis}
    for k in answers:
        if k in known and k not in vis_ids:
            errors[k] = "answer supplied for a hidden field"
    for f in vis:
        fid, t = f["id"], f["type"]
        v = answers.get(fid)
        if _empty(v):
            if is_required(f, answers):
                errors[fid] = "required"
            continue
        match t:
            case "text" | "textarea":
                if not isinstance(v, str):
                    errors[fid] = "must be text"
                elif len(v) > f.get("max_length", MAX_TEXT):
                    errors[fid] = "too long"
            case "integer":
                if not isinstance(v, int) or isinstance(v, bool):
                    errors[fid] = "must be a whole number"
            case "decimal":
                if isinstance(v, bool) or not isinstance(v, int | float):
                    errors[fid] = "must be a number"
            case "boolean":
                if not isinstance(v, bool):
                    errors[fid] = "must be true or false"
            case "select":
                if v not in f.get("options", []):
                    errors[fid] = "not an allowed option"
            case "date":
                try:
                    date.fromisoformat(v)
                except (TypeError, ValueError):
                    errors[fid] = "must be an ISO date"
            case "photo":
                if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                    errors[fid] = "must be a list of attachment ids"
                elif len(v) > f.get("max_count", 1):
                    errors[fid] = "too many photos"
                elif attachment_ids is not None and not set(v) <= attachment_ids:
                    errors[fid] = "photo is not one of this submission's attachments"
            case "equipment_ref":
                if not isinstance(v, str):
                    errors[fid] = "must be an equipment id"
    return errors
