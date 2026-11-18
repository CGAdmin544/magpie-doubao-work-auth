/**
 * 统一的上游错误。
 *
 * 网关按状态码决定故障切换：401 会把账号标记为需要重新登录，429 会换账号，
 * 403/404 当作「模型被拒」。所以这里必须把豆包的错误码映射准确，
 * 否则一个偶发的限流会把整批账号打成失效。
 */
export class ProviderError extends Error {
  constructor(message, status = 502, code = 'upstream_error', extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 豆包网关错误码 → 我们的状态码 */
const CODE_MAP = {
  710012000: [401, 'sign_in_required'], // user invalid
  710012001: [401, 'sign_in_expired'],  // login invalid / 登录已过期
  710010202: [400, 'invalid_param'],    // common invalid param
  710020202: [400, 'invalid_param'],    // 同一类的业务参数拒绝（常见于会话 id 复用）
  710022004: [403, 'captcha_required'], // 风控验证码
  710012004: [429, 'rate_limited'],
};

/**
 * 上游的错误消息对人没什么用（比如风控拦下来也回 "rate limited"），
 * 加上一句能照着做的提示，不然用户只能看到 rate limited 以为是限流。
 */
const CODE_HINT = {
  captcha_required: '豆包要求人工验证：打开 https://www.doubao.com/chat/ 手动发一句话，过掉验证后再试。',
  invalid_param: '豆包拒绝了请求参数。如果反复出现，把 magpie 里这次请求的记录一起发到插件仓库。',
  rate_limited: '豆包侧限流，稍等一会儿再试。',
};

export function upstreamError(payload, fallbackStatus) {
  const code = payload?.error?.code ?? payload?.error_code ?? payload?.code;
  const message = payload?.error?.message ?? payload?.error_msg ?? payload?.message ?? payload?.msg ?? '豆包返回未知错误';
  const [status, ourCode] = CODE_MAP[code] || [fallbackStatus || 502, 'upstream_error'];
  const hint = CODE_HINT[ourCode];
  const text = hint ? `${message}（${hint}）` : String(message);
  const error = new ProviderError(text.slice(0, 500), status, ourCode);
  // 只有登录类错误才让 magpie 标记账号；验证码不标记，避免账号被永久停用
  if (ourCode === 'sign_in_required' || ourCode === 'sign_in_expired') error.signIn = 'expired';
  // 要求人工验证时，换账号或重试都不会变好，反而每次重试都在加深风控。
  // 标成 refused，magpie 就不会再换账号重试（它默认把 403 当可重试）。
  if (ourCode === 'captcha_required') error.refused = text.slice(0, 200);
  return error;
}

export function errorResponse(error) {
  const status = error instanceof ProviderError ? error.status : 502;
  const code = error instanceof ProviderError ? error.code : 'plugin_error';
  const body = {
    error: {
      message: error?.message || '插件内部错误',
      type: code,
      code,
    },
  };
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (error?.signIn) headers['X-Magpie-Sign-In'] = error.signIn;
  // 风控验证和内容拒绝不是「换个账号就能成」的失败。magpie 默认把 403 一律当作
  // 可换账号重试（fallback.go 的 retryable 对 4xx 一律 true），于是同一个请求会连打
  // 五次，每次都撞在验证上，反而把风控状态越堆越高。
  // 带上 X-Magpie-Refused 后，magpie 走 h.refused 分支、不进 retryable，只失败一次。
  // HTTP 头只能是 ASCII，中文说明得编码后再放。
  if (error?.refused) headers['X-Magpie-Refused'] = encodeURIComponent(String(error.refused).slice(0, 200));
  return new Response(JSON.stringify(body), { status, headers });
}
