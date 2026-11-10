/**
 * Raccoon's two ways in.
 *
 * **WeChat, by QR code.** The desktop client's own flow ends at an
 * `office-raccoon://` callback, which a plugin running in the host's process
 * never receives, and the authorization page's redirect is fixed — so this
 * package does what the client's renderer does instead: it mints a code
 * itself (any code is accepted; the service only answers polls about it),
 * draws the QR for the vendor's own landing page, and asks every two seconds
 * whether that code has been scanned. The QR lives on a loopback page and
 * refreshes itself when the service cancels the code.
 *
 * **SMS, on the same kind of page.** A phone number is encrypted host-side
 * with the vendor's constant and posted with an Aliyun slider's answer; the
 * page never holds the key, the number the user typed is the only sensitive
 * thing in it, and it is never written into the HTML either.
 *
 * Both need something from the user's own client: the QR path needs nothing
 * but the browser, the SMS path needs the phone cipher key the vendor's
 * bundle carries. Without that key the SMS method is not offered at all
 * rather than failing once the user has typed a number.
 */

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { readCredential } from "../../core/credentials.ts"
import { errorMessage } from "../../core/errors.ts"
import type { Fetcher } from "../../core/http.ts"
import { asObject, str } from "../../core/json.ts"
import { notFound, type PageRequest, type PageResponse, PageServer } from "../../core/local-page.ts"
import { vendorLogger } from "../../core/log.ts"
import {
  jsonFail,
  jsonOk,
  renderLoginPage,
  renderSandboxedScriptFrame,
  renderSandboxedScriptPage,
} from "../../core/login-page.ts"
import { renderQrSvg } from "../../core/qr.ts"
import type { AuthMethod, PluginClient, SignInResult } from "../../core/types.ts"
import { createSettlement, mainlandPhone, maskPhone, randomHex, sleep } from "../../core/util.ts"
import {
  exchangeAuthorizationCode,
  fetchUserInfo,
  generateQrCode,
  jwtExpiresAtMs,
  loginWithSmsCode,
  pollQrLogin,
  qrContent,
  type RaccoonLogin,
  type RaccoonQrPoll,
  sendSmsCode,
} from "./api.ts"
import {
  RACCOON_ALIYUN_CAPTCHA,
  RACCOON_API_BASE,
  RACCOON_ID,
  RACCOON_PATHS,
  RACCOON_PHONE_CIPHER_SECRET,
  RACCOON_QR_POLL_INTERVAL_MS,
  RACCOON_SIGN_IN_TIMEOUT_MS,
} from "./product.ts"

export interface RaccoonLoginDeps {
  options: Record<string, unknown>
  client: PluginClient
  fetcher: Fetcher
  signInTimeoutMs?: number
}

/** The phone cipher key, when it was configured. */
export function phoneCipherSecret(options: Record<string, unknown>): string | undefined {
  return readCredential(RACCOON_PHONE_CIPHER_SECRET, options)
}

export interface RaccoonLearned {
  phone?: string
  nickname?: string
  userId?: string
  officeIdentity?: string
}

/**
 * What a finished sign-in hands the host.
 *
 * A sign-in that came with a refresh token is stored the OAuth way, with its
 * expiry; a sign-in that did not is stored as a key, with no expiry at all —
 * the host has nothing to renew it with, and saying otherwise would have it
 * renew on a schedule that cannot work. The account's own name (its phone
 * number, which is the only field that tells two accounts apart) rides along
 * so the account list is readable without opening the vendor's app.
 */
export function signInResult(login: RaccoonLogin, learned: RaccoonLearned = {}): SignInResult {
  const officeIdentity = login.officeIdentity ?? learned.officeIdentity
  const named: Record<string, unknown> = {
    ...(officeIdentity === undefined ? {} : { officeIdentity }),
    ...(learned.phone === undefined ? {} : { phone: learned.phone }),
    ...(learned.userId === undefined ? {} : { userId: learned.userId }),
    ...(learned.nickname === undefined ? {} : { nickname: learned.nickname }),
  }
  const label = learned.phone === undefined ? (learned.nickname ?? learned.userId) : maskPhone(learned.phone)
  const accountId = label === undefined ? {} : { accountId: label }
  if (login.refresh !== undefined) {
    return {
      type: "success",
      access: login.access,
      refresh: login.refresh,
      expires: login.expires ?? 0,
      ...named,
      ...accountId,
    }
  }
  // No refresh token: the host's key sign-in is the shape that promises no
  // renewal, so the account is stored as one instead of as an OAuth sign-in
  // whose renewal could only ever fail.
  return { type: "success", key: login.access, metadata: named, ...accountId }
}

/**
 * Asks the service who just signed in. Best effort by design: it names the
 * account and answers which organisation it belongs to, and a sign-in that
 * worked is not undone because this did not.
 */
async function learn(deps: RaccoonLoginDeps, login: RaccoonLogin): Promise<RaccoonLearned> {
  try {
    const info = await fetchUserInfo(deps.fetcher, login.access, login.officeIdentity)
    return {
      ...(info.phone === undefined ? {} : { phone: info.phone }),
      ...(info.nickname === undefined ? {} : { nickname: info.nickname }),
      ...(info.userId === undefined ? {} : { userId: info.userId }),
      ...(info.officeIdentity === undefined ? {} : { officeIdentity: info.officeIdentity }),
    }
  } catch (error) {
    await vendorLogger(deps.client, RACCOON_ID).warn(
      `登录成功但读取账号信息失败（不影响使用）：${errorMessage(error)}`,
    )
    return {}
  }
}

interface StartedFlow {
  url: string
  instructions: string
  done: Promise<SignInResult>
}

// ---- the QR page -------------------------------------------------------------

type QrPhase = "waiting" | "scanned" | "refreshed" | "done" | "failed"

interface QrState {
  phase: QrPhase
  message: string
  svg: string
}

const QR_TEXT: Record<QrPhase, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码，请在微信里确认",
  refreshed: "二维码已刷新，请重新扫码",
  done: "登录成功，可以关闭此页面",
  failed: "登录失败",
}

function renderQrPage(state: QrState): string {
  const script = `
  var stop = cnPoll("state", function (next) {
    var box = document.getElementById("cn-qr");
    if (next.svg && box && box.innerHTML !== next.svg) box.innerHTML = next.svg;
    if (next.phase === "done") { cnDone(stop, next.message); return; }
    if (next.phase === "failed") {
      stop();
      cnStatus("cn-status", next.message || "登录失败", "err");
      return;
    }
    cnStatus("cn-status", next.message || "");
  }, 1200);
`
  return renderLoginPage({
    title: "登录 Raccoon",
    note: "用微信扫一扫，登录商汤小浣熊",
    accent: "#8e6bf2",
    body: `
      <div class="cn-qr" id="cn-qr">${state.svg}</div>
      <p class="cn-hint">二维码过期后会自动刷新</p>`,
    script,
  })
}

/**
 * A finished poll, when it is one: the sign-in that just became complete.
 * Returns false for every other state, including a `success` without a
 * session — waiting two seconds costs nothing, believing it costs the flow.
 */
async function completedQrLogin(
  deps: RaccoonLoginDeps,
  poll: RaccoonQrPoll,
): Promise<SignInResult | undefined> {
  if (poll.status !== "success" || poll.access === undefined) return undefined
  const login: RaccoonLogin = {
    access: poll.access,
    ...(poll.refresh === undefined ? {} : { refresh: poll.refresh }),
    ...(poll.expires === undefined ? {} : { expires: poll.expires }),
  }
  return signInResult(login, await learn(deps, login))
}

/**
 * What one poll means for the page, and for the loop: a cancelled code is
 * redrawn (and the callers wait before asking about the new one), everything
 * else is a state the page shows until the answer changes.
 */
function showPoll(state: QrState, poll: RaccoonQrPoll): "again" | "restart" {
  if (poll.status === "canceled") {
    state.phase = "refreshed"
    state.message = QR_TEXT.refreshed
    return "restart"
  }
  if (poll.status === "logging") {
    state.phase = "scanned"
    state.message = QR_TEXT.scanned
  } else if (state.phase !== "refreshed") {
    state.phase = "waiting"
    state.message = QR_TEXT.waiting
  }
  return "again"
}

/**
 * Runs one QR sign-in: the page, the poll behind it and the redraw a
 * cancelled code needs. Nothing waits for the page — a user who scans and
 * confirms finishes without ever loading it.
 */
async function startQrSignIn(deps: RaccoonLoginDeps): Promise<StartedFlow> {
  const settlement = createSettlement<SignInResult>()
  const state: QrState = { phase: "waiting", message: QR_TEXT.waiting, svg: "" }
  // The page only ever sees the picture, so the code it was drawn from is
  // kept here: it is what every poll asks about, and what a redraw replaces.
  let code = ""
  const draw = (): void => {
    code = generateQrCode()
    state.svg = renderQrSvg(qrContent(code), { size: 200 })
  }
  draw()
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    // Later than the page's own last poll, so "登录成功" stays readable.
    const timer = setTimeout(() => server.close(), 5_000)
    timer.unref?.()
  }

  const fail = (message: string): void => {
    if (settlement.settled) return
    state.phase = "failed"
    state.message = message
    settlement.settle({ type: "failed", error: message })
    close()
  }

  const server = await PageServer.start((request: PageRequest) => {
    if (request.method === "GET" && request.path === "/") {
      return { contentType: "text/html; charset=utf-8", body: renderQrPage(state) }
    }
    if (request.method === "GET" && request.path === "/state") {
      return jsonOk({ phase: state.phase, message: state.message, svg: state.svg })
    }
    return notFound()
  })

  void (async () => {
    const deadline = Date.now() + (deps.signInTimeoutMs ?? RACCOON_SIGN_IN_TIMEOUT_MS)
    try {
      while (!settlement.settled && Date.now() < deadline) {
        const poll = await pollQrLogin(deps.fetcher, code)
        const result = await completedQrLogin(deps, poll)
        if (result !== undefined) {
          state.phase = "done"
          state.message = QR_TEXT.done
          settlement.settle(result)
          close()
          return
        }
        if (showPoll(state, poll) === "restart") {
          draw()
          await sleep(1_000)
          state.phase = "waiting"
          state.message = QR_TEXT.waiting
          continue
        }
        await sleep(RACCOON_QR_POLL_INTERVAL_MS)
      }
      if (!settlement.settled) fail("登录超时，请重新发起登录")
    } catch (error) {
      fail(errorMessage(error))
    }
  })()

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址，用微信扫码登录",
    done: settlement.promise,
  }
}

// ---- the SMS page ------------------------------------------------------------

function renderSmsPage(): string {
  const script = `
  var verify = document.getElementById("cn-verify");
  var captchaFrame = document.getElementById("cn-captcha-frame");
  var phoneInput = document.getElementById("cn-phone");

  function submit(phone, captchaParam) {
    cnStatus("cn-status", "正在发送验证码…");
    cnPost("sms", { phone: phone, captchaParam: captchaParam || "" })
      .then(function (data) { cnStatus("cn-status", data.message || "验证码已发送", "ok"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "发送失败", "err"); });
  }

  window.addEventListener("message", function (event) {
    // The frame is sandboxed without allow-same-origin, so its origin is the
    // opaque "null" origin. Source matching prevents another local frame from
    // submitting a token to this page.
    if (!captchaFrame || event.source !== captchaFrame.contentWindow || event.origin !== "null") return;
    var data = event.data || {};
    if (data.type === "raccoon-captcha-ready" && data.ok !== true) {
      cnStatus("cn-status", "验证码组件未加载，请检查网络后刷新页面", "err");
      return;
    }
    if (data.type !== "raccoon-captcha" || typeof data.captchaParam !== "string" || data.captchaParam.length === 0) return;
    var phone = phoneInput ? phoneInput.value.trim() : "";
    submit(phone, data.captchaParam);
  });

  verify.addEventListener("click", function () {
    cnStatus("cn-status", "正在验证…");
    cnPost("verify", { code: document.getElementById("cn-code").value.trim() })
      .then(function () { cnDone(null, "登录成功，可以关闭此页面"); })
      .catch(function (e) { cnStatus("cn-status", e.message || "验证失败", "err"); });
  });
`
  return renderLoginPage({
    title: "登录 Raccoon",
    note: "短信验证码登录（需要完成滑块验证）",
    accent: "#8e6bf2",
    body: `
      <label for="cn-phone">手机号</label>
      <div class="cn-row">
        <input id="cn-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号">
      </div>
      ${renderSandboxedScriptFrame({
        id: "cn-captcha-frame",
        title: "阿里云验证码",
        path: "captcha",
      })}
      <label for="cn-code">短信验证码</label>
      <input id="cn-code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
      <button id="cn-verify" type="button">登录</button>`,
    script,
  })
}

function renderCaptchaPage(): PageResponse {
  return renderSandboxedScriptPage({
    source: RACCOON_ALIYUN_CAPTCHA.script,
    body: `<div id="cn-captcha"></div><button id="cn-send" type="button">完成验证并发送验证码</button>`,
    bootstrap: `
  (function () {
    function emit(value) { window.parent.postMessage(value, "*"); }
    if (typeof window.initAliyunCaptcha !== "function") {
      emit({ type: "raccoon-captcha-ready", ok: false });
      return;
    }
    window.initAliyunCaptcha({
      SceneId: "${RACCOON_ALIYUN_CAPTCHA.sceneId}",
      prefix: "${RACCOON_ALIYUN_CAPTCHA.prefix}",
      mode: "popup",
      element: "#cn-captcha",
      button: "#cn-send",
      captchaVerifyCallback: function (captchaParam) {
        if (typeof captchaParam !== "string" || captchaParam.length === 0) {
          return { captchaResult: false, bizResult: false };
        }
        emit({ type: "raccoon-captcha", captchaParam: captchaParam });
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function () { return null; },
      getInstance: function () { return null; },
      slideStyle: { width: 320, height: 40 },
      language: "cn"
    });
    emit({ type: "raccoon-captcha-ready", ok: true });
  })();
`,
  })
}

/** One immutable send attempt, including the generation it belongs to. */
interface SmsAttempt {
  readonly generation: number
  readonly phone: string
  status: "sending" | "sent" | "verifying" | "completed"
  msgid?: string
  verifyPromise?: Promise<PageResponse>
  lastVerifyCode?: string
  lastVerifyResponse?: PageResponse
}

/** Mutable flow state. A new send always replaces the current generation. */
interface SmsState {
  generation: number
  current: SmsAttempt | undefined
}

/**
 * The slider's answer, turned into a code. Only the number the service
 * accepted is remembered: submitting a code for a number that never got one
 * can only fail, and saying "先获取验证码" is the honest answer to it.
 */
async function sendSmsRequest(
  deps: RaccoonLoginDeps,
  secret: string,
  state: SmsState,
  request: PageRequest,
): Promise<PageResponse> {
  const body = await request.json()
  const typed = mainlandPhone(typeof body.phone === "string" ? body.phone : undefined)
  if (typed === undefined) return jsonFail("请输入有效的 11 位手机号")
  const generation = state.generation + 1
  state.generation = generation
  const attempt: SmsAttempt = { generation, phone: typed, status: "sending" }
  // Invalidate a previous send before awaiting the vendor. Its eventual
  // response may still arrive, but it can no longer become verifiable state.
  state.current = attempt
  try {
    const captcha = typeof body.captchaParam === "string" ? body.captchaParam : ""
    await sendSmsCode(deps.fetcher, secret, typed, captcha)
    if (state.current !== attempt || state.generation !== generation) {
      return jsonFail("发送请求已过期，请使用最新手机号重新获取验证码", 409)
    }
    attempt.status = "sent"
    return jsonOk({ message: `验证码已发送到 ${maskPhone(typed)}` })
  } catch (error) {
    const current = state.current === attempt && state.generation === generation
    if (current) state.current = undefined
    if (!current) return jsonFail("发送请求已过期，请使用最新手机号重新获取验证码", 409)
    return jsonFail(errorMessage(error))
  }
}

/** The code the user typed, exchanged for a sign-in. */
async function verifySmsRequest(
  deps: RaccoonLoginDeps,
  secret: string,
  state: SmsState,
  request: PageRequest,
  complete: (result: SignInResult) => void,
): Promise<PageResponse> {
  const body = await request.json()
  const code = typeof body.code === "string" ? body.code.trim() : ""
  if (code.length === 0) return jsonFail("请输入短信验证码")
  const attempt = state.current
  if (attempt === undefined || attempt.status === "sending") {
    return jsonFail("请先获取验证码")
  }
  // Duplicate browser submissions share the in-flight result. This keeps the
  // vendor exchange and account write one-shot without relying on button UI.
  if (attempt.status === "verifying" && attempt.verifyPromise !== undefined) {
    return await attempt.verifyPromise
  }
  if (attempt.lastVerifyCode === code && attempt.lastVerifyResponse !== undefined) {
    return attempt.lastVerifyResponse
  }

  const generation = attempt.generation
  attempt.status = "verifying"
  const operation = (async (): Promise<PageResponse> => {
    let response: PageResponse
    try {
      const login = await loginWithSmsCode(deps.fetcher, secret, {
        phone: attempt.phone,
        code,
      })
      if (state.current !== attempt || state.generation !== generation) {
        response = jsonFail("验证码请求已过期，请重新获取验证码", 409)
      } else {
        const learned = await learn(deps, login)
        if (state.current !== attempt || state.generation !== generation) {
          response = jsonFail("验证码请求已过期，请重新获取验证码", 409)
        } else {
          complete(signInResult(login, { phone: attempt.phone, ...learned }))
          attempt.status = "completed"
          response = jsonOk()
        }
      }
    } catch (error) {
      response = jsonFail(errorMessage(error))
      if (state.current === attempt && state.generation === generation) attempt.status = "sent"
    }
    attempt.lastVerifyCode = code
    attempt.lastVerifyResponse = response
    delete attempt.verifyPromise
    return response
  })()
  attempt.verifyPromise = operation
  return await operation
}

/** One request from the SMS page. */
async function handleSmsRequest(
  deps: RaccoonLoginDeps,
  secret: string,
  state: SmsState,
  request: PageRequest,
  complete: (result: SignInResult) => void,
): Promise<PageResponse> {
  if (request.method === "POST" && request.path === "/sms") {
    return sendSmsRequest(deps, secret, state, request)
  }
  if (request.method === "POST" && request.path === "/verify") {
    return verifySmsRequest(deps, secret, state, request, complete)
  }
  if (request.method === "GET" && request.path === "/") {
    return { contentType: "text/html; charset=utf-8", body: renderSmsPage() }
  }
  if (request.method === "GET" && request.path === "/captcha") return renderCaptchaPage()
  return notFound()
}

async function startSmsSignIn(deps: RaccoonLoginDeps): Promise<StartedFlow> {
  const secret = phoneCipherSecret(deps.options)
  if (secret === undefined) throw new Error("短信登录需要手机号加密密钥（phoneCipherSecret）")
  const settlement = createSettlement<SignInResult>()
  const state: SmsState = { generation: 0, current: undefined }
  let closed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const close = (immediate = false): void => {
    if (closed) return
    closed = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (immediate) {
      server.close()
      return
    }
    const timer = setTimeout(() => server.close(), 5_000)
    timer.unref?.()
  }

  const server = await PageServer.start(async (request: PageRequest) => {
    if (!settlement.settled) {
      return await handleSmsRequest(deps, secret, state, request, (result) => {
        settlement.settle(result)
        close()
      })
    }
    // A browser may retry the same verify POST after the connection carrying
    // the success response was interrupted. Preserve that idempotent answer,
    // but do not report success for a different code after settlement.
    if (
      request.method === "POST" &&
      request.path === "/verify" &&
      state.current?.lastVerifyResponse !== undefined
    ) {
      const body = await request.json()
      const code = typeof body.code === "string" ? body.code.trim() : ""
      if (code === state.current.lastVerifyCode) return state.current.lastVerifyResponse
    }
    return jsonFail("登录流程已结束，请重新发起登录", 409)
  })

  timeoutTimer = setTimeout(() => {
    if (settlement.settled) return
    settlement.settle({ type: "failed", error: "登录超时，请重新发起登录" })
    close(true)
  }, deps.signInTimeoutMs ?? RACCOON_SIGN_IN_TIMEOUT_MS)
  timeoutTimer.unref?.()

  return {
    url: server.url,
    instructions: "在浏览器里打开这个地址，用手机号登录",
    done: settlement.promise,
  }
}

// ---- sign-in fallbacks ------------------------------------------------------

/**
 * Where the desktop client keeps its session. The two environment variables
 * are the client's own override; otherwise it is per-OS application data, and
 * on Windows the older `~/.office-raccoon` profile too.
 */
export function desktopAuthCandidates(
  home = homedir(),
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  for (const key of ["RACCOON_BOX_AGENT_CONFIG_DIR", "BOX_AGENT_CONFIG_DIR"]) {
    const dir = String(env[key] ?? "").trim()
    if (dir) return [join(dir, "auth.json")]
  }
  const appData =
    platform === "win32"
      ? String(env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : String(env.XDG_CONFIG_HOME ?? "").trim() || join(home, ".config")
  const profiles = [join(appData, "office-raccoon")]
  if (platform === "win32") profiles.unshift(join(home, ".office-raccoon"))
  return [
    ...profiles.map((dir) => join(dir, "agent", "config", "auth.json")),
    join(home, ".box-agent", "config", "auth.json"),
  ]
}

function stripBearer(value: string | undefined): string {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "")
}

interface DesktopAuth {
  access: string
  refresh?: string
  expires?: number
}

/** Reads the client's own session, without ever writing to its file. */
function readDesktopAuth(): DesktopAuth | undefined {
  for (const path of desktopAuthCandidates()) {
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size <= 0 || st.size > 256 * 1024) continue
      const raw = asObject(JSON.parse(readFileSync(path, "utf8")))
      const access = stripBearer(str(raw?.access_token))
      if (!access) continue
      const refresh = stripBearer(str(raw?.refresh_token))
      const expires = jwtExpiresAtMs(access)
      return {
        access,
        ...(refresh ? { refresh } : {}),
        ...(expires === undefined ? {} : { expires }),
      }
    } catch {
      // A missing or unreadable file is just another candidate to try.
    }
  }
  return undefined
}

function authorizeUrl(state: string): string {
  const url = new URL(RACCOON_PATHS.authorize, RACCOON_API_BASE)
  url.searchParams.set("login_source", "desktop")
  url.searchParams.set("appname", "办公小浣熊客户端")
  url.searchParams.set("state", state)
  return url.toString()
}

type Pasted = { direct?: RaccoonLogin; code?: string }

/** What the user pasted: a token, a JSON session, or the callback link. */
function parsePasted(raw: string, expectedState: string): Pasted {
  const text = String(raw ?? "").trim()
  if (!text) throw new Error("请输入回调链接或 Token")
  if (text.startsWith("{")) {
    const obj = asObject(JSON.parse(text))
    const access = stripBearer(str(obj?.access_token) ?? str(obj?.accessToken))
    if (!access) throw new Error("JSON 中缺少 access_token")
    const refresh = stripBearer(str(obj?.refresh_token) ?? str(obj?.refreshToken))
    return {
      direct: {
        access,
        ...(refresh ? { refresh } : {}),
        ...(jwtExpiresAtMs(access) === undefined ? {} : { expires: jwtExpiresAtMs(access) }),
      },
    }
  }
  if (text.split(".").length === 3 && !text.includes("://")) {
    const access = stripBearer(text)
    return {
      direct: {
        access,
        ...(jwtExpiresAtMs(access) === undefined ? {} : { expires: jwtExpiresAtMs(access) }),
      },
    }
  }
  const url = new URL(text)
  const code = (url.searchParams.get("code") ?? "").trim()
  if (!code) throw new Error("回调链接中缺少授权码 code")
  const state = (url.searchParams.get("state") ?? "").trim()
  if (expectedState && state && state !== expectedState) {
    throw new Error("回调链接 state 不匹配，请使用本次打开页面产生的回调链接")
  }
  return { code }
}

/**
 * Two ways out when the QR sign-in cannot be used: the desktop client's
 * session on this machine, and a token or callback link pasted by hand.
 * Neither needs the phone cipher key, so both are always offered.
 */
export function fallbackMethods(deps: RaccoonLoginDeps): AuthMethod[] {
  return [
    {
      type: "oauth",
      label: "商汤小浣熊桌面端登录态（读取本机客户端）",
      async authorize() {
        return {
          url: "",
          instructions: "直接复用本机商汤小浣熊客户端的实时登录态（只读，不写入桌面端文件）。",
          method: "auto" as const,
          async callback() {
            const found = readDesktopAuth()
            if (found === undefined) {
              return {
                type: "failed" as const,
                error: `未检测到本机商汤小浣熊登录态（已查找 ${desktopAuthCandidates().join("、")}）`,
              }
            }
            if (found.refresh === undefined && found.expires !== undefined && found.expires <= Date.now()) {
              return {
                type: "failed" as const,
                error: "商汤小浣熊桌面端登录态已过期，请先打开商汤小浣熊客户端重新登录",
              }
            }
            return signInResult(found, await learn(deps, found))
          },
        }
      },
    },
    {
      type: "oauth",
      label: "手动粘贴回调链接或 Token（非短信验证码）",
      async authorize() {
        const state = randomHex(32)
        return {
          url: authorizeUrl(state),
          instructions:
            "在浏览器完成商汤小浣熊登录后，复制地址栏或弹窗跳转的 office-raccoon://auth/callback?code=... 链接粘贴到下方（也支持直接粘贴 JWT access_token 或 JSON 登录态）：",
          method: "code" as const,
          async callback(input) {
            try {
              const pasted = parsePasted(input ?? "", state)
              const login = pasted.direct ?? (await exchangeAuthorizationCode(deps.fetcher, pasted.code ?? ""))
              return signInResult(login, await learn(deps, login))
            } catch (error) {
              return { type: "failed" as const, error: errorMessage(error) }
            }
          },
        }
      },
    },
  ]
}

/** The methods, as the host wants them. */
export function loginMethods(deps: RaccoonLoginDeps): AuthMethod[] {
  const methods: AuthMethod[] = [
    {
      type: "oauth",
      label: "微信扫码登录",
      async authorize() {
        const flow = await startQrSignIn(deps)
        return { url: flow.url, instructions: flow.instructions, method: "auto", callback: () => flow.done }
      },
    },
  ]
  if (phoneCipherSecret(deps.options) !== undefined) {
    methods.push({
      type: "oauth",
      label: "短信验证码登录",
      async authorize() {
        const flow = await startSmsSignIn(deps)
        return { url: flow.url, instructions: flow.instructions, method: "auto", callback: () => flow.done }
      },
    })
  }
  return methods.concat(fallbackMethods(deps))
}
