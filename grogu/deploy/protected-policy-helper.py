#!/usr/bin/python3 -I
"""Root-owned, fixed-target Cloudflare Access policy projection."""

import http.client
import fcntl
import json
import os
import re
import stat
import sys
import urllib.parse

CONFIG_PATH = "/private/var/db/ai.grogu.protected/policy.json"
API_HOST = "api.cloudflare.com"
MAX_BYTES = 262144
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
WRITABLE_FIELDS = frozenset(
    (
        "name",
        "decision",
        "include",
        "exclude",
        "require",
        "precedence",
        "session_duration",
        "approval_required",
        "approval_groups",
        "purpose_justification_required",
        "purpose_justification_prompt",
        "isolation_required",
        "connection_rules",
        "mfa_config",
    )
)
READ_ONLY_FIELDS = frozenset(
    ("id", "uid", "account_id", "created_at", "updated_at", "app_count", "reusable")
)


class PolicyError(Exception):
    pass


def normalize_email(value):
    if not isinstance(value, str):
        raise PolicyError()
    value = value.strip().lower()
    if len(value) > 254 or not EMAIL.fullmatch(value):
        raise PolicyError()
    return value


def validate_request(value, owner_email):
    if not isinstance(value, dict) or set(value) != {"revision", "add", "remove"}:
        raise PolicyError()
    revision = value["revision"]
    additions = value["add"]
    removals = value["remove"]
    if (
        type(revision) is not int
        or revision < 0
        or not isinstance(additions, list)
        or not isinstance(removals, list)
        or len(additions) + len(removals) > 1000
    ):
        raise PolicyError()
    additions = {normalize_email(email) for email in additions}
    removals = {normalize_email(email) for email in removals}
    if owner_email in removals or additions & removals:
        raise PolicyError()
    return revision, additions, removals


def target_path(config):
    ids = [config.get(key) for key in ("accountId", "appId", "policyId")]
    if not all(isinstance(value, str) and IDENTIFIER.fullmatch(value) for value in ids):
        raise PolicyError()
    account, app, policy = (urllib.parse.quote(value, safe="") for value in ids)
    return "/client/v4/accounts/{}/access/apps/{}/policies/{}".format(account, app, policy)


def policy_snapshot(response, config):
    if not isinstance(response, dict) or response.get("success") is not True:
        raise PolicyError()
    policy = response.get("result")
    if not isinstance(policy, dict):
        raise PolicyError()
    if (
        policy.get("id") != config["policyId"]
        or policy.get("name") != config["policyName"]
        or policy.get("decision") != "allow"
        or ("reusable" in policy and type(policy["reusable"]) is not bool)
        or (policy.get("reusable") is True and (
            type(policy.get("app_count")) is not int or policy["app_count"] != 1
        ))
        or ("uid" in policy and (
            not isinstance(policy["uid"], str) or not IDENTIFIER.fullmatch(policy["uid"])
        ))
        or set(policy) - WRITABLE_FIELDS - READ_ONLY_FIELDS
    ):
        raise PolicyError()
    rules = policy.get("include")
    if not isinstance(rules, list):
        raise PolicyError()
    current = []
    for rule in rules:
        if (
            not isinstance(rule, dict)
            or set(rule) != {"email"}
            or not isinstance(rule["email"], dict)
            or set(rule["email"]) != {"email"}
        ):
            raise PolicyError()
        current.append(normalize_email(rule["email"]["email"]))
    if config["ownerEmail"] not in current:
        raise PolicyError()
    payload = {key: value for key, value in policy.items() if key in WRITABLE_FIELDS}
    reusable = policy.get("reusable") is True
    if reusable:
        payload.pop("precedence", None)
    return payload, sorted(set(current)), reusable


def send_cloudflare(method, path, token, payload=None):
    # This direct connection neither follows redirects nor consults proxy variables.
    connection = http.client.HTTPSConnection(API_HOST, timeout=15)
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES or not 200 <= response.status < 300:
            raise PolicyError()
        return json.loads(data)
    finally:
        connection.close()


def synchronize(config, value, send):
    owner_email = normalize_email(config.get("ownerEmail"))
    if config["ownerEmail"] != owner_email:
        raise PolicyError()
    revision, additions, removals = validate_request(value, owner_email)
    path = target_path(config)
    token = config.get("token")
    if (
        not isinstance(token, str)
        or not token
        or "\n" in token
        or "\r" in token
        or not isinstance(config.get("policyName"), str)
        or not config["policyName"]
    ):
        raise PolicyError()
    payload, current, reusable = policy_snapshot(send("GET", path, token), config)
    emails = sorted((set(current) | additions) - removals)
    payload["include"] = [{"email": {"email": email}} for email in emails]
    if current == emails:
        return {"revision": revision, "status": "synced"}
    try:
        write_path = path if not reusable else "/client/v4/accounts/{}/access/policies/{}".format(
            urllib.parse.quote(config["accountId"], safe=""),
            urllib.parse.quote(config["policyId"], safe=""),
        )
        send("PUT", write_path, token, payload)
    except Exception:
        # A failed response can follow a committed remote write. Read before any retry.
        pass
    try:
        _, observed, observed_reusable = policy_snapshot(send("GET", path, token), config)
    except Exception:
        return {"revision": revision, "status": "unknown"}
    return {
        "revision": revision,
        "status": "synced" if observed == emails and observed_reusable == reusable else "unknown",
    }


def load_config():
    for directory in ("/private", "/private/var", "/private/var/db", os.path.dirname(CONFIG_PATH)):
        info = os.lstat(directory)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        ):
            raise PolicyError()
    descriptor = os.open(CONFIG_PATH, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise PolicyError()
        raw = file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise PolicyError()
    config = json.loads(raw)
    if not isinstance(config, dict) or set(config) != {
        "accountId",
        "appId",
        "policyId",
        "policyName",
        "ownerEmail",
        "token",
    }:
        raise PolicyError()
    return config


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise PolicyError()
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise PolicyError()
    config = load_config()
    lock_path = os.path.join(os.path.dirname(CONFIG_PATH), "policy.lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise PolicyError()
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        result = synchronize(config, json.loads(raw), send_cloudflare)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Policy synchronization failed. Inspect the protected helper configuration.\n")
        sys.exit(1)
