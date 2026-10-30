# Echo Notes 回声笔记

一个**情绪优先**的 DeepSeek Harness 日记插件，让 Agent 当你的写作搭子：情绪/人设模版、
按时间与心情回看、可选的密码加密，以及定时写作提醒。

原生面板与 `echo_note` Agent 工具运行在 DeepSeek Harness 里。下面同时记录了那份可移植的
JSON Schema 工具契约，供其它 Agent 宿主做适配；提醒、存储这类宿主侧能力需要 Harness
运行时或一个适配器。

英文文档见 [README.md](README.md)。

---

## 能做什么

| | |
|---|---|
| **情绪模版** | i 人 / e 人，外加每种心情一个（开心、伤心、焦虑、疲惫…）和一个空白自由写。可以自己写模版，也可以「遮住」内置模版，都不用改代码。 |
| **回看** | 按时间窗、心情、标签、模版筛选，以及全文搜索。另有按心情/日期/标签的聚合和连续写作天数。 |
| **加密** | AES-256-GCM，密钥由你的密码经 `scrypt` 派生，每条笔记独立随机 IV，笔记 id 作为 AAD 绑定进去。在建立密钥库之前不加密。 |
| **提醒** | 每天、每周、按间隔，或一次性。触发时唤醒 Agent，带着一段提示去写这一篇。 |
| **Agent 访问** | 一个 `echo_note` 工具（9 个 action），外加一个 `echo-notes` 技能承载写作指引。 |
| **自动锁定** | 可选：闲置一段时间后把密钥从内存里丢掉。 |

## Agent 兼容性

| 接口面 | 兼容性 | 要求 |
|---|---|---|
| DeepSeek Harness 原生 Agent 工具 | 原生 `echo_note` 工具，标准 JSON Schema 出入参 | Harness 中启用本插件 |
| 支持 MCP 的 Agent 客户端 | 通过随包附带的 stdio MCP 适配器使用 `echo_note` | Harness 本地运行；设置 `ECHO_NOTES_API_URL` |
| Claude Desktop / Cursor / Continue | MCP stdio 传输，受各客户端自身配置支持度约束 | Node.js 20+，按客户端配置 MCP |
| 直接 REST 调用方 | `/echo-notes/api` 下的本地 JSON API | 回环 Host；POST 需同源或省略 Origin |
| 既无 MCP 也无自定义工具的 Agent | 不直接支持 | 走 MCP 桥接或客户端自带的工具适配能力 |

这是**通过共享 schema 与适配器实现的互操作**，不是在宣称同一份插件二进制能在每个 Agent
产品里原样跑起来。密钥库、加密密钥、提醒与持久化都归 Harness 所有；外部 MCP 客户端只是
转发给那个正在运行的本地服务，无法靠一次工具调用就把锁解开。

## 安装

### DeepSeek Harness（开发态链接）

在本地 DSH 会话里，用插件管理器把这个目录作为 bundle 安装，填这个 checkout 的绝对路径。
该 bundle 会注册一行 Host 插件和一个客户端面板；激活后从侧边栏打开 **回声笔记**，
建立密钥库即可。

### DeepSeek Harness（发布版）

从已打 tag 的 GitHub release 获取本包，通过 DSH 插件管理器安装。
安装流程见 [RELEASING.md](RELEASING.md)。

### 其它 Agent 宿主

其它支持 MCP 的 Agent 可以在配置好后，用 `mcp/` 里那份可移植的 MCP 适配器接上同一套
回声笔记数据服务。UI、本地存储域、提醒调度与密码生命周期都归 Harness 所有；换一个宿主
就必须由它提供适配/存储服务，且不能在 Harness 进程运行时共用原始的裸数据目录。
详见 [Agent 兼容性](#agent-兼容性)。

## 怎么用

1. **建密钥库。** 设一个密码。它会被拉伸成一把密钥加密密钥；落盘的只有一把被包裹的数据
   密钥，所以之后改密码**不会**重写任何一条笔记。
2. **写。** 先点一个心情标签，再按需选一个模版。模版会把提示小标题填进编辑器——想答的
   答，不想答的直接删掉。
3. **让 Agent 来写。** 「帮我写今天的日记，今天有点累」就够了。它会先调 `status`，
   挑一个匹配的模版，用你的口吻写，最后一行确认。
4. **回看。** 按文字或心情筛列表，或打开 **设置** 看心情/日期图表和统计。

### 提醒时间表

```yaml
daily:    { kind: daily,    at: "21:30" }
weekly:   { kind: weekly,   at: "09:00", weekdays: [1, 5] }   # 1 = 周一
interval: { kind: interval, everyMinutes: 45 }
once:     { kind: once,     at: "2026-10-09T09:00:00+08:00" }
```

机器睡眠期间到点的提醒会被**跳过，而不是补发**——放完假打开 App 不会砸来一墙提醒。
宽限窗口是 10 分钟。

## 配置

改这个 bundle 在 `cordis.patch.yml` 里的那一行（或插件的设置页）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `autoLockMinutes` | `0` | 闲置这么多分钟后丢掉密钥。`0` 表示关闭自动锁定。 |
| `defaultReminder` | `"21:30"` | 未指定时间的提醒所用的默认时刻。 |
| `encryptByDefault` | `true` | 密钥库一旦存在就加密正文。 |
| `tickSeconds` | `30` | 提醒/自动锁定循环多久跑一次。 |

## 内部结构

```
index.js          Host 半边：密钥库、工具、技能、提醒循环、HTTP API
client.js         客户端半边：面板（纯 JS，React 取自模块表）
src/crypto.js     scrypt + AES-256-GCM，零依赖
src/store.js      笔记索引、筛选、修订、加密迁移
src/templates.js  情绪模版及其渲染
src/reminders.js  纯时间表算术（下次触发、补发策略）
skills/echo-notes/SKILL.md   面向 Agent 的工作流
test/             单测、集成、MCP 协议与渲染测试
```

三个值得知道的决定：

**一个 action 分发器，多个适配器。** Harness 工具和 HTTP 路由调的是同一份
`runToolAction`/`operations` 逻辑。MCP 适配器把同一份 `echo_note` JSON Schema/action
请求转发到 `/tool`；它**不**另建一套数据存储或业务逻辑副本。集成测试逐面覆盖每个适配器。

**客户端走 HTTP 调 Host，而不是 Remote 命名空间。** 这个包是纯 JavaScript，没有代码生成
步骤。`ctx.webServer.register` 给面板一条同源传输；回环 Host 与 Origin 校验限制浏览器
请求。MCP stdio 是给本地客户端连正在运行的 Harness 用的。不要把这个 HTTP 端点暴露到
公网，也不要在没有真正加认证和 TLS 的情况下给它做代理。

**元数据是明文，笔记正文与修订是密文。** 落盘的索引仍然带着标题、心情、标签、时间戳、
字数与置顶状态，这样筛选不必解密每条笔记。40 字的预览片段在启用加密后会被清掉。但这些
元数据字段仍可能泄露隐私信息，请相应对待存储目录。

## 开发与测试

```sh
pnpm install
pnpm check
pnpm test
```

Node 内置测试套件覆盖加密与篡改检测、存储与迁移、提醒、HTTP 与原生工具操作、标准
JSON Schema 可移植性、MCP stdio JSON-RPC，以及客户端视图渲染。profile 安装用的是
DSH 自有的包 peer；本地开发用 lockfile 里钉死的那些 peer 版本。
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

浏览器端冒烟测试（需要一起跑着的 `dsh web` 和 Playwright，不在 `pnpm test` 里）：

```sh
DSH_WEB_URL="http://127.0.0.1:8321/?token=…" pnpm test:browser
```

## 已知边界

- **元数据仍是明文。** 标题、心情、标签、时间戳、字数与置顶状态为索引和筛选而未加密存储。
  启用加密后明文正文预览会被移除。能读存储后端的人仍可从元数据推断出一些模式。
- **认证加密挡不住回滚或删除。** AES-GCM 能发现密文被篡改、以及把密文在笔记/修订 id
  之间搬家。但任何对存储后端有写权限的人仍可以删笔记，或把一个更早的、合法的数据库快照
  恢复回来。请妥善备份存储后端。
- **密码忘了就是不可恢复的。** 加密本来就是为这个。没有恢复密钥，也没有托管。
- **自动锁定是粗粒度的。** 它在 tick 循环上检查，所以锁定会在截止时间前后一个
  `tickSeconds` 内落下，不是精确到点。
- **提醒需要 Harness 活着。** 它们是 Host 定时器，不是系统级通知；App 关着就什么都不触发，
  错过的那次直接跳过。
- **搜索需要密钥库处于解锁状态。** 匹配是对内存里解密后的正文做的，所以锁着的密钥库可以
  列出元数据，但搜不了正文。
- **面板经过真实浏览器验证。** `scripts/browser-smoke.mjs`（`pnpm test:browser`，需要跑着的
  `dsh web` 与 Playwright）驱动真实的 Web UI：侧边栏入口能打开面板、首次运行的密码卡片
  能渲染，且 `--dsw-alias-*` 主题 token 在浅色与深色方案下解析出不同的调色板。
  已在 DeepSeek Harness 0.2.2-alpha.2 上验证。

## 存储 schema

`echo_notes` 域存三张表（`notes`、`revisions`、`settings`），schema 是刻意宽松的。记录
形状会在日记使用过程中生长——严格的 schema 会把每次加字段都变成一次迁移——所以真正要紧的
不变量由 `NoteStore` 保证、由测试覆盖。
