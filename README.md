# moonlybox-desktop

魔力宝盒（MoonlyBox）桌面客户端仓库——CLI 先行（M1），桌面壳随后（M4）。

> 战略底稿：《记忆产品化与客户端战略规划》（服务端仓 docs/，单一来源）——本仓只放代码与自身文档。

## 定位

- **CLI（M1）**：`moonlybox` 单二进制（Bun + TypeScript）——`login`（OAuth Device Flow）/ `sync`（vault 双向同步）/ `inbox watch`（收集箱监听）/ `compile --local`（本地 LLM 整理，M2）/ `xiaoyue`（对话）；
- **Desktop（M4）**：Electron 壳（倾向定案，五硬指标终裁门见规划 §5.11）——单窗口三区 + 小月右栏 + 托盘。

## 构建

```bash
bun install
bun run build        # CLI 单文件编译
bun test
```

## 分支与发布

- `main` 为主干；版本 semver 双轨（壳版本 / 内核版本，见规划 §5.15）；
- 发布渠道：GitHub Releases（主）+ Gitee（国内兜底）+ 官网自建更新源（灰度/critical 权威）。

## 纪律（从第一天开源标准）

- 密钥/签名证书/更新凭证**永不入仓**（CI secrets 隔离）；
- `tools.ts` 单源权威在服务端仓（myfavorite），本仓经 `@moonlybox/tools` 发布包消费，禁止 fork 工具定义；
- MIT LICENSE；NOTICE 保留对 Hermes Desktop（MIT）的参考声明；
- 迭代编号沿用全局 # 序列；规划/迭代记录归服务端仓 docs/，本仓不放。

## 参考声明

本项目 UI 与更新架构参考了 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（MIT）的工程实践，感谢开源。
