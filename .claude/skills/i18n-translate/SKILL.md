---
name: i18n-translate
description: 翻译新增/未完成的 i18n key。当你在 src/renderer 新增或修改了 t('...') / <Trans i18nKey="..."> 文案后，或用户要求翻译、补全语言文件时使用。由 LLM 自己读源码理解上下文并直接翻译，不调外部 API。
---

# i18n-translate

把还没翻译的 i18n key 补齐到各语言。**你（LLM）就是译者**：自己找上下文、自己翻、直接写语言 JSON。

## 数据结构（先了解）

- 每种语言一个文件：`src/renderer/i18n/locales/<locale>/translation.json`，是 `{ "英文 key": "译文" }` 的扁平表。
- `en` 是源语言。**key 通常就是英文原文本身**；翻译时以 `en` 文件里该 key 的 value 作为源文本（少数 key 的 value 与 key 不同，以 value 为准）。
- 未翻译的条目其 value 为空字符串 `""`。
- **若发现 en 的 value 与源码里的 i18nKey 不一致**（常见于 `<Trans>` 同时写了 `i18nKey` 和 children，抽取出的 value 用了错的 `<1>`/丢了占位符）：这是**源码 bug**，去修源码（用 `components` prop 让 i18nKey 成为唯一来源）并明确告知用户，别只改 JSON——否则下次抽取又会被打回。

## 步骤

1. 同步并列出待翻 key（抽取只创建空壳，后两步分别补 en 源文本、列出待翻）：

   ```bash
   pnpm run sync:error-i18n-keys && pnpm exec i18next   # 抽取源码里的 key，新 key 以空值出现在所有语言
   node script/i18n-glossary.mjs --fill-en              # 把 en 的空值填成 key 本身（否则英文 UI 渲染空白）
   node script/i18n-glossary.mjs --list-empty           # 列出待翻：<locale>\t<key>
   ```
   `--list-empty` 没有输出 = 没活儿，结束。

2. 先读术语表 `script/i18n-glossary.mjs`（`keepVerbatim` = 各语言都保留英文的词；`translateAs` = 分语言强制译法）。

3. 对每个待翻 `<locale, key>`：在 `src/renderer` 里 grep 该 key 看它怎么用（按钮/输入提示/错误信息…），根据上下文把源文本翻成该语言，写进对应 `translation.json`。要求：
   - 遵守术语表；
   - 逐字保留原文的 `{{占位符}}` 和 `<标签>`，不要增删。

4. 校验，修到通过：

   ```bash
   node script/i18n-glossary.mjs --check   # 有问题退出码 1，并列出哪个 key 哪里不对
   ```

5. 只格式化改动的语言文件（**别跑全仓库 `pnpm format`**，会动到无关文件）：

   ```bash
   pnpm exec biome format --write src/renderer/i18n/locales
   ```
   未经要求不要提交。

when you are done, keep the summary concise.