<div align="center">
  <img src="assets/icon.png" width="80" alt="Token Usage" />
  <h1 align="center">Token Usage</h1>
  <p align="center">本地优先的 AI 编程工具 Token 消耗监控与费用计算桌面工具</p>
  <p align="center">
    <img src="https://img.shields.io/badge/Electron-42.2-47848F?logo=electron" alt="Electron" />
    <img src="https://img.shields.io/badge/OpenCode-支持-000000?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMiA0TDggMEwxNCA0VjEyTDggMTZMMiAxMlY0WiIgZmlsbD0iY3VycmVudENvbG9yIi8+PC9zdmc+" alt="OpenCode" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  </p>
</div>

---

## 概述

**Token Usage** 是一款基于 Electron 的桌面工具，实时监控 [OpenCode](https://opencode.ai) AI 编程助手的 Token 消耗与 API 费用。本地读取 `opencode.db`，无需任何网络请求，数据完全离线计算。

### 主要功能

- **实时监控** — 监听 `opencode.db` 文件变更 + 定时轮询，秒级刷新数据
- **多维展示** — 按模型、日期、会话三种维度查看 Token 消耗
- **费用计算** — 基于 LiteLLM 定价库 + OpenCode 本地缓存定价，精确匹配供应商和模型
- **会话详情** — 展开查看每轮对话的 Token 明细（输入/输出/缓存/推理）
- **毛玻璃界面** — 深色主题 + 液态玻璃效果，支持窗口缩放
- **模型图标** — 使用 [@lobehub/icons](https://lobehub.com/icons) 展示模型品牌图标

---

## 截图

| 模型视图 | 日期视图 | 会话视图 | 会话详情 |
|---|---|---|---|
| 按模型聚合展示 | 按日期分布展示 | 按会话排列 | 展开对话轮次 |

---

## 安装

### 前置条件

- [Node.js](https://nodejs.org/) >= 18
- [npm](https://www.npmjs.com/) >= 9

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/luziyi/token-usage.git
cd token-usage

# 安装依赖
npm install

# 启动
npm start
```

### 打包构建

```bash
npm run build
```

---

## 数据来源

软件读取 OpenCode 的本地 SQLite 数据库：

```
~/.local/share/opencode/opencode.db
```

从以下表中提取数据：

| 表名 | 用途 |
|------|------|
| `session` | 会话摘要（模型、Token 数、费用、时间） |
| `message` | 对话消息（角色、Token 明细） |
| `part` | 消息内容片段（文本、工具调用） |

> 所有数据仅在本地读取，**不会上传至任何服务器**。

---

## 费用计算机制

### 定价优先级

1. **OpenCode 本地缓存** (`~/.cache/opencode/models.json`) — 优先按供应商+模型精确匹配
2. **LiteLLM 定价库** (内置 2100+ 模型定价数据) — 模型名称匹配
3. **Pinned 定价表** — 手动维护的主流模型价格
4. **启发式匹配** — 按模型名称关键词推断

### 计费公式

```
费用 = 输入Token × 输入单价
     + 缓存读取 × 缓存读单价
     + 缓存写入 × 缓存写单价
     + 输出Token × 输出单价
     + 推理Token × 输出单价
```

> 数据库中 `tokens_input` 与 `tokens_cache_read` 为独立计费字段，互不重叠。

---

## 技术栈

| 技术 | 用途 |
|------|------|
| [Electron](https://www.electronjs.org/) | 桌面应用框架 |
| [sql.js](https://github.com/sql-js/sql.js/) | SQLite WASM 运行时 |
| [chokidar](https://github.com/paulmillr/chokidar) | 文件变更监听 |
| [@lobehub/icons](https://lobehub.com/icons) | AI 品牌图标集合 |

---

## 许可证

[MIT](LICENSE)

Copyright (c) 2026
