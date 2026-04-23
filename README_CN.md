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
npm run dev
```

开发服务器默认监听 `5174` 端口。

默认情况下，Vite 会把下面这些路径代理到 `http://localhost:8080`：

- `/api/v1`
- `/v1`
- `/images`

如果你的后端地址不同，可以覆盖代理目标：

```bash
VITE_SUB2API_PROXY_TARGET=http://127.0.0.1:8080 npm run dev
```

生产环境下，可以把 `VITE_SUB2API_BASE_URL` 设置为公开的 `sub2api` 地址，或者把这个前端和 `sub2api` 放在同一个反向代理后面。

## 请求链路

```text
sub2api_playground -> sub2api backend -> PostgreSQL / Redis
```

Playground 本身不会直接连接 PostgreSQL 或 Redis。

## Docker 部署

Docker 镜像会先构建静态前端，再通过 Nginx 在 `8081` 端口提供服务。

它会把以下路径代理到现有的 `sub2api` 服务：

- `/api/v1`
- `/v1`
- `/images`

### Host Network 部署

如果你现有的 `sub2api` 容器已经使用 Docker host 网络，可以使用这个方式。

先确认宿主机可以访问 `sub2api`：

```bash
curl -fsS http://127.0.0.1:8080/health
```

克隆并启动 Playground：

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_UPSTREAM=http://127.0.0.1:8080 docker compose -f docker-compose.host.example.yml up -d --build
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

克隆并启动 Playground：

```bash
git clone https://github.com/meteor041/sub2api_playground.git
cd sub2api_playground
SUB2API_DOCKER_NETWORK=deploy_sub2api-network docker compose -f docker-compose.example.yml up -d --build
```

然后访问：

```text
http://your-server-ip:8081
```

如果你的 `sub2api` 容器使用了不同的主机名或上游地址，可以覆盖：

```bash
SUB2API_UPSTREAM=http://sub2api:8080 docker compose -f docker-compose.example.yml up -d --build
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
