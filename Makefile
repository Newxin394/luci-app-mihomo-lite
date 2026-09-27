include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mihomo-lite
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Newxin394
PKG_LICENSE:=GPL-3.0-only

LUCI_TITLE:=LuCI support for Mihomo Lite (Bare-core)
LUCI_DEPENDS:=+curl +gzip +ca-certificates
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
