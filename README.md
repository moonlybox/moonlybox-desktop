# moonlybox-desktop

[![CI](https://github.com/moonlybox/moonlybox-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/moonlybox/moonlybox-desktop/actions/workflows/ci.yml)

魔力宝盒（MoonlyBox）桌面客户端仓库。

> 镜像仓库：[Gitee（国内）](https://gitee.com/moonlybox/moonlybox-desktop)

## 定位

`moonlybox` 是一个单二进制 CLI（Bun + TypeScript），把你的知识库同步到本机文件夹，并提供本地检索与 AI 问答：

- **vault 同步**：`sync` 把云端书房镜像到本地文件夹（双向：收集箱上行 + 镜像区下行对账），`inbox` 监听收集箱自动上传；
- **本地混合检索**：`search` 关键词（FTS5）+ 语义向量（sqlite-vec）RRF 融合；embedding 用本地 CPU 小模型（bge-small-zh，q8 量化 33MB，首跑自动下载后全离线）；索引落 `.moonlybox/index.db`，**数据不出本机、零流量离线可用**；
- **Moonie 问答**（中文名「小月」，命令 `xiaoyue`）：本地轨优先——命中书房直接答（BYOK key 只存本机钥匙串直连 LLM）；未命中升级云端轨；对话按日落盘 `.moonlybox/dialogs/`；
- **记忆面板**：`memory` 搜索/追加你的记忆（走 moonlink MCP 同轨配额）；
- **远程工具**：`tools` 列出并调用 MoonLink 全部远程工具。

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

# 5. 本地混合检索（离线可用）
bun run src/cli.ts search "血小板输注有什么讲究"

# 6. 问 Moonie（小月）
bun run src/cli.ts xiaoyue "我的书房里有什么"
bun run src/cli.ts xiaoyue        # REPL 模式

# 7. 配置 BYOK 直连（可选：用自己的 LLM key 本地生成回答，key 只存本机钥匙串）
bun run src/cli.ts xiaoyue --setup

# 8. 日常：把新文件扔进 收集箱/ 即自动上传（监听模式）
bun run src/cli.ts inbox

# 9. 记忆面板
bun run src/cli.ts memory search 输血
bun run src/cli.ts memory add "用户是输血医学主任医师"

# 10. 远程工具
bun run src/cli.ts tools
bun run src/cli.ts tools call list_stickies '{}'
```

## vault 目录语义

```
MyMoonVault/
├── 文档/        ← 下行镜像区（云端权威；外部修改会被对账检出并提示）
├── 知识页/      ← 下行镜像区（云端编译产物，明文 md）
├── 收集箱/      ← 唯一上行口：扔进来 = 上传，处理完自动归位
└── .moonlybox/  ← manifest + sync.log + index.db + dialogs/
```

不变量：**镜像区永远等于云端；一切分歧只存在于收集箱里。**

## 构建

```bash
bun install
bun run build        # CLI 单文件编译（bun build --compile）
bun x tsc --noEmit   # 类型检查
```

## 测试

```bash
bun tests/hybrid-search.e2e.ts   # 本地混合检索（不依赖云端）
bun tests/device-flow.e2e.ts     # OAuth Device Flow（需本地 API 栈）
bun tests/changes.e2e.ts         # 增量同步（需本地 API 栈）
bun tests/keyring.e2e.ts         # 系统钥匙串
```

## 已知边界

- 镜像区改版经收集箱回传 = 新文档（服务端按 `moonlybox.id` 识别既有实体的版本管道尚未实现）；
- 下行为增量游标分页，中断后从整批重拉（断点续传未做）；
- 决策卡（改版回传/放弃/稍后）为桌面壳交互，CLI 以分歧清单代替。

## 分支与发布

- `main` 为主干；版本 semver；
- 发布渠道：GitHub Releases（主）+ Gitee（国内兜底）+ 官网自建更新源。

## License

MIT；NOTICE 保留对 Hermes Desktop（MIT）的参考声明。
