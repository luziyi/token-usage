<div align="center">
  <img src="assets/icon.png" width="80" alt="Token Usage" />
  <h1 align="center">Token Usage</h1>
  <p align="center">本地优先的 AI 编程工具 Token 消耗监控与费用计算桌面工具</p>
  <p align="center">
    <img src="https://img.shields.io/badge/Electron-42.2-47848F?logo=electron&logoColor=white" alt="Electron" />
    <img src="https://img.shields.io/badge/Windows_|_macOS_|_Linux-支持-9696F0?logo=electron&logoColor=white" alt="Platform" />
    <img src="https://img.shields.io/badge/OpenCode-支持-000?logo=OpenAI&logoColor=white" alt="OpenCode" />
    <img src="https://img.shields.io/badge/Claude_Code-支持-D97757?logo=claude&logoColor=white" alt="Claude Code" />
    <img src="https://img.shields.io/badge/license-MIT-3DA639?logo=openaccess&logoColor=white" alt="MIT" />
    <img src="https://img.shields.io/badge/version-1.1.7-5e9eff?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiAyTDIgN1YxN0wxMiAyMkwyMiAxN1Y3TDEyIDJaIi8+PHBvbHlsaW5lIHBvaW50cz0iMiA3IDEyIDEyIDIyIDciLz48bGluZSB4MT0iMTIiIHkxPSIxMiIgeDI9IjEyIiB5Mj0iMjIiLz48L3N2Zz4=&logoColor=white" alt="Version" />
  </p>
</div>


---

## 概述

**Token Usage** 是一款基于 Electron 的桌面工具，实时监控 **OpenCode** 和 **Claude Code** 的 Token 消耗与 API 费用。本地读取 `opencode.db` 与 Claude Code 会话文件，无需任何网络请求，数据完全离线计算。

### 主要功能

- **实时监控** — 监听 `opencode.db` 与 Claude Code JSONL 会话文件变更 + 定时轮询，秒级刷新数据
- **多维展示** — 按模型、日期、会话三种维度查看 Token 消耗
- **费用计算** — 基于 LiteLLM 定价库 + OpenCode 本地缓存定价，精确匹配供应商和模型
- **会话详情** — 展开查看每轮对话的 Token 明细（输入/输出/缓存/推理）
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

软件读取本地数据文件，**所有数据仅在本地读取，不会上传至任何服务器**。

### OpenCode

读取 OpenCode 的本地 SQLite 数据库：

```
~/.local/share/opencode/opencode.db
```

从以下表中提取数据：

| 表名 | 用途 |
|------|------|
| `session` | 会话摘要（模型、Token 数、费用、时间） |
| `message` | 对话消息（角色、Token 明细） |
| `part` | 消息内容片段（文本、工具调用） |

### Claude Code

读取 Claude Code 的 JSONL 会话文件：

```
~/.claude/projects/*/*.jsonl
~/.claude/projects/*/*/subagents/agent-*.jsonl
```

每个 JSONL 文件包含一次完整会话，从中提取每次 assistant 回复中的 `usage` 字段计算 Token 消耗。

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



