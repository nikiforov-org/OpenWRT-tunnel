include $(TOPDIR)/rules.mk

PKG_NAME:=mf286r-usb
PKG_VERSION:=1.0
PKG_RELEASE:=4
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=mf286r

include $(INCLUDE_DIR)/package.mk

define Package/mf286r-usb
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=USB menu section (groups the pages for the socket on the case)
  DEPENDS:=+luci-base +rpcd-mod-file +block-mount +dosfstools +e2fsprogs +exfat-mkfs +sfdisk +partx-utils +avahi-nodbus-daemon +wsdd2
  PKGARCH:=all
endef

define Package/mf286r-usb/description
  Adds a "USB" entry to Services and moves the pages that belong to the socket
  on the case under it as tabs: Printer (p910nd) and Storage, the page that
  lists the drives and can mount, unmount and format them.
  Also turns on anonymous mounts, so a drive that was never configured still
  mounts by itself when it is plugged in.
  Applied on first boot via uci-defaults; a page whose package is not installed
  is simply skipped. The name is board-namespaced on purpose — a generic
  luci-app-usb could one day appear in the feeds and collide with it.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/mf286r-usb/install
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/mf286r-usb.json $(1)/usr/share/luci/menu.d/mf286r-usb.json
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/92-usb-menu $(1)/etc/uci-defaults/92-usb-menu
	$(INSTALL_BIN) ./files/etc/uci-defaults/93-usb-automount $(1)/etc/uci-defaults/93-usb-automount
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/usb-disk $(1)/usr/bin/usb-disk
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/usb
	$(INSTALL_DATA) ./files/www/view/usb/storage.js $(1)/www/luci-static/resources/view/usb/storage.js
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/luci/acl.d/mf286r-usb.json $(1)/usr/share/rpcd/acl.d/mf286r-usb.json
	$(INSTALL_DIR) $(1)/etc/avahi/services
	$(INSTALL_DATA) ./files/etc/avahi/services/smb.service $(1)/etc/avahi/services/smb.service
endef

$(eval $(call BuildPackage,mf286r-usb))
