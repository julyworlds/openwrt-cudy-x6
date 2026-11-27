# Local overlay of the prplmesh package from the "packages" feed.
#
# Nothing upstream is copied: the upstream Makefile, files/ and patches/
# are used as they are, and the patches in ./patches are applied on top
# of them. If an upstream update makes one of these patches stale, the
# build stops in the patch step instead of silently dropping it.
#
# For "./scripts/feeds install -a" to pick this package over the upstream
# one, the "custom" feed must be listed before "packages" in feeds.conf
# (or use: ./scripts/feeds install -p custom prplmesh).
#
# Helper symlinks this overlay relies on:
#   files                           -> feeds/packages/net/prplmesh/files
#   ../../lang/python/python3-*.mk  -> feeds/packages/lang/python/
# (the upstream Makefile includes ../../lang/python/python3-host.mk
# relative to the package directory)

PRPLMESH_UPSTREAM_DIR:=$(TOPDIR)/feeds/packages/net/prplmesh
PRPLMESH_LOCAL_PATCH_DIR:=$(CURDIR)/patches

ifeq ($(wildcard $(PRPLMESH_UPSTREAM_DIR)/Makefile),)
  $(error prplmesh overlay: $(PRPLMESH_UPSTREAM_DIR)/Makefile not found, run ./scripts/feeds update packages)
endif

# Upstream patches first (quilt.mk only sets PATCH_DIR if unset) ...
PATCH_DIR:=$(PRPLMESH_UPSTREAM_DIR)/patches

# ... then ours, as a prepare hook so they land after upstream's.
define Prplmesh/LocalPatches
	$(call PatchDir,$(PKG_BUILD_DIR),$(PRPLMESH_LOCAL_PATCH_DIR),local/)
endef
Hooks/Prepare/Post += Prplmesh/LocalPatches

# Build for size (needs patches/190-cmake-optimize-for-size.patch).
CMAKE_OPTIONS += -DPRPLMESH_OPTIMIZE_SIZE=ON

include $(PRPLMESH_UPSTREAM_DIR)/Makefile

# call BuildPackage - OpenWrt buildroot signature (BuildPackage is called by the upstream Makefile)
