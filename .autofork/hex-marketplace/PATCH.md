The marketplace in `.claude-plugin/marketplace.json` is named `hex` instead of `claude-plugins-official`. That lets this fork install next to the official marketplace without a name clash, and its plugins load as `<plugin>@hex`, the identity managed settings allowlist as a channel (`allowedChannelPlugins`).

It also lists the channels this fork adds, each from its folder in `external_plugins/`: `buzz`, the Buzz channel (`buzz-threads`); `t3`, the T3 Code agent (`t3-acp`); and `voice`, live voice calls (`voice`). They install as `buzz@hex`, `t3@hex` and `voice@hex`.

Change only the marketplace's `name` and add those entries. Upstream's plugin entries stay as they are.

The file stays valid JSON, its name is `hex`, and it has entries for `telegram`, `discord`, `buzz`, `t3` and `voice`.

Once the fork is no longer installed as a marketplace beside the official one, this patch is done.
