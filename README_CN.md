# Sub2API Image Playground

[English README](./README.md)

`sub2api_playground` 是一个基于 Vue 3 + Vite 的独立前端 Playground，用来配合 `sub2api` 使用。

GitHub 仓库地址：

- https://github.com/meteor041/sub2api_playground.git

这个项目运行在独立端口上，但认证、余额、API Key、用量记录、扣费、并发控制和上游调度都仍然依赖现有的 `sub2api` 后端。

## 功能特性

- 使用现有 `sub2api` 账号登录。
- 展示当前账户余额。
- 选择或创建 OpenAI 分组 API Key。
- 与 `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.3-codex-spark`、`gpt-5.2` 等文字模型对话。
- 在聊天框中直接粘贴截图，或在发送前附加本地图片文件。
- 当用户明确要求“画图 / 生成图片”时，让文字模型自动调用生图工具。
- 使用 `gpt-image-2` 手动生成图片。

## 快速开始

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
npm install
npm run dev:server
npm run dev
```

前端开发服务器默认监听 `5174` 端口。
本地任务 / 代理服务默认监听 `8081` 端口。

默认情况下，Vite 会按下面的规则做代理：

- `/api/playground` -> `http://localhost:8081`
- `/api/v1`
- `/v1`
- `/images`

其中 `/api/v1`、`/v1`、`/images` 默认代理到 `http://localhost:8080`。

如果你的后端地址或本地任务服务地址不同，可以覆盖：

```bash
VITE_SUB2API_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
VITE_PLAYGROUND_SERVER_TARGET=http://127.0.0.1:8081 npm run dev
```

生产环境下，可以把 `VITE_SUB2API_BASE_URL` 设置为公开的 `sub2api` 地址，或者把这个前端和 `sub2api` 放在同一个反向代理后面。

## 请求链路

```text
浏览器 -> image-playground Node BFF -> sub2api backend
                               |-> 本地 PostgreSQL
                               |-> 挂载的数据目录
```

浏览器本身不会直接连接 PostgreSQL。会话元数据会写入你通过 `DATABASE_URL` 提供的本地 PostgreSQL，大体积内容则写到挂载的 `PLAYGROUND_DATA_DIR` 目录。

如果同时配置了 `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`，用户上传图片和生成结果图片也会写入 Cloudflare R2。最终公开 URL 仍然是 `${PLAYGROUND_IMAGE_CDN_BASE}/${public_token}`，而实际写入 R2 的 object key 会根据 `PLAYGROUND_IMAGE_CDN_BASE` 里的路径前缀自动推导。

## 异步生图任务

手动生图和工具触发的生图现在都会先经过这个仓库内置的轻量 Node BFF：

```text
浏览器 -> image-playground 任务服务 -> sub2api /v1/images/generations
```

这样浏览器不会再一直挂着一条面向 Cloudflare 的长生图请求，而是：

1. 先创建任务
2. 立刻拿到 `task_id`
3. 轮询任务状态
4. 完成后再读取图片 URL 或 data URL

## 持久化模型

- 会话元数据写入本地 PostgreSQL
- 会话快照以 JSON 文件形式写入 `PLAYGROUND_DATA_DIR`
- 配置 `R2_*` 后，上传图片和生成结果图片会写入 Cloudflare R2
- `PLAYGROUND_DATA_DIR` 仍然保存会话 JSON；如果 `PLAYGROUND_KEEP_LOCAL_ASSETS=true`，也会额外保留本地图片兜底副本
- 只要 PostgreSQL 数据和 `./data/playground` 目录还在，重新 `docker compose up -d --build` 就不会丢历史

## Docker 部署

Docker 镜像会先构建静态前端，再通过内置 Node 任务 / 代理服务在 `8081` 端口提供服务。

它会把以下路径代理到现有的 `sub2api` 服务：

- `/api/playground`
- `/api/v1`
- `/v1`
- `/images`

### Host Network 部署

如果你现有的 `sub2api` 容器已经使用 Docker host 网络，可以使用这个方式。

先确认宿主机可以访问 `sub2api`：

```bash
curl -fsS http://127.0.0.1:8080/health
```

先准备一个本地 PostgreSQL 数据库，例如 `sub2api_playground`，再克隆并启动 Playground：

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_UPSTREAM=http://127.0.0.1:8080 \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.host.example.yml up -d --build
```

验证：

```bash
curl -fsS http://127.0.0.1:8081/health
```

### Bridge Network 部署

如果 `sub2api` 和 `sub2api_playground` 共用同一个 Docker bridge 网络，可以使用这个方式。

先查看当前的 Docker 网络：

```bash
docker network ls
```

如果你是从 `sub2api` 的 `deploy/` 目录部署的，网络名称通常是 `deploy_sub2api-network`。

先准备一个本地 PostgreSQL 数据库，再克隆并启动 Playground：

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_DOCKER_NETWORK=deploy_sub2api-network \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.example.yml up -d --build
```

然后访问：

```text
http://your-server-ip:8081
```

如果你的 `sub2api` 容器使用了不同的主机名或上游地址，可以覆盖：

```bash
SUB2API_UPSTREAM=http://sub2api:8080 \
PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images \
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
R2_BUCKET=meteor-images \
R2_ACCESS_KEY_ID=your-access-key-id \
R2_SECRET_ACCESS_KEY=your-secret-access-key \
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/sub2api_playground?sslmode=disable \
docker compose -f docker-compose.example.yml up -d --build
```

挂载的 `./data/playground` 目录现在会包含：

- 会话快照 JSON 文件
- 当 `PLAYGROUND_KEEP_LOCAL_ASSETS=true` 时保留的本地图片兜底副本

## R2 配置

在 Node 服务容器上设置这些环境变量：

- `PLAYGROUND_IMAGE_CDN_BASE=https://img.meteor041.com/meteor-images`
- `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `R2_BUCKET=meteor-images`
- `R2_REGION=auto`
- `R2_ACCESS_KEY_ID=...`
- `R2_SECRET_ACCESS_KEY=...`
- `PLAYGROUND_KEEP_LOCAL_ASSETS=false`

当 `R2_*` 配置完整后，服务会在 `persistAsset()` 时把图片字节上传到 R2。R2 object key 会跟随 `PLAYGROUND_IMAGE_CDN_BASE` 里的路径，例如 `https://img.meteor041.com/meteor-images/<token>` 会对应到 R2 中的 `meteor-images/<token>`。旧的 `/api/playground/assets/:token` 路由仍然保留：本地文件存在时继续直接返回，不存在时会跳转到 CDN URL。

对于历史上已经落在本地磁盘里的图片，可以运行一次性迁移脚本：

```bash
npm run migrate:r2 -- --dry-run
npm run migrate:r2 -- --concurrency=8
```

## 域名代理

如果你要使用 `playground.example.com`，可以在反向代理或 Cloudflare Tunnel 中把它指向 `http://127.0.0.1:8081`。

如果使用 Cloudflare Tunnel，可以添加一个公开域名：

- Hostname: `playground.example.com`
- Service: `http://127.0.0.1:8081`

在 Cloudflare Tunnel 场景下，通常不需要额外开放 `8081` 入站端口。

如果你要直接暴露 `8081`，记得同时在服务器防火墙和云服务安全组中放行 TCP `8081`。

## 说明

- 当前后端图片模型名称是 `gpt-image-2`。如果前端想展示成 `image-gpt-2`，可以只做显示别名，实际请求仍然发送 `gpt-image-2`。
- 当前 MVP 版本允许浏览器直接使用用户选择的 API Key 调用网关。若要增强生产安全性，建议增加一个基于 JWT 的 BFF，避免浏览器直接接触 API Key。
- 这个仓库是独立发布的，但它的定位是配合现有 `sub2api` 部署使用，而不是替代 `sub2api`。

## 在线体验

如果你想直接体验已经部署好的版本，也欢迎来玩：

- https://playground.meteor041.com
