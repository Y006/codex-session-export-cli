#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Codex session HTML exporter wrapper."""

from __future__ import print_function

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


FULL_EXPORT_SCRIPT = "generate-codex-session-html.js"
CHAT_ONLY_EXPORT_SCRIPT = "generate-codex-session-html-only-chat.js"


HELP_TEXT = """Codex Session HTML 导出器

用法：
  python3 codex-session-export.py <session-id> -output <输出html路径>
  python3 codex-session-export.py <session-id> -chat_only -output <输出html路径>
  python3 codex-session-export.py -doctor
  python3 codex-session-export.py <session-id> -doctor
  python3 codex-session-export.py -help

参数：
  <session-id>     Codex session id，也可以直接传入 session jsonl 文件路径
  -output <path>   必填。输出 HTML 文件路径，文件名按这里指定
  -chat_only       可选。只导出用户和 Codex 最终回复，不导出工具、推理、上下文等内容
  -doctor          只检查 Python、Node.js、两个 JS 生成器、Codex session 目录是否可用
  -help            显示帮助

示例：
  python3 codex-session-export.py 019f275a-ef85-7472-8d64-ee7ff19f6d52 -output ./session.html
  python3 codex-session-export.py 019f275a-ef85-7472-8d64-ee7ff19f6d52 -chat_only -output ./share.html
  python3 codex-session-export.py -doctor
"""


class CliError(Exception):
    pass


def print_title(title):
    print("")
    print(title)
    print("=" * display_width(title))


def display_width(value):
    return max(8, len(str(value)))


def print_step(index, total, title):
    print("")
    print("[{}/{}] {}".format(index, total, title))


def print_kv(key, value):
    print("  {:<10}: {}".format(key, value))


def print_ok(message):
    print("  状态      : 通过 - {}".format(message))


def print_fail(message):
    print("  状态      : 失败 - {}".format(message))


def exit_error(message, code=1):
    print("")
    print("错误：{}".format(message), file=sys.stderr)
    print("")
    print("可运行以下命令查看帮助：", file=sys.stderr)
    print("  python3 codex-session-export.py -help", file=sys.stderr)
    return code


def parse_args(argv):
    options = {
        "session_id": None,
        "output": None,
        "chat_only": False,
        "doctor": False,
        "help": False,
    }

    if not argv:
        raise CliError("缺少参数。至少需要提供 session id 和 -output，或使用 -doctor / -help。")

    i = 0
    while i < len(argv):
        token = argv[i]

        if token in ("-help", "--help", "-h", "/?"):
            options["help"] = True
            i += 1
            continue

        if token == "-doctor":
            if options["doctor"]:
                raise CliError("重复提供了 -doctor。")
            options["doctor"] = True
            i += 1
            continue

        if token in ("-chat_only", "-chat-only"):
            if options["chat_only"]:
                raise CliError("重复提供了 -chat_only。")
            options["chat_only"] = True
            i += 1
            continue

        if token in ("-output", "--output"):
            if options["output"] is not None:
                raise CliError("重复提供了 -output。")
            if i + 1 >= len(argv):
                raise CliError("缺少 -output 后面的输出 HTML 路径。")
            next_value = argv[i + 1]
            if next_value.startswith("-"):
                raise CliError("缺少 -output 后面的输出 HTML 路径。")
            options["output"] = next_value
            i += 2
            continue

        if token.startswith("-"):
            raise CliError("无法识别的参数：{}".format(token))

        if options["session_id"] is not None:
            raise CliError("只支持输入一个 session id。多余的输入是：{}".format(token))
        options["session_id"] = token
        i += 1

    if options["help"]:
        return options

    if options["doctor"]:
        if options["output"] is not None:
            raise CliError("-doctor 只检查配置，不需要 -output。")
        if options["chat_only"]:
            raise CliError("-doctor 会同时检查两个 JS 生成器，不需要 -chat_only。")
        return options

    if options["session_id"] is None:
        raise CliError("缺少 session id。")
    if options["output"] is None:
        raise CliError("缺少必选参数：-output <输出html路径>。")

    return options


def script_dir():
    return Path(__file__).resolve().parent


def resolve_output_path(value):
    out = Path(value).expanduser()
    if not out.is_absolute():
        out = Path.cwd() / out
    return out.resolve()


def run_command(command, timeout=20):
    return subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
    )


def find_node():
    node = shutil.which("node")
    if not node:
        return None, None, "未找到 node 命令。请先安装 Node.js，并确认 node 在 PATH 中。"
    try:
        result = run_command([node, "--version"], timeout=10)
    except Exception as exc:
        return node, None, "执行 node --version 失败：{}".format(exc)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "node --version 返回非 0 状态").strip()
        return node, None, message
    return node, (result.stdout or "").strip(), None


def generator_paths(base_dir):
    return {
        "完整导出": base_dir / FULL_EXPORT_SCRIPT,
        "纯对话导出": base_dir / CHAT_ONLY_EXPORT_SCRIPT,
    }


def check_generators(base_dir):
    results = []
    for label, file_path in generator_paths(base_dir).items():
        exists = file_path.is_file()
        results.append((label, file_path, exists))
    return results


def codex_home_candidates():
    homes = []
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        homes.append(Path(env_home).expanduser())
    homes.append(Path.home() / ".codex")

    unique = []
    seen = set()
    for item in homes:
        try:
            resolved = item.resolve()
        except Exception:
            resolved = item
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def session_search_roots():
    roots = []
    for home in codex_home_candidates():
        roots.extend([
            home / "sessions",
            home / "archive",
        ])
    unique = []
    seen = set()
    for root in roots:
        try:
            resolved = root.resolve()
        except Exception:
            resolved = root
        key = str(resolved)
        if root.exists() and key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def fallback_codex_roots():
    roots = []
    for home in codex_home_candidates():
        if home.exists():
            roots.append(home)
    return roots


def find_session_file(session_id):
    direct = Path(session_id).expanduser()
    if direct.exists():
        if direct.is_file():
            return direct.resolve(), []
        raise CliError("输入路径存在，但不是文件：{}".format(direct))

    roots = session_search_roots()
    if not roots:
        raise CliError("没有找到 Codex session 目录。已检查：{}".format(
            "、".join(str(path) for path in [home / "sessions" for home in codex_home_candidates()])
        ))

    matches = search_jsonl_roots(roots, session_id)
    if not matches:
        matches = search_jsonl_roots(fallback_codex_roots(), session_id)

    if not matches:
        raise CliError("没有找到匹配的 session：{}".format(session_id))

    exact = [path for path in matches if path.stem.endswith(session_id) or path.name == session_id]
    if len(exact) == 1:
        return exact[0], matches
    if len(matches) == 1:
        return matches[0], matches

    listed = "\n".join("  - {}".format(path) for path in matches[:10])
    extra = "" if len(matches) <= 10 else "\n  ... 还有 {} 个匹配结果".format(len(matches) - 10)
    raise CliError("找到多个匹配的 session，请输入更完整的 session id：\n{}{}".format(listed, extra))


def search_jsonl_roots(roots, needle):
    matches = []
    seen = set()
    for root in roots:
        try:
            iterator = root.rglob("*.jsonl")
            for file_path in iterator:
                if needle in file_path.name:
                    resolved = file_path.resolve()
                    key = str(resolved)
                    if key not in seen:
                        seen.add(key)
                        matches.append(resolved)
        except PermissionError:
            continue
    return sorted(matches, key=lambda path: str(path))


def doctor(optional_session_id=None):
    print_title("Codex Session HTML 导出器 - doctor")
    total = 5 if optional_session_id else 4
    ok = True

    print_step(1, total, "检查 Python")
    print_kv("Python", sys.version.split()[0])
    print_kv("平台", "{} / {}".format(platform.system(), platform.machine()))
    if sys.version_info < (3, 7):
        print_fail("需要 Python 3.7 或更高版本")
        ok = False
    else:
        print_ok("Python 版本可用")

    print_step(2, total, "检查 Node.js")
    node, version, error = find_node()
    print_kv("Node 路径", node or "[未找到]")
    print_kv("Node 版本", version or "[未知]")
    if error:
        print_fail(error)
        ok = False
    else:
        print_ok("Node.js 可用")

    print_step(3, total, "检查 JS 生成器")
    base_dir = script_dir()
    print_kv("脚本目录", base_dir)
    generator_results = check_generators(base_dir)
    for label, file_path, exists in generator_results:
        print_kv(label, file_path)
        if not exists:
            print_fail("缺少 {}".format(file_path.name))
            ok = False
    if all(exists for _, _, exists in generator_results):
        print_ok("两个 JS 生成器都存在")
        if node:
            for label, file_path, _ in generator_results:
                result = run_command([node, "--check", str(file_path)], timeout=20)
                if result.returncode != 0:
                    print_fail("{} 语法检查失败：{}".format(label, (result.stderr or result.stdout).strip()))
                    ok = False

    print_step(4, total, "检查 Codex session 目录")
    roots = session_search_roots()
    if roots:
        for root in roots:
            print_kv("目录", root)
        print_ok("可搜索 session jsonl")
    else:
        print_fail("没有找到 ~/.codex/sessions 或 CODEX_HOME/sessions")
        ok = False

    if optional_session_id:
        print_step(5, total, "检查指定 session")
        print_kv("输入", optional_session_id)
        try:
            session_file, _ = find_session_file(optional_session_id)
            print_kv("匹配文件", session_file)
            print_ok("session 可找到")
        except CliError as exc:
            print_fail(str(exc))
            ok = False

    print("")
    if ok:
        print("doctor 结果：通过")
        return 0
    print("doctor 结果：未通过")
    return 1


def ensure_environment():
    base_dir = script_dir()
    missing = [str(path) for _, path, exists in check_generators(base_dir) if not exists]
    if missing:
        raise CliError("缺少 JS 生成器：\n{}".format("\n".join("  - " + item for item in missing)))

    node, version, error = find_node()
    if error:
        raise CliError(error)
    return base_dir, node, version


def export_session(options):
    print_title("Codex Session HTML 导出器")
    mode = "纯对话导出" if options["chat_only"] else "完整导出"
    output_path = resolve_output_path(options["output"])

    print_step(1, 4, "检查参数")
    print_kv("模式", mode)
    print_kv("Session", options["session_id"])
    print_kv("输出文件", output_path)

    print_step(2, 4, "查找 session")
    session_file, _ = find_session_file(options["session_id"])
    print_kv("匹配文件", session_file)
    print_ok("session 可读取")

    print_step(3, 4, "检查 Node.js 和生成器")
    base_dir, node, node_version = ensure_environment()
    print_kv("Node 路径", node)
    print_kv("Node 版本", node_version)
    print_kv("脚本目录", base_dir)
    print_ok("运行环境可用")

    print_step(4, 4, "生成 HTML")
    generator = base_dir / (CHAT_ONLY_EXPORT_SCRIPT if options["chat_only"] else FULL_EXPORT_SCRIPT)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print_kv("生成器", generator.name)
    command = [node, str(generator), str(session_file), str(output_path)]
    result = run_command(command, timeout=120)
    if result.stdout.strip():
        print_kv("stdout", result.stdout.strip())
    if result.returncode != 0:
        if result.stderr.strip():
            print_kv("stderr", result.stderr.strip())
        raise CliError("生成 HTML 失败，Node 进程退出码：{}".format(result.returncode))

    print_ok("HTML 已生成")
    print("")
    print("完成：")
    print("  {}".format(output_path))
    return 0


def main(argv):
    try:
        options = parse_args(argv)
        if options["help"]:
            print(HELP_TEXT)
            return 0
        if options["doctor"]:
            return doctor(options["session_id"])
        return export_session(options)
    except CliError as exc:
        return exit_error(str(exc))
    except KeyboardInterrupt:
        return exit_error("用户中断。", code=130)
    except Exception as exc:
        return exit_error("发生未预期错误：{}".format(exc))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
