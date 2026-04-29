#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


NAMESPACE = "sub2api-playground"
DEFAULT_PLAYGROUND_URL = "https://playground.meteor041.com"
DEFAULT_USER_AGENT = "Sub2API-Image-Skill/1.0 (+https://playground.meteor041.com)"
USER_AGENT = os.environ.get("SUB2API_USER_AGENT", DEFAULT_USER_AGENT)


class ScriptError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.message = message
        self.code = code


def fail(message, code=1):
    raise ScriptError(message, code)


def normalize_url(value):
    return (value or DEFAULT_PLAYGROUND_URL).rstrip("/")


def request_json(base_url, path, payload=None, token=None, method=None):
    data = None
    headers = {
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers=headers,
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
            message = detail.get("message") or detail.get("error") or raw
        except json.JSONDecodeError:
            message = raw or str(exc)
        fail(f"HTTP {exc.code}: {message}")
    except urllib.error.URLError as exc:
        fail(f"Unable to reach playground: {exc}")

    parsed = json.loads(raw) if raw else {}
    if isinstance(parsed, dict) and "code" in parsed:
        if parsed.get("code") == 0:
            return parsed.get("data")
        fail(parsed.get("message") or "Playground request failed")
    return parsed


def find_private_keys(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_key = os.environ.get("SUB2API_SSH_KEY")
    if env_key:
        candidates.append(Path(env_key).expanduser())
    ssh_dir = Path.home() / ".ssh"
    candidates.extend([
        ssh_dir / "id_ed25519",
        ssh_dir / "id_ecdsa",
        ssh_dir / "id_rsa",
    ])
    seen = set()
    keys = []
    for candidate in candidates:
        resolved = candidate.resolve() if candidate.exists() else candidate
        if candidate.is_file() and resolved not in seen:
            seen.add(resolved)
            keys.append(candidate)
    if keys:
        return keys
    fail("No SSH private key found. Set SUB2API_SSH_KEY or create ~/.ssh/id_ed25519.")


def run_ssh_keygen(args):
    try:
        return subprocess.run(
            ["ssh-keygen", *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=60,
        )
    except FileNotFoundError:
        fail("ssh-keygen is required for SSH authentication.")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", errors="replace").strip()
        fail(detail or "ssh-keygen failed")
    except subprocess.TimeoutExpired:
        fail("ssh-keygen timed out. Unlock the SSH key or choose another key.")


def public_key_for(private_key):
    pub_path = private_key.with_name(f"{private_key.name}.pub")
    if pub_path.is_file():
        return pub_path.read_text(encoding="utf-8").strip()
    result = run_ssh_keygen(["-y", "-f", str(private_key)])
    return result.stdout.decode("utf-8").strip()


def sign_message(private_key, namespace, message):
    with tempfile.NamedTemporaryFile("wb", delete=False) as tmp:
        tmp.write(message.encode("utf-8"))
        message_path = Path(tmp.name)
    signature_path = Path(f"{message_path}.sig")
    try:
        run_ssh_keygen(["-Y", "sign", "-f", str(private_key), "-n", namespace, str(message_path)])
        return signature_path.read_text(encoding="utf-8")
    finally:
        message_path.unlink(missing_ok=True)
        signature_path.unlink(missing_ok=True)


def ssh_login(base_url, private_key_path=None):
    errors = []
    for private_key in find_private_keys(private_key_path):
        try:
            public_key = public_key_for(private_key)
            challenge = request_json(base_url, "/api/playground/ssh/challenge", {"public_key": public_key})
            signature = sign_message(private_key, challenge.get("namespace") or NAMESPACE, challenge["message"])
            login = request_json(base_url, "/api/playground/ssh/login", {
                "public_key": public_key,
                "challenge_id": challenge["challenge_id"],
                "signature": signature,
            })
            return login["access_token"]
        except ScriptError as exc:
            errors.append(f"{private_key}: {exc.message}")
    fail("SSH login failed for all discovered keys. " + " | ".join(errors))


def extension_for(content_type):
    mime = (content_type or "image/png").split(";", 1)[0].strip().lower()
    if mime == "image/jpeg":
        return ".jpg"
    if mime == "image/svg+xml":
        return ".svg"
    return mimetypes.guess_extension(mime) or ".png"


def download_bytes(base_url, path, token):
    req = urllib.request.Request(
        f"{base_url}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.read(), res.headers.get("Content-Type") or "image/png"
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
            message = detail.get("message") or raw
        except json.JSONDecodeError:
            message = raw or str(exc)
        fail(f"HTTP {exc.code}: {message}")


def resolve_output_paths(download_path, task_id, count, content_types):
    raw_path = Path(download_path).expanduser()
    directory_target = (
        count > 1 or
        str(download_path).endswith(("/", "\\")) or
        (raw_path.exists() and raw_path.is_dir())
    )
    if directory_target:
        raw_path.mkdir(parents=True, exist_ok=True)
        return [
            raw_path / f"{task_id}-{index + 1}{extension_for(content_types[index])}"
            for index in range(count)
        ]
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    if raw_path.suffix:
        return [raw_path]
    return [raw_path.with_suffix(extension_for(content_types[0]))]


def main():
    global USER_AGENT
    parser = argparse.ArgumentParser(description="Query a Sub2API Playground image task and download completed images.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--download-path", required=True)
    parser.add_argument("--playground-url", default=os.environ.get("SUB2API_PLAYGROUND_URL", DEFAULT_PLAYGROUND_URL))
    parser.add_argument("--ssh-key", default=os.environ.get("SUB2API_SSH_KEY"))
    parser.add_argument("--user-agent", default=os.environ.get("SUB2API_USER_AGENT", DEFAULT_USER_AGENT))
    args = parser.parse_args()

    USER_AGENT = args.user_agent
    base_url = normalize_url(args.playground_url)
    token = ssh_login(base_url, args.ssh_key)
    task_path = f"/api/playground/ssh/tasks/{urllib.parse.quote(args.task_id)}"
    task = request_json(base_url, task_path, token=token)

    status = task.get("status")
    if status != "completed":
        print(json.dumps({
            "ok": True,
            "task_id": task.get("task_id", args.task_id),
            "status": status,
            "message": "任务尚未完成，请等待一两分钟后再次查询。",
            "error": task.get("error"),
        }, ensure_ascii=False, indent=2))
        return

    images = ((task.get("result") or {}).get("images") or [])
    if not images:
        fail("Task is completed but contains no downloadable images.")

    downloads = []
    content_types = []
    for index, _image in enumerate(images):
        data, content_type = download_bytes(
            base_url,
            f"{task_path}/download?index={index}",
            token,
        )
        downloads.append(data)
        content_types.append(content_type)

    output_paths = resolve_output_paths(args.download_path, args.task_id, len(downloads), content_types)
    written = []
    for data, output_path in zip(downloads, output_paths):
        output_path.write_bytes(data)
        written.append(str(output_path.resolve()))

    print(json.dumps({
        "ok": True,
        "task_id": task.get("task_id", args.task_id),
        "status": status,
        "files": written,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except ScriptError as exc:
        print(json.dumps({"ok": False, "error": exc.message}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(exc.code)
