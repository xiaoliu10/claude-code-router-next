import { KIRO_ERROR_CODES } from "./protocol";

const messages: Record<typeof KIRO_ERROR_CODES[number], [string, string]> = {
  kiro_unauthorized: ["Local access required", "仅允许本机访问"],
  kiro_login_invalid: ["Choose a valid sign-in method, HTTPS Start URL and AWS region", "请选择有效登录方式、HTTPS Start URL 和 AWS 区域"],
  kiro_login_unknown: ["Sign-in session not found", "找不到登录会话"],
  kiro_login_expired: ["Sign-in timed out; start again", "登录超时，请重新开始"],
  kiro_login_busy: ["Sign-in is already completing", "正在完成登录"],
  kiro_callback_invalid: ["Callback URL does not match this sign-in", "回调地址与本次登录不匹配"],
  kiro_callback_ports_busy: ["All callback ports are busy; close other sign-in sessions", "所有回调端口均被占用，请关闭其他登录会话"],
  kiro_login_cancelled: ["Sign-in was cancelled or is already complete", "登录已取消或已经完成"],
  kiro_login_failed: ["Sign-in failed; start again", "登录失败，请重新开始"],
  kiro_not_connected: ["No connected Kiro account", "尚未连接 Kiro 账号"],
  kiro_reauth_required: ["Kiro sign-in expired; sign in again", "Kiro 登录已失效，请重新登录"],
  kiro_account_cooling: ["Account is cooling down", "账号冷却中"],
  kiro_persist_failed: ["Could not save Kiro credentials", "无法保存 Kiro 凭据"],
  kiro_config_write_failed: ["Could not update provider configuration", "无法更新提供商配置"],
  kiro_provider_name_conflict: ["Provider name is already in use", "提供商名称已被使用"],
  kiro_credential_invalid: ["Invalid Kiro credential file", "Kiro 凭据文件无效"],
  kiro_credential_unreadable: ["Could not read Kiro credential file", "无法读取 Kiro 凭据文件"],
  kiro_raw_config_required: ["Raw configuration capability required", "需要原始配置读取能力"],
  kiro_upstream_error: ["Kiro service request failed", "Kiro 服务请求失败"],
  kiro_rate_limited: ["Kiro rate limit reached", "已触发 Kiro 限流"],
  kiro_request_failed: ["Kiro management request failed", "Kiro 管理请求失败"],
  kiro_model_unknown: ["Unknown Kiro model", "未知的 Kiro 模型"],
};
export const kiroLocales = {
  en: { kiro: { title: "Kiro Subscription", ...Object.fromEntries(KIRO_ERROR_CODES.map(k => [k, messages[k][0]])) } },
  zh: { kiro: { title: "Kiro 订阅", ...Object.fromEntries(KIRO_ERROR_CODES.map(k => [k, messages[k][1]])) } },
};
