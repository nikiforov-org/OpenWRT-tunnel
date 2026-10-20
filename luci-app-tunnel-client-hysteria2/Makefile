include $(TOPDIR)/rules.mk

LUCI_TITLE:=Hysteria2 client links for the Tunnel > Clients page
LUCI_DEPENDS:=+luci-app-tunnel-clients +ucode-mod-fs +ucode-mod-uci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-tunnel-client-hysteria2/conffiles
/etc/config/tunnel-client-hysteria2
endef

define Package/luci-app-tunnel-client-hysteria2/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel-client-hysteria2/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel-client-hysteria2/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
