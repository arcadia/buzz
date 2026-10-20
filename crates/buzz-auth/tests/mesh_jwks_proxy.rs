use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use buzz_auth::nip_fi::{HttpJwksFetcher, JwksFetcher, JwksSourceContract};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

#[path = "support/jwks_tls.rs"]
mod tls;

const CHILD_MARKER: &str = "BUZZ_AUTH_JWKS_PROXY_TEST_CHILD";
const CHILD_TARGET: &str = "BUZZ_AUTH_JWKS_PROXY_TEST_TARGET";
const CHILD_ROOT: &str = "BUZZ_AUTH_JWKS_PROXY_TEST_ROOT";
const JWKS_BODY: &str = r#"{"keys":[{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0","use":"sig","alg":"ES256","kid":"proxy-test"}]}"#;

#[tokio::test(flavor = "current_thread")]
async fn mesh_fetch_for_contract_ignores_proxy_environment() {
    if std::env::var_os(CHILD_MARKER).is_some() {
        run_child_test().await;
        return;
    }

    let address = tokio::net::lookup_host(("localhost", 0))
        .await
        .unwrap()
        .next()
        .expect("localhost address");
    assert!(address.ip().is_loopback());
    let target = tokio::net::TcpListener::bind(address).await.unwrap();
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_url = format!("https://localhost:{}", target.local_addr().unwrap().port());
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let fixture = tls::TlsFixture::new();
    let root = STANDARD.encode(&fixture.root_der);
    let target_task = tokio::spawn(async move {
        let mut stream = fixture.accept(&target).await;
        let request = read_request_headers(&mut stream).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            JWKS_BODY.len(), JWKS_BODY
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        request
    });
    let proxy_task = tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        let request = read_request_headers(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        request
    });
    let _cleanup = AbortOnDrop(vec![target_task.abort_handle(), proxy_task.abort_handle()]);

    // Isolate ambient proxy settings in a child process, avoiding races with
    // other tests. The proxy control must receive a real HTTPS CONNECT.
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "mesh_fetch_for_contract_ignores_proxy_environment",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env(CHILD_TARGET, &target_url)
            .env(CHILD_ROOT, root)
            .env("HTTPS_PROXY", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env_remove("HTTP_PROXY")
            .env_remove("http_proxy")
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy")
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .env_remove("REQUEST_METHOD")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("proxy regression child must finish within 20 seconds")
    .unwrap();
    assert!(
        output.status.success(),
        "child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let proxy_request = tokio::time::timeout(Duration::from_secs(2), proxy_task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        proxy_request.starts_with("CONNECT localhost:"),
        "positive control must use the configured HTTPS proxy"
    );
    let target_request = tokio::time::timeout(Duration::from_secs(2), target_task)
        .await
        .unwrap()
        .unwrap();
    assert!(target_request.starts_with("GET /jwks.json HTTP/1.1\r\n"));
}

async fn run_child_test() {
    let target_url = std::env::var(CHILD_TARGET).unwrap();
    let root = STANDARD.decode(std::env::var(CHILD_ROOT).unwrap()).unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(
        client
            .get(format!("{target_url}/proxy-control"))
            .send()
            .await
            .is_err(),
        "the positive control's HTTPS tunnel must be rejected by the test proxy"
    );
    let contract =
        JwksSourceContract::new_mesh(format!("{target_url}/jwks.json"), 300, 3600).unwrap();
    let body = HttpJwksFetcher::new()
        .with_root_certificate(reqwest::Certificate::from_der(&root).unwrap())
        .fetch_for_contract(&contract)
        .await
        .expect("verified TLS fetch must bypass the configured proxy");
    assert_eq!(body, JWKS_BODY);
}

struct AbortOnDrop(Vec<tokio::task::AbortHandle>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

async fn read_request_headers(stream: &mut (impl AsyncRead + Unpin)) -> String {
    let mut request = Vec::new();
    let mut chunk = [0; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await.unwrap();
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        assert!(
            request.len() <= 16 * 1024,
            "request headers exceed test limit"
        );
    }
    String::from_utf8(request).unwrap()
}
