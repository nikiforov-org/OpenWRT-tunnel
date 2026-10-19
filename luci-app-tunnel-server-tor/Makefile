include $(TOPDIR)/rules.mk

LUCI_TITLE:=Tor onion service: reach this router through the Tor network, with per-client authorization
LUCI_DEPENDS:=+tor +obfs4proxy +snowflake-client +curl +openssl-util +luci-lib-uqr +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

define Package/luci-app-tunnel-server-tor/conffiles
/etc/config/tunnel-server-tor
endef

define Package/luci-app-tunnel-server-tor/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel-server-tor/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel-server-tor/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
