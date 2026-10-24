include $(TOPDIR)/rules.mk

LUCI_TITLE:=XTunnel: dynamic DNS, Let's Encrypt certificates and a web site, an xray server (VLESS + REALITY, Hysteria2) with a Tor onion service, and the LAN through tunnel clients
LUCI_DEPENDS:=+uhttpd +uacme +uclient-fetch +xtunnel-core +kmod-nft-tproxy +kmod-nft-socket +curl +jsonfilter +luci-lib-uqr +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +ucode-mod-math +ucode-mod-log
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-xtunnel/conffiles
/etc/config/xtunnel-ddns
/etc/config/xtunnel-server
/etc/config/xtunnel-client
endef

define Package/luci-app-xtunnel/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-xtunnel/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/usr/libexec/xtunnel-client/sync revert >/dev/null 2>&1
	/usr/libexec/xtunnel-server/sync revert >/dev/null 2>&1
	/usr/libexec/xtunnel/xray-service stop /etc/xtunnel-client/config.json >/dev/null 2>&1
	/usr/libexec/xtunnel/xray-service stop /etc/xtunnel-server/config.json >/dev/null 2>&1
	/usr/libexec/xtunnel-tor/sync revert >/dev/null 2>&1
	/usr/libexec/xtunnel-ddns/sync revert >/dev/null 2>&1
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
