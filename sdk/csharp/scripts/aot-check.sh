#!/usr/bin/env bash
# NativeAOT / trimming compatibility check of Tcapi.Sdk.
#
# Publishes the minimal consumer scripts/Tcapi.Sdk.AotSmoke (PublishAot, zero
# warnings required: TreatWarningsAsErrors + AOT/trim/single-file analyzers)
# and runs the result where it can run.
#
#   scripts/aot-check.sh [linux-x64] [linux-arm64] [win-x64] [osx-arm64] ...
#
# Without arguments it checks the host RID. NativeAOT cannot cross-compile
# between operating systems, so:
#   * <host RID>   native AOT publish + run
#   * linux-arm64  from linux-x64: needs clang, lld, gcc-aarch64-linux-gnu,
#                  libc6-dev-arm64-cross, libstdc++-13-dev-arm64-cross and an
#                  arm64 libz in the sysroot (see SYSROOT below); the binary is
#                  run under qemu-aarch64 when that is installed
#                  Sysroot recipe (Debian/Ubuntu x64): install the packages above,
#                  then make $TCAPI_ARM64_SYSROOT (default /tmp/sysroot-arm64)
#                  with symlinks usr/aarch64-linux-gnu -> /usr/aarch64-linux-gnu,
#                  usr/lib and lib -> /usr/aarch64-linux-gnu/lib, usr/include ->
#                  /usr/aarch64-linux-gnu/include, and put the arm64 libz.so.1
#                  (zlib1g_*_arm64.deb) and a libz.so link into
#                  /usr/aarch64-linux-gnu/lib.
#   * any other OS RID: trimmed self-contained publish (ILLink, every warning
#                  shown, none allowed) instead of a native one; not run.
#
# Build products go to $TCAPI_AOT_WORK (default: a temp directory), never into
# the source tree.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
project="$here/Tcapi.Sdk.AotSmoke/Tcapi.Sdk.AotSmoke.csproj"
work="${TCAPI_AOT_WORK:-${TMPDIR:-/tmp}/tcapi-aot-check}"
sysroot="${TCAPI_ARM64_SYSROOT:-/tmp/sysroot-arm64}"

host_rid() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=osx ;; *) os=win ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
  echo "$os-$arch"
}

host="$(host_rid)"
rids=("$@")
[ ${#rids[@]} -gt 0 ] || rids=("$host")

for rid in "${rids[@]}"; do
  out="$work/$rid/out"
  rm -rf "$work/$rid"
  common=(-r "$rid" -c Release -o "$out" "-p:TcapiAotWork=$work/$rid")
  if [ "$rid" = "$host" ]; then
    echo "== $rid: NativeAOT publish"
    dotnet publish "$project" "${common[@]}"
    "$out/Tcapi.Sdk.AotSmoke"
  elif [ "$rid" = "linux-arm64" ] && [ "$host" = "linux-x64" ]; then
    echo "== $rid: NativeAOT cross publish (sysroot $sysroot)"
    dotnet publish "$project" "${common[@]}" \
      -p:CppCompilerAndLinker=clang "-p:SysRoot=$sysroot" -p:LinkerFlavor=lld \
      -p:ObjCopyName=aarch64-linux-gnu-objcopy
    if command -v qemu-aarch64 >/dev/null; then
      qemu-aarch64 -L /usr/aarch64-linux-gnu "$out/Tcapi.Sdk.AotSmoke"
    else
      echo "(qemu-aarch64 not installed: built, not run)"
    fi
  else
    echo "== $rid: trimmed self-contained publish (no cross-OS NativeAOT)"
    dotnet publish "$project" "${common[@]}" \
      -p:PublishAot=false -p:PublishTrimmed=true -p:SelfContained=true \
      -p:TrimmerSingleWarn=false
  fi
done
echo "aot-check: OK (${rids[*]})"
