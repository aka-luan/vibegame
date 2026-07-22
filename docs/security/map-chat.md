# Controlled map chat policy

Map chat exists only for controlled non-production testing. It is disabled by
default and can be enabled only with `CONTROLLED_MAP_CHAT_ENABLED=true` while
`NODE_ENV` is `development` or `test`. Production startup rejects an enabled
flag. Missing, misspelled, or malformed values do not enable chat.

Messages are ephemeral. They remain in one live map room long enough for
connected clients to render them and are never written to PostgreSQL or another
store. No moderation or message-history capability exists in this slice.

The server emits structured `map_chat` operational records containing only:

- outcome (`accepted` or `rejected`)
- safe rejection code, when applicable
- UTF-8 byte count and line count, when validation can determine them

Operational records exclude message text, user/session credentials, stable
user or character identity, ephemeral entity identity, and room identity.
Deployment operators own log retention and must apply the same short retention
used for transient application diagnostics; these records are not an approved
source of chat history or player profiling.
