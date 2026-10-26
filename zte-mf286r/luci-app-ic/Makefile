include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ic
PKG_VERSION:=1.0
PKG_RELEASE:=3
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=mf286r

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-ic
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Cellular Network status (LuCI)
  DEPENDS:=+luci-base +rpcd-mod-file +mf286r-modem
  PKGARCH:=all
endef

define Package/luci-app-ic/description
  Status -> Cellular Network: the same page a ModemManager device shows, but
  driven over AT. It ships the upstream luci-proto-modemmanager status view and
  feeds it from /usr/bin/modem-info through an adapter, so the rendered page
  (Modem Info / Network Registration / Cell Location / SIMs) matches the
  reference build; the only change is the per-modem tab bar, dropped because
  there is one modem and no sysfs path to name a tab with. No IMEI-change page
  — the module locks that write, and it is intentionally absent.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-ic/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/modemmanager
	$(INSTALL_DATA) ./files/www/view/modemmanager/status.js $(1)/www/luci-static/resources/view/modemmanager/status.js
	$(INSTALL_DIR) $(1)/www/luci-static/resources
	$(INSTALL_DATA) ./files/www/resources/modemmanager_helper.js $(1)/www/luci-static/resources/modemmanager_helper.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/luci/menu.d/luci-app-ic.json $(1)/usr/share/luci/menu.d/luci-app-ic.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/luci/acl.d/luci-app-ic.json $(1)/usr/share/rpcd/acl.d/luci-app-ic.json
endef

$(eval $(call BuildPackage,luci-app-ic))
