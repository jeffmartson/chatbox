# 数据备份归档

> Last updated: 2026-07

Chatbox 的手动数据备份使用带版本的 ZIP 归档。归档以会话为独立恢复单元，同时携带会话引用的受管图片、附件原文、解析内容和其他 blob 资源。历史单 JSON 备份仍可导入，但新导出统一使用 ZIP v2。

## 归档结构

```text
chatbox-backup-YYYY-M-D.zip
├── manifest.json
├── settings.json                  # 选中“设置”时存在
├── copilots.json                  # 选中“My Copilots”时存在
├── session-settings.json          # 存在相关设置时生成
├── sessions/
│   └── <encoded-session-id>/
│       ├── session.json
│       └── resources/
│           └── <resource-id>.<ext>
└── resources/
    └── <resource-id>.<ext>        # 全局或共享资源
```

`manifest.json` 最后写入，因此它记录的是本次流式导出的最终结果，而不是导出前的预估。根字段包括：

- `format: "chatbox-backup"` 与 `formatVersion: 2`；
- 导出时间、应用版本、平台和所选导出范围；
- 设置、Copilot、session settings 和每个 session JSON 的路径、字节数与 SHA-256；
- 资源 id、原始 storage key、归档路径、会话映射、MIME type、编码、字节数与 SHA-256；
- session/资源读取失败、外部路径跳过和 RAG 重建失败的 warning；
- session、资源、去重资源和 warning 数量。

Schema 的单一实现位于 `src/renderer/packages/backup/types.ts`。导入端只接受明确支持的格式版本，不对未知版本做猜测性恢复。

## 资源边界

资源收集器遍历 session 当前消息、历史线程和消息分叉，并收集：

- 消息图片和旧版图片会话图片；
- 附件解析内容 `storageKey` 与原始附件 `rawStorageKey`；
- 已解析链接、离线 tool result；
- session 头像和背景图；
- 设置头像、全局背景及 Copilot 图片。

相同 storage key 只生成一个资源节点；内容、编码和 MIME type 相同的不同 key 也可共享同一个归档 entry。manifest 保留所有原始 key 和 session 映射，导入时再按目标存储状态决定是否复用或重映射。

仅导出 Chatbox blob storage 中的受管内容。`localPath` 等外部绝对路径不会进入备份，也不会递归读取用户目录；缺少受管原文时会写入 warning。session attachment RAG 的 attachment id、索引状态、chunk 和 embedding 等派生状态会从 session JSON 中移除。原始/解析附件恢复后，桌面端重新创建 RAG 索引任务；不支持该能力的平台降级为 inline 附件。

## 有界内存与跨平台输出

`fflate` 的 streaming `Zip`/`Unzip` API 负责逐 entry 压缩和解压。ZIP writer 将单个输入 entry 切成 1 MiB 块，输出队列使用 4 MiB 高水位背压。导出内存上限由“单个 session JSON 或单个资源”决定，不随完整归档大小线性增长。

- Desktop/Web：优先使用 File System Access 可写流；不支持时退化为 Blob 下载，并在 UI 明确提示本次保存需要缓冲完整归档。
- Android：分块写入 Documents；权限或目录能力不足时流式写入 Cache，再交给系统文件选择器，结束后删除临时文件。
- iOS：分块写入 Cache 后打开系统分享面板，完成或失败后清理临时文件。

导出取消会终止 ZIP producer，并删除已创建的部分文件。资源或 session 读取失败不会被静默吞掉：manifest 和设置页都会显示 warning；包含缺失受管资源的归档会被导入端拒绝，避免恢复出只有 storage key、没有实际内容的引用。

## 导入事务

ZIP 导入分为三个阶段：

1. **读取与暂存**：逐 entry 解压；JSON entry 写入临时 KV，资源写入临时 blob。
2. **完整校验**：验证 manifest schema、entry/path 唯一性、大小、SHA-256、session/resource 双向映射和统计值。
3. **提交**：先规划资源 key，再写资源、session、meta、设置和 Copilot。目标 key 已有不同内容时生成同类的新 key，并重写所有引用。

提交前保存将被覆盖的 KV/meta 快照。提交中取消或失败时按逆序恢复快照、删除新资源，并清理所有暂存 key。导入成功后应用重启，使设置和查询缓存从持久化状态重新加载。

## ZIP 安全限制

导入器在解压前后同时检查：

- 绝对路径、反斜杠、空路径段、`.` / `..` 和 Windows drive path；
- 重复 entry path、缺少 central directory 或截断归档；
- entry 数量（默认 50,000）；
- 单 entry 解压大小（备份导入为 128 MiB）；
- 总解压大小（默认 4 GiB）；
- 高压缩比 entry（默认上限 250 倍）；
- manifest 未声明的 entry、缺失 entry、size/checksum 不一致和映射不一致。

这些限制在写入正式存储前生效。

## 相关实现

- `src/renderer/packages/backup/`：manifest、资源图、ZIP codec、导出、导入和 RAG 恢复。
- `src/renderer/routes/settings/general.tsx`：导出范围、进度、取消、warning 和 legacy JSON 路由。
- `src/renderer/platform/*_exporter.ts`：Desktop/Web/Mobile 输出能力。
- `src/renderer/platform/filter_writer.ts`：Capacitor 分块写入、Android picker fallback 和临时文件清理。
