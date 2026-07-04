# SonicNote Sync — VSCode 插件

将 [SonicNote（妙记）](https://ainote.easylinkin.com) 的录音内容同步到本地 Markdown 文件，在 VSCode 中管理和编辑。

## 功能

- **一键同步**：从 SonicNote 服务器拉取所有录音，生成本地 Markdown 文件
- **增量同步**：已同步的录音自动跳过，只下载新增内容；服务器端更新标题后本地文件自动重命名
- **富内容输出**：每个 `.md` 文件包含 Frontmatter 元数据、笔记、AI 总结、学习报告、逐字转录
- **侧边栏管理**：专属侧边栏面板，浏览、打开、复制、删除已同步文件
- **定时自动同步**：支持按间隔（1/3/6/24 小时）自动重新同步
- **可配置属性**：勾选需要的 Frontmatter 字段，支持自定义属性

## 输出文件结构

```markdown
---
audio_id: "xxx"
record_name: "20240601_143000.mp3"
record_nick_name: "产品评审会"
duration: "3600"
record_time: "2024-06-01 14:30:00"
record_type: "录音"
device_name: "iPhone"
audio_url: "https://..."
tags:
  - sonicnote
  - 录音
sync_time: "2024-06-02 10:30:00"
---

# 产品评审会

## 笔记
要点记录...

## AI 总结
会议讨论了三个核心议题...

## 学习总结
![知识全景图](https://...)

### 核心收获
...

### 课后巩固
...

## 转录内容
**[00:00:05] 张三：** 今天我们讨论一下...
**[00:01:20] 李四：** 我觉得这个方案可行...
```

## 命令

| 命令 | 说明 |
|------|------|
| `SonicNote Sync: 同步录音` | 触发手动同步 |
| `SonicNote Sync: 登录` | 使用 API Key 登录 |
| `SonicNote Sync: 登出` | 退出登录 |
| `SonicNote Sync: 打开设置` | 打开设置面板 |

## 配置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `sonicnote-sync.serverUrl` | `https://ainote.easylinkin.com:18048/prod-api` | 服务器地址 |
| `sonicnote-sync.syncFolder` | `SonicNoteSync`（工作区根目录下） | 同步文件存放路径 |
| `sonicnote-sync.pageSize` | `50` | 每页获取录音数量 |
| `sonicnote-sync.includeTranscript` | `true` | 包含逐字转录内容 |
| `sonicnote-sync.autoSyncOnOpen` | `false` | 启动时自动同步 |
| `sonicnote-sync.resyncIntervalMinutes` | `0`（关闭） | 定时重同步间隔 |

## 快速开始

1. 在 SonicNote App → 我的 → MCP Key 管理中创建 API Key
2. 在 VSCode 中按 `Cmd+Shift+P`，运行 `SonicNote Sync: 登录`，粘贴 API Key
3. 运行 `SonicNote Sync: 同步录音`
4. 文件将出现在工作区 `SonicNoteSync/` 目录下

> **提示**：建议在设置中指定同步文件夹的绝对路径，避免文件散落在工作区根目录。

## 系统要求

- VSCode ≥ 1.85.0

## 开发

```bash
npm install          # 安装依赖
npm run compile      # 编译 TypeScript
npm run watch        # 监听模式
npm run package      # 打包 .vsix
```

### 项目结构

```
SonicNoteSync-Vscode/
├── src/
│   ├── extension.ts      # 插件入口：侧边栏、设置面板、命令注册
│   ├── api.ts             # SonicNote API 客户端（登录、录音列表、转录、总结）
│   ├── sync.ts            # 同步服务：增量同步、本地索引、文件重命名
│   ├── formatter.ts       # Markdown / Frontmatter 格式化
│   └── types.ts           # 类型定义与常量
├── media/icon.svg          # 插件图标
├── release/                # 发布产物 (.vsix + 安装指南)
├── package.json            # 插件元数据与命令配置
└── tsconfig.json           # TypeScript 编译配置
```

## 许可证

MIT
