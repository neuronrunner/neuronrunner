#!/usr/bin/env python3
"""
File Tools Dispatcher for Workspace Sandbox.

This script is invoked inside the sandbox container by SandboxSessionManager.
It reads the tool name and arguments from command line, executes the tool,
and prints the JSON result to stdout.
"""
from __future__ import annotations

import json
import sys
import traceback

# Add workspace to path
sys.path.insert(0, "/workspace")

# Import the file tools
from sandbox.services.file_tools import dispatch_file_tool


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python dispatcher.py <tool_name> <args_json>"}), file=sys.stderr)
        sys.exit(1)

    tool_name = sys.argv[1]
    args_json = sys.argv[2]

    try:
        arguments = json.loads(args_json)
    except json.JSONDecodeError as e:
        result = {"error": f"Invalid JSON arguments: {e}"}
        print(json.dumps(result))
        sys.exit(1)

    try:
        result = dispatch_file_tool(tool_name, arguments)
    except Exception as e:
        result = {"error": f"Dispatcher error: {str(e)}", "traceback": traceback.format_exc()}

    # Write result to stdout
    print(json.dumps(result))


if __name__ == "__main__":
    main()
