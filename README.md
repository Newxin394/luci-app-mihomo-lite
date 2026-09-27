# luci-app-mihomo-lite

**Mihomo Lite (极简裸核代理)** 的 LuCI 管理面板与服务控制套件。

适用于 ImmortalWRT / OpenWrt 21.02+ / 23.05+，采用现代 LuCI JavaScript 架构。

## 特性亮点

- **极简极速**：剥离冗余依赖，基于原生裸核 + 覆写配置运行。
- **透明代理与入站**：支持 eBPF / TC 透明代理 + DoH DNS + 显式代理入站。
- **在线内核热更新**：支持在线检测并一键更新官方/预发布内核（带预检与旧核自动回滚防护）。
- **规则集热刷新**：支持独立一键刷新全部规则集（Rule Provider）。
- **面板集成**：集成 Web 控制台面板在线检测与更新（Zashboard 等）。

## 目录结构

```
luci-app-mihomo-lite/
├── Makefile
├── htdocs/
│   └── luci-static/
│       └── resources/
│           └── view/
│               └── mihomo-lite/
│                   └── main.js             # 现代 LuCI JS 前端视图
├── root/
│   ├── etc/
│   │   ├── config/
│   │   │   └── mihomo                      # UCI 默认配置
│   │   ├── init.d/
│   │   │   └── mihomo                      # procd 守护服务脚本
│   │   └── mihomo/
│   │       └── mixin.yaml                  # 基础覆写规则模版
│   └── usr/
│       └── share/
│           ├── luci/
│           │   └── menu.d/
│           │       └── luci-app-mihomo-lite.json   # 菜单注册定义
│           ├── mihomo/
│           │   └── ctl.sh                  # 核心运维/RPC 控制后端
│           └── rpcd/
│               └── acl.d/
│                   └── luci-app-mihomo-lite.json   # ubus/rpcd 权限定义
└── README.md
```

## 编译与安装

### 作为 OpenWrt 源码包编译
将源码克隆至 OpenWrt / ImmortalWRT 源码树的 `package/` 目录下：
```bash
git clone https://github.com/Newxin394/luci-app-mihomo-lite.git package/luci-app-mihomo-lite
make menuconfig
# 在 LuCI -> 3. Applications 中勾选 luci-app-mihomo-lite
make package/luci-app-mihomo-lite/compile V=s
```

## 许可证
GPL-3.0
