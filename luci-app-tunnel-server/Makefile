include $(TOPDIR)/rules.mk

LUCI_TITLE:=Tunnel > Server: one xray process with VLESS + REALITY (TCP + XTLS-Vision, XHTTP) and Hysteria2
LUCI_DEPENDS:=+xray-core +openssl-util +luci-lib-uqr +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-tunnel-server/conffiles
/etc/config/tunnel-server
endef

define Package/luci-app-tunnel-server/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel-server/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel-server/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
