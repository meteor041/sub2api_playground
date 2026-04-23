# Image Playground Project Plan

## 目标

在 `sub2api` 仓库内新增一个独立的并行网页项目 `image-playground`，使用单独端口运行，但不直接写数据库。它通过现有 `sub2api` 后端 API 共享 PostgreSQL、Redis、用户、余额、API Key、分组、用量记录和扣费逻辑。

核心能力：

- 用户登录后查看余额。
- 用户选择文字模型进行对话，例如 `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.3-codex-spark`。
- 用户手动输入提示词调用图片模型生成图片。
- 后续支持文字模型在对话中通过工具调用触发生图。

当前后端约定：

- 文字对话优先复用 `/v1/responses`，可选兼容 `/v1/chat/completions`。
- 图片生成复用 `/v1/images/generations`。
- 当前图片模型名使用 `gpt-image-2`。如果产品侧需要展示 `image-gpt-2`，在前端或 BFF 做别名映射到 `gpt-image-2`。

## 项目边界

`image-playground` 是独立前端项目，不嵌入现有 `frontend`，便于独立端口、独立 UI 风格和后续独立部署。

默认不直接连接 PostgreSQL 或 Redis，避免绕过现有计费一致性。所有余额校验、扣费、用量记录、并发控制和账号调度都通过 `sub2api` 后端完成。

## 推荐技术方案

- 前端框架：Vue 3 + Vite + TypeScript，保持与主前端技术栈一致，便于复用经验。
- 开发端口：`5174`。
- 生产端口：建议容器或反代暴露 `8081`。
- API 访问：开发期用 Vite proxy 转发 `/api/v1`、`/v1`、`/images` 到 `sub2api` 后端；生产期通过 Caddy/Nginx 或 Docker 网络反代到 `sub2api`。
- 认证：复用 `sub2api` JWT 登录接口和刷新逻辑。
- 初始实现：浏览器可选择用户自己的 OpenAI 分组 API Key 调用网关。
- 生产增强：增加 JWT 鉴权的 BFF 接口，浏览器不直接持有 API Key。

## 阶段计划

### 阶段 1：文字对话 MVP

目标：先让用户能用 `gpt-5.4/gpt-5.3` 等模型聊天。

任务：

- 初始化 `image-playground` 前端工程。
- 配置 Vite 独立端口和 API proxy。
- 实现登录、登出、刷新 token。
- 实现用户资料和余额展示，调用 `/api/v1/user/profile`。
- 实现 API Key 选择或提示创建，调用 `/api/v1/keys` 与 `/api/v1/groups/available`。
- 实现聊天页，支持模型选择、消息输入、响应展示。
- 调用 `/v1/responses` 完成文本对话。

验收：

- 用户可以登录。
- 页面显示余额。
- 用户选择 OpenAI 分组 API Key 后可发送文本对话。
- `sub2api` 后台可看到对应用量记录和余额扣减。

### 阶段 2：手动生图

目标：先提供稳定可控的手动生图入口。

任务：

- 在聊天页或独立生图页增加提示词输入框。
- 支持尺寸选择，首版建议 `1024x1024`。
- 请求 `/v1/images/generations`，默认模型 `gpt-image-2`。
- 展示返回的 `b64_json` 图片。
- 支持错误提示：余额不足、API Key 无效、分组不支持图片、上游失败、超时。
- 在生成后刷新用户余额。

验收：

- 用户输入提示词后可以生成图片。
- 图片消耗余额。
- `usage_logs.billing_mode` 应记录为 `image`。
- 前端能清晰展示失败原因。

### 阶段 3：文字模型自动调用生图工具

目标：让文字模型在对话中决定是否调用生图工具。

首选方案：前端或 BFF 编排工具调用，不改动现有网关计费链路。

流程：

1. 用户给文字模型发送自然语言请求。
2. 请求中声明 `generate_image` 工具，参数包含 `prompt`、`size`、`n`。
3. 文字模型返回 tool call。
4. 编排层调用 `/v1/images/generations`。
5. 编排层把图片结果作为 tool result 回填到对话。
6. 文字模型总结结果，页面展示图片。

任务：

- 定义工具 schema：`generate_image(prompt, size, n)`。
- 实现 tool call 解析和状态机。
- 限制单轮最大工具调用次数，建议首版最多 1 次。
- 实现 tool result 回填。
- 增加图片生成确认策略：首版可默认需要用户确认，避免模型误调用造成余额消耗。
- 增加费用提示或预估文案。

验收：

- 用户输入“帮我画一张……”时，文字模型可以触发生图。
- 图片生成费用仍由现有图片接口扣费。
- 文字对话费用和图片费用都分别记录在 `sub2api`。
- 模型无法无限循环调用工具。

## BFF 增强计划

MVP 可以让前端读取用户 API Key 并调用网关，但生产更推荐新增一个轻量 BFF。

BFF 目标：

- 浏览器只持有 JWT，不暴露 API Key。
- 后端按当前登录用户自动选择可用 OpenAI 分组和 API Key。
- BFF 内部调用现有 `/v1/responses` 和 `/v1/images/generations`。
- 保留现有网关扣费链路，不重复实现余额扣费。

候选接口：

- `POST /api/v1/playground/chat`
- `POST /api/v1/playground/images`
- `GET /api/v1/playground/config`

注意：BFF 如果直接调用 service 层，需要谨慎复用现有计费记录逻辑；更安全的首版是内部 HTTP 调用现有网关。

## 管理配置建议

管理员需要提前配置：

- 至少一个 OpenAI 分组。
- 该分组绑定可用 OpenAI 账号。
- 分组或渠道中为 `gpt-image-2` 配置图片计价。
- 用户拥有可使用该 OpenAI 分组的 API Key。
- 如果独立端口访问，配置 CORS `allowed_origins`。

## 风险与处理

- API Key 暴露风险：MVP 可接受，生产改 BFF。
- 模型名混淆：统一内部使用 `gpt-image-2`，展示层可做 `image-gpt-2` 别名。
- 自动工具误调用扣费：首版加用户确认和单轮次数限制。
- 跨域和 OAuth 回调：开发用 proxy，生产用同站反代或明确配置 CORS。
- 大图响应体较大：限制尺寸、数量和前端缓存策略。
- 扣费一致性：不直接写数据库，全部经现有网关。

## 推荐交付顺序

1. 创建前端工程骨架和开发端口。
2. 完成登录、余额、API Key 选择。
3. 完成 `gpt-5.4/gpt-5.3` 文本聊天。
4. 完成手动 `gpt-image-2` 生图。
5. 增加工具调用编排。
6. 视生产安全要求增加 BFF。

## 非目标

- 不在首版重写 `sub2api` 计费系统。
- 不在首版直接连接 PostgreSQL 或 Redis。
- 不在首版实现完整图片资产库。
- 不在首版实现复杂多工具代理循环。
