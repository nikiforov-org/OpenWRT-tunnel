include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

PKG_NAME:=apfs
PKG_VERSION:=0.3.21
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/linux-apfs/linux-apfs-rw.git
PKG_SOURCE_VERSION:=8a3760029333
PKG_MIRROR_HASH:=skip

PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=mf286r

include $(INCLUDE_DIR)/package.mk

define KernelPackage/fs-apfs
  SUBMENU:=Filesystems
  TITLE:=APFS, the filesystem of every current Mac
  URL:=https://github.com/linux-apfs/linux-apfs-rw
  # zlib for the compressed files inside a volume; crc32c and the NLS base are
  # what the module turned out to reference at packaging time - the build names
  # them plainly ("missing dependencies for the following libraries"), so this
  # list is measured rather than guessed.
  DEPENDS:=+kmod-lib-zlib-inflate +kmod-lib-crc32c +kmod-nls-base
  FILES:=$(PKG_BUILD_DIR)/apfs.ko
  AUTOLOAD:=$(call AutoLoad,30,apfs)
endef

define KernelPackage/fs-apfs/description
  APFS is not in the mainline kernel and never will be: the format is Apple's,
  closed, and this driver is the result of reverse engineering. It is the only
  way to read a disk from a modern Mac, so it is here.

  Built with CONFIG_APFS_RW_ALWAYS, which makes a mount read-write by default
  instead of read-only. That is a deliberate choice: writing is possible either
  way (the option is "-o readwrite"), the flag only decides what happens when
  something mounts the volume without asking - which is exactly what the
  automount does. The author calls write support experimental; reading carries
  no such warning.

  Not supported by the driver: encrypted volumes (FileVault), not even for
  reading, and fusion drives.
endef

# super.c includes a generated version.h, and the generator wants a git checkout
# to name the commit. OpenWrt strips .git when it packs the source, so the build
# died on "fatal error: version.h: No such file or directory". The generator has
# its own fallback for exactly this - it reads the version out of dkms.conf - so
# it only needs to be called.
define Build/Configure
	( cd $(PKG_BUILD_DIR); sh ./genver.sh )
endef

# The module is a plain out-of-tree build; the flag is the one documented in its
# own Makefile for making mounts writable by default.
define Build/Compile
	+$(MAKE) $(PKG_JOBS) -C "$(LINUX_DIR)" \
		$(KERNEL_MAKE_FLAGS) \
		M="$(PKG_BUILD_DIR)" \
		APFS_CONFIG="-DCONFIG_APFS_RW_ALWAYS" \
		modules
endef

$(eval $(call KernelPackage,fs-apfs))
