use super::*;
use axum::{
    routing::{get, post},
    Router,
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct NoBrowser;
impl BrowserOpener for NoBrowser {
    fn open(&self, _: &str) -> Result<(), String> {
        panic!("rejected OAuth endpoints must not open a browser");
    }
}

#[test]
fn remote_http_discovery_is_rejected_before_cache_creation() {
    let root = tempfile::tempdir().unwrap();
    let mut cfg = crate::llm::databricks_pkce_config(
        "http://provider.invalid",
        Some(root.path().join("unused")),
    );
    for discovery in [
        "http://provider.invalid/discovery",
        "http://192.0.2.1/discovery",
        "http://localhost.example/discovery",
    ] {
        cfg.discovery_url = discovery.into();
        assert!(PkceOAuthTokenSource::new_with(cfg.clone(), Arc::new(NoBrowser)).is_err());
        assert!(!root.path().join("unused").exists());
    }
}

#[tokio::test]
async fn insecure_discovered_endpoints_receive_no_refresh_credentials() {
    for rejected_field in ["authorization_endpoint", "token_endpoint"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base = format!("http://{address}");
        let mut document = json!({
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
        });
        document[rejected_field] =
            json!(format!("http://provider.invalid:{}/token", address.port()));
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let router = Router::new()
            .route(
                "/oidc/.well-known/oauth-authorization-server",
                get(move || {
                    let document = document.clone();
                    async move { axum::Json(document) }
                }),
            )
            .fallback(move || {
                seen.fetch_add(1, Ordering::SeqCst);
                async { axum::Json(json!({"access_token":"should-not-be-issued"})) }
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        // A failed guard would contact this local sink, never a real host.
        let http = Client::builder()
            .no_proxy()
            .resolve("provider.invalid", address)
            .redirect(oauth_redirect_policy(true))
            .build()
            .unwrap();
        let source = PkceOAuthTokenSource::from_parts(
            crate::llm::databricks_pkce_config(&base, Some(root.path().into())),
            Arc::new(NoBrowser),
            http,
            None,
        )
        .unwrap();
        *source.state.lock().await = Some(CachedToken {
            access_token: "synthetic-expired".into(),
            refresh_token: Some("synthetic-refresh".into()),
            expires_at: Some(1),
        });
        let result = source.bearer_no_browser().await;
        task.abort();
        assert!(result.is_err(), "{rejected_field} must be rejected");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "no grant may reach the sink"
        );
    }
}

#[tokio::test]
async fn explicit_loopback_providers_can_refresh_through_the_public_constructor() {
    for host in ["127.0.0.1", "localhost"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{host}:{}", listener.local_addr().unwrap().port());
        let document = json!({
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let router = Router::new()
            .route(
                "/oidc/.well-known/oauth-authorization-server",
                get(move || {
                    let document = document.clone();
                    async move { axum::Json(document) }
                }),
            )
            .route(
                "/token",
                post(move || {
                    seen.fetch_add(1, Ordering::SeqCst);
                    async {
                        axum::Json(json!({
                            "access_token": "synthetic-local-access",
                            "expires_in": 3600,
                        }))
                    }
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let source = PkceOAuthTokenSource::new_with(
            crate::llm::databricks_pkce_config(&base, Some(root.path().into())),
            Arc::new(NoBrowser),
        )
        .unwrap();
        *source.state.lock().await = Some(CachedToken {
            access_token: "synthetic-expired".into(),
            refresh_token: Some("synthetic-refresh".into()),
            expires_at: Some(1),
        });
        let result = source.bearer_no_browser().await;
        task.abort();
        assert_eq!(result.unwrap(), "synthetic-local-access");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
