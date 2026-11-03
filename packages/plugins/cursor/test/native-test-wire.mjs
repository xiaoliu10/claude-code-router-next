// Synthetic wire fixtures, independent of the implementation's PB/fields codec.
// Field numbers follow agent.v1: no installed CLI or remote endpoint is needed.
export const vi = (value) => {
  let v = BigInt(value)
  const b = []
  do {
    const n = Number(v & 127n)
    v >>= 7n
    b.push(v ? n | 128 : n)
  } while (v)
  return Buffer.from(b)
}
export const uint = (field, value) => Buffer.concat([vi(field * 8), vi(value)])
export const bin = (field, value) => {
  const b = Buffer.from(value)
  return Buffer.concat([vi(field * 8 + 2), vi(b.length), b])
}
export const text = (field, value) => bin(field, Buffer.from(value))
export const message = (...parts) => Buffer.concat(parts)
export function readWire(input) {
  const buffer = Buffer.from(input)
  let at = 0
  const varint = () => {
    let result = 0n
    let shift = 0n
    while (at < buffer.length) {
      const b = buffer[at++]
      result |= BigInt(b & 127) << shift
      if (!(b & 128)) return Number(result)
      shift += 7n
    }
    throw new Error("fixture truncated varint")
  }
  const out = []
  while (at < buffer.length) {
    const tag = varint()
    const no = tag >> 3
    const kind = tag & 7
    if (kind === 0) out.push({ no, value: varint() })
    else if (kind === 2) {
      const n = varint()
      if (at + n > buffer.length) throw new Error("fixture truncated bytes")
      out.push({ no, data: buffer.subarray(at, at + n) })
      at += n
    } else throw new Error("fixture unsupported wire")
  }
  return out
}
export const item = (b, n) => readWire(b).find((f) => f.no === n)
export const nest = (b, n) => {
  const f = item(b, n)
  if (!f?.data) throw new Error("fixture missing message " + n)
  return f.data
}
export const string = (b, n) => item(b, n)?.data?.toString() ?? ""
export const number = (b, n) => item(b, n)?.value ?? 0
export function envelope(body, flags = 0) {
  const h = Buffer.alloc(5)
  h[0] = flags
  h.writeUInt32BE(body.length, 1)
  return Buffer.concat([h, body])
}
export const update = (n, body) => envelope(bin(1, bin(n, body)))
export const end = () => envelope(Buffer.from("{}"), 2)
export function tool(id, rawID, value = "seed", { name = "audit_echo", provider = "tools", server = "tools", approval = false, omitID = false, argumentValue, omitArguments = false } = {}) {
  const args = omitArguments ? Buffer.alloc(0) : bin(2, message(text(1, "value"), bin(2, argumentValue ?? text(3, value))))
  const a = message(text(1, "tools-" + name), args, text(3, rawID), text(4, provider), text(5, name), text(9, server), ...(approval ? [uint(7, 1)] : []))
  return envelope(bin(2, message(...(omitID ? [] : [uint(1, id)]), text(15, "exec-" + id), bin(11, a))))
}
export const setBlob = (request, id, data) => envelope(bin(4, message(uint(1, request), bin(3, message(bin(1, id), bin(2, data))))))
export const getBlob = (request, id) => envelope(bin(4, message(uint(1, request), bin(2, bin(1, id)))))
export const checkpoint = (state) => envelope(bin(3, state))
export const abortExec = (id) => envelope(bin(5, bin(1, uint(1, id))))
export function readResult(b) {
  const exec = nest(b, 2)
  const result = nest(exec, 11)
  const success = nest(result, 1)
  if (readWire(result).some((f) => f.no !== 1)) throw new Error("fixture expected McpResult.success")
  return {
    id: number(exec, 1),
    execID: string(exec, 15),
    content: readWire(success).filter((f) => f.no === 1).map((f) => {
      const txt = item(f.data, 1)
      if (txt) return { type: "text", text: string(txt.data, 1) }
      const image = nest(f.data, 2)
      return { type: "image", data: nest(image, 1), mimeType: string(image, 2) }
    }),
    isError: !!number(success, 2),
  }
}
