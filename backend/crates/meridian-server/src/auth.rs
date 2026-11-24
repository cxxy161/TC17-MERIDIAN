//! 账号与会话：argon2id 口令哈希、随机会话令牌、Cookie 读写、登录限流、Turnstile 校验。
//!
//! 设计要点（见 docs/MULTIPLAYER_AUDIT.md）：
//! - 会话只存 token 的 SHA-256，数据库泄露也拿不到可用令牌
//! - 口令用 argon2id 默认参数（m=19 MiB, t=2, p=1），哈希计算放 spawn_blocking 且全局并发 1
//! - Cookie: HttpOnly + SameSite=Lax；Secure 按请求的 X-Forwarded-Proto 判断（可用环境变量强制）
//! - 客户端 IP 只在直连 peer 属于可信反代（MERIDIAN_TRUSTED_PROXIES）时才采信 XFF，
//!   且只取最右一跳；否则一律使用 peer IP，根除「伪造 XFF 绕过限流」与「全体共用一个桶」

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
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

/// 极简内存限流：全局注册令牌桶（容量 5，2 次/分钟）+ 每 IP 桶 + 每账号登录失败计数。
/// 单实例、2C/500MB 场景下不需要 Redis。
///
/// 所有内部表都有硬上限：伪造来源（大量不同 IP / 邮箱）只能淘汰旧条目，
/// 不能把内存撑爆；淘汰会打 warn 日志便于观测。
#[derive(Default)]
pub struct AuthLimiter {
    global_register: Mutex<HashMap<&'static str, Bucket>>,
    per_ip: Mutex<HashMap<String, Bucket>>,
    login_fail: Mutex<HashMap<String, LoginFailState>>,
}

const GLOBAL_REGISTER_CAPACITY: f64 = 5.0;
const GLOBAL_REGISTER_RATE: f64 = 2.0 / 60.0;
const REGISTER_PER_IP_CAPACITY: f64 = 3.0;
const REGISTER_PER_IP_WINDOW: f64 = 3600.0;
const LOGIN_PER_IP_CAPACITY: f64 = 10.0;
const LOGIN_PER_IP_WINDOW: f64 = 60.0;

/// 每 IP 限流表上限（键数）。
const MAX_TRACKED_IPS: usize = 4096;
/// 登录失败计数表上限（账号数）。
const MAX_TRACKED_ACCOUNTS: usize = 4096;
/// 空闲超过该时长的条目可被清理（秒）。
const IDLE_TTL_SECS: f64 = 600.0;

/// 同一账号连续登录失败多少次后锁定。
pub const ACCOUNT_FAIL_LIMIT: u32 = 5;
/// 账号锁定持续时间（秒）。
pub const ACCOUNT_LOCK_SECS: i64 = 300;
/// 失败计数窗口：最后一次失败超过该时长后计数清零（秒）。
const ACCOUNT_FAIL_WINDOW_SECS: f64 = 900.0;

#[derive(Debug, Clone, Copy)]
struct LoginFailState {
    failures: u32,
    locked_until: i64,
    last_failure: f64,
}

fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 淘汰日志节流：攻击者持续制造新键时避免每个请求一行日志把磁盘打满。
static LAST_PRUNE_WARN_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn should_log_prune() -> bool {
    let now = now_secs().max(0) as u64;
    let last = LAST_PRUNE_WARN_SECS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 60 {
        return false;
    }
    LAST_PRUNE_WARN_SECS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
}

fn prune_ip_buckets(map: &mut HashMap<String, Bucket>, now: f64) {
    if map.len() <= MAX_TRACKED_IPS {
        return;
    }
    let before = map.len();
    map.retain(|_, b| now - b.last <= IDLE_TTL_SECS);
    if map.len() > MAX_TRACKED_IPS {
        let mut by_age: Vec<(String, f64)> = map.iter().map(|(k, b)| (k.clone(), b.last)).collect();
        by_age.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let excess = map.len() - MAX_TRACKED_IPS;
        for (key, _) in by_age.into_iter().take(excess) {
            map.remove(&key);
        }
    }
    if should_log_prune() {
        tracing::warn!(
            before,
            after = map.len(),
            cap = MAX_TRACKED_IPS,
            "每 IP 限流表超过上限，已淘汰最久未使用条目"
        );
    }
}

fn prune_account_failures(map: &mut HashMap<String, LoginFailState>, now: i64) {
    if map.len() <= MAX_TRACKED_ACCOUNTS {
        return;
    }
    let before = map.len();
    map.retain(|_, st| st.locked_until > now || (now as f64 - st.last_failure) <= IDLE_TTL_SECS);
    if map.len() > MAX_TRACKED_ACCOUNTS {
        let mut by_age: Vec<(String, f64)> =
            map.iter().map(|(k, st)| (k.clone(), st.last_failure)).collect();
        by_age.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let excess = map.len() - MAX_TRACKED_ACCOUNTS;
        for (key, _) in by_age.into_iter().take(excess) {
            map.remove(&key);
        }
    }
    if should_log_prune() {
        tracing::warn!(
            before,
            after = map.len(),
            cap = MAX_TRACKED_ACCOUNTS,
            "登录失败计数表超过上限，已淘汰最久未使用账号"
        );
    }
}

impl AuthLimiter {
    pub fn check_register(&self, ip: &str) -> Result<(), String> {
        let now = now_secs() as f64;
        {
            let mut global = lock_or_recover(&self.global_register);
            let bucket = global
                .entry("register")
                .or_insert_with(|| Bucket::new(GLOBAL_REGISTER_CAPACITY, now));
            if !bucket.take(GLOBAL_REGISTER_CAPACITY, GLOBAL_REGISTER_RATE, now) {
                return Err("全站注册频率已达上限，请稍后再试".to_string());
            }
        }

        let mut per_ip = lock_or_recover(&self.per_ip);
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
        prune_ip_buckets(&mut per_ip, now);
        Ok(())
    }

    pub fn check_login(&self, ip: &str) -> Result<(), String> {
        let now = now_secs() as f64;
        let mut per_ip = lock_or_recover(&self.per_ip);
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
        prune_ip_buckets(&mut per_ip, now);
        Ok(())
    }

    /// 账号当前是否处于失败锁定中；返回解锁时间戳。
    pub fn account_lock_until(&self, account: &str) -> Option<i64> {
        let now = now_secs();
        let map = lock_or_recover(&self.login_fail);
        match map.get(account) {
            Some(st) if st.locked_until > now => Some(st.locked_until),
            _ => None,
        }
    }

    /// 记录一次失败；达到阈值时返回新的锁定时间戳（同时开始 5 分钟锁定）。
    pub fn record_login_failure(&self, account: &str) -> Option<i64> {
        let now_ts = now_secs();
        let now = now_ts as f64;
        let mut map = lock_or_recover(&self.login_fail);
        let locked = {
            let st = map.entry(account.to_string()).or_insert(LoginFailState {
                failures: 0,
                locked_until: 0,
                last_failure: now,
            });
            if st.locked_until > now_ts {
                // 锁定期内继续失败：保持原锁定，不叠加计数
                return Some(st.locked_until);
            }
            if st.locked_until != 0 {
                // 上一轮锁定刚结束，重新计数
                st.locked_until = 0;
                st.failures = 0;
            }
            if now - st.last_failure > ACCOUNT_FAIL_WINDOW_SECS {
                st.failures = 0;
            }
            st.failures += 1;
            st.last_failure = now;
            if st.failures >= ACCOUNT_FAIL_LIMIT {
                st.failures = 0;
                st.locked_until = now_ts + ACCOUNT_LOCK_SECS;
                Some(st.locked_until)
            } else {
                None
            }
        };
        prune_account_failures(&mut map, now_ts);
        locked
    }

    /// 登录成功后清零该账号的失败计数。
    pub fn clear_login_failures(&self, account: &str) {
        let mut map = lock_or_recover(&self.login_fail);
        map.remove(account);
    }

    /// 当前跟踪的 IP 桶数量（测试/观测用）。
    pub fn tracked_ip_count(&self) -> usize {
        lock_or_recover(&self.per_ip).len()
    }

    /// 当前跟踪的登录失败账号数量（测试/观测用）。
    pub fn tracked_account_count(&self) -> usize {
        lock_or_recover(&self.login_fail).len()
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

/* ------------------------------------------------- 客户端 IP / 可信反代 */

/// 拿不到 peer 信息时使用的占位来源，**不是**真实 IP。
///
/// 生产入口 main.rs 用 into_make_service_with_connect_info::<SocketAddr>()
/// 注入 peer 地址，真实请求不会落到这里；只有测试或嵌入式调用才会。
pub const UNKNOWN_CLIENT: &str = "unknown";

#[derive(Debug, Clone, Copy)]
struct Cidr {
    net: IpAddr,
    prefix: u8,
}

/// MERIDIAN_TRUSTED_PROXIES（逗号分隔 CIDR）解析结果，进程内只读一次。
static TRUSTED_PROXIES: LazyLock<Vec<Cidr>> = LazyLock::new(|| {
    let raw = std::env::var("MERIDIAN_TRUSTED_PROXIES").unwrap_or_default();
    let mut out = Vec::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        match parse_cidr(item) {
            Some(cidr) => out.push(cidr),
            None => tracing::warn!(entry = item, "MERIDIAN_TRUSTED_PROXIES 含无效 CIDR，已忽略"),
        }
    }
    out
});

static WARNED_NO_PEER: AtomicBool = AtomicBool::new(false);

fn parse_cidr(s: &str) -> Option<Cidr> {
    let (ip_part, prefix_part) = match s.split_once('/') {
        Some((ip, p)) => (ip, Some(p)),
        None => (s, None),
    };
    let net: IpAddr = ip_part.trim().parse().ok()?;
    let max = if net.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix_part {
        Some(p) => p.trim().parse::<u8>().ok().filter(|p| *p <= max)?,
        None => max,
    };
    Some(Cidr { net, prefix })
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        // 双栈 listener 可能把 IPv4 客户端报告成 ::ffff:a.b.c.d
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        IpAddr::V4(_) => ip,
    }
}

fn cidr_contains(cidr: Cidr, ip: IpAddr) -> bool {
    match (normalize_ip(cidr.net), normalize_ip(ip)) {
        (IpAddr::V4(net), IpAddr::V4(ip)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(cidr.prefix)).unwrap_or(0);
            (u32::from(net) & mask) == (u32::from(ip) & mask)
        }
        (IpAddr::V6(net), IpAddr::V6(ip)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(cidr.prefix)).unwrap_or(0);
            (u128::from(net) & mask) == (u128::from(ip) & mask)
        }
        _ => false,
    }
}

fn resolve_client_ip(headers: &HeaderMap, peer: Option<IpAddr>, proxies: &[Cidr]) -> String {
    let Some(peer) = peer else {
        if !WARNED_NO_PEER.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "请求缺少 ConnectInfo，无法校验 peer IP；X-Forwarded-For 一律忽略（测试/嵌入式调用）"
            );
        }
        return UNKNOWN_CLIENT.to_string();
    };
    let peer = normalize_ip(peer);
    if proxies.iter().any(|c| cidr_contains(*c, peer)) {
        // 只信最右一跳：这是可信反代覆盖写入的那一项，左侧可被客户端伪造。
        if let Some(real) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next_back())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return real.to_string();
        }
    }
    peer.to_string()
}

/// 请求来源 IP。
///
/// - 仅当直连 peer 属于 MERIDIAN_TRUSTED_PROXIES（逗号分隔 CIDR）时才采信
///   X-Forwarded-For，并取**最右一跳**（由可信反代覆盖写入）；
/// - 否则一律使用 peer IP，客户端自带的 XFF 被忽略；
/// - 没有 ConnectInfo（测试/嵌入式调用）时返回 UNKNOWN_CLIENT，
///   不会把全部请求折叠成同一个可被利用的共享桶（生产路径由 main.rs 注入 peer）。
pub fn client_ip(headers: &HeaderMap, peer: Option<ConnectInfo<SocketAddr>>) -> String {
    resolve_client_ip(headers, peer.map(|ci| ci.0.ip()), &TRUSTED_PROXIES)
}

/// 可选 peer 地址提取器：没有 ConnectInfo（例如 Router::oneshot 测试）时降级为 None，
/// 而不是让整个 handler 拒绝请求。
#[derive(Debug, Clone, Copy)]
pub struct ClientAddr(pub Option<SocketAddr>);

impl ClientAddr {
    /// 转成 client_ip() 需要的 ConnectInfo 形态。
    pub fn connect_info(self) -> Option<ConnectInfo<SocketAddr>> {
        self.0.map(ConnectInfo)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ClientAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let addr = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0)
            .or_else(|| {
                parts
                    .extensions
                    .get::<axum::extract::connect_info::MockConnectInfo<SocketAddr>>()
                    .map(|m| m.0)
            });
        Ok(ClientAddr(addr))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_xff(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    fn cidrs(list: &[&str]) -> Vec<Cidr> {
        list.iter().filter_map(|s| parse_cidr(s)).collect()
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn xff_from_untrusted_peer_is_ignored() {
        let proxies = cidrs(&["127.0.0.1/32"]);
        let resolved = resolve_client_ip(
            &headers_with_xff("1.2.3.4"),
            Some(ip("203.0.113.9")),
            &proxies,
        );
        assert_eq!(resolved, "203.0.113.9");
    }

    #[test]
    fn xff_rightmost_hop_used_for_trusted_peer() {
        let proxies = cidrs(&["10.0.0.0/8"]);
        let resolved = resolve_client_ip(
            &headers_with_xff("6.6.6.6, 198.51.100.7"),
            Some(ip("10.1.2.3")),
            &proxies,
        );
        assert_eq!(resolved, "198.51.100.7", "只能采信最右一跳");
    }

    #[test]
    fn trusted_peer_without_xff_uses_peer() {
        let proxies = cidrs(&["127.0.0.1/32"]);
        let resolved = resolve_client_ip(&HeaderMap::new(), Some(ip("127.0.0.1")), &proxies);
        assert_eq!(resolved, "127.0.0.1");
    }

    #[test]
    fn ipv4_mapped_peer_matches_ipv4_cidr() {
        let proxies = cidrs(&["127.0.0.1/32"]);
        let resolved = resolve_client_ip(
            &headers_with_xff("9.9.9.9"),
            Some(ip("::ffff:127.0.0.1")),
            &proxies,
        );
        assert_eq!(resolved, "9.9.9.9");
    }

    #[test]
    fn missing_peer_never_trusts_xff() {
        assert_eq!(
            resolve_client_ip(&headers_with_xff("1.2.3.4"), None, &[]),
            UNKNOWN_CLIENT
        );
    }

    #[test]
    fn cidr_prefix_zero_matches_everything() {
        let proxies = cidrs(&["0.0.0.0/0"]);
        let resolved = resolve_client_ip(
            &headers_with_xff("5.5.5.5"),
            Some(ip("198.51.100.1")),
            &proxies,
        );
        assert_eq!(resolved, "5.5.5.5");
    }

    #[test]
    fn limiter_table_is_bounded() {
        let limiter = AuthLimiter::default();
        for i in 0..(MAX_TRACKED_IPS + 64) {
            let key = format!("198.51.{}.{}", i / 256, i % 256);
            let _ = limiter.check_login(&key);
        }
        assert!(
            limiter.tracked_ip_count() <= MAX_TRACKED_IPS,
            "每 IP 限流表必须有硬上限，实际 {}",
            limiter.tracked_ip_count()
        );
    }

    #[test]
    fn account_locks_after_five_failures_and_clears_on_success() {
        let limiter = AuthLimiter::default();
        let account = "victim@meridian.test";
        for _ in 0..(ACCOUNT_FAIL_LIMIT - 1) {
            assert!(limiter.record_login_failure(account).is_none());
        }
        assert_eq!(limiter.account_lock_until(account), None);
        let until = limiter
            .record_login_failure(account)
            .expect("第 5 次失败应当触发锁定");
        assert!(until > now_secs());
        assert_eq!(limiter.account_lock_until(account), Some(until));
        assert_eq!(
            limiter.record_login_failure(account),
            Some(until),
            "锁定期内继续失败应保持同一解锁时间"
        );

        limiter.clear_login_failures(account);
        assert_eq!(limiter.account_lock_until(account), None);
        assert!(limiter.record_login_failure(account).is_none());
    }
}
