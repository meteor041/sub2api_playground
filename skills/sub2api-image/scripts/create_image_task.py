#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


NAMESPACE = "sub2api-playground"
DEFAULT_PLAYGROUND_URL = "https://playground.meteor041.com"
DEFAULT_MODEL = "image2"


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
    headers = {"Accept": "application/json"}
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


def run_ssh_keygen(args, input_bytes=None):
    try:
        return subprocess.run(
            ["ssh-keygen", *args],
            input=input_bytes,
            stdin=subprocess.DEVNULL if input_bytes is None else None,
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
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
        tmp.write(message)
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


def image_data_url(path_value):
    path = Path(path_value).expanduser()
    if not path.is_file():
        fail(f"Reference image not found: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {
        "name": path.name,
        "mime_type": mime_type,
        "data_url": f"data:{mime_type};base64,{encoded}",
    }


def normalize_model(model):
    return "gpt-image-2" if model.lower() in {"image2", "image-gpt-2", "gpt-image-2"} else model


def build_payload(args):
    references = [item for group in args.references for item in group]
    images = [image_data_url(path) for path in references]
    return {
        "mode": "edit" if images else "generate",
        "prompt": args.prompt,
        "model": normalize_model(args.model),
        "quality": args.quality,
        "size": args.size,
        "n": 1,
        "response_format": "b64_json",
        "stream": True,
        "partial_images": 2,
        "images": images,
    }


def main():
    parser = argparse.ArgumentParser(description="Create an async Sub2API Playground image task.")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--reference", "--references", dest="references", action="append", nargs="+", default=[])
    parser.add_argument("--quality", default="high")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--playground-url", default=os.environ.get("SUB2API_PLAYGROUND_URL", DEFAULT_PLAYGROUND_URL))
    parser.add_argument("--ssh-key", default=os.environ.get("SUB2API_SSH_KEY"))
    args = parser.parse_args()

    base_url = normalize_url(args.playground_url)
    token = ssh_login(base_url, args.ssh_key)
    task = request_json(base_url, "/api/playground/ssh/tasks", {"payload": build_payload(args)}, token=token)
    print(json.dumps({
        "ok": True,
        "task_id": task["task_id"],
        "status": task.get("status", "queued"),
        "message": task.get("message") or "任务已创建，图片生成通常需要等待一两分钟。请稍后用任务 id 查询进度并下载结果。",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except ScriptError as exc:
        print(json.dumps({"ok": False, "error": exc.message}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(exc.code)
