//! Bounded OAuth response decoding shared by legacy and strict callers.
//!
//! Deliberate compatibility change: oversized discovery/token documents are
//! infrastructure failures, never grant rejections. Raw provider diagnostics
//! are not returned or logged (they can echo codes, verifiers and tokens).

use reqwest::{redirect::Policy, Response, Url};
use serde_json::Value;

use crate::types::AgentError;

pub(crate) const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_OAUTH_ERROR_BYTES: usize = 16 * 1024;

/// Local development providers may use loopback HTTP. Public discovery and
/// grant endpoints must use TLS; an HTTPS provider cannot opt into this exception.
pub(crate) fn validate_oauth_endpoint(
    raw: &str,
    allow_loopback_http: bool,
) -> Result<Url, AgentError> {
    let url = Url::parse(raw).map_err(|_| insecure_endpoint())?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost",
        None => false,
    };
    if url.scheme() == "https" || (allow_loopback_http && url.scheme() == "http" && loopback) {
        Ok(url)
    } else {
        Err(insecure_endpoint())
    }
}

fn insecure_endpoint() -> AgentError {
    AgentError::Llm("OAuth endpoints require HTTPS except for local loopback providers".into())
}

/// Preserve legacy cross-origin HTTPS redirects without allowing a 307/308
/// redirect to replay a refresh token or authorization code over cleartext.
pub(crate) fn oauth_redirect_policy(allow_loopback_http: bool) -> Policy {
    Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("OAuth redirect limit exceeded");
        }
        if validate_oauth_endpoint(attempt.url().as_str(), allow_loopback_http).is_err()
            || (attempt.url().scheme() == "http"
                && attempt.previous().iter().any(|url| url.scheme() == "https"))
        {
            return attempt.error("OAuth redirect requires a secure transport");
        }
        attempt.follow()
    })
}

pub(crate) async fn read_oauth_json(mut response: Response) -> Result<Value, ()> {
    let limit = if response.status().is_success() {
        MAX_OAUTH_RESPONSE_BYTES
    } else {
        MAX_OAUTH_ERROR_BYTES
    };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > limit - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_transport_requires_tls_or_explicit_loopback() {
        for url in [
            "https://workspace.example/discovery",
            "https://different-origin.example/token",
        ] {
            assert!(validate_oauth_endpoint(url, false).is_ok());
        }
        for url in [
            "http://127.0.0.1:1234/token",
            "http://[::1]:1234/token",
            "http://localhost:1234/token",
        ] {
            assert!(validate_oauth_endpoint(url, true).is_ok());
            assert!(validate_oauth_endpoint(url, false).is_err());
        }
        for url in [
            "http://provider.example/token",
            "http://192.0.2.1/token",
            "http://localhost.example/token",
            "http://127.0.0.1.example/token",
            "ftp://localhost/token",
        ] {
            assert!(validate_oauth_endpoint(url, true).is_err());
        }
    }
}
