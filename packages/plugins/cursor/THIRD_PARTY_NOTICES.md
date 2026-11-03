# Third-party notices

`src/vendor/engine.mjs` and `src/vendor/native-session.mjs` are locally
modified (engine) and verbatim (native-session) copies of
[magpie-community/plugins](https://github.com/magpie-community/plugins),
`packages/cursor/index.mjs` + `packages/cursor/native-session.mjs` at commit
`bace91473b4f113a719a49b7d8ce81fe1f5b5760`, published as
`@magpie-community/opencode-cursor-auth` version `0.2.26`.
Every local modification to the engine is listed in
`src/vendor/PATCHES.md`.

## magpie-community/plugins license

MIT License

Copyright (c) 2026 magpie-community contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Upstream protocol provenance (within magpie-community/plugins)

The upstream package documents that its Cursor protocol implementation is
ported from magpie's built-in Cursor account (internal/provider/cursor*.go,
internal/gateway/cursor.go), distributed under the same MIT license via the
magpie-community/plugins repository. The vendored files carry that upstream
file's own header comments verbatim.
