#!/bin/sh
# Mihomo Lite 控制脚本 (bare-core controller)
# 用法: ctl.sh {update_sub [url]|apply_mixin|core_info|update_core [force]|rollback_core|update_ui|status|ports|tail_log|clear_log|rotate_logs}

CONFIG_DIR="/etc/mihomo"
RUN_YAML="$CONFIG_DIR/config.yaml"
SUB_YAML="$CONFIG_DIR/sub.yaml"
MIXIN_YAML="$CONFIG_DIR/mixin.yaml"
LOG_DIR="/var/log/mihomo"
CORE_LOG="$LOG_DIR/core.log"
SUB_LOG="$LOG_DIR/sub.log"

# --- 内核更新源（liuran001/mihomo = 带 smart + eBPF 的 mihomo 分支）---
# 该仓库只有一个「预发布滚动 release」，tag 固定 Prerelease-Alpha，每次 CI 覆盖上传
# mihomo-linux-arm64-alpha-smart-<sha>.gz；因此 GitHub 的 releases/latest 对它返回 404，
# 必须按 tag 取资产列表 —— 这就是之前"更新源只指向仓库、下不到东西"的根因。
CORE_REPO="liuran001/mihomo"
CORE_TAG="Prerelease-Alpha"
CORE_ASSET_RE='mihomo-linux-arm64-alpha-smart-[0-9a-f]{7,}\.gz'
CORE_ASSET_FALLBACK="mihomo-linux-arm64-alpha-smart-4a5de79.gz"
# 下载加速前缀（末尾空项 = 直连 GitHub），按顺序尝试
CORE_MIRRORS="https://gh-proxy.com/ https://ghfast.top/ "

# 目录/日志文件只在缺失时才创建（原来每次调用都 mkdir/touch，4 次 fork）
[ -d "$CONFIG_DIR" ] || mkdir -p "$CONFIG_DIR"
[ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR"
[ -f "$CORE_LOG" ] || : > "$CORE_LOG"
[ -f "$SUB_LOG" ] || : > "$SUB_LOG"

log_sub() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$SUB_LOG"
}

get_uci() { uci -q get mihomo.config."$1"; }
api_secret() { local s=$(get_uci api_secret); [ -z "$s" ] && s="zj88O465"; echo "$s"; }
api_port() { local p=$(get_uci api_port); [ -z "$p" ] && p="9090"; echo "$p"; }
# JSON 字符串转义：注意不要用 tr '\n' ' ' —— 那会给单行值尾部塞一个空格，
# 前端读取后原样回存就会把订阅链接写脏（尾部空格会让 curl 直接拒绝该 URL）。
json_escape() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'; }
trim() { sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr -d '\r\n'; }
current_core_ver() { /usr/bin/mihomo -v 2>/dev/null | head -n 1 | awk '{print $3}'; }

LOCK_FILE="/var/run/mihomo_sub.lock"

# ---------------- 配置合成 / 校验 / 热应用 ----------------

build_config() {
    local nodes="$1" out="$2"
    local mixin_en=$(get_uci mixin_enabled)
    [ -z "$mixin_en" ] && mixin_en="1"

    if [ "$mixin_en" = "1" ] && [ -f "$MIXIN_YAML" ]; then
        log_sub "Mixin enabled, merging mixin.yaml..."
        yq eval-all 'select(fileIndex == 0) * select(fileIndex == 1)' "$nodes" "$MIXIN_YAML" > "$out" 2>> "$SUB_LOG"
    else
        log_sub "Mixin disabled, using raw subscription"
        cp "$nodes" "$out"
    fi

    local sec=$(api_secret)
    local port=$(api_port)
    yq -i ".external-controller = \"[::]:$port\" | .secret = \"$sec\" | .external-ui = \"ui\"" "$out" 2>> "$SUB_LOG"
}

apply_config() {
    local cand="$1"

    # 1. 第一重：YAML 语法完整性极速校验
    if ! yq eval '.' "$cand" >/dev/null 2>&1; then
        log_sub "Error: Merged configuration is not valid YAML"
        echo '{"ok":false,"msg":"配置合并生成的 YAML 语法无效"}'
        return 1
    fi

    # 2. 第二重：隔离目录 mihomo -t 预检
    log_sub "Validating configuration with mihomo -t..."
    local test_dir="/tmp/mihomo_test_$$"
    mkdir -p "$test_dir"
    for item in "$CONFIG_DIR"/*; do
        case "$(basename "$item")" in
            *.db|*.yaml|*.bak) ;;
            *) ln -sf "$item" "$test_dir/" 2>/dev/null ;;
        esac
    done

    local test_ok=0
    if GOGC=50 /usr/bin/mihomo -t -d "$test_dir" -f "$cand" >> "$SUB_LOG" 2>&1; then
        test_ok=1
    else
        log_sub "Warning: mihomo -t returned non-zero (checking for possible runtime crash)..."
    fi
    rm -rf "$test_dir"

    local sec=$(api_secret)
    local port=$(api_port)
    local is_running=false
    if pgrep -f "/usr/bin/mihomo.*$CONFIG_DIR" >/dev/null 2>&1; then
        is_running=true
    fi

    if [ "$test_ok" = "1" ]; then
        log_sub "Configuration valid! Applying..."
        cp "$cand" "$RUN_YAML"
        if [ "$is_running" = "true" ]; then
            local rcode=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$port/configs?force=true" \
                -H "Authorization: Bearer $sec" \
                -H "Content-Type: application/json" \
                -d "{\"path\": \"$RUN_YAML\"}")
            log_sub "Hot reload finished, status code: $rcode"
            if [ "$rcode" != "204" ] && [ "$rcode" != "200" ]; then
                log_sub "Hot reload failed, restarting service instead"
                /etc/init.d/mihomo restart >/dev/null 2>&1
            fi
        else
            log_sub "Service not running, starting it..."
            /etc/init.d/mihomo start >/dev/null 2>&1
        fi
        return 0
    fi

    # 3. 第三重：如果 -t 偶发崩溃，当前正在运行则利用 API 原生原子热重载兜底
    if [ "$is_running" = "true" ]; then
        log_sub "Attempting atomic reload via running Mihomo API as fallback..."
        cp "$RUN_YAML" "$RUN_YAML.bak-safe" 2>/dev/null
        cp "$cand" "$RUN_YAML"
        local rcode=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$port/configs?force=true" \
            -H "Authorization: Bearer $sec" \
            -H "Content-Type: application/json" \
            -d "{\"path\": \"$RUN_YAML\"}")
        if [ "$rcode" = "204" ] || [ "$rcode" = "200" ]; then
            log_sub "Fallback reload successful, status code: $rcode!"
            rm -f "$RUN_YAML.bak-safe" 2>/dev/null
            return 0
        else
            log_sub "Fallback reload failed with HTTP $rcode, restoring backup..."
            cp "$RUN_YAML.bak-safe" "$RUN_YAML" 2>/dev/null
            rm -f "$RUN_YAML.bak-safe" 2>/dev/null
        fi
    fi

    log_sub "Error: Configuration test failed"
    echo '{"ok":false,"msg":"配置校验失败，请查看订阅日志"}'
    return 1
}

update_sub() {
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        echo '{"ok":false,"msg":"已有订阅更新或配置任务正在进行中，请稍候"}'
        return 1
    fi

    log_sub "Starting subscription update..."
    local url="$1"
    [ -z "$url" ] && url=$(get_uci sub_url)
    if [ -z "$url" ]; then
        log_sub "Error: sub_url not configured"
        echo '{"ok":false,"msg":"未配置订阅链接"}'
        return 1
    fi

    log_sub "Downloading from: $url"
    local tmp_sub="/tmp/mihomo_sub_$$.yaml"
    local tmp_merged="/tmp/mihomo_merged_$$.yaml"
    rm -f "$tmp_sub" "$tmp_merged"

    curl -s -L -m 40 -o "$tmp_sub" "$url"

    if [ ! -s "$tmp_sub" ]; then
        rm -f "$tmp_sub" "$tmp_merged"
        log_sub "Error: Subscription download failed or empty"
        echo '{"ok":false,"msg":"订阅下载失败或内容为空"}'
        return 1
    fi
    log_sub "Download successful, size: $(wc -c < "$tmp_sub") bytes"

    build_config "$tmp_sub" "$tmp_merged" || { rm -f "$tmp_sub" "$tmp_merged"; echo '{"ok":false,"msg":"配置合并失败"}'; return 1; }
    apply_config "$tmp_merged" || { rm -f "$tmp_sub" "$tmp_merged"; return 1; }

    cp "$tmp_sub" "$SUB_YAML"
    rm -f "$tmp_sub" "$tmp_merged"
    uci set mihomo.config.updated_at="$(date '+%Y-%m-%d_%H:%M:%S')"
    uci commit mihomo
    log_sub "Subscription updated successfully!"
    echo '{"ok":true,"msg":"订阅已更新并热应用"}'
    return 0
}

apply_mixin() {
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        echo '{"ok":false,"msg":"已有订阅更新或配置任务正在进行中，请稍候"}'
        return 1
    fi

    if [ ! -s "$SUB_YAML" ]; then
        echo '{"ok":false,"msg":"缺少 sub.yaml，请先更新订阅"}'
        return 1
    fi
    log_sub "Re-merging local sub.yaml + mixin.yaml (no download)..."
    local tmp_merged="/tmp/mihomo_merged_$$.yaml"
    build_config "$SUB_YAML" "$tmp_merged" || { rm -f "$tmp_merged"; echo '{"ok":false,"msg":"配置合并失败"}'; return 1; }
    apply_config "$tmp_merged" || { rm -f "$tmp_merged"; return 1; }
    rm -f "$tmp_merged"
    uci set mihomo.config.updated_at="$(date '+%Y-%m-%d_%H:%M:%S')"
    uci commit mihomo
    log_sub "Mixin applied successfully!"
    echo '{"ok":true,"msg":"覆写已合并并热应用"}'
    return 0
}

# ---------------- 内核更新 ----------------

# 解析当前可下载的 arm64 资产绝对地址
resolve_core_url() {
    local js url="" rel p

    # A) GitHub API：按固定 tag 取（该仓库只有预发布滚动 release，releases/latest 会 404）
    js=$(curl -s -m 25 -H 'User-Agent: mihomo-lite' \
         "https://api.github.com/repos/$CORE_REPO/releases/tags/$CORE_TAG")
    url=$(echo "$js" | grep -oE "https://github\.com/[^\"]*$CORE_ASSET_RE" | head -n 1)

    # B) 退一步：不限 tag，扫最近的 release 列表
    if [ -z "$url" ]; then
        js=$(curl -s -m 25 -H 'User-Agent: mihomo-lite' \
             "https://api.github.com/repos/$CORE_REPO/releases?per_page=10")
        url=$(echo "$js" | grep -oE "https://github\.com/[^\"]*$CORE_ASSET_RE" | head -n 1)
    fi

    # C) API 不可用（限流/被墙）时抓 expanded_assets HTML 片段
    if [ -z "$url" ]; then
        for p in $CORE_MIRRORS ""; do
            js=$(curl -sL -m 25 "${p}https://github.com/$CORE_REPO/releases/expanded_assets/$CORE_TAG")
            rel=$(echo "$js" | grep -oE "/$CORE_REPO/releases/download/[^\"]*$CORE_ASSET_RE" | head -n 1)
            if [ -n "$rel" ]; then
                url="https://github.com$rel"
                break
            fi
        done
    fi

    # D) 最后兜底：已知可用的资产名（sha 可能已过期，但路径形态正确）
    [ -z "$url" ] && url="https://github.com/$CORE_REPO/releases/download/$CORE_TAG/$CORE_ASSET_FALLBACK"

    echo "$url"
}

# 依次尝试镜像下载并校验 gzip 完整性
dl_with_mirror() {
    local url="$1" out="$2" p
    for p in $CORE_MIRRORS ""; do
        rm -f "$out"
        curl -sL -m 240 -o "$out" "${p}${url}"
        if [ -s "$out" ] && gzip -t "$out" 2>/dev/null; then
            log_sub "Core downloaded via '${p:-direct}' ($(wc -c < "$out") bytes)"
            return 0
        fi
        log_sub "Mirror '${p:-direct}' failed, trying next..."
    done
    return 1
}

core_info() {
    local cur=$(current_core_ver)
    [ -z "$cur" ] && cur="unknown"
    local url=$(resolve_core_url)
    local remote=$(echo "$url" | grep -oE 'alpha-smart-[0-9a-f]{7,}' | head -n 1)
    [ -z "$remote" ] && remote="unknown"
    local has=false
    [ "$remote" != "unknown" ] && [ "$remote" != "$cur" ] && has=true
    local bak=false; [ -f /usr/bin/mihomo.bak ] && bak=true
    echo "{\"repo\":\"$CORE_REPO\",\"tag\":\"$CORE_TAG\",\"current\":\"$cur\",\"remote\":\"$remote\",\"asset\":\"$(basename "$url")\",\"url\":\"$(echo "$url" | json_escape)\",\"has_update\":$has,\"core_backup\":$bak}"
}

update_core() {
    local force="$1"
    local cur=$(current_core_ver)
    [ -z "$cur" ] && cur="unknown"

    log_sub "Resolving latest core asset from $CORE_REPO (tag $CORE_TAG)..."
    local url=$(resolve_core_url)
    local remote=$(echo "$url" | grep -oE 'alpha-smart-[0-9a-f]{7,}' | head -n 1)
    log_sub "Resolved: $url"

    if [ "$force" != "force" ] && [ -n "$remote" ] && [ "$remote" = "$cur" ]; then
        echo "{\"ok\":true,\"updated\":false,\"current\":\"$cur\",\"remote\":\"$remote\",\"msg\":\"已是最新内核（$cur）\"}"
        return 0
    fi

    local tmp_gz="/tmp/mihomo_new.gz" tmp_bin="/tmp/mihomo_new"
    rm -f "$tmp_gz" "$tmp_bin"
    if ! dl_with_mirror "$url" "$tmp_gz"; then
        log_sub "Error: core download failed from all mirrors"
        echo "{\"ok\":false,\"msg\":\"内核下载失败（已尝试 gh-proxy / ghfast / 直连）\",\"url\":\"$(echo "$url" | json_escape)\"}"
        return 1
    fi

    gzip -d -f "$tmp_gz" >>"$SUB_LOG" 2>&1
    if [ ! -s "$tmp_bin" ]; then
        log_sub "Error: gunzip failed"
        echo '{"ok":false,"msg":"解压失败"}'
        return 1
    fi
    chmod +x "$tmp_bin"
    sync

    local test_ok=false
    for _i in 1 2; do
        if "$tmp_bin" -v >>"$SUB_LOG" 2>&1; then
            test_ok=true
            break
        fi
        sleep 1
        sync
    done

    if [ "$test_ok" != "true" ]; then
        log_sub "Error: downloaded binary is not runnable"
        rm -f "$tmp_bin"
        echo '{"ok":false,"msg":"下载的二进制无法运行，已放弃替换"}'
        return 1
    fi
    local newver=$("$tmp_bin" -v 2>/dev/null | head -n 1 | awk '{print $3}')

    cp /usr/bin/mihomo /usr/bin/mihomo.bak
    mv "$tmp_bin" /usr/bin/mihomo
    chmod +x /usr/bin/mihomo
    log_sub "Core updated: $cur -> $newver, restarting..."
    /etc/init.d/mihomo restart >/dev/null 2>&1
    echo "{\"ok\":true,\"updated\":true,\"from\":\"$cur\",\"to\":\"$newver\",\"msg\":\"内核已更新：$cur → $newver（旧版已备份，可回滚）\"}"
}

rollback_core() {
    if [ -f /usr/bin/mihomo.bak ]; then
        local old=$(/usr/bin/mihomo.bak -v 2>/dev/null | head -n 1 | awk '{print $3}')
        cp /usr/bin/mihomo.bak /usr/bin/mihomo
        chmod +x /usr/bin/mihomo
        /etc/init.d/mihomo restart >/dev/null 2>&1
        log_sub "Core rolled back to $old"
        echo "{\"ok\":true,\"msg\":\"已回滚到备份内核 $old\"}"
    else
        echo '{"ok":false,"msg":"没有备份内核可回滚"}'
    fi
}

update_ui() {
    log_sub "Updating Web Dashboard..."
    local path="Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"
    local tmp_zip="/tmp/ui.zip" p
    rm -f "$tmp_zip"
    for p in $CORE_MIRRORS ""; do
        curl -s -L -m 90 -o "$tmp_zip" "${p}https://github.com/$path"
        if [ -s "$tmp_zip" ] && unzip -t -q "$tmp_zip" >/dev/null 2>&1; then
            break
        fi
        rm -f "$tmp_zip"
    done
    if [ -s "$tmp_zip" ]; then
        mkdir -p "$CONFIG_DIR/ui"
        unzip -o -q "$tmp_zip" -d "$CONFIG_DIR/ui/" 2>>"$SUB_LOG"
        rm -f "$tmp_zip"
        log_sub "Web Dashboard updated successfully"
        echo '{"ok":true,"msg":"Web 面板已更新"}'
    else
        echo '{"ok":false,"msg":"Web 面板下载失败（已尝试全部镜像）"}'
    fi
}

# ---------------- 状态 / 端口 / 日志 ----------------

# ---------------- 状态 / 端口（性能敏感：会被前端每 10 秒轮询）----------------
#
# 开销优化：
#  1. 状态与端口一次算完，前端轮询只发一次 ubus exec（overview 命令）
#  2. 内核版本走 /tmp 缓存，指纹不变就不再 exec 那个 60MB 的 mihomo -v
#  3. 节点数走 /tmp 缓存，只在 config.yaml 变化时用 yq 重算（原来每轮询解析 172KB YAML）
#  4. UCI 只读一次 `uci show mihomo` 本地解析，不再 5 次 spawn uci
#  5. 端口探测只跑一次 netstat -lntu + 一次 awk
#  缓存都在 /tmp（tmpfs），不写 flash。

CACHE_DIR="/tmp/mihomo-lite"
ST_COMPUTED=""
ST_JSON=""
PT_JSON=""

file_sig() {
    [ -f "$1" ] || { echo ""; return 0; }
    if stat -c '%s-%Y' "$1" >/dev/null 2>&1; then
        stat -c '%s-%Y' "$1"
    else
        ls -l "$1" 2>/dev/null | awk '{print $5"-"$6"-"$7"-"$8}'
    fi
}

cache_dir_ready() { [ -d "$CACHE_DIR" ] || mkdir -p "$CACHE_DIR"; }

# 带指纹失效的小缓存：cached_value <名> <指纹> <计算命令...>
cached_value() {
    local name="$1" sig="$2"
    shift 2
    cache_dir_ready
    local cur=""
    [ -f "$CACHE_DIR/$name.sig" ] && cur=$(cat "$CACHE_DIR/$name.sig")
    if [ -n "$sig" ] && [ "$sig" = "$cur" ] && [ -f "$CACHE_DIR/$name" ]; then
        cat "$CACHE_DIR/$name"
        return 0
    fi
    local v
    v=$("$@" 2>/dev/null)
    printf '%s' "$v" > "$CACHE_DIR/$name"
    printf '%s' "$sig" > "$CACHE_DIR/$name.sig"
    printf '%s' "$v"
}

_compute_core_ver() { /usr/bin/mihomo -v 2>/dev/null | head -n 1 | awk '{print $3}'; }
_compute_proxies() {
    local n
    n=$(yq '.proxies | length' "$RUN_YAML" 2>/dev/null)
    case "$n" in ''|null) n=0 ;; esac
    echo "$n"
}

compute_state() {
    [ -n "$ST_COMPUTED" ] && return 0
    ST_COMPUTED=1

    # --- UCI：一次 uci show + 一次 awk 取出全部字段（原来 5 次 spawn uci）---
    # 注意：awk 程序用单引号包裹，程序内绝不能出现单引号字符（连注释里也不行），
    #       否则会截断 shell 的引号字符串导致程序被拆坏。
    local ud vals enabled mixin_en updated suburl port
    ud=$(uci -q show mihomo 2>/dev/null)
    vals=$(echo "$ud" | awk '
        /^mihomo\.config\./ {
            eq = index($0, "=")
            if (eq == 0) next
            k = substr($0, 15, eq - 15)
            v = substr($0, eq + 2, length($0) - eq - 2)
            if (k == "enabled") e = v
            else if (k == "mixin_enabled") m = v
            else if (k == "updated_at") u = v
            else if (k == "sub_url") s = v
            else if (k == "api_port") p = v
        }
        END { printf "%s\t%s\t%s\t%s\t%s\n", e, m, u, s, p }')
    IFS="$(printf '\t')" read -r enabled mixin_en updated suburl port <<EOF
$vals
EOF
    [ -z "$enabled" ] && enabled="0"
    [ -z "$mixin_en" ] && mixin_en="1"
    [ -z "$updated" ] && updated="none"
    [ -z "$port" ] && port="9090"

    # --- 进程 ---
    local pid=""
    pid=$(pgrep -f "/usr/bin/mihomo.*$CONFIG_DIR" 2>/dev/null | head -n 1)
    local running=false up=0 mem=0
    if [ -n "$pid" ]; then
        running=true
        mem=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null)
        [ -z "$mem" ] && mem=0
        local sysup pstart
        sysup=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
        pstart=$(awk '{print int($22/100)}' "/proc/$pid/stat" 2>/dev/null)
        if [ -n "$pstart" ] && [ -n "$sysup" ]; then up=$((sysup - pstart)); fi
    fi

    # --- 缓存值 ---
    local version pcount
    version=$(cached_value corever "$(file_sig /usr/bin/mihomo)" _compute_core_ver)
    [ -z "$version" ] && version="unknown"
    pcount=$(cached_value proxies "$(file_sig "$RUN_YAML")" _compute_proxies)
    [ -z "$pcount" ] && pcount=0

    local boot=false; [ -x /etc/rc.d/S95mihomo ] && boot=true
    local bak=false;  [ -f /usr/bin/mihomo.bak ] && bak=true

    ST_JSON="{\"running\":$running,\"pid\":\"$pid\",\"uptime\":$up,\"mem_kb\":$mem,\"version\":\"$version\",\"proxies_count\":$pcount,\"updated_at\":\"$updated\",\"enabled\":\"$enabled\",\"autostart\":$boot,\"mixin_enabled\":\"$mixin_en\",\"core_backup\":$bak,\"sub_url\":\"$(echo "$suburl" | json_escape)\"}"

    # --- 端口：一次 netstat + 一次 awk ---
    # 实测对比：busybox netstat -lntu ≈ 20-24ms，自己解析 /proc/net/* ≈ 31-32ms（busybox awk 逐行更慢），
    # 所以这里保留 netstat —— 别为了"看起来更底层"换成 procfs。
    local plist out p
    plist=" $(netstat -lntu 2>/dev/null | awk 'NR>2{ n=split($4,a,":"); if (a[n] != "") printf "%s ", a[n] }') "
    out=""
    for p in $port 8090 1080 7893 1053 8080 8081 36712; do
        [ -n "$out" ] && out="$out,"
        case "$plist" in
            *" $p "*) out="$out{\"port\":$p,\"listen\":true}" ;;
            *)        out="$out{\"port\":$p,\"listen\":false}" ;;
        esac
    done
    PT_JSON="{\"ports\":[$out]}"
}

status_json() { compute_state; echo "$ST_JSON"; }
overview_json() { compute_state; echo "{\"status\":$ST_JSON,\"ports\":$PT_JSON}"; }

# ---------------- UCI 写入（openwrt 侧提交，避免依赖 LuCI 前端的 uci 写接口）----------------

set_sub() {
    local url mixin
    url=$(echo "$1" | trim)
    mixin=$(echo "$2" | trim)
    if [ -z "$url" ]; then
        echo '{"ok":false,"msg":"订阅链接不能为空"}'
        return 1
    fi
    case "$url" in
        http://*|https://*|file:*) ;;
        *) echo '{"ok":false,"msg":"订阅链接必须是 http(s):// 开头"}'; return 1 ;;
    esac
    case "$mixin" in ""|0|1) ;; *) echo '{"ok":false,"msg":"mixin 取值不合法"}'; return 1 ;; esac

    uci set mihomo.config.sub_url="$url" || { echo '{"ok":false,"msg":"uci 写入失败"}'; return 1; }
    [ -n "$mixin" ] && uci set mihomo.config.mixin_enabled="$mixin"
    uci commit mihomo || { echo '{"ok":false,"msg":"uci 提交失败"}'; return 1; }
    log_sub "Subscription settings saved (mixin_enabled=${mixin:-unchanged})"
    echo '{"ok":true,"msg":"订阅设置已保存"}'
}

toggle_autostart() {
    local on=$(get_uci enabled)
    if [ "$on" = "1" ]; then
        uci set mihomo.config.enabled=0
        uci commit mihomo
        /etc/init.d/mihomo disable >/dev/null 2>&1
        echo '{"ok":true,"enabled":"0","msg":"已关闭开机自启"}'
    else
        uci set mihomo.config.enabled=1
        uci commit mihomo
        /etc/init.d/mihomo enable >/dev/null 2>&1
        echo '{"ok":true,"enabled":"1","msg":"已开启开机自启"}'
    fi
}

ports_json() { compute_state; echo "$PT_JSON"; }

tail_log() {
    local which="$1" n="$2"
    [ -z "$n" ] && n=200
    local f="$CORE_LOG"
    [ "$which" = "sub" ] && f="$SUB_LOG"
    [ -f "$f" ] || { echo ""; return 0; }
    tail -n "$n" "$f"
}

clear_log() {
    case "$1" in
        sub) : > "$SUB_LOG" ;;
        core) : > "$CORE_LOG" ;;
        *) : > "$CORE_LOG"; : > "$SUB_LOG" ;;
    esac
    echo '{"ok":true,"msg":"日志已清空"}'
}

# 日志轮转：单文件超过 9MB 才清（对齐原 Nikki 的 scheduled_clear_size_limit=9MB）
rotate_logs() {
    local lim=$((9 * 1024 * 1024)) f sz
    for f in "$CORE_LOG" "$SUB_LOG"; do
        [ -f "$f" ] || continue
        sz=$(wc -c < "$f")
        if [ "$sz" -gt "$lim" ]; then
            : > "$f"
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] rotated: $f was ${sz} bytes" >> "$CORE_LOG"
        fi
    done
    echo '{"ok":true,"msg":"日志轮转完成"}'
}

update_rules() {
    local target="$1"
    local sec=$(api_secret)
    local port=$(api_port)

    if ! pgrep -f "/usr/bin/mihomo.*$CONFIG_DIR" >/dev/null 2>&1; then
        echo '{"ok":false,"msg":"Mihomo 服务未运行，无法更新规则"}'
        return 1
    fi

    if [ -n "$target" ]; then
        log_sub "Updating single rule-provider: $target..."
        local code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$port/providers/rules/$target" \
            -H "Authorization: Bearer $sec")
        if [ "$code" = "204" ] || [ "$code" = "200" ]; then
            log_sub "Rule provider $target updated successfully"
            echo "{\"ok\":true,\"msg\":\"规则集 $target 更新成功\"}"
            return 0
        else
            log_sub "Failed to update rule provider $target (HTTP $code)"
            echo "{\"ok\":false,\"msg\":\"规则集 $target 更新失败 (HTTP $code)\"}"
            return 1
        fi
    fi

    log_sub "Starting batch update for all rule providers..."
    local list=$(curl -s -H "Authorization: Bearer $sec" "http://127.0.0.1:$port/providers/rules" | \
        awk -F'"name":' '{for(i=2;i<=NF;i++){split($i,a,"\""); if(a[2]!="") print a[2]}}')

    if [ -z "$list" ]; then
        log_sub "No rule providers found from API"
        echo '{"ok":false,"msg":"未找到已加载的规则集"}'
        return 1
    fi

    local succ=0 fail=0
    for name in $list; do
        local code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$port/providers/rules/$name" \
            -H "Authorization: Bearer $sec")
        if [ "$code" = "204" ] || [ "$code" = "200" ]; then
            succ=$((succ + 1))
        else
            fail=$((fail + 1))
            log_sub "Provider $name update failed (HTTP $code)"
        fi
    done

    log_sub "Rule providers updated: $succ success, $fail failed"
    echo "{\"ok\":true,\"msg\":\"规则更新完成：$succ 个成功，$fail 个失败\"}"
    return 0
}

case "$1" in
    update_sub) update_sub "$2" ;;
    update_rules) update_rules "$2" ;;
    apply_mixin) apply_mixin ;;
    set_sub) set_sub "$2" "$3" ;;
    toggle_autostart) toggle_autostart ;;
    core_info) core_info ;;
    update_core) update_core "$2" ;;
    rollback_core) rollback_core ;;
    update_ui) update_ui ;;
    status) status_json ;;
    ports) ports_json ;;
    overview) overview_json ;;
    tail_log) tail_log "$2" "$3" ;;
    clear_log) clear_log "$2" ;;
    rotate_logs) rotate_logs ;;
    *)
        echo "Usage: $0 {update_sub [url]|update_rules [name]|apply_mixin|set_sub <url> <0|1>|toggle_autostart|core_info|update_core [force]|rollback_core|update_ui|status|overview|ports|tail_log core|sub [lines]|clear_log all|core|sub|rotate_logs}"
        ;;
esac
