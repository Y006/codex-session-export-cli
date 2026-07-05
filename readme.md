# Codex Session HTML 导出器

这个文件夹提供一个跨平台的 Python 命令行包装器，用来根据 Codex session id 导出 HTML。

目录内文件：

- `codex-session-export.py`：命令行入口。
- `generate-codex-session-html.js`：完整导出生成器。
- `generate-codex-session-html-only-chat.js`：纯对话导出生成器。

## 运行前提

需要本机已经安装：

- Python 3.7 或更高版本。
- Node.js，并且 `node` 命令在 `PATH` 中可用。
- Codex session 文件位于 `~/.codex/sessions`，或通过环境变量 `CODEX_HOME` 指向 Codex 目录。

可以先运行：

```bash
python3 codex-session-export.py -doctor
```

Windows 可以使用：

```powershell
py codex-session-export.py -doctor
```

## 命令格式

完整导出：

```bash
python3 codex-session-export.py <session-id> -output <输出html路径>
```

纯对话导出：

```bash
python3 codex-session-export.py <session-id> -chat_only -output <输出html路径>
```

查看帮助：

```bash
python3 codex-session-export.py -help
```

只检查配置：

```bash
python3 codex-session-export.py -doctor
```

检查配置并确认某个 session 能找到：

```bash
python3 codex-session-export.py <session-id> -doctor
```

## 示例

完整导出：

```bash
python3 codex-session-export.py 019f275a-ef85-7472-8d64-ee7ff19f6d52 -output ./session-full.html
```

纯对话导出，适合分享：

```bash
python3 codex-session-export.py 019f275a-ef85-7472-8d64-ee7ff19f6d52 -chat_only -output ./session-chat-only.html
```

也可以直接传入 session jsonl 文件路径：

```bash
python3 codex-session-export.py ~/.codex/sessions/2026/07/03/rollout-xxx.jsonl -output ./session.html
```

## 导出模式区别

完整导出会调用：

```text
generate-codex-session-html.js
```

它会保留更完整的 session 内容，适合自己审计和回看。

纯对话导出会调用：

```text
generate-codex-session-html-only-chat.js
```

它只导出用户消息和 Codex 最终回复，不导出工具调用、推理摘要、上下文、工作目录、原始 JSONL 记录等内容，更适合分享给别人。

## session 查找规则

如果输入的是一个真实存在的文件路径，脚本会直接使用这个文件。

如果输入的是 session id，脚本会搜索：

- `$CODEX_HOME/sessions`
- `$CODEX_HOME/archive`
- `~/.codex/sessions`
- `~/.codex/archive`

如果找到多个匹配结果，脚本会用中文列出候选文件，并要求输入更完整的 session id。

## 常见错误

缺少 session id：

```text
错误：缺少 session id。
```

缺少输出路径：

```text
错误：缺少必选参数：-output <输出html路径>。
```

`-output` 后面没有路径：

```text
错误：缺少 -output 后面的输出 HTML 路径。
```

找不到 Node.js：

```text
错误：未找到 node 命令。请先安装 Node.js，并确认 node 在 PATH 中。
```

找不到生成器：

```text
错误：缺少 JS 生成器：
  - /path/to/generate-codex-session-html.js
```

## 跨平台说明

macOS / Linux：

```bash
python3 codex-session-export.py <session-id> -output ./out.html
```

Windows：

```powershell
py codex-session-export.py <session-id> -output .\out.html
```

脚本内部使用 Python 标准库处理路径和子进程，不依赖 Bash、Make、find 等 Unix 专用命令。
