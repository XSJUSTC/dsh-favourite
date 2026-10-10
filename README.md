# @xsj/dsh-favourite

DSH 收藏插件：为工作区管理侧栏（`sidebar.workspaces`）增加会话/工作区收藏、收藏筛选、置顶展示与 fork 收藏继承，另提供可配置的收藏星标颜色。

> A DeepSeek Harness plugin that adds favorites (star) for sessions and workspaces, a favorites-only filter, a "hide unfavorites" display mode, top-pinning with hover metadata, star-color settings, and fork-time favorite inheritance.

## 功能

1. **收藏**：工作区行与会话行悬停出现星标按钮（收藏后常亮）；行菜单里也有 收藏/取消收藏。收藏工作区**不会**自动收藏其内部会话。
2. **只看收藏**（筛选收藏结果）：一级只显示 **收藏的会话（散行，不带工作区归属）+ 收藏的工作区**；收藏的工作区可展开，展开显示其下**全部会话**；未收藏的工作区与未收藏的会话不出现。散行排序跟随视图选项的 排序方式（最近更新=按活跃度，手动=跟随单列表手动顺序）。
3. **置顶**：对收藏的会话/工作区执行 置顶（行菜单），置顶项显示在工作区管理最上方。置顶会话以单行形式直接展示，**不显示工作区名**；鼠标悬浮展示工作区名、路径、会话标题、时间与状态等元信息。置顶为额外快捷行，**会话本身仍保留在其工作区内**，不改拓扑。
4. **fork 继承**：会话 fork 时（`session/created`，普通 fork 而非子代理），子会话默认继承原会话当时的收藏与置顶状态。
5. **隐藏未收藏**：官方结构上只做减法 —— 不显示"未收藏工作区的未收藏会话"：收藏的工作区展开显示其**全部**会话；未收藏但含收藏会话的工作区显示且会话嵌在其中；收藏会话数为 0 的未收藏工作区隐藏。
6. **全部显示**：官方原样列表（显式回落入口，取消任一筛选也可回落）。
7. **星标颜色**：视图选项菜单可选 金黄/橙/红/蓝/紫/跟随主题，持久化保存。

两个筛选/隐藏模式激活期间**跳过 5 行折叠限制**（普通浏览时超过 5 个会话折叠为"展开其余 N 个"，筛选模式下匹配项永不折叠隐藏）。收藏文档 2 秒轮询 + 窗口聚焦即时刷新，多窗口/宿主侧 fork 继承最迟 2 秒可见。

置顶行菜单同时提供 重命名 / 分叉会话 / 归档会话，行为与组内会话行一致。

## 安装

```powershell
# 从 GitHub 安装
dsh plugin --profile web add github:XSJUSTC/dsh-favourite

# 或从本地目录
dsh plugin --profile web add <本插件目录或 file:/link: 路径>

# 重启 DSH，刷新页面
```

安装后插件以 `priority: -1` 影子接管 `sidebar.workspaces` 槽位（官方浏览器保持注册，卸载本插件即回落）。

## 数据与接口

- 持久化：`<DSH_HOME>/storages/dsh-favourite.json`（原子写）
- 路由：`GET /api/dsh-favourite`、`POST /api/dsh-favourite/toggle`、`POST /api/dsh-favourite/pin`（64KB body 上限）
- 宿主服务：`ctx.dshFavourite`（snapshot / toggle / setPinned / isFavorited）
- fork 继承：监听 `session/created`，`header.parentSession` 且 `isSeeded` 且非 `subagent` 时继承

## 测试

```powershell
node --test test/host.test.mjs test/client.test.mjs   # 单元（宿主 mock ctx + 客户端 ModuleLoader 装载）
node test/e2e-api.mjs <baseUrl> <token> <parentId> <plainId>          # 真实运行时 RPC 链路
node test/seed-sessions.mjs <dshHome> <cwd> <count>                   # 为虚拟环境种子会话
node test/e2e-ui.mjs <baseUrl> <token> <parentId> <plainId>           # Playwright 真实 UI 全链路
```

## 结构

```
lib/index.js    宿主半：路由、存储、fork 继承
lib/client.js   客户端半：影子注册的收藏版 WorkspaceBrowser
cordis.patch.yml 挂载行
test/           单元 + API e2e + UI e2e + 种子脚本
```

## License

MIT
