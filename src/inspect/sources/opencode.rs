//! Authenticated GET-only OpenCode activity observation.

use super::scope::source_error;
use crate::inspect::model::*;
use crate::process::now;
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    env, fs,
    io::Read,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

const API_REQUEST_TIMEOUT_MS: u64 = 1_800;
const API_RESPONSE_LIMIT: usize = 512 * 1024;
const SERVICE_FILE_LIMIT: u64 = 64 * 1024;
const ACTIVITY_TTL_MS: u64 = 4_500;

struct ApiEndpoint {
    base: String,
    headers: Vec<(String, String)>,
    secrets: Vec<String>,
}

fn discover_api(secrets: &mut Vec<String>) -> Result<ApiEndpoint> {
    if let Ok(explicit) = env::var("AVEN_DISPATCH_OPENCODE_URL") {
        if explicit.is_empty() {
            bail!("explicit OpenCode service URL is empty");
        }
        let url = validate_origin(&explicit, false)?;
        let headers = explicit_auth(secrets)?;
        return Ok(ApiEndpoint {
            base: url,
            headers,
            secrets: secrets.clone(),
        });
    }
    let file = env::var_os("AVEN_DISPATCH_OPENCODE_SERVICE_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(default_service_file);
    let metadata = fs::metadata(&file).with_context(|| {
        format!(
            "no existing OpenCode service registration at {}",
            file.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() > SERVICE_FILE_LIMIT {
        bail!("OpenCode service registration is not a bounded file");
    }
    let raw = fs::read_to_string(&file).context("read OpenCode service registration")?;
    let registration: Value =
        serde_json::from_str(&raw).context("OpenCode service registration is not JSON")?;
    let url = registration
        .get("url")
        .and_then(Value::as_str)
        .context("OpenCode service registration is missing url")?;
    let base = validate_origin(url, true)?;
    let password = registration
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut headers = Vec::new();
    if !password.is_empty() {
        if password.len() > 4096 {
            bail!("OpenCode service password is not bounded");
        }
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("opencode:{password}").as_bytes());
        headers.push(("authorization".into(), format!("Basic {encoded}")));
        if !secrets.iter().any(|secret| secret == password) {
            secrets.push(password.to_owned());
        }
    }
    Ok(ApiEndpoint {
        base,
        headers,
        secrets: secrets.clone(),
    })
}

fn explicit_auth(secrets: &mut Vec<String>) -> Result<Vec<(String, String)>> {
    if let Ok(authorization) = env::var("AVEN_DISPATCH_OPENCODE_AUTHORIZATION") {
        if authorization.is_empty() || authorization.len() > 8192 {
            bail!("explicit OpenCode authorization header is not bounded");
        }
        return Ok(vec![("authorization".into(), authorization)]);
    }
    if let Ok(token) = env::var("AVEN_DISPATCH_OPENCODE_TOKEN") {
        if token.is_empty() || token.len() > 8192 {
            bail!("explicit OpenCode token is not bounded");
        }
        return Ok(vec![("authorization".into(), format!("Bearer {token}"))]);
    }
    if let Ok(password) = env::var("AVEN_DISPATCH_OPENCODE_PASSWORD") {
        if password.is_empty() || password.len() > 4096 {
            bail!("explicit OpenCode password is not bounded");
        }
        if !secrets.iter().any(|secret| secret == &password) {
            secrets.push(password.clone());
        }
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("opencode:{password}").as_bytes());
        return Ok(vec![("authorization".into(), format!("Basic {encoded}"))]);
    }
    Ok(Vec::new())
}

fn default_service_file() -> PathBuf {
    let base = env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local/state"))
        })
        .unwrap_or_else(|| PathBuf::from(".local/state"));
    base.join("opencode/service.json")
}

fn validate_origin(value: &str, require_loopback: bool) -> Result<String> {
    if value.len() > 2048 {
        bail!("OpenCode service origin is not bounded");
    }
    let url = Url::parse(value).context("OpenCode service origin is not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("OpenCode service origin must use http or https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("OpenCode service origin must not embed credentials");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        bail!("OpenCode service origin must not carry a path, query or fragment");
    }
    if require_loopback
        && !matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        )
    {
        bail!("discovered OpenCode service is not a loopback endpoint");
    }
    Ok(url.origin().ascii_serialization())
}

fn allowed_api_read(path: &str) -> bool {
    if path == "/openapi.json" || path == "/api/session/active" {
        return true;
    }
    let Some(rest) = path.strip_prefix("/api/session/") else {
        return false;
    };
    let mut parts = rest.split('/');
    let Some(session_id) = parts.next() else {
        return false;
    };
    if !valid_session_id(session_id) {
        return false;
    }
    match parts.next() {
        None => parts.next().is_none(),
        Some("permission" | "form") => parts.next().is_none(),
        Some(_) => false,
    }
}

struct ApiClient {
    agent: ureq::Agent,
    base: String,
    headers: Vec<(String, String)>,
    capabilities: BTreeSet<String>,
    secrets: Vec<String>,
}

enum ApiError {
    NotFound,
    Other(String),
}

impl ApiClient {
    fn connect(mut endpoint: ApiEndpoint) -> Result<Self> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(API_REQUEST_TIMEOUT_MS))
            .redirects(0)
            .build();
        let mut client = Self {
            agent,
            base: endpoint.base,
            headers: endpoint.headers,
            capabilities: BTreeSet::new(),
            secrets: std::mem::take(&mut endpoint.secrets),
        };
        let schema = client.get("/openapi.json").map_err(|error| {
            anyhow!(
                "OpenCode capability discovery unavailable: {}",
                describe_api_error(error, &client.secrets)
            )
        })?;
        let paths = schema
            .get("paths")
            .and_then(Value::as_object)
            .context("OpenCode OpenAPI payload has no paths")?;
        for (path, value) in paths {
            if value.get("get").is_some() {
                client.capabilities.insert(path.clone());
            }
        }
        Ok(client)
    }

    fn supports(&self, path: &str) -> bool {
        self.capabilities.contains(path)
    }

    fn get(&self, path: &str) -> Result<Value, ApiError> {
        if !allowed_api_read(path) {
            return Err(ApiError::Other("non-allowlisted API read".into()));
        }
        let mut request = self.agent.get(&format!("{}{path}", self.base));
        for (name, value) in &self.headers {
            request = request.set(name, value);
        }
        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(404, _) => ApiError::NotFound,
            other => ApiError::Other(api_error(other, &self.secrets)),
        })?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(ApiError::Other(format!(
                "API returned unsupported status {status}"
            )));
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take((API_RESPONSE_LIMIT + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|error| {
                ApiError::Other(sanitize(
                    &format!("read API response: {error}"),
                    200,
                    &self.secrets,
                ))
            })?;
        if body.len() > API_RESPONSE_LIMIT {
            return Err(ApiError::Other("API response exceeded the bound".into()));
        }
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::Other("API returned malformed JSON".into()))
    }

    fn get_until(&self, path: &str, deadline: Instant) -> Result<Value, ApiError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ApiError::Other("API read budget exhausted".into()));
        }
        if !allowed_api_read(path) {
            return Err(ApiError::Other("non-allowlisted API read".into()));
        }
        let mut request = self
            .agent
            .get(&format!("{}{path}", self.base))
            .timeout(remaining.min(Duration::from_millis(API_REQUEST_TIMEOUT_MS)));
        for (name, value) in &self.headers {
            request = request.set(name, value);
        }
        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(404, _) => ApiError::NotFound,
            other => ApiError::Other(api_error(other, &self.secrets)),
        })?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(ApiError::Other(format!(
                "API returned unsupported status {status}"
            )));
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take((API_RESPONSE_LIMIT + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|error| {
                ApiError::Other(sanitize(
                    &format!("read API response: {error}"),
                    200,
                    &self.secrets,
                ))
            })?;
        if body.len() > API_RESPONSE_LIMIT {
            return Err(ApiError::Other("API response exceeded the bound".into()));
        }
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::Other("API returned malformed JSON".into()))
    }
}

fn api_error(error: ureq::Error, secrets: &[String]) -> String {
    match error {
        ureq::Error::Status(status, _) => format!("API returned status {status}"),
        ureq::Error::Transport(error) => {
            sanitize(&format!("API transport unavailable: {error}"), 200, secrets)
        }
    }
}

fn describe_api_error(error: ApiError, secrets: &[String]) -> String {
    match error {
        ApiError::NotFound => "API returned status 404".into(),
        ApiError::Other(message) => sanitize(&message, 200, secrets),
    }
}

pub(super) fn read_api_activity(
    sessions: &mut [SessionRecord],
    secrets: &[String],
) -> SourceHealth {
    if sessions.is_empty() {
        return SourceHealth::ok(
            "opencode",
            "No linked execution sessions; the API was not queried.",
        );
    }
    let mut known = secrets.to_vec();
    let deadline = Instant::now() + Duration::from_millis(SOURCE_TIMEOUT_MS);
    let endpoint = match discover_api(&mut known) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode is optional and unavailable; API activity stays unknown and no service was started: {}",
                    source_error(&error, secrets)
                ),
            );
        }
    };
    let client = match ApiClient::connect(endpoint) {
        Ok(client) => client,
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode is optional and unavailable; API activity stays unknown and no service was started: {}",
                    source_error(&error, secrets)
                ),
            );
        }
    };
    if !client.supports("/api/session/active") || !client.supports("/api/session/{sessionID}") {
        return SourceHealth::unavailable(
            "opencode",
            "Installed OpenCode service lacks the required activity/session GET endpoints; API activity unknown.",
        );
    }
    let active = match client.get_until("/api/session/active", deadline) {
        Ok(value) => value
            .get("data")
            .cloned()
            .unwrap_or(value)
            .as_object()
            .map(|values| {
                values
                    .iter()
                    .filter(|(_, value)| {
                        value.get("type").and_then(Value::as_str) == Some("running")
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default(),
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode activity endpoint unavailable; API activity stays unknown: {}",
                    describe_api_error(error, &client.secrets)
                ),
            );
        }
    };
    let observed_at = now();
    let expires_at = observed_at.saturating_add(ACTIVITY_TTL_MS);
    let next = AtomicUsize::new(0);
    let failures = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    thread::scope(|thread_scope| {
        for _ in 0..SOURCE_WORKERS.min(sessions.len().max(1)) {
            thread_scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(session) = sessions.get(index) else {
                        break;
                    };
                    if Instant::now() >= deadline {
                        break;
                    }
                    let result = read_one_activity(&client, &session.session_id, &active, deadline);
                    if result.is_err() {
                        failures.fetch_add(1, Ordering::SeqCst);
                    }
                    results
                        .lock()
                        .expect("API result lock")
                        .push((index, result));
                }
            });
        }
    });
    for (index, result) in results.into_inner().expect("API result lock") {
        match result {
            Ok(mut activity) => {
                activity.observed_at_ms = observed_at;
                activity.expires_at_ms = expires_at;
                sessions[index].api = activity;
            }
            Err(_) => {
                sessions[index].api = ApiActivity {
                    freshness: Freshness::Unknown,
                    ..ApiActivity::unknown()
                };
            }
        }
    }
    let failures = failures.load(Ordering::SeqCst);
    let remaining = sessions
        .iter()
        .filter(|session| session.api.observed_at_ms == 0)
        .count();
    if failures > 0 || remaining > 0 {
        SourceHealth::incomplete(
            "opencode",
            format!(
                "Linked API activity partially unavailable ({} failed, {} not observed); unknown is never reported as idle.",
                failures, remaining
            ),
        )
    } else {
        SourceHealth::ok(
            "opencode",
            format!(
                "Authenticated GET-only V2 activity for {} linked session(s); live activity expires after {} ms.",
                sessions.len(),
                ACTIVITY_TTL_MS
            ),
        )
    }
}

fn read_one_activity(
    client: &ApiClient,
    session_id: &str,
    active: &BTreeSet<String>,
    deadline: Instant,
) -> Result<ApiActivity, ApiError> {
    let info = match client.get_until(&format!("/api/session/{session_id}"), deadline) {
        Ok(info) => info,
        Err(ApiError::NotFound) => {
            return Ok(ApiActivity {
                state: ApiState::Missing,
                freshness: Freshness::Current,
                observed_at_ms: now(),
                expires_at_ms: now().saturating_add(ACTIVITY_TTL_MS),
                approval_waiting: Tri::Unknown,
                input_waiting: Tri::Unknown,
                parent_id: None,
            });
        }
        Err(error) => return Err(error),
    };
    let data = info.get("data").unwrap_or(&info);
    let returned_id = data.get("id").and_then(Value::as_str).unwrap_or_default();
    if returned_id != session_id {
        return Err(ApiError::Other(
            "API returned a mismatched session identity".into(),
        ));
    }
    let parent_id = data
        .get("parentID")
        .and_then(Value::as_str)
        .filter(|value| valid_session_id(value))
        .map(str::to_owned);
    let mut activity = ApiActivity {
        state: if active.contains(session_id) {
            ApiState::Working
        } else {
            ApiState::Idle
        },
        freshness: Freshness::Current,
        observed_at_ms: now(),
        expires_at_ms: now().saturating_add(ACTIVITY_TTL_MS),
        approval_waiting: Tri::Unknown,
        input_waiting: Tri::Unknown,
        parent_id,
    };
    if Instant::now() < deadline && client.supports("/api/session/{sessionID}/permission") {
        activity.approval_waiting = waiting_facet(
            client,
            &format!("/api/session/{session_id}/permission"),
            deadline,
        );
    }
    if Instant::now() < deadline && client.supports("/api/session/{sessionID}/form") {
        activity.input_waiting =
            waiting_facet(client, &format!("/api/session/{session_id}/form"), deadline);
    }
    Ok(activity)
}

fn waiting_facet(client: &ApiClient, path: &str, deadline: Instant) -> Tri {
    match client.get_until(path, deadline) {
        Ok(value) => {
            let data = value.get("data").unwrap_or(&value);
            match data.as_array() {
                Some(values) => {
                    if values.is_empty() {
                        Tri::No
                    } else {
                        Tri::Yes
                    }
                }
                None => Tri::Unknown,
            }
        }
        Err(_) => Tri::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_allowlist_is_exact() {
        assert!(allowed_api_read("/openapi.json"));
        assert!(allowed_api_read("/api/session/active"));
        assert!(allowed_api_read("/api/session/ses_one"));
        assert!(allowed_api_read("/api/session/ses_one/permission"));
        assert!(allowed_api_read("/api/session/ses_one/form"));
        assert!(!allowed_api_read("/api/session"));
        assert!(!allowed_api_read("/api/session?limit=1"));
        assert!(!allowed_api_read("/api/session/ses_one/message"));
        assert!(!allowed_api_read("/api/session/ses_one/permission/x"));
        assert!(!allowed_api_read("/api/session/ses_bad/../x"));
    }
}
