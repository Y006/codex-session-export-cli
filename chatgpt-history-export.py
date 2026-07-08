#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ChatGPT data export package HTML wrapper."""

from __future__ import print_function

import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path


GENERATOR_SCRIPT = "generate-chatgpt-history-html.js"


HELP_TEXT = """ChatGPT 历史对话 HTML 导出器

用法：
  python3 chatgpt-history-export.py <ChatGPT导出文件夹路径> -output <输出html路径>
  python3 chatgpt-history-export.py <ChatGPT导出文件夹路径> -doctor
  python3 chatgpt-history-export.py -doctor
  python3 chatgpt-history-export.py -help

参数：
  <ChatGPT导出文件夹路径>  包含 conversations-*.json 的 ChatGPT 数据导出目录
  -output <path>          必填。输出 HTML 文件路径
  -doctor                 只检查 Python、Node.js、JS 生成器，以及可选目录结构
  -help                   显示帮助

示例：
  python3 chatgpt-history-export.py ~/Downloads/chatgpt-export -output ~/Desktop/chatgpt-history.html
"""


class CliError(Exception):
    pass


def print_title(title):
    print("")
    print(title)
    print("=" * max(8, len(title)))


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
    print("  python3 chatgpt-history-export.py -help", file=sys.stderr)
    return code


def parse_args(argv):
    options = {
        "input_dir": None,
        "output": None,
        "doctor": False,
        "help": False,
    }
    if not argv:
        raise CliError("缺少参数。至少需要提供 ChatGPT 导出文件夹路径和 -output，或使用 -doctor / -help。")

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
        if token in ("-output", "--output"):
            if options["output"] is not None:
                raise CliError("重复提供了 -output。")
            if i + 1 >= len(argv) or argv[i + 1].startswith("-"):
                raise CliError("缺少 -output 后面的输出 HTML 路径。")
            options["output"] = argv[i + 1]
            i += 2
            continue
        if token.startswith("-"):
            raise CliError("无法识别的参数：{}".format(token))
        if options["input_dir"] is not None:
            raise CliError("只支持输入一个 ChatGPT 导出文件夹路径。多余的输入是：{}".format(token))
        options["input_dir"] = token
        i += 1

    if options["help"]:
        return options
    if options["doctor"]:
        if options["output"] is not None:
            raise CliError("-doctor 只检查配置，不需要 -output。")
        return options
    if options["input_dir"] is None:
        raise CliError("缺少 ChatGPT 导出文件夹路径。")
    if options["output"] is None:
        raise CliError("缺少必选参数：-output <输出html路径>。")
    return options


def script_dir():
    return Path(__file__).resolve().parent


def resolve_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


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
        return node, None, (result.stderr or result.stdout or "node --version 返回非 0 状态").strip()
    return node, (result.stdout or "").strip(), None


def generator_path():
    return script_dir() / GENERATOR_SCRIPT


def conversation_files(directory):
    pattern = re.compile(r"^conversations-\d+\.json$")
    return sorted(path for path in directory.iterdir() if path.is_file() and pattern.match(path.name))


def validate_input_dir(input_dir):
    if input_dir is None:
        return None
    directory = resolve_path(input_dir)
    if not directory.exists():
        raise CliError("ChatGPT 导出文件夹不存在：{}".format(directory))
    if not directory.is_dir():
        raise CliError("输入路径存在，但不是文件夹：{}".format(directory))
    files = conversation_files(directory)
    if not files:
        raise CliError("导出文件夹缺少 conversations-*.json：{}".format(directory))
    return directory


def doctor(input_dir=None):
    total = 4 if input_dir else 3
    ok = True
    print_title("ChatGPT 历史对话 HTML 导出器 - doctor")

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
    js_path = generator_path()
    print_kv("生成器", js_path)
    if not js_path.is_file():
        print_fail("缺少 {}".format(GENERATOR_SCRIPT))
        ok = False
    else:
        print_ok("JS 生成器存在")
        if node:
            result = run_command([node, "--check", str(js_path)], timeout=20)
            if result.returncode != 0:
                print_fail("JS 语法检查失败：{}".format((result.stderr or result.stdout).strip()))
                ok = False

    if input_dir:
        print_step(4, total, "检查 ChatGPT 导出文件夹")
        print_kv("输入", input_dir)
        try:
            directory = validate_input_dir(input_dir)
            files = conversation_files(directory)
            print_kv("目录", directory)
            print_kv("会话文件", "{} 个".format(len(files)))
            print_ok("conversations-*.json 可读取")
        except CliError as exc:
            print_fail(str(exc))
            ok = False

    print("")
    print("doctor 结果：{}".format("通过" if ok else "未通过"))
    return 0 if ok else 1


def export_history(options):
    print_title("ChatGPT 历史对话 HTML 导出器")
    input_dir = validate_input_dir(options["input_dir"])
    output_path = resolve_path(options["output"])

    print_step(1, 4, "检查参数")
    print_kv("输入目录", input_dir)
    print_kv("输出文件", output_path)

    print_step(2, 4, "检查 Node.js 和生成器")
    node, version, error = find_node()
    if error:
        raise CliError(error)
    js_path = generator_path()
    if not js_path.is_file():
        raise CliError("缺少 JS 生成器：{}".format(js_path))
    print_kv("Node 路径", node)
    print_kv("Node 版本", version)
    print_kv("生成器", js_path)
    print_ok("运行环境可用")

    print_step(3, 4, "检查导出数据")
    files = conversation_files(input_dir)
    print_kv("会话文件", "{} 个".format(len(files)))
    print_kv("附件索引", input_dir / "conversation_asset_file_names.json" if (input_dir / "conversation_asset_file_names.json").exists() else "[未找到，可跳过]")
    print_kv("文件库", input_dir / "library_files.json" if (input_dir / "library_files.json").exists() else "[未找到，可跳过]")
    print_ok("输入结构可用")

    print_step(4, 4, "生成 HTML")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = run_command([node, str(js_path), str(input_dir), str(output_path)], timeout=300)
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
            return doctor(options["input_dir"])
        return export_history(options)
    except CliError as exc:
        return exit_error(str(exc))
    except KeyboardInterrupt:
        return exit_error("用户中断。", code=130)
    except Exception as exc:
        return exit_error("发生未预期错误：{}".format(exc))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
