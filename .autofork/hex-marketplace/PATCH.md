The marketplace is named `hex` instead of `claude-plugins-official`, so this
fork installs next to the official marketplace without a name clash, and its
plugins load as `<plugin>@hex`, which is how managed settings allow them as
channels (`allowedChannelPlugins`). It also lists the channels this fork adds,
`buzz`, `t3` and `voice`, from their folders in `external_plugins/`, so they
install as `buzz@hex`, `t3@hex` and `voice@hex`. Upstream's own entries stay
as they are.

This patch is done when the fork is no longer installed as a marketplace
beside the official one.
