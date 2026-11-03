// Imported first by every test here: nothing a test runs reaches Cursor.
// fetch and HTTP/2 go to this machine (a test's fake) or fail, so a test
// left without its fake, or work still going after it, can't send a token
// to api2.cursor.sh or the agent API.
import http2 from "node:http2"

const local = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error("a test asked " + u + " with no fake in place")
  return realFetch(input, init)
}
const connect = http2.connect
http2.connect = (origin, ...rest) => {
  if (!local(String(origin))) throw new Error("a test connected to " + origin)
  return connect(origin, ...rest)
}
