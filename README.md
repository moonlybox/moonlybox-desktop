# moonlybox-desktop

魔力宝盒（MoonlyBox）桌面客户端仓库——CLI 先行（M1），桌面壳随后（M4）。

> 战略底稿：《记忆产品化与客户端战略规划》（服务端仓 docs/，单一来源）——本仓只放代码与自身文档。

## 定位

- **CLI（M1）**：`moonlybox` 单二进制（Bun + TypeScript）——`login`（OAuth Device Flow）/ `sync`（vault 双向同步）/ `inbox`（收集箱监听）/ `tools`（MoonLink 远程工具）/ `xiaoyue`（对话）；`compile --local`（本地 LLM 整理，M2，参数位已留）；
- **Desktop（M4）**：Electron 壳（倾向定案，五硬指标终裁门见规划 §5.11）——单窗口三区 + 小月右栏 + 托盘。

## 快速上手

```bash
# 1. 安装（源码运行）
bun install

# 2. 登录（OAuth Device Flow：给出浏览器链接+用户码，任意设备审批均可）
bun run src/cli.ts login

# 3. 初始化 vault（~/MyMoonVault，可用 --dir 指定）
bun run src/cli.ts sync init

# 4. 同步（收集箱上行 + 镜像区下行对账）
bun run src/cli.ts sync

# 5. 日常：把新文件扔进 收集箱/ 即自动上传（监听模式）
bun run src/cli.ts inbox

# 6. 工具（MoonLink 29 项，远程执行）
bun run src/cli.ts tools
bun run src/cli.ts tools call list_stickies '{}'

# 7. 问小月
bun run src/cli.ts xiaoyue "我的书房里有什么"
bun run src/cli.ts xiaoyue        # REPL 模式
```

## vault 目录语义（§5.10）

```
MyMoonVault/
├── 文档/        ← 下行镜像区（云端权威；外部修改会被对账检出并提示）
├── 知识页/      ← 下行镜像区（云端编译产物，明文 md）
├── 收集箱/      ← 唯一上行口：扔进来 = 上传，处理完自动归位
└── .moonlybox/  ← manifest + sync.log（同步日志全链可查）
```

不变量：**镜像区永远等于云端；一切分歧只存在于收集箱里。**

## 构建

```bash
bun install
bun run build        # CLI 单文件编译（bun build --compile）
bun x tsc --noEmit   # 类型检查
```

## M1 验收记录（2026-09-23）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| OAuth Device Flow（登录） | ✅ | E2E 11/11：DCR→device/code→审批→token→refresh→/api/auth/me；`login` 命令真跑 ✓ Logged in |
| 目录接管（vault 四目录+frontmatter 身份） | ✅ | sync init 建骨架；下行文件带 `moonlybox:{id,version}` |
| 选择性上云（收集箱唯一上行口） | ✅ | 收集箱 .md → 上传 → 归位 → 清空；失败件留箱 |
| 同步日志 | ✅ | `.moonlybox/sync.log` JSONL：download/update-down/upload-inbox/remove-down 全流水 |
| 对账权威（D10） | ✅ | 外部修改 → 分歧清单不覆盖（EXIT=2）；幂等 sync ✓ |
| MoonLink 工具单源消费 | ✅ | tools/list 29 工具全量 + tools/call 远程执行 ok=true |
| 小月问答 | ✅ | 认证/422/命中进 LLM 段本机验证；生产 LLM 真链路沙箱 llm_ok=1 + #227 两轮实证 |
| BYOK 直连（预留） | ⏳ M2 | `compile --local` 参数位已留；小月先走平台网关 |
| 真机生产一条龙 | 🔶 | 本地 sqlite API 全链五轮实证；生产 login 需人工浏览器审批，首装留给真实用户场景 |

E2E 脚本：`tests/device-flow.e2e.ts`（Device Flow 11 断言）。

## 已知边界（M2 收敛）

- 镜像区改版经收集箱回传 = 新文档；服务端按 `moonlybox.id` 识别既有实体走版本管道是 M2；
- 下行为全量对账，增量游标/断点续传协议 M2 出草案（D6）；
- 凭据暂存 `~/.config/moonlybox/credentials.json`（0600），系统钥匙串迁移 M2 前；
- 决策卡（改版回传/放弃/稍后）为桌面壳交互，CLI 以分歧清单代替。

## 分支与发布

- `main` 为主干；版本 semver 双轨（壳版本 / 内核版本，见规划 §5.15）；
- 发布渠道：GitHub Releases（主）+ Gitee（国内兜底）+ 官网自建更新源（灰度/critical 权威）。

## 纪律（从第一天开源标准）

- 密钥/签名证书/更新凭证**永不入仓**（CI secrets 隔离）；
- MoonLink 工具单源权威在服务端仓（myfavorite）——CLI 经远程 MCP（tools/list + tools/call）消费，**不 fork 工具定义**（§5.13 修订：发布包方案由远程 MCP 消费替代，工具执行与配额校验全在云端）；
- MIT LICENSE；NOTICE 保留对 Hermes Desktop（MIT）的参考声明；
- 迭代编号沿用全局 # 序列；规划/迭代记录归服务端仓 docs/，本仓不放。
