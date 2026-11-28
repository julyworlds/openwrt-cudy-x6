# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for prplMesh (EasyMesh)
LUCI_DESCRIPTION:=Status of the EasyMesh network and basic prplMesh settings
LUCI_DEPENDS:=+luci-base +prplmesh
LUCI_PKGARCH:=all

PKG_VERSION:=1.0
PKG_RELEASE:=7
PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
