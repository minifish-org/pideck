# Browser distribution

Pideck packages the complete, pinned Playwright CLI and browser installer with
its standalone Node.js runtime. **Browser and FFmpeg binaries are downloaded
directly from their upstream services on first use.** They are not included
in Pideck application resources, installers, or release attachments.

## First use

The first browser command needs an internet connection and can take longer
while the matching browser and FFmpeg are installed. Preparation is automatic;
no system Node.js installation, existing browser, extra configuration, or
browser-choice button is required. Downloads remain in Pideck's application
data and are reused by later sessions. An interrupted installation can be
retried without accepting a partial download as ready.

Pideck uses the pinned upstream installer's normal download URLs, platform
selection and matching browser revisions, as documented by
[Playwright][pw-install]. Browser executable files, license files and notices
remain together in the installation cache. The downloaded browser is for use
on that machine and remains subject to the upstream terms.

The complete CLI uses the matching browser through the ordinary Playwright
launch path. Its command set is not filtered or replaced with an Electron or
CDP-only bridge. Headed and headless operation, isolated named sessions,
screenshots, snapshots, downloads, tracing, recording and `run-code` retain
their upstream implementation.

## Redistribution basis

The pinned Playwright installer selects **Google Chrome for Testing**,
including on Linux arm64. Its `chromium` engine name does not identify the
downloaded executable's redistribution license.

Google's Chrome for Testing maintainer explicitly states that the Apache-2.0
license in the download-metadata repository applies to that repository, while
the browser binary is covered by the Chrome executable terms. See the
[upstream licensing answer][cft-license] and [Chrome terms][chrome-terms],
which incorporate Google's terms of service. The previously bundled
157.0.8103.15 macOS distribution also contained a non-open-source
`WidevineCdm/LICENSE` requiring a separate Google agreement for redistribution.
Pideck has no such agreement. Removing Widevine alone would not establish
permission to redistribute the remaining Chrome executable.

Pideck therefore does not redistribute Chrome for Testing, Widevine or
FFmpeg. It automates [the upstream install-on-the-user's-machine
workflow][pw-install]. This does not relicense those downloads or claim they
are covered by Playwright's Apache-2.0 license. Pideck's own distributed
JavaScript, CLI and Node.js components retain their separate license and
notice materials in the application package.

## Package checks

Packaging verifies that application resources contain no downloaded browser,
FFmpeg executable, browser profile or browser download cache, and that the
CLI and installer versions match their manifest. Packaged acceptance uses a
clean application-data directory to verify preparation, reuse and the normal
edit → serve → operate → screenshot → correct workflow. Browser sessions use
separate profiles from the user's ordinary browser.

[cft-license]: https://github.com/GoogleChromeLabs/chrome-for-testing/issues/21
[chrome-terms]: https://www.google.com/chrome/terms/
[pw-install]: https://playwright.dev/docs/browsers#install-browsers
