#!/usr/bin/env bash

set -Eeuo pipefail

readonly repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${VIRTUAL_ENV:-}" && -x "${VIRTUAL_ENV}/bin/python" ]]; then
    python_bin="${VIRTUAL_ENV}/bin/python"
elif [[ -x "${repo_dir}/.venv/bin/python" ]]; then
    python_bin="${repo_dir}/.venv/bin/python"
elif [[ -x "${repo_dir}/venv/bin/python" ]]; then
    python_bin="${repo_dir}/venv/bin/python"
else
    echo "Python virtual environment not found." >&2
    echo "Create one with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi
readonly python_bin

if [[ -f "${repo_dir}/.env" && "${EASISTENT_DOTENV_LOADED:-}" != "1" ]]; then
    exec "${python_bin}" -m dotenv -f "${repo_dir}/.env" run --no-override -- \
        env EASISTENT_DOTENV_LOADED=1 "${repo_dir}/dev.sh"
fi

export SCHOOL_CATALOG_PATH="${SCHOOL_CATALOG_PATH:-${repo_dir}/.data/schools.json}"
readonly dev_host="${HOST:-127.0.0.1}"
readonly dev_port="${PORT:-8080}"

cd "${repo_dir}"
exec "${python_bin}" -m uvicorn web:app --reload --host "${dev_host}" --port "${dev_port}"
