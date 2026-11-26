/**
 * 保护 vendors/loomy/vision-purpose.ts：只有含图片 part 的请求体被盖上
 * `X-Loomy-Request-Purpose: kb.vision`，纯文本与非 JSON 请求原样放行，
 * 且只合并 headers、不动 body。全部用 cannedFetch 驱动，不联网。
 */

import { describe, expect, test } from "bun:test"
import {
  VISION_PURPOSE,
  VISION_PURPOSE_HEADER,
  withVisionPurpose,
} from "../src/vendors/loomy/vision-purpose.ts"
import { at, cannedFetch, headersOf, jsonOk } from "./helpers.ts"

const PURPOSE_HEADER = VISION_PURPOSE_HEADER.toLowerCase()

function chatBody(content: unknown): string {
  return JSON.stringify({ model: "deepseek-v4-flash-1017", messages: [{ role: "user", content }] })
}

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
const PLAIN_PART = { type: "text", text: "描述这张图" }

/** 跑一次包装后的请求，返回底层 fetch 收到的那次调用记录。 */
async function sentInit(init: RequestInit) {
  const fake = cannedFetch([{ match: "/chat/completions", respond: jsonOk({}) }])
  const wrapped = withVisionPurpose(fake)
  await wrapped("https://loomyad.xunfei.cn/api/v1/chat/completions", init)
  return at(fake.calls, 0)
}

describe("withVisionPurpose", () => {
  test("image_url 请求体盖 kb.vision 头", async () => {
    const call = await sentInit({
      method: "POST",
      body: chatBody([PLAIN_PART, IMAGE_PART]),
      headers: { "content-type": "application/json" },
    })
    expect(headersOf(call)[PURPOSE_HEADER]).toBe(VISION_PURPOSE)
  })

  test("image 形态的请求体同样盖头", async () => {
    const call = await sentInit({
      method: "POST",
      body: chatBody([PLAIN_PART, { type: "image", source: { type: "base64" } }]),
    })
    expect(headersOf(call)[PURPOSE_HEADER]).toBe(VISION_PURPOSE)
  })

  test("system 消息里的图片也触发", async () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: [IMAGE_PART] },
        { role: "user", content: "hi" },
      ],
    })
    const call = await sentInit({ method: "POST", body })
    expect(headersOf(call)[PURPOSE_HEADER]).toBe(VISION_PURPOSE)
  })

  test("已有用途头被强制覆盖为 kb.vision", async () => {
    const call = await sentInit({
      method: "POST",
      body: chatBody([IMAGE_PART]),
      headers: { [VISION_PURPOSE_HEADER]: "chat.message" },
    })
    expect(headersOf(call)[PURPOSE_HEADER]).toBe(VISION_PURPOSE)
  })

  test("纯文本请求体不盖头", async () => {
    const call = await sentInit({
      method: "POST",
      body: chatBody([PLAIN_PART]),
      headers: { token: "sess-1" },
    })
    expect(headersOf(call)[PURPOSE_HEADER]).toBeUndefined()
    expect(headersOf(call).token).toBe("sess-1")
  })

  test("非 JSON body 原样放行", async () => {
    const call = await sentInit({ method: "POST", body: "not-json{" })
    expect(headersOf(call)[PURPOSE_HEADER]).toBeUndefined()
  })

  test("空 body 原样放行", async () => {
    const call = await sentInit({ method: "POST", body: "" })
    expect(headersOf(call)[PURPOSE_HEADER]).toBeUndefined()
  })

  test("body 不被重写", async () => {
    const body = chatBody([PLAIN_PART, IMAGE_PART])
    const call = await sentInit({ method: "POST", body })
    expect(call.init?.body).toBe(body)
  })
})
