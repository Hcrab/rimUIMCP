#!/usr/bin/env bash
set -euo pipefail

dotnet run --project Tests/RimUIMCP.LiveSmoke/RimUIMCP.LiveSmoke.csproj -- "$@"
