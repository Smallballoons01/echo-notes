# First GitHub release checklist

This repository is code-complete for a local Harness install, but it is not
ready to publish until the project owner fills the identity placeholders.

## Required before publishing

- [ ] Choose the GitHub owner and canonical repository name.
- [ ] Replace `REPLACE_WITH_OWNER` in `package.json` `repository`, `homepage`,
  and `bugs`.
- [ ] Confirm the npm scope/package name (`@dsh-plugin/echo-notes`) is owned and
  publishable; update the package name if the selected distribution differs.
- [ ] Add a monitored `SECURITY.md` contact (do not publish an unmonitored or
  guessed address).
- [ ] Review the license copyright holder; replace “Echo Notes contributors” if
  the project owner requires a named holder.
- [ ] Review all third-party dependencies and generated/bundled files.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm test` in a
  clean checkout.
- [ ] Run `npm pack --dry-run` and confirm `LICENSE`, docs, source, client, MCP
  adapter, skill, icon and bundle patch are included while `node_modules`, local
  profile data, and secrets are excluded.
- [ ] Verify install against a clean supported DSH profile and test the MCP
  adapter against the documented local Harness endpoint.
- [ ] Tag `v0.1.0`, publish a GitHub release, and publish to npm only if the
  package name and maintainer account are ready.

Do not publish with placeholder repository URLs or an unverified npm scope.
