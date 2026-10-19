include $(TOPDIR)/rules.mk

LUCI_TITLE:=Xray server: VLESS + REALITY over TCP (XTLS-Vision) and XHTTP
LUCI_DEPENDS:=+xray-core +luci-lib-uqr +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-tunnel-server-xray/conffiles
/etc/config/tunnel_server-xray
endef

define Package/luci-app-tunnel-server-xray/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel-server-xray/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel_server-xray/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
