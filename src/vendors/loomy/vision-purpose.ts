/**
 * Loomy upstream routes requests by the `X-Loomy-Request-Purpose` header.
 *
 * A chat request that carries an image must declare the `kb.vision` purpose;
 * without it the upstream replaces the image with a textual "[IMAGE] ...
 * visual analysis skipped" placeholder and the model never sees the picture
 * (confirmed against loomyad.xunfei.cn on 2026-11-27: the same body answers
 * correctly once the header is stamped, and prompt_tokens jump from 74 to
 * 147 as the image is actually encoded).
 *
 * This wraps the vendor's outgoing fetch and stamps the header on
 * image-bearing request bodies only. Pure-text requests are forwarded
 * untouched, so the header cannot change the semantics of existing chat.
 */

import type { Fetcher } from "../../core/http.ts"

/** The purpose value the upstream's vision channel recognizes. */
export const VISION_PURPOSE = "kb.vision"

/** Header carrying the purpose; see `src/vendors/loomy/product.ts` for the
 *  upstream's protocol notes. */
export const VISION_PURPOSE_HEADER = "X-Loomy-Request-Purpose"

/**
 * Wrap `fetcher` so that any request whose JSON body contains an image part
 * carries the vision-purpose header. Body is never rewritten — only headers
 * are merged — so the wire payload stays byte-identical to what the host sent.
 */
export function withVisionPurpose(fetcher: Fetcher): Fetcher {
  const wrapped = async (input: Parameters<Fetcher>[0], init?: Parameters<Fetcher>[1]): Promise<Response> => {
    const stamped = stampVisionPurpose(init)
    return fetcher(input, stamped === undefined ? init : stamped)
  }
  return wrapped as Fetcher
}

/** Returns a new init with the vision-purpose header when the body has an
 *  image part; undefined means "forward the original init unchanged". */
function stampVisionPurpose(init?: RequestInit): RequestInit | undefined {
  if (init === undefined) return undefined
  const body = init.body
  if (typeof body !== "string" || body.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!messagesContainImage(parsed)) return undefined
  const headers = new Headers(init.headers)
  headers.set(VISION_PURPOSE_HEADER, VISION_PURPOSE)
  return { ...init, headers }
}

/** True when the OpenAI-style payload has at least one message with an
 *  image content part, across all roles. */
function messagesContainImage(payload: unknown): boolean {
  const messages = (payload as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return false
  return messages.some((message) => contentHasImage((message as { content?: unknown } | null)?.content))
}

/** True when a message content array holds an image part. Both the OpenAI
 *  `image_url` shape and the AI SDK's plain `image` shape are covered. */
function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((part) => {
    const type = (part as { type?: string } | null)?.type
    return type === "image_url" || type === "image"
  })
}
