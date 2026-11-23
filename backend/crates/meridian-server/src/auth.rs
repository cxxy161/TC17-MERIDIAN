//! 账号与会话：argon2id 口令哈希、随机会话令牌、Cookie 读写、登录限流、Turnstile 校验。
//!
//! 设计要点（见 docs/MULTIPLAYER_AUDIT.md）：
//! - 会话只存 token 的 SHA-256，数据库泄露也拿不到可用令牌
//! - 口令用 argon2id 默认参数（m=19 MiB, t=2, p=1），哈希计算放 spawn_blocking 且全局并发 1
//! - Cookie: HttpOnly + SameSite=Lax，Secure 默认开（本地 127.0.0.1 属安全上下文，浏览器仍会存）

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::{header, StatusCode};
use axum::http::request::Parts;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::engine::SharedEngine;
use crate::storage::UserRow;

pub const COOKIE_NAME: &str = "meridian_sid";

/// 全局 argon2 并发闸门：2C 机器上同时只允许一次口令哈希，避免注册/登录打爆 CPU。
pub static HASH_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// 「保持登录」的会话时长（秒）：14 天；否则 12 小时
pub const SESSION_TTL_REMEMBER: i64 = 14 * 24 * 3600;
pub const SESSION_TTL_DEFAULT: i64 = 12 * 3600;

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 生成 (salt_hex, hash_hex)。计算量约 20 ms，调用方必须放在 spawn_blocking 里。
pub fn hash_password(password: &str) -> Result<(String, String), String> {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|e| format!("hash failed: {e}"))?;
    Ok((hex(&salt), hex(&out)))
}

pub fn verify_password(password: &str, salt_hex: &str, hash_hex: &str) -> bool {
    let (Ok(salt), Ok(expected)) = (unhex(salt_hex), unhex(hash_hex)) else {
        return false;
    };
    let mut out = [0u8; 32];
    if Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .is_err()
    {
        return false;
    }
    constant_time_eq(&out, &expected)
}

fn unhex(s: &str) -> Result<Vec<u8>, ()> {
    if s.len() % 2 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16).ok_or(())? as u8;
        let lo = (bytes[i + 1] as char).to_digit(16).ok_or(())? as u8;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 32 字节随机令牌，hex 编码（64 字符）
pub fn new_token() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    hex(&buf)
}

pub fn token_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex(&hasher.finalize())
}

pub fn read_cookie(header_value: Option<&str>, name: &str) -> Option<String> {
    let raw = header_value?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// 是否给 Cookie 加 `Secure`。
///
/// 规则：`MERIDIAN_COOKIE_SECURE` 显式设置时优先（1/true 或 0/false）；
/// 未设置时按请求判断 —— 反代带了 `X-Forwarded-Proto: https` 才加 Secure。
/// 这样裸 HTTP（局域网 IP、内网调试）能正常存下 Cookie，上了 TLS 反代又自动收紧。
pub fn cookie_secure(headers: &axum::http::HeaderMap) -> bool {
    match std::env::var("MERIDIAN_COOKIE_SECURE").as_deref() {
        Ok("0") | Ok("false") => return false,
        Ok("1") | Ok("true") => return true,
        _ => {}
    }
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

pub fn session_cookie(token: &str, ttl_secs: i64, persistent: bool, secure: bool) -> String {
    let mut cookie = format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax");
    if persistent {
        // 勾选「保持登录」：持久化 Cookie，关掉浏览器也在
        cookie.push_str(&format!("; Max-Age={ttl_secs}"));
    }
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

pub fn clear_cookie(secure: bool) -> String {
    format!(
        "{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

/* ------------------------------------------------------------ 限流 */

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last: f64,
}

impl Bucket {
    fn new(capacity: f64, now: f64) -> Self {
        Self {
            tokens: capacity,
            last: now,
        }
    }

    fn take(&mut self, capacity: f64, rate_per_sec: f64, now: f64) -> bool {
        let elapsed = (now - self.last).max(0.0);
        self.tokens = (self.tokens + elapsed * rate_per_sec).min(capacity);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// 极简内存限流：全局注册令牌桶（容量 5，2 次/分钟）+ 每 IP 桶。
/// 单实例、2C/500MB 场景下不需要 Redis。
#[derive(Default)]
pub struct AuthLimiter {
    global_register: Mutex<HashMap<&'static str, Bucket>>,
    per_ip: Mutex<HashMap<String, Bucket>>,
}

const GLOBAL_REGISTER_CAPACITY: f64 = 5.0;
const GLOBAL_REGISTER_RATE: f64 = 2.0 / 60.0;
const REGISTER_PER_IP_CAPACITY: f64 = 3.0;
const REGISTER_PER_IP_WINDOW: f64 = 3600.0;
const LOGIN_PER_IP_CAPACITY: f64 = 10.0;
const LOGIN_PER_IP_WINDOW: f64 = 60.0;

impl AuthLimiter {
    pub fn check_register(&self, ip: &str) -> Result<(), String> {
        let now = now_secs() as f64;
        let mut global = self.global_register.lock().unwrap();
        let bucket = global
            .entry("register")
            .or_insert_with(|| Bucket::new(GLOBAL_REGISTER_CAPACITY, now));
        if !bucket.take(GLOBAL_REGISTER_CAPACITY, GLOBAL_REGISTER_RATE, now) {
            return Err("全站注册频率已达上限，请稍后再试".to_string());
        }
        drop(global);

        let mut per_ip = self.per_ip.lock().unwrap();
        let entry = per_ip
            .entry(format!("reg:{ip}"))
            .or_insert_with(|| Bucket::new(REGISTER_PER_IP_CAPACITY, now));
        if !entry.take(
            REGISTER_PER_IP_CAPACITY,
            REGISTER_PER_IP_CAPACITY / REGISTER_PER_IP_WINDOW,
            now,
        ) {
            return Err("该 IP 注册过于频繁，请稍后再试".to_string());
        }
        Ok(())
    }

    pub fn check_login(&self, ip: &str) -> Result<(), String> {
        let now = now_secs() as f64;
        let mut per_ip = self.per_ip.lock().unwrap();
        let entry = per_ip
            .entry(format!("login:{ip}"))
            .or_insert_with(|| Bucket::new(LOGIN_PER_IP_CAPACITY, now));
        if !entry.take(
            LOGIN_PER_IP_CAPACITY,
            LOGIN_PER_IP_CAPACITY / LOGIN_PER_IP_WINDOW,
            now,
        ) {
            return Err("登录尝试过于频繁，请稍后再试".to_string());
        }
        Ok(())
    }
}

/* ------------------------------------------------------ Turnstile 校验 */

/// 未配置 secret 时直接放行（本地开发）；配置后调用 Cloudflare siteverify。
pub async fn verify_turnstile(token: &str, remote_ip: Option<&str>) -> Result<(), String> {
    let secret = match std::env::var("MERIDIAN_TURNSTILE_SECRET") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => return Ok(()),
    };
    if token.trim().is_empty() {
        return Err("缺少人机验证令牌".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| format!("turnstile client: {e}"))?;
    let mut form = vec![("secret", secret.as_str()), ("response", token)];
    if let Some(ip) = remote_ip {
        form.push(("remoteip", ip));
    }
    let resp = client
        .post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("turnstile verify failed: {e}"))?;
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("turnstile bad response: {e}"))?;
    if body.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(())
    } else {
        Err("人机验证未通过".to_string())
    }
}

/// 请求来源 IP：优先 X-Forwarded-For（反代场景），否则退化为 "local"。
/// 生产部署时 Caddy/nginx 必须覆盖写入该头，避免客户端伪造。
pub fn client_ip(headers: &axum::http::HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

/* --------------------------------------------------------- 鉴权提取器 */

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user: UserRow,
    pub session_id: i64,
}

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.user.role == "admin"
    }
}

impl FromRequestParts<SharedEngine> for AuthUser {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedEngine,
    ) -> Result<Self, Self::Rejection> {
        let cookie = parts
            .headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok());
        let token = read_cookie(cookie, COOKIE_NAME)
            .ok_or((StatusCode::UNAUTHORIZED, "未登录：缺少会话 Cookie".to_string()))?;
        let hash = token_hash(&token);
        let eng = state.lock().await;
        let Some((session, user)) = eng.store.session_by_token_hash(&hash) else {
            return Err((StatusCode::UNAUTHORIZED, "会话无效或已过期".to_string()));
        };
        if session.expires_at <= now_secs() {
            let _ = eng.store.delete_session(session.id);
            return Err((StatusCode::UNAUTHORIZED, "会话已过期".to_string()));
        }
        if user.status != "active" {
            return Err((StatusCode::FORBIDDEN, "账号已被禁用".to_string()));
        }
        let _ = eng.store.touch_session(session.id, now_secs());
        Ok(AuthUser {
            user,
            session_id: session.id,
        })
    }
}

/// 仅管理员可用；非管理员一律 403。
pub struct AdminUser(pub AuthUser);

impl FromRequestParts<SharedEngine> for AdminUser {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedEngine,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if !user.is_admin() {
            return Err((StatusCode::FORBIDDEN, "需要管理员权限".to_string()));
        }
        Ok(AdminUser(user))
    }
}

/// 归属校验：管理员放行，否则必须是自己名下的公司。
pub fn ensure_owner(user: &AuthUser, company_id: &str) -> Result<(), (StatusCode, String)> {
    if user.is_admin() || user.user.company_id == company_id {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            format!("公司 '{company_id}' 不属于当前账号"),
        ))
    }
}
