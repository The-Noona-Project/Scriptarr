from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REQUIREMENTS = ROOT / "requirements.txt"
VENV = ROOT / ".venv"
STAMP = VENV / ".requirements.stamp"


def _venv_python() -> Path:
    if sys.platform == "win32":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def ensure_packages(modules: list[str]) -> None:
    if not _venv_python().exists():
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)], cwd=ROOT)

    requirements_text = REQUIREMENTS.read_text(encoding="utf-8")
    needs_install = not STAMP.exists() or STAMP.read_text(encoding="utf-8") != requirements_text
    if not needs_install:
        for module in modules:
            probe = subprocess.run(
                [_venv_python(), "-c", f"import {module}"],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True
            )
            if probe.returncode != 0:
                needs_install = True
                break

    if needs_install:
        subprocess.check_call(
            [_venv_python(), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REQUIREMENTS)],
            cwd=ROOT
        )
        STAMP.write_text(requirements_text, encoding="utf-8")


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "start"

    if command == "start":
        ensure_packages(["fastapi", "httpx", "openai", "uvicorn"])
        subprocess.check_call([_venv_python(), "server.py"], cwd=ROOT)
        return 0

    if command == "test":
        ensure_packages(["fastapi", "httpx", "openai", "pytest", "uvicorn"])
        subprocess.check_call([_venv_python(), "-m", "pytest", "tests"], cwd=ROOT)
        return 0

    raise SystemExit(f"Unknown oracle runner command: {command}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
