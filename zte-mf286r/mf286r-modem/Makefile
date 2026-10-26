include $(TOPDIR)/rules.mk

PKG_NAME:=mf286r-modem
PKG_VERSION:=1.0
PKG_RELEASE:=2
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=mf286r

include $(INCLUDE_DIR)/package.mk

define Package/mf286r-modem
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=WWAN
  TITLE:=ZTE MF286R internal LTE module (WAN, AT port arbitration, status)
  DEPENDS:=+comgt-ncm +luci-proto-ncm +kmod-usb-net-rndis +kmod-usb-acm
  PKGARCH:=all
endef

define Package/mf286r-modem/description
  Everything the MF286R's built-in LTE module needs that stock OpenWrt does not
  ship: a wan interface driven by the ncm protocol over /dev/ttyACM0 with the
  RNDIS data interface pinned, the removal of the DHCP client identifier the
  module's own DHCP server refuses to answer, and /usr/bin/modem-at, through which
  every consumer of the single AT control port takes turns.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/mf286r-modem/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/modem-info $(1)/usr/bin/modem-info
	$(INSTALL_BIN) ./files/usr/bin/modem-at    $(1)/usr/bin/modem-at
	$(INSTALL_BIN) ./files/usr/bin/modem-atlock $(1)/usr/bin/modem-atlock
	$(INSTALL_DIR) $(1)/usr/share/mf286r
	$(INSTALL_DATA) ./files/usr/share/mf286r/at-lock.inc $(1)/usr/share/mf286r/at-lock.inc
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/88-mf286r-port-labels $(1)/etc/uci-defaults/88-mf286r-port-labels
	$(INSTALL_BIN) ./files/etc/uci-defaults/89-mf286r-wan     $(1)/etc/uci-defaults/89-mf286r-wan
	$(INSTALL_BIN) ./files/etc/uci-defaults/90-mf286r-at-lock $(1)/etc/uci-defaults/90-mf286r-at-lock
endef

$(eval $(call BuildPackage,mf286r-modem))
