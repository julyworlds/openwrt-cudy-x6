# prplMesh for the Cudy X6 firmware.
#
# Built from our prplMesh fork (branch "openwrt"): upstream release 6.2.0,
# the patches of the OpenWrt packages feed and our own changes, all as git
# commits. Changes to prplMesh go to the fork, never as patches here.
#
# Local development: point the package at a checkout of the fork with
#   ln -s /path/to/prplMesh/.git custom-feed/net/prplmesh/git-src
# and enable "Enable package source tree override" (CONFIG_SRC_TREE_OVERRIDE).

include $(TOPDIR)/rules.mk

PKG_NAME:=prplmesh
PKG_VERSION:=6.2.0
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/julyworlds/prplMesh.git
PKG_MIRROR_HASH:=731774cdd8a8fa4315ebff6dde11bb4a1f78cee600203d11374499804def7221
PKG_SOURCE_DATE:=2026-11-28
PKG_SOURCE_VERSION:=2b229f6f25bc3880fdd20d221db98e21d580a6c0
# The commit is part of the archive name so a new fork commit never reuses a
# cached tarball of an older one.
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION)-$(PKG_SOURCE_VERSION).tar.zst
PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)

PKG_LICENSE:=BSD-2-Clause-Patent BSD-3-Clause ISC MIT
PKG_LICENSE_FILES:=LICENSE LICENSES/BSD-3-Clause.txt LICENSES/ISC.txt LICENSES/MIT.txt

# The tlvf code generator (framework/tlvf/tlvf.py) runs at build time and
# needs a host Python with PyYAML
PKG_BUILD_DEPENDS:=python3/host python-yaml/host
CMAKE_BINARY_SUBDIR:=build-openwrt-stock

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk
include ../../lang/python/python3-host.mk

define Package/prplmesh
  SECTION:=net
  CATEGORY:=Network
  TITLE:=prplMesh EasyMesh controller and agent
  URL:=https://github.com/julyworlds/prplMesh
  DEPENDS:=+libstdcpp +libpthread +librt +libjson-c +libmbedtls +libnl-core +libnl-genl +libnl-route +libuci +libubus +libubox +getopt
endef

define Package/prplmesh/description
  prplMesh EasyMesh controller and agent built for stock OpenWrt. It talks
  to the hostapd instances of the installed wpad over their UNIX control
  sockets through a small bundled control-interface client; it does not
  bundle, build or replace hostapd.
endef

define Package/prplmesh/conffiles
/etc/config/prplmesh
endef

CMAKE_OPTIONS += \
	-DTARGET_PLATFORM=openwrt \
	-DTARGET_PLATFORM_TYPE=stock \
	-DBWL_TYPE=NL80211 \
	-DBWL_BUNDLED_WPA_CTRL=ON \
	-DENABLE_NBAPI=OFF \
	-DUSE_PRPLMESH_WHM=OFF \
	-DPRPLMESH_STOCK_OPENWRT_UCI=ON \
	-DPRPLMESH_OPTIMIZE_SIZE=ON \
	-DBUILD_AGENT=ON \
	-DBUILD_CONTROLLER=ON \
	-DBUILD_TESTS=OFF \
	-DPRPLMESH_VERSION=$(PKG_VERSION) \
	-DPRPLMESH_REVISION=openwrt-r$(PKG_RELEASE) \
	-DBUILD_DATE=$(SOURCE_DATE_EPOCH) \
	-DCMAKE_INSTALL_PREFIX=/usr/libexec/prplmesh \
	-DPLATFORM_STAGING_DIR=$(STAGING_DIR) \
	-DPLATFORM_INCLUDE_DIR=$(STAGING_DIR)/usr/include \
	-DPython3_EXECUTABLE=$(HOST_PYTHON3_BIN)

define Package/prplmesh/install
	$(INSTALL_DIR) $(1)/usr/libexec/prplmesh/bin $(1)/usr/libexec/prplmesh/scripts $(1)/usr/share/prplmesh/config $(1)/usr/lib $(1)/etc/init.d $(1)/etc/config
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/libexec/prplmesh/bin/* $(1)/usr/libexec/prplmesh/bin/
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/libexec/prplmesh/scripts/prplmesh_utils.sh $(1)/usr/libexec/prplmesh/scripts/
	$(INSTALL_DATA) $(PKG_INSTALL_DIR)/usr/libexec/prplmesh/share/* $(1)/usr/share/prplmesh/
	$(INSTALL_DATA) $(PKG_INSTALL_DIR)/usr/libexec/prplmesh/config/* $(1)/usr/share/prplmesh/config/
	$(LN) ../../share/prplmesh $(1)/usr/libexec/prplmesh/share
	$(LN) ../../share/prplmesh/config $(1)/usr/libexec/prplmesh/config
	$(CP) $(PKG_INSTALL_DIR)/usr/libexec/prplmesh/lib/*.so* $(1)/usr/lib/
	$(INSTALL_BIN) ./files/prplmesh.init $(1)/etc/init.d/prplmesh
	$(INSTALL_CONF) ./files/prplmesh.config $(1)/etc/config/prplmesh
endef

$(eval $(call BuildPackage,prplmesh))
