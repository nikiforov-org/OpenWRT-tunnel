include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-sms
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=mf286r

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-sms
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Modem SMS and USSD (LuCI)
  DEPENDS:=+luci-base +rpcd-mod-file +sms-tool +mf286r-modem +curl
  PKGARCH:=all
endef

define Package/luci-app-sms/description
  Web interface (LuCI) for the cellular modem's messaging: read stored messages,
  send a message, and run USSD service sessions (balance and package queries).
  There is no ModemManager on this device — the module has no QMI or MBIM port —
  so everything runs over AT on the single control port, through sms_tool and the
  shared lock that keeps it from colliding with netifd's dialling.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-sms/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/smsctl $(1)/usr/bin/smsctl
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/smsd $(1)/etc/init.d/smsd
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/sms $(1)/etc/config/sms
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/sms
	$(INSTALL_DATA) ./files/www/view/main.js $(1)/www/luci-static/resources/view/sms/main.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/luci/menu.d/luci-app-sms.json $(1)/usr/share/luci/menu.d/luci-app-sms.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/luci/acl.d/luci-app-sms.json  $(1)/usr/share/rpcd/acl.d/luci-app-sms.json
endef

$(eval $(call BuildPackage,luci-app-sms))
