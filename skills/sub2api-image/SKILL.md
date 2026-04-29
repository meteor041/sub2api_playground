---
name: sub2api-image
description: Generate or edit images through a Sub2API Image Playground using local SSH-key authentication. Use this when an AI agent needs to create an async playground image task, poll it later by task id, and download completed images without handling API keys directly.
---

# Sub2API Image

Use the bundled scripts; do not call the image API directly.

Prerequisites:

- The user has bound this machine's SSH public key in the Playground WebUI.
- `SUB2API_PLAYGROUND_URL` points at the Playground origin. It defaults to `https://playground.meteor041.com`.
- Optional: set `SUB2API_SSH_KEY` to the private key path. If unset, scripts try common keys under `~/.ssh`.

## Create a Task

Run:

```bash
python scripts/create_image_task.py --prompt "A precise image prompt"
```

For editing/reference images, pass one or more local files:

```bash
python scripts/create_image_task.py --prompt "Keep the subject, change the background to a rainy neon street" --reference ./input.png
```

Important arguments:

- `--reference PATH` can be repeated; any reference image switches the task to edit mode.
- `--quality` defaults to `high`.
- `--model` defaults to `image2` and is sent to the playground as `gpt-image-2`.
- `--size` defaults to `1024x1024`.

After the script returns, tell the user the task was created, include `task_id`, and say image generation usually takes one or two minutes. Do not wait unless the user asked you to.

## Query and Download

Run:

```bash
python scripts/download_image_task.py --task-id TASK_ID --download-path ./result.png
```

If the task is still queued or processing, report the current status and ask the user to wait. If it is completed, the script downloads the image to `--download-path` and prints the local file path.
