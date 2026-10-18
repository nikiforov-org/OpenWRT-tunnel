include $(TOPDIR)/rules.mk

LUCI_TITLE:=Domains (DDNS), Let's Encrypt certificates and a web site served by the router
LUCI_DEPENDS:=+uhttpd +ddns-scripts +ddns-scripts-services +ddns-scripts-beget +ddns-scripts-cloudflare +acme-acmesh +acme-acmesh-dnsapi +openssl-util +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +ucode-mod-math +ucode-mod-log
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Evgenii Nikiforov
LUCI_URL:=https://github.com/nikiforov-org/OpenWRT-tunnel

PKG_VERSION:=1.0.0
PKG_RELEASE:=2

define Package/luci-app-tunnel_ddns/conffiles
/etc/config/tunnel_ddns
endef

define Package/luci-app-tunnel_ddns/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-tunnel_ddns/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /usr/libexec/tunnel_ddns/sync revert >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
