# License and distribution

wirestage is distributed under the MIT license in [LICENSE](LICENSE), with
copyright attributed to heojeongbo. Package metadata declares `MIT`.

The npm tarball contains the compiled modules, the TypeScript source (for
source maps, tests excluded), README, LICENSE and this inventory. It bundles
no third-party code. Dependencies are installed separately and keep their own
licenses:

| Package | Kind | License |
| --- | --- | --- |
| @heojeongbo/log-palette | dependency | MIT |
| @playwright/test | required peer | Apache-2.0 |
| @connectrpc/connect | optional peer (`/connect`) | Apache-2.0 |
| @connectrpc/connect-node | optional peer (`/connect`) | Apache-2.0 |
| @bufbuild/protobuf | optional peer (`/connect`) | Apache-2.0 AND BSD-3-Clause |

The core and the `/rest`, `/sse`, `/websocket` and `/webrtc` entries use only
Playwright and the platform. Connect and protobuf are imported by `/connect`
alone, so they may be absent otherwise (`pnpm package:check` proves it).
