include $(TOPDIR)/rules.mk

LUCI_TITLE:=Tunnel > Clients: the LAN reaches the Internet through tunnel clients (one xray process), split by lists, with a kill switch and speed-based selection
LUCI_DEPENDS:=+xray-core +kmod-nft-tproxy +kmod-nft-socket +curl +jsonfilter +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-tunnel-clients/conffiles
/etc/config/tunnel-clients
endef

define Package/luci-app-tunnel-clients/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel-clients/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel-clients/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
