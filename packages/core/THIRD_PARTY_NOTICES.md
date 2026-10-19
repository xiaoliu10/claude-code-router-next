# Third-Party Notices

## WorkBuddy protocol (CN site)

The WorkBuddy built-in subscription provider in `packages/core` implements a
protocol reverse-engineered from the community plugin:

- Project: magpie-community/plugins, `packages/workbuddy`
- Pin: `ab38da681af7716ea9a7609f045ca91d2ad9988a`
- License: MIT

The CCR implementation (`services/workbuddy.ts`, `services/workbuddy-auth.ts`,
`transformer/workbuddy.transformer.ts` and their tests) was written from the
protocol description (endpoints, user agents, header sets, request-body quirks,
`/v3/config` schema handling, error codes). It does not copy substantial code
from the plugin, but the protocol knowledge itself derives from that MIT
project, and the upstream project's authors accordingly deserve attribution:

```
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
```

MIT is the license of the community plugin only. It does not constitute any
authorization from WorkBuddy/Tencent of third-party subscription bridging, and
CCR makes no claim of official support or account-safety guarantees.
