# The Playwright image already carries Chromium, Firefox and WebKit for the
# version pinned in package.json, plus their system libraries. Matching the tag
# to @playwright/test is what keeps `playwright test` from asking for a browser
# download inside the container.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# corepack ships with Node but is not enabled; pnpm then comes from
# package.json's `packageManager`, so the container and CI agree on a version.
#
# node_modules and the pnpm store are named volumes (devcontainer.json). A new
# named volume copies the ownership of the directory it is mounted over, so the
# directories are created here and handed to pwuser; without that the volumes
# come up root-owned and `pnpm install` fails with EACCES.
RUN corepack enable \
	&& mkdir -p /workspaces/wirestage/node_modules /home/pwuser/.local/share/pnpm \
	&& chown -R pwuser:pwuser /workspaces /home/pwuser/.local

USER pwuser
# pnpm picks its store by whether it can hard-link into the project root, not
# into node_modules. The root is the host bind mount, so without an explicit
# store-dir pnpm falls back to `<mount root>/.pnpm-store` -- inside the
# checkout -- instead of the store volume.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
	PNPM_HOME=/home/pwuser/.local/share/pnpm \
	pnpm_config_store_dir=/home/pwuser/.local/share/pnpm/store
